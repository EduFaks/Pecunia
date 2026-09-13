import uuid
from datetime import UTC, date, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project as project_fields
from pecunia.events import DomainEvent, event_bus
from pecunia.models.budget import Budget
from pecunia.models.category import Category
from pecunia.models.transaction import Transaction
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.period import current_window
from pecunia.services.scoping import get_scoped, scoped_select

# Sentinel distinguishing "field not present in the PATCH body" from "field
# explicitly set to null" for the nullable category_id column.
UNSET = object()


class CategoryNotFoundError(Exception):
    """Raised when a budget references a category that doesn't exist in the
    caller's workspace. The router maps this to 404."""


class BudgetService:
    """Budget business logic. Contract: methods flush, never commit — the
    caller (router) owns the transaction boundary (CONVENTIONS §2)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def _validate_category(self, workspace_id: uuid.UUID, category_id: uuid.UUID) -> Category:
        category = await get_scoped(self.db, Category, category_id, workspace_id)
        if category is None:
            raise CategoryNotFoundError()
        return category

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        name: str,
        period: str,
        amount_minor: int,
        currency: str,
        category_id: uuid.UUID | None = None,
    ) -> Budget:
        if category_id is not None:
            await self._validate_category(workspace_id, category_id)
        budget = Budget(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            category_id=category_id,
            period=period,
            amount_minor=amount_minor,
            currency=currency,
        )
        self.db.add(budget)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.BUDGET_CREATED,
                resource_type="budget",
                resource_id=str(budget.id),
                workspace_id=workspace_id,
                after=project_fields("budget", budget),
                activity_template=Activity.BUDGET_CREATED,
                activity_params={
                    "name": budget.name,
                    "amount_minor": budget.amount_minor,
                    "currency": budget.currency,
                },
            ),
        )
        return budget

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[Budget], str | None]:
        stmt = scoped_select(Budget, workspace_id)
        # UUID primary keys carry no order — paginate newest-first on
        # created_at, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = stmt.order_by(Budget.created_at.desc(), Budget.id.desc())
        return await keyset_page(
            self.db,
            stmt,
            Budget.created_at,
            Budget.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(self, workspace_id: uuid.UUID, budget_id: uuid.UUID) -> Budget | None:
        return await get_scoped(self.db, Budget, budget_id, workspace_id)

    async def update(
        self,
        budget: Budget,
        *,
        name: str | None = None,
        category_id: object = UNSET,
        period: str | None = None,
        amount_minor: int | None = None,
        currency: str | None = None,
    ) -> Budget:
        if category_id is not UNSET and category_id is not None:
            await self._validate_category(budget.workspace_id, category_id)
        before = project_fields("budget", budget)
        if name is not None:
            budget.name = name
        if category_id is not UNSET:
            budget.category_id = category_id
        if period is not None:
            budget.period = period
        if amount_minor is not None:
            budget.amount_minor = amount_minor
        if currency is not None:
            budget.currency = currency
        budget.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.BUDGET_UPDATED,
                resource_type="budget",
                resource_id=str(budget.id),
                workspace_id=budget.workspace_id,
                before=before,
                after=project_fields("budget", budget),
            ),
        )
        return budget

    async def actual_minor(self, budget: Budget, ref: date) -> int | None:
        """Sum of the absolute value of expense transactions (amount_minor <
        0) in `budget`'s category, scoped to its workspace, not soft-deleted,
        falling within the period window containing `ref`. `None` when the
        budget carries no category (nothing to aggregate against).

        One scoped aggregate query per budget — N+1 across a budget list is
        acceptable at household scale; batch this in the v1.1-E pass.
        """
        if budget.category_id is None:
            return None
        start, end = current_window(budget.period, ref)
        total = await self.db.scalar(
            select(func.coalesce(func.sum(-Transaction.amount_minor), 0)).where(
                Transaction.workspace_id == budget.workspace_id,
                Transaction.category_id == budget.category_id,
                Transaction.amount_minor < 0,
                Transaction.deleted_at.is_(None),
                Transaction.occurred_on >= start,
                Transaction.occurred_on <= end,
            )
        )
        return total

    async def delete(self, budget: Budget) -> None:
        """Hard delete: budgets have no children."""
        before = project_fields("budget", budget)
        await self.db.delete(budget)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.BUDGET_DELETED,
                resource_type="budget",
                resource_id=str(budget.id),
                workspace_id=budget.workspace_id,
                before=before,
            ),
        )
