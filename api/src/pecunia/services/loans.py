import builtins
import uuid
from datetime import UTC, date, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.contact import Contact
from pecunia.models.loan import Loan, LoanDirection, LoanPayment
from pecunia.models.transaction import Transaction
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select

# Reuse the transaction domain's contact lookup exception so the router maps
# a foreign contact_id to the same 404 CONTACT_NOT_FOUND the rest of the app
# uses (mirrors ScheduledTransactionService/SubscriptionService).
from pecunia.services.transactions import ContactNotFoundError

# Sentinel distinguishing "field absent from the PATCH body" from "field
# explicitly set to null" for the nullable loan columns.
UNSET = object()


class NonPositivePaymentError(Exception):
    """Raised when a payment's amount_minor <= 0 — a payment magnitude is a
    positive integer (CONVENTIONS §4). The router maps this to
    422 LOAN_PAYMENT_NONPOSITIVE."""


class TransactionNotFoundError(Exception):
    """Raised when a payment links a transaction that doesn't exist in the
    loan's workspace. The router maps this to 404 TRANSACTION_NOT_FOUND
    (mirrors ProjectService.attach_item_transaction)."""


class TransactionAlreadyLinkedError(Exception):
    """Raised when linking a transaction already funding a different loan
    payment — a transaction funds at most one loan payment. The router maps
    this to 409 TRANSACTION_ALREADY_LINKED."""


class TransactionIsTransferLegError(Exception):
    """Raised when linking a transaction that is a leg of a transfer
    (transfer_id set). A transfer leg is already managed by its transfer and
    can't fund a loan payment. The router maps this to
    422 TRANSACTION_IS_TRANSFER_LEG (mirrors ManagedByTransferError)."""


class LoanPaymentCurrencyMismatchError(Exception):
    """Raised when linking a transaction whose currency differs from the loan's
    — the funding transaction must be in the loan's currency, or a foreign
    amount would corrupt the loan's remaining_minor (CONVENTIONS §4 — never sum
    across currencies). The router maps this to
    422 LOAN_PAYMENT_CURRENCY_MISMATCH (mirrors TRANSFER_CURRENCY_MISMATCH)."""


class LoanService:
    """Loan + loan-payment business logic. Mirrors the Portfolio aggregate: a
    Loan is the parent (a liability when `direction` is borrowed, a receivable
    when lent) and a LoanPayment is a child ledger row. V1 does NOT amortize:
    the remaining balance is `principal − Σ payments`, reconstructed from the
    ledger by date (CONVENTIONS §4 — integer minor units only, never a float,
    never summed across currencies).

    Contract: methods flush, never commit — the caller (router) owns the
    transaction boundary (§2). Clock-free: payment dates are passed in (§4);
    `on_date=None` means "count every payment" (the current remaining), not
    "today read from the clock"."""

    def __init__(self, db: AsyncSession):
        self.db = db

    # ---- Loan CRUD -------------------------------------------------------- #

    async def _validate_contact(self, workspace_id: uuid.UUID, contact_id: uuid.UUID) -> None:
        if await get_scoped(self.db, Contact, contact_id, workspace_id) is None:
            raise ContactNotFoundError()

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        name: str,
        currency: str,
        principal_minor: int,
        direction: str = LoanDirection.BORROWED,
        interest_rate_bps: int | None = None,
        planned_payment_minor: int | None = None,
        payment_frequency: str | None = None,
        next_due: date | None = None,
        opened_on: date | None = None,
        description: str | None = None,
        contact_id: uuid.UUID | None = None,
    ) -> Loan:
        if contact_id is not None:
            await self._validate_contact(workspace_id, contact_id)
        loan = Loan(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            direction=direction,
            principal_minor=principal_minor,
            currency=currency,
            interest_rate_bps=interest_rate_bps,
            planned_payment_minor=planned_payment_minor,
            payment_frequency=payment_frequency,
            next_due=next_due,
            opened_on=opened_on,
            description=description,
            contact_id=contact_id,
        )
        self.db.add(loan)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.LOAN_CREATED,
                resource_type="loan",
                resource_id=str(loan.id),
                workspace_id=workspace_id,
                after=project("loan", loan),
                activity_template=Activity.LOAN_CREATED,
                activity_params={
                    "name": loan.name,
                    "direction": loan.direction,
                    "currency": loan.currency,
                },
            ),
        )
        return loan

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        contact_id: uuid.UUID | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[builtins.list[Loan], str | None]:
        # UUID primary keys carry no order — paginate newest-first on
        # created_at, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = scoped_select(Loan, workspace_id)
        if contact_id is not None:
            stmt = stmt.where(Loan.contact_id == contact_id)
        stmt = stmt.order_by(Loan.created_at.desc(), Loan.id.desc())
        return await keyset_page(
            self.db,
            stmt,
            Loan.created_at,
            Loan.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(self, workspace_id: uuid.UUID, loan_id: uuid.UUID) -> Loan | None:
        return await get_scoped(self.db, Loan, loan_id, workspace_id)

    async def update(
        self,
        loan: Loan,
        *,
        name: str | None = None,
        direction: str | None = None,
        principal_minor: int | None = None,
        currency: str | None = None,
        interest_rate_bps: object = UNSET,
        planned_payment_minor: object = UNSET,
        payment_frequency: object = UNSET,
        next_due: object = UNSET,
        opened_on: object = UNSET,
        description: object = UNSET,
        contact_id: object = UNSET,
    ) -> Loan:
        # Validate BEFORE mutating anything, so a foreign contact_id leaves
        # the loan untouched (mirrors ScheduledTransactionService/
        # SubscriptionService.update).
        if contact_id is not UNSET and contact_id is not None:
            await self._validate_contact(loan.workspace_id, contact_id)  # type: ignore[arg-type]
        before = project("loan", loan)
        if name is not None:
            loan.name = name
        if direction is not None:
            loan.direction = direction
        if principal_minor is not None:
            loan.principal_minor = principal_minor
        if currency is not None:
            loan.currency = currency
        if interest_rate_bps is not UNSET:
            loan.interest_rate_bps = interest_rate_bps  # type: ignore[assignment]
        if planned_payment_minor is not UNSET:
            loan.planned_payment_minor = planned_payment_minor  # type: ignore[assignment]
        if payment_frequency is not UNSET:
            loan.payment_frequency = payment_frequency  # type: ignore[assignment]
        if next_due is not UNSET:
            loan.next_due = next_due  # type: ignore[assignment]
        if opened_on is not UNSET:
            loan.opened_on = opened_on  # type: ignore[assignment]
        if description is not UNSET:
            loan.description = description  # type: ignore[assignment]
        if contact_id is not UNSET:
            loan.contact_id = contact_id  # type: ignore[assignment]
        loan.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.LOAN_UPDATED,
                resource_type="loan",
                resource_id=str(loan.id),
                workspace_id=loan.workspace_id,
                before=before,
                after=project("loan", loan),
            ),
        )
        return loan

    async def delete(self, loan: Loan) -> None:
        """Hard delete: payments cascade at the DB level via their FK
        ondelete=CASCADE."""
        before = project("loan", loan)
        await self.db.delete(loan)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.LOAN_DELETED,
                resource_type="loan",
                resource_id=str(loan.id),
                workspace_id=loan.workspace_id,
                before=before,
            ),
        )

    # ---- Payments (scoped to a loan) -------------------------------------- #

    async def _validate_link(
        self,
        workspace_id: uuid.UUID,
        transaction_id: uuid.UUID,
        loan_currency: str,
        *,
        exclude_payment_id: uuid.UUID | None = None,
    ) -> None:
        """Validate a payment ↔ transaction link. The transaction must:
        exist in the workspace (else TransactionNotFoundError → 404); not be a
        transfer leg (else TransactionIsTransferLegError → 422 — a leg is
        managed by its transfer); match the loan's currency (else
        LoanPaymentCurrencyMismatchError → 422 — a foreign amount would corrupt
        remaining_minor, §4); and not already fund a different loan payment
        (else TransactionAlreadyLinkedError → 409). The DB unique constraint is
        the hard floor for the last check — this turns it into a clean 409
        instead of an IntegrityError. Mirrors attach_item_transaction."""
        tx = await get_scoped(self.db, Transaction, transaction_id, workspace_id)
        if tx is None:
            raise TransactionNotFoundError()
        if tx.transfer_id is not None:
            raise TransactionIsTransferLegError()
        if tx.currency != loan_currency:
            raise LoanPaymentCurrencyMismatchError()
        stmt = scoped_select(LoanPayment, workspace_id).where(
            LoanPayment.transaction_id == transaction_id
        )
        if exclude_payment_id is not None:
            stmt = stmt.where(LoanPayment.id != exclude_payment_id)
        conflicting = await self.db.scalar(stmt)
        if conflicting is not None:
            raise TransactionAlreadyLinkedError()

    async def record_payment(
        self,
        loan: Loan,
        *,
        amount_minor: int,
        paid_on: date,
        note: str | None = None,
        transaction_id: uuid.UUID | None = None,
    ) -> LoanPayment:
        if amount_minor <= 0:
            raise NonPositivePaymentError()
        if transaction_id is not None:
            await self._validate_link(loan.workspace_id, transaction_id, loan.currency)
        payment = LoanPayment(
            id=uuid.uuid4(),
            workspace_id=loan.workspace_id,
            loan_id=loan.id,
            transaction_id=transaction_id,
            amount_minor=amount_minor,
            paid_on=paid_on,
            note=note,
        )
        self.db.add(payment)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.LOAN_PAYMENT_RECORDED,
                resource_type="loan_payment",
                resource_id=str(payment.id),
                workspace_id=payment.workspace_id,
                after=project("loan_payment", payment),
            ),
        )
        return payment

    async def update_payment(
        self,
        payment: LoanPayment,
        *,
        amount_minor: int | None = None,
        paid_on: date | None = None,
        note: object = UNSET,
        transaction_id: object = UNSET,
    ) -> LoanPayment:
        """Edit a payment and/or attach/detach its funding transaction. For
        transaction_id: UNSET leaves the link untouched, None clears (detaches)
        it, a uuid attaches (validated). Validate the link BEFORE mutating so a
        conflict/foreign tx never leaves the payment dirty."""
        if amount_minor is not None and amount_minor <= 0:
            raise NonPositivePaymentError()
        if transaction_id is not UNSET and transaction_id is not None:
            # The payment carries no currency of its own — the link must match
            # the parent loan's currency, so load it for the guard.
            loan = await get_scoped(self.db, Loan, payment.loan_id, payment.workspace_id)
            await self._validate_link(
                payment.workspace_id,
                transaction_id,  # type: ignore[arg-type]
                loan.currency,  # type: ignore[union-attr]
                exclude_payment_id=payment.id,
            )
        before = project("loan_payment", payment)
        if amount_minor is not None:
            payment.amount_minor = amount_minor
        if paid_on is not None:
            payment.paid_on = paid_on
        if note is not UNSET:
            payment.note = note  # type: ignore[assignment]
        if transaction_id is not UNSET:
            payment.transaction_id = transaction_id  # type: ignore[assignment]
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.LOAN_PAYMENT_UPDATED,
                resource_type="loan_payment",
                resource_id=str(payment.id),
                workspace_id=payment.workspace_id,
                before=before,
                after=project("loan_payment", payment),
            ),
        )
        return payment

    async def list_payments(
        self,
        loan: Loan,
        *,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[builtins.list[LoanPayment], str | None]:
        # Most-recent payment first — what the user just did is what they look
        # for. The id tiebreaker keeps a walk deterministic when several
        # payments share a paid_on (CONVENTIONS §6).
        stmt = (
            scoped_select(LoanPayment, loan.workspace_id)
            .where(LoanPayment.loan_id == loan.id)
            .order_by(LoanPayment.paid_on.desc(), LoanPayment.id.desc())
        )
        return await keyset_page(
            self.db,
            stmt,
            LoanPayment.paid_on,
            LoanPayment.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get_payment(
        self, workspace_id: uuid.UUID, payment_id: uuid.UUID
    ) -> LoanPayment | None:
        return await get_scoped(self.db, LoanPayment, payment_id, workspace_id)

    async def delete_payment(self, payment: LoanPayment) -> None:
        before = project("loan_payment", payment)
        await self.db.delete(payment)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.LOAN_PAYMENT_DELETED,
                resource_type="loan_payment",
                resource_id=str(payment.id),
                workspace_id=payment.workspace_id,
                before=before,
            ),
        )

    # ---- Paid / remaining (integer minor units, §4) ---------------------- #

    async def paid_total_minor(self, loan: Loan, *, on_date: date | None = None) -> int:
        """Σ of the loan's payment amounts (all, or only those with
        `paid_on <= on_date`). A plain int in minor units — never a float."""
        conds = [LoanPayment.loan_id == loan.id]
        if on_date is not None:
            conds.append(LoanPayment.paid_on <= on_date)
        total = await self.db.scalar(
            select(func.coalesce(func.sum(LoanPayment.amount_minor), 0)).where(*conds)
        )
        return int(total or 0)

    async def remaining_minor(self, loan: Loan, *, on_date: date | None = None) -> int:
        """`max(principal − paid_total, 0)` in minor units — the outstanding
        balance, floored at 0 so an overpaid loan never goes negative. `on_date`
        reconstructs the balance as of that date from the payment ledger."""
        paid = await self.paid_total_minor(loan, on_date=on_date)
        return max(loan.principal_minor - paid, 0)
