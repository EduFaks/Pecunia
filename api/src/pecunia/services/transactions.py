import uuid
from datetime import UTC, date, datetime
from typing import Literal

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.account import Account
from pecunia.models.category import Category
from pecunia.models.contact import Contact
from pecunia.models.project import Project
from pecunia.models.transaction import Transaction
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select

# Sentinel distinguishing "field not present in the PATCH body" from "field
# explicitly set to null" for the nullable `category_id`/`contact_id` columns.
UNSET = object()


class AccountNotFoundError(Exception):
    """Raised when a transaction references an account that doesn't exist in
    the caller's workspace. The router maps this to 404."""


class CategoryNotFoundError(Exception):
    """Raised when a transaction references a category that doesn't exist in
    the caller's workspace. The router maps this to 404."""


class ContactNotFoundError(Exception):
    """Raised when a transaction references a contact that doesn't exist in the
    caller's workspace. The router maps this to 404 (mirrors category_id)."""


class ProjectNotFoundError(Exception):
    """Raised when a transaction references a project that doesn't exist in the
    caller's workspace. The router maps this to 404 (mirrors category_id)."""


class CurrencyMismatchError(Exception):
    """Raised when a transaction's currency doesn't match its account's
    currency. The router maps this to 422."""


class ManagedByTransferError(Exception):
    """Raised when update/soft_delete is attempted on a transaction that is a
    transfer leg (transfer_id set). A leg exists only as part of its transfer
    and is edited/removed only through TransferService — the transaction API
    refuses to mutate it. The router maps this to 409 MANAGED_BY_TRANSFER."""


class TransactionService:
    """Transaction business logic. Contract: methods flush, never commit —
    the caller (router) owns the transaction boundary (CONVENTIONS §2)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def _validate_account(
        self, workspace_id: uuid.UUID, account_id: uuid.UUID, currency: str
    ) -> Account:
        account = await get_scoped(self.db, Account, account_id, workspace_id)
        if account is None:
            raise AccountNotFoundError()
        if account.currency != currency:
            raise CurrencyMismatchError()
        return account

    async def _validate_category(self, workspace_id: uuid.UUID, category_id: uuid.UUID) -> Category:
        category = await get_scoped(self.db, Category, category_id, workspace_id)
        if category is None:
            raise CategoryNotFoundError()
        return category

    async def _validate_contact(self, workspace_id: uuid.UUID, contact_id: uuid.UUID) -> Contact:
        contact = await get_scoped(self.db, Contact, contact_id, workspace_id)
        if contact is None:
            raise ContactNotFoundError()
        return contact

    async def _validate_project(self, workspace_id: uuid.UUID, project_id: uuid.UUID) -> Project:
        project = await get_scoped(self.db, Project, project_id, workspace_id)
        if project is None:
            raise ProjectNotFoundError()
        return project

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        account_id: uuid.UUID,
        amount_minor: int,
        currency: str,
        description: str,
        occurred_on: date,
        category_id: uuid.UUID | None = None,
        contact_id: uuid.UUID | None = None,
        project_id: uuid.UUID | None = None,
    ) -> Transaction:
        await self._validate_account(workspace_id, account_id, currency)
        contact_row = (
            await self._validate_contact(workspace_id, contact_id) if contact_id is not None else None
        )
        if category_id is not None:
            await self._validate_category(workspace_id, category_id)
        if project_id is not None:
            # A transaction linked directly to a project via project_id does NOT
            # trigger the project target-reached activity — that is evaluated
            # only on the attach path (ProjectService.attach_item_transaction),
            # an accepted limitation to keep this service decoupled from
            # project-funding crossing logic. (See update() for the fuller note.)
            await self._validate_project(workspace_id, project_id)
        # Default-category apply (create-only): a transaction that gets a contact
        # but no category of its own inherits the contact's default category. An
        # explicit category_id always wins; update() never auto-applies. The
        # rule keys off "category_id is None at create" — deliberately NOT
        # distinguishing unset-vs-explicit-null — so the server rule is
        # identical to the client's "fill category only when empty", keeping
        # client/server behavior in lockstep (plan requirement). The inherited
        # id is already workspace-scoped and validated (it was checked when the
        # contact's default_category_id was set), so no re-validation is needed.
        if contact_row is not None and category_id is None and contact_row.default_category_id is not None:
            category_id = contact_row.default_category_id
        transaction = Transaction(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            account_id=account_id,
            category_id=category_id,
            contact_id=contact_id,
            project_id=project_id,
            amount_minor=amount_minor,
            currency=currency,
            description=description,
            occurred_on=occurred_on,
        )
        self.db.add(transaction)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.TRANSACTION_CREATED,
                resource_type="transaction",
                resource_id=str(transaction.id),
                workspace_id=workspace_id,
                after=project("transaction", transaction),
                activity_template=Activity.TRANSACTION_CREATED,
                activity_params={
                    "description": transaction.description,
                    "amount_minor": transaction.amount_minor,
                    "currency": transaction.currency,
                },
            ),
        )
        return transaction

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        account_id: uuid.UUID | None = None,
        category_id: uuid.UUID | None = None,
        contact_id: uuid.UUID | None = None,
        project_id: uuid.UUID | None = None,
        q: str | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        min_amount_minor: int | None = None,
        max_amount_minor: int | None = None,
        type: Literal["income", "expense", "transfer"] | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[Transaction], str | None]:
        stmt = scoped_select(Transaction, workspace_id).where(Transaction.deleted_at.is_(None))
        if account_id is not None:
            stmt = stmt.where(Transaction.account_id == account_id)
        if category_id is not None:
            stmt = stmt.where(Transaction.category_id == category_id)
        if contact_id is not None:
            stmt = stmt.where(Transaction.contact_id == contact_id)
        if project_id is not None:
            stmt = stmt.where(Transaction.project_id == project_id)
        # Case-insensitive substring search on the description. A blank or
        # whitespace-only q is treated as "no search" so an empty search box
        # never filters everything out. Escape LIKE metacharacters (%, _, \) so
        # they are matched literally, not as SQL wildcards.
        if q is not None and q.strip():
            escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            stmt = stmt.where(Transaction.description.ilike(f"%{escaped}%", escape="\\"))
        # Inclusive occurred_on bounds.
        if date_from is not None:
            stmt = stmt.where(Transaction.occurred_on >= date_from)
        if date_to is not None:
            stmt = stmt.where(Transaction.occurred_on <= date_to)
        # Amount range on the *magnitude* (ABS) so a "$10–$50" band matches both
        # a −5000 expense and a +5000 income. When both bounds are given with
        # min > max, the two ANDed conditions can never both hold, so the query
        # naturally returns nothing — we deliberately treat an inverted range as
        # "no match" (empty) rather than raising 422.
        if min_amount_minor is not None:
            stmt = stmt.where(func.abs(Transaction.amount_minor) >= min_amount_minor)
        if max_amount_minor is not None:
            stmt = stmt.where(func.abs(Transaction.amount_minor) <= max_amount_minor)
        # Type partition, matching the cashflow definitions: a transfer leg
        # (transfer_id set) is only "transfer", never income/expense.
        if type == "income":
            stmt = stmt.where(Transaction.amount_minor > 0, Transaction.transfer_id.is_(None))
        elif type == "expense":
            stmt = stmt.where(Transaction.amount_minor < 0, Transaction.transfer_id.is_(None))
        elif type == "transfer":
            stmt = stmt.where(Transaction.transfer_id.is_not(None))
        # UUID primary keys carry no order — paginate newest-first on
        # occurred_on, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = stmt.order_by(Transaction.occurred_on.desc(), Transaction.id.desc())
        return await keyset_page(
            self.db,
            stmt,
            Transaction.occurred_on,
            Transaction.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(self, workspace_id: uuid.UUID, transaction_id: uuid.UUID) -> Transaction | None:
        return await get_scoped(self.db, Transaction, transaction_id, workspace_id)

    async def update(
        self,
        transaction: Transaction,
        *,
        account_id: uuid.UUID | None = None,
        category_id: object = UNSET,
        amount_minor: int | None = None,
        currency: str | None = None,
        description: str | None = None,
        contact_id: object = UNSET,
        project_id: object = UNSET,
        occurred_on: date | None = None,
    ) -> Transaction:
        # A transfer leg is managed only through its transfer — refuse to edit
        # it here so the paired-leg invariant can't be broken from the tx API.
        if transaction.transfer_id is not None:
            raise ManagedByTransferError()
        # Re-validate the account/currency relationship BEFORE mutating
        # anything (mirrors create's validate-first structure) whenever
        # either side of it could change. Validating first — rather than
        # mutating then checking — also avoids handing a dirty, FK-violating
        # account_id to autoflush ahead of the check.
        if account_id is not None or currency is not None:
            target_account_id = account_id if account_id is not None else transaction.account_id
            target_currency = currency if currency is not None else transaction.currency
            await self._validate_account(transaction.workspace_id, target_account_id, target_currency)
        if category_id is not UNSET and category_id is not None:
            await self._validate_category(transaction.workspace_id, category_id)
        if contact_id is not UNSET and contact_id is not None:
            await self._validate_contact(transaction.workspace_id, contact_id)
        if project_id is not UNSET and project_id is not None:
            await self._validate_project(transaction.workspace_id, project_id)
        before = project("transaction", transaction)
        if account_id is not None:
            transaction.account_id = account_id
        if category_id is not UNSET:
            transaction.category_id = category_id
        # Update never auto-applies a contact's default category — the
        # default-category convenience is create-only (see create()). Attaching
        # or changing a contact here leaves category_id exactly as the caller
        # specified (or unchanged when omitted).
        if contact_id is not UNSET:
            transaction.contact_id = contact_id
        # Accepted limitation: the project target-reached activity is evaluated
        # only in ProjectService.attach_item_transaction (the attach path), NOT
        # when a transaction is linked directly to a project via project_id
        # here. Re-evaluating the funding-crossing here would couple the
        # transaction service to project-funding logic; the direct link is a
        # deliberately lighter path that skips it. (Same applies in create().)
        if project_id is not UNSET:
            transaction.project_id = project_id
        if amount_minor is not None:
            transaction.amount_minor = amount_minor
        if currency is not None:
            transaction.currency = currency
        if description is not None:
            transaction.description = description
        if occurred_on is not None:
            transaction.occurred_on = occurred_on
        transaction.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.TRANSACTION_UPDATED,
                resource_type="transaction",
                resource_id=str(transaction.id),
                workspace_id=transaction.workspace_id,
                before=before,
                after=project("transaction", transaction),
            ),
        )
        return transaction

    async def soft_delete(self, transaction: Transaction) -> Transaction:
        # A transfer leg is removed only by deleting its transfer (CASCADE) —
        # never soft-deleted on its own, which would unbalance the pair.
        if transaction.transfer_id is not None:
            raise ManagedByTransferError()
        transaction.deleted_at = datetime.now(UTC)
        transaction.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.TRANSACTION_DELETED,
                resource_type="transaction",
                resource_id=str(transaction.id),
                workspace_id=transaction.workspace_id,
                after=project("transaction", transaction),
            ),
        )
        return transaction

    async def restore(self, transaction: Transaction) -> Transaction:
        transaction.deleted_at = None
        transaction.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.TRANSACTION_RESTORED,
                resource_type="transaction",
                resource_id=str(transaction.id),
                workspace_id=transaction.workspace_id,
                after=project("transaction", transaction),
            ),
        )
        return transaction
