import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.account import Account
from pecunia.models.transaction import Transaction
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select


class AccountCurrencyChangeError(Exception):
    """Raised when a currency change is attempted on an account that already
    has at least one transaction (of any deleted state). balance() sums
    Transaction.amount_minor as if it were all one currency, so changing an
    account's currency out from under existing transactions would make that
    sum meaningless. The router maps this to 409."""


class AccountService:
    """Account business logic. Contract: methods flush, never commit — the
    caller (router) owns the transaction boundary (CONVENTIONS §2)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        name: str,
        type: str,
        currency: str,
        initial_balance_minor: int = 0,
    ) -> Account:
        account = Account(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            type=type,
            currency=currency,
            initial_balance_minor=initial_balance_minor,
        )
        self.db.add(account)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.ACCOUNT_CREATED,
                resource_type="account",
                resource_id=str(account.id),
                workspace_id=workspace_id,
                after=project("account", account),
                activity_template=Activity.ACCOUNT_CREATED,
                activity_params={"name": account.name, "type": account.type},
            ),
        )
        return account

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        include_archived: bool = False,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[Account], str | None]:
        stmt = scoped_select(Account, workspace_id)
        if not include_archived:
            stmt = stmt.where(Account.archived_at.is_(None))
        # UUID primary keys carry no order — paginate newest-first on
        # created_at, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = stmt.order_by(Account.created_at.desc(), Account.id.desc())
        return await keyset_page(
            self.db,
            stmt,
            Account.created_at,
            Account.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(self, workspace_id: uuid.UUID, account_id: uuid.UUID) -> Account | None:
        return await get_scoped(self.db, Account, account_id, workspace_id)

    async def update(
        self,
        account: Account,
        *,
        name: str | None = None,
        type: str | None = None,
        currency: str | None = None,
    ) -> Account:
        if currency is not None and currency != account.currency:
            has_transaction = await self.db.scalar(
                select(Transaction.id).where(Transaction.account_id == account.id).limit(1)
            )
            if has_transaction is not None:
                raise AccountCurrencyChangeError()
        before = project("account", account)
        if name is not None:
            account.name = name
        if type is not None:
            account.type = type
        if currency is not None:
            account.currency = currency
        account.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.ACCOUNT_UPDATED,
                resource_type="account",
                resource_id=str(account.id),
                workspace_id=account.workspace_id,
                before=before,
                after=project("account", account),
            ),
        )
        return account

    async def archive(self, account: Account) -> Account:
        account.archived_at = datetime.now(UTC)
        account.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.ACCOUNT_ARCHIVED,
                resource_type="account",
                resource_id=str(account.id),
                workspace_id=account.workspace_id,
                after=project("account", account),
            ),
        )
        return account

    async def balance(self, account: Account) -> int:
        """Initial balance plus the sum of non-deleted transactions."""
        total = await self.db.scalar(
            select(func.coalesce(func.sum(Transaction.amount_minor), 0)).where(
                Transaction.account_id == account.id, Transaction.deleted_at.is_(None)
            )
        )
        return account.initial_balance_minor + total
