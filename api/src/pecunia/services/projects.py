import builtins
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project as project_fields
from pecunia.events import DomainEvent, event_bus
from pecunia.models.project import Project, ProjectItem, ProjectType
from pecunia.models.transaction import Transaction
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select

# Sentinel distinguishing "field not present in the PATCH body" from "field
# explicitly set to null" for nullable columns (description, target_amount_minor).
UNSET = object()

_PROJECT_TYPES = frozenset(t.value for t in ProjectType)


class TransactionNotFoundError(Exception):
    """Raised when an attach references a transaction that doesn't exist in the
    item's workspace. The router maps this to 404 (mirrors category_id)."""


class TransactionAlreadyAttachedError(Exception):
    """Raised when attaching a transaction already fulfilling a different part —
    a transaction can fulfill at most one part. The router maps this to 409."""


class ProjectService:
    """Project + project item business logic. Contract: methods flush, never
    commit — the caller (router) owns the transaction boundary (CONVENTIONS §2)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        name: str,
        currency: str,
        description: str | None = None,
        target_amount_minor: int | None = None,
        status: str = "active",
        type: str = "spending",
    ) -> Project:
        if type not in _PROJECT_TYPES:
            raise ValueError(f"invalid project type: {type!r}")
        project = Project(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            description=description,
            target_amount_minor=target_amount_minor,
            currency=currency,
            status=status,
            type=type,
        )
        self.db.add(project)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.PROJECT_CREATED,
                resource_type="project",
                resource_id=str(project.id),
                workspace_id=workspace_id,
                after=project_fields("project", project),
                activity_template=Activity.PROJECT_CREATED,
                activity_params={
                    "name": project.name,
                    "target_amount_minor": project.target_amount_minor,
                    "currency": project.currency,
                },
            ),
        )
        return project

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        status: str | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[Project], str | None]:
        stmt = scoped_select(Project, workspace_id)
        if status is not None:
            stmt = stmt.where(Project.status == status)
        # UUID primary keys carry no order — paginate newest-first on
        # created_at, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = stmt.order_by(Project.created_at.desc(), Project.id.desc())
        return await keyset_page(
            self.db,
            stmt,
            Project.created_at,
            Project.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(self, workspace_id: uuid.UUID, project_id: uuid.UUID) -> Project | None:
        return await get_scoped(self.db, Project, project_id, workspace_id)

    async def update(
        self,
        project: Project,
        *,
        name: str | None = None,
        description: object = UNSET,
        target_amount_minor: object = UNSET,
        currency: str | None = None,
        status: str | None = None,
        type: str | None = None,
    ) -> Project:
        if type is not None and type not in _PROJECT_TYPES:
            raise ValueError(f"invalid project type: {type!r}")
        before = project_fields("project", project)
        if name is not None:
            project.name = name
        if description is not UNSET:
            project.description = description
        if target_amount_minor is not UNSET:
            project.target_amount_minor = target_amount_minor
        if currency is not None:
            project.currency = currency
        if status is not None:
            project.status = status
        if type is not None:
            project.type = type
        project.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.PROJECT_UPDATED,
                resource_type="project",
                resource_id=str(project.id),
                workspace_id=project.workspace_id,
                before=before,
                after=project_fields("project", project),
            ),
        )
        return project

    async def delete(self, project: Project) -> None:
        """Hard delete (spec/task 4): project_items cascade at the DB level via
        their FK ondelete=CASCADE."""
        before = project_fields("project", project)
        await self.db.delete(project)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.PROJECT_DELETED,
                resource_type="project",
                resource_id=str(project.id),
                workspace_id=project.workspace_id,
                before=before,
            ),
        )

    async def planned_minor(self, project: Project) -> int:
        """Planned funding = Σ of the project's part estimates. A separate figure
        from actual (Σ linked transactions) — the plan, not the realized spend."""
        total = await self.db.scalar(
            select(func.coalesce(func.sum(ProjectItem.amount_minor), 0)).where(
                ProjectItem.workspace_id == project.workspace_id,
                ProjectItem.project_id == project.id,
            )
        )
        return int(total)

    async def actual_minor(self, project: Project) -> int:
        """Actual funding = Σ ABS(amount) of transactions linked to the project.
        Magnitude, so saving contributions (positive) and spending expenses
        (negative) both count toward the target. Soft-deleted transactions are
        excluded — a deleted tx no longer affects the account balance, so it
        must not count here either."""
        total = await self.db.scalar(
            select(func.coalesce(func.sum(func.abs(Transaction.amount_minor)), 0)).where(
                Transaction.workspace_id == project.workspace_id,
                Transaction.project_id == project.id,
                Transaction.deleted_at.is_(None),
            )
        )
        return int(total)

    async def item_actual_minor(self, item: ProjectItem) -> int | None:
        """A part's actual cost = its attached transaction's ABS(amount_minor),
        or None when the part is unattached (not yet 'bought')."""
        if item.transaction_id is None:
            return None
        total = await self.db.scalar(
            select(func.abs(Transaction.amount_minor)).where(
                Transaction.workspace_id == item.workspace_id,
                Transaction.id == item.transaction_id,
            )
        )
        return int(total) if total is not None else None

    async def add_item(self, project: Project, *, name: str, amount_minor: int) -> ProjectItem:
        item = ProjectItem(
            id=uuid.uuid4(),
            workspace_id=project.workspace_id,
            project_id=project.id,
            name=name,
            amount_minor=amount_minor,
        )
        self.db.add(item)
        await self.db.flush()
        # Adding a planned part no longer emits a funded/target activity — funding
        # is realized by *linked transactions* (actual), so the target-reached
        # activity fires on the attach/link path, not here. This stays a plain
        # audited create.
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.PROJECT_ITEM_CREATED,
                resource_type="project_item",
                resource_id=str(item.id),
                workspace_id=project.workspace_id,
                after=project_fields("project_item", item),
            ),
        )
        return item

    async def attach_item_transaction(
        self, item: ProjectItem, transaction_id: uuid.UUID
    ) -> ProjectItem:
        """Mark a part 'bought' by attaching a transaction. Sets both
        item.transaction_id and tx.project_id (upholds the Task 1 invariant).
        Raises TransactionNotFoundError (foreign/missing tx) or
        TransactionAlreadyAttachedError (tx already fulfilling another part)."""
        tx = await get_scoped(self.db, Transaction, transaction_id, item.workspace_id)
        if tx is None:
            raise TransactionNotFoundError()
        # A transaction can fulfill at most one part. Re-attaching the same tx to
        # the same part is idempotent; only a *different* part is a conflict. The
        # DB unique constraint is the hard floor — this check turns it into a
        # clean 409 instead of an IntegrityError.
        conflicting = await self.db.scalar(
            scoped_select(ProjectItem, item.workspace_id)
            .where(ProjectItem.transaction_id == transaction_id)
            .where(ProjectItem.id != item.id)
        )
        if conflicting is not None:
            raise TransactionAlreadyAttachedError()
        project = await get_scoped(self.db, Project, item.project_id, item.workspace_id)
        target = project.target_amount_minor if project is not None else None
        # Snapshot actual BEFORE the mutation (query autoflushes, so read first),
        # then compare after — target-reached fires only on the crossing.
        actual_before = await self.actual_minor(project) if project is not None else 0
        before = project_fields("project_item", item)
        item.transaction_id = tx.id
        tx.project_id = item.project_id
        await self.db.flush()
        actual_after = await self.actual_minor(project) if project is not None else 0
        crossed = target is not None and actual_before < target <= actual_after
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.PROJECT_ITEM_UPDATED,
                resource_type="project_item",
                resource_id=str(item.id),
                workspace_id=item.workspace_id,
                before=before,
                after=project_fields("project_item", item),
                activity_template=Activity.PROJECT_TARGET_REACHED if crossed else None,
                activity_params=(
                    {
                        "project": project.name,
                        "funded": actual_after,
                        "target": target,
                        "currency": project.currency,
                    }
                    if crossed
                    else None
                ),
            ),
        )
        return item

    async def detach_item_transaction(self, item: ProjectItem) -> ProjectItem:
        """Un-mark a part: clear item.transaction_id only. The transaction keeps
        its project_id (it stays linked to the project) unless separately
        unlinked — detach clears just the part-fulfillment link."""
        before = project_fields("project_item", item)
        item.transaction_id = None
        item.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.PROJECT_ITEM_UPDATED,
                resource_type="project_item",
                resource_id=str(item.id),
                workspace_id=item.workspace_id,
                before=before,
                after=project_fields("project_item", item),
            ),
        )
        return item

    async def list_items(
        self,
        workspace_id: uuid.UUID,
        project_id: uuid.UUID,
        *,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[builtins.list[ProjectItem], str | None]:
        stmt = scoped_select(ProjectItem, workspace_id).where(ProjectItem.project_id == project_id)
        stmt = stmt.order_by(ProjectItem.created_at.desc(), ProjectItem.id.desc())
        return await keyset_page(
            self.db,
            stmt,
            ProjectItem.created_at,
            ProjectItem.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get_item(self, workspace_id: uuid.UUID, item_id: uuid.UUID) -> ProjectItem | None:
        return await get_scoped(self.db, ProjectItem, item_id, workspace_id)

    async def update_item(
        self,
        item: ProjectItem,
        *,
        name: str | None = None,
        amount_minor: int | None = None,
    ) -> ProjectItem:
        before = project_fields("project_item", item)
        if name is not None:
            item.name = name
        if amount_minor is not None:
            item.amount_minor = amount_minor
        item.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.PROJECT_ITEM_UPDATED,
                resource_type="project_item",
                resource_id=str(item.id),
                workspace_id=item.workspace_id,
                before=before,
                after=project_fields("project_item", item),
            ),
        )
        return item
