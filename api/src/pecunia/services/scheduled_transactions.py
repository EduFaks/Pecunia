import uuid
from datetime import UTC, date, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from pecunia import period
from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.account import Account
from pecunia.models.category import Category
from pecunia.models.contact import Contact
from pecunia.models.scheduled_transaction import ScheduledTransaction, ScheduleFrequency
from pecunia.models.transaction import Transaction
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select

# The FK/currency validation of a scheduled transaction is identical to a real
# transaction's — reuse the same exception classes so the router maps them to
# the same status codes/details, and reuse TransactionService for the post path
# so a posted schedule flows through the ordinary transaction creation logic
# (balance, analytics, `transaction.created`).
from pecunia.services.transactions import (
    AccountNotFoundError,
    CategoryNotFoundError,
    ContactNotFoundError,
    CurrencyMismatchError,
    TransactionService,
)

# Sentinel distinguishing "field absent from the PATCH body" from "field
# explicitly set to null" for the nullable `category_id`/`contact_id`/`end_date`.
UNSET = object()

_VALID_FREQUENCIES = frozenset(f.value for f in ScheduleFrequency)


class ScheduleZeroAmountError(Exception):
    """Raised when a schedule is created/updated with amount_minor == 0 — a
    recurring rule that moves no money is meaningless. Router maps to 422
    SCHEDULE_ZERO_AMOUNT."""


class InvalidFrequencyError(Exception):
    """Raised when frequency is not a ScheduleFrequency value. The router's
    enum-typed schema already rejects this (422); this is defense in depth for
    direct service callers. Router maps to 422 SCHEDULE_INVALID_FREQUENCY."""


class ScheduledTransactionService:
    """Planned/recurring-schedule business logic. A schedule is a *rule*, never
    a transaction: `post` creates a real Transaction from the template and
    advances `next_due`; `skip` advances without creating one. Contract:
    methods flush, never commit — the router owns the transaction boundary
    (CONVENTIONS §2)."""

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

    async def _validate_category(self, workspace_id: uuid.UUID, category_id: uuid.UUID) -> None:
        if await get_scoped(self.db, Category, category_id, workspace_id) is None:
            raise CategoryNotFoundError()

    async def _validate_contact(self, workspace_id: uuid.UUID, contact_id: uuid.UUID) -> None:
        if await get_scoped(self.db, Contact, contact_id, workspace_id) is None:
            raise ContactNotFoundError()

    def _advance(self, sched: ScheduledTransaction) -> None:
        """Move `next_due` on by one period (clock-free, via `period.advance`),
        deactivating the schedule when the new date runs past `end_date`.
        Shared by `post` and `skip`."""
        sched.next_due = period.advance(sched.next_due, sched.frequency, sched.interval_count)
        if sched.end_date is not None and sched.next_due > sched.end_date:
            sched.is_active = False

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        account_id: uuid.UUID,
        amount_minor: int,
        currency: str,
        description: str,
        frequency: str,
        next_due: date,
        category_id: uuid.UUID | None = None,
        contact_id: uuid.UUID | None = None,
        interval_count: int = 1,
        end_date: date | None = None,
    ) -> ScheduledTransaction:
        if amount_minor == 0:
            raise ScheduleZeroAmountError()
        if frequency not in _VALID_FREQUENCIES:
            raise InvalidFrequencyError()
        await self._validate_account(workspace_id, account_id, currency)
        if category_id is not None:
            await self._validate_category(workspace_id, category_id)
        if contact_id is not None:
            await self._validate_contact(workspace_id, contact_id)
        sched = ScheduledTransaction(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            account_id=account_id,
            category_id=category_id,
            contact_id=contact_id,
            amount_minor=amount_minor,
            currency=currency,
            description=description,
            frequency=frequency,
            interval_count=interval_count,
            next_due=next_due,
            end_date=end_date,
        )
        self.db.add(sched)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SCHEDULED_TRANSACTION_CREATED,
                resource_type="scheduled_transaction",
                resource_id=str(sched.id),
                workspace_id=workspace_id,
                after=project("scheduled_transaction", sched),
                activity_template=Activity.SCHEDULED_TRANSACTION_CREATED,
                activity_params={
                    "description": sched.description,
                    "amount_minor": sched.amount_minor,
                    "currency": sched.currency,
                },
            ),
        )
        return sched

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        is_active: bool | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[ScheduledTransaction], str | None]:
        stmt = scoped_select(ScheduledTransaction, workspace_id)
        if is_active is not None:
            stmt = stmt.where(ScheduledTransaction.is_active == is_active)
        # Soonest-first: what is due next is what the user acts on next. The id
        # tiebreaker keeps a walk deterministic when several schedules share a
        # next_due (CONVENTIONS §6).
        stmt = stmt.order_by(ScheduledTransaction.next_due.asc(), ScheduledTransaction.id.asc())
        return await keyset_page(
            self.db,
            stmt,
            ScheduledTransaction.next_due,
            ScheduledTransaction.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
            descending=False,
        )

    async def get(
        self, workspace_id: uuid.UUID, scheduled_transaction_id: uuid.UUID
    ) -> ScheduledTransaction | None:
        return await get_scoped(
            self.db, ScheduledTransaction, scheduled_transaction_id, workspace_id
        )

    async def update(
        self,
        sched: ScheduledTransaction,
        *,
        account_id: uuid.UUID | None = None,
        amount_minor: int | None = None,
        currency: str | None = None,
        description: str | None = None,
        frequency: str | None = None,
        next_due: date | None = None,
        category_id: object = UNSET,
        contact_id: object = UNSET,
        interval_count: int | None = None,
        end_date: object = UNSET,
    ) -> ScheduledTransaction:
        if amount_minor is not None and amount_minor == 0:
            raise ScheduleZeroAmountError()
        if frequency is not None and frequency not in _VALID_FREQUENCIES:
            raise InvalidFrequencyError()
        # Validate the account/currency relationship BEFORE mutating anything
        # whenever either side could change (mirrors TransactionService.update).
        if account_id is not None or currency is not None:
            target_account_id = account_id if account_id is not None else sched.account_id
            target_currency = currency if currency is not None else sched.currency
            await self._validate_account(sched.workspace_id, target_account_id, target_currency)
        if category_id is not UNSET and category_id is not None:
            await self._validate_category(sched.workspace_id, category_id)
        if contact_id is not UNSET and contact_id is not None:
            await self._validate_contact(sched.workspace_id, contact_id)
        before = project("scheduled_transaction", sched)
        if account_id is not None:
            sched.account_id = account_id
        if category_id is not UNSET:
            sched.category_id = category_id
        if contact_id is not UNSET:
            sched.contact_id = contact_id
        if amount_minor is not None:
            sched.amount_minor = amount_minor
        if currency is not None:
            sched.currency = currency
        if description is not None:
            sched.description = description
        if frequency is not None:
            sched.frequency = frequency
        if interval_count is not None:
            sched.interval_count = interval_count
        if next_due is not None:
            sched.next_due = next_due
        if end_date is not UNSET:
            sched.end_date = end_date
        sched.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SCHEDULED_TRANSACTION_UPDATED,
                resource_type="scheduled_transaction",
                resource_id=str(sched.id),
                workspace_id=sched.workspace_id,
                before=before,
                after=project("scheduled_transaction", sched),
            ),
        )
        return sched

    async def set_active(
        self, sched: ScheduledTransaction, active: bool
    ) -> ScheduledTransaction:
        """Pause (False) or resume (True) a schedule without touching its
        content. A paused schedule stays in the list but drops out of the
        `is_active=true` filter the Planned screen defaults to."""
        before = project("scheduled_transaction", sched)
        sched.is_active = active
        sched.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SCHEDULED_TRANSACTION_UPDATED,
                resource_type="scheduled_transaction",
                resource_id=str(sched.id),
                workspace_id=sched.workspace_id,
                before=before,
                after=project("scheduled_transaction", sched),
            ),
        )
        return sched

    async def post(
        self,
        sched: ScheduledTransaction,
        *,
        today: date,
        on_date: date | None = None,
    ) -> tuple[ScheduledTransaction, Transaction]:
        """Realize this occurrence: create an ordinary Transaction from the
        template (so balance/analytics/audit all update for free, and the
        normal `transaction.created` event fires), then advance `next_due` by
        one period. `today` is accepted to keep the service clock-free per
        CONVENTIONS (the router passes `date.today()`); the posted transaction's
        `occurred_on` is `on_date or sched.next_due` and the advance is
        date-driven, so `today` is not otherwise read here."""
        occurred_on = on_date or sched.next_due
        transaction = await TransactionService(self.db).create(
            sched.workspace_id,
            account_id=sched.account_id,
            amount_minor=sched.amount_minor,
            currency=sched.currency,
            description=sched.description,
            occurred_on=occurred_on,
            category_id=sched.category_id,
            contact_id=sched.contact_id,
        )
        before = project("scheduled_transaction", sched)
        self._advance(sched)
        sched.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SCHEDULED_TRANSACTION_POSTED,
                resource_type="scheduled_transaction",
                resource_id=str(sched.id),
                workspace_id=sched.workspace_id,
                before=before,
                after=project("scheduled_transaction", sched),
                metadata={"transaction_id": str(transaction.id)},
            ),
        )
        return sched, transaction

    async def skip(self, sched: ScheduledTransaction) -> ScheduledTransaction:
        """Advance `next_due` past this occurrence WITHOUT creating a
        transaction (same end-date deactivation as `post`)."""
        before = project("scheduled_transaction", sched)
        self._advance(sched)
        sched.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SCHEDULED_TRANSACTION_SKIPPED,
                resource_type="scheduled_transaction",
                resource_id=str(sched.id),
                workspace_id=sched.workspace_id,
                before=before,
                after=project("scheduled_transaction", sched),
            ),
        )
        return sched

    async def delete(self, sched: ScheduledTransaction) -> None:
        """Hard-delete the rule (it carries no history of its own — posted
        occurrences live on as ordinary transactions)."""
        resource_id = str(sched.id)
        workspace_id = sched.workspace_id
        before = project("scheduled_transaction", sched)
        await self.db.delete(sched)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.SCHEDULED_TRANSACTION_DELETED,
                resource_type="scheduled_transaction",
                resource_id=resource_id,
                workspace_id=workspace_id,
                before=before,
            ),
        )
