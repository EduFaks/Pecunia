import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, Date, DateTime, Text, Uuid

from pecunia.models.base import Base


class LoanDirection(StrEnum):
    BORROWED = "borrowed"  # you owe — a liability
    LENT = "lent"  # owed to you — a receivable


_DIRECTIONS = "','".join(d.value for d in LoanDirection)
# payment_frequency is nullable (a loan may have no set schedule), so the CHECK
# guards the value only when present — NULL is always allowed (see 0013).
_FREQUENCIES = "','".join(f for f in ("weekly", "monthly", "quarterly", "yearly"))


class Loan(Base):
    """A loan — a real liability if `direction` is borrowed (you owe) or a
    receivable if lent (owed to you). Tracks the `principal` (original amount),
    an optional planned payment (how much / how often / next due) and an
    optional interest rate for DISPLAY only (V1 does not amortize — remaining
    is principal − Σ payments, reconstructed from the LoanPayment ledger). Its
    remaining balance rolls into net worth per currency (borrowed subtracts,
    lent adds). Money is integer minor units; `interest_rate_bps` is basis
    points. Optionally links to a `contact` (the lender/lendee) — ON DELETE
    SET NULL, so removing the contact never deletes or blocks the loan.
    Mirrors the Portfolio aggregate (parent + child ledger)."""

    __tablename__ = "loans"
    __table_args__ = (
        CheckConstraint(f"direction IN ('{_DIRECTIONS}')", name="direction_valid"),
        CheckConstraint(
            f"payment_frequency IS NULL OR payment_frequency IN ('{_FREQUENCIES}')",
            name="payment_frequency_valid",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'borrowed'")
    )
    principal_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    interest_rate_bps: Mapped[int | None] = mapped_column(Integer)
    planned_payment_minor: Mapped[int | None] = mapped_column(BigInteger)
    payment_frequency: Mapped[str | None] = mapped_column(Text)
    next_due: Mapped[date | None] = mapped_column(Date)
    opened_on: Mapped[date | None] = mapped_column(Date)
    description: Mapped[str | None] = mapped_column(Text)
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("contacts.id", ondelete="SET NULL"), index=True
    )
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)


class LoanPayment(Base):
    """A single payment made against a Loan — the ledger that reconstructs the
    remaining balance by date (remaining as-of a date = principal − Σ payments
    with paid_on ≤ date). `amount_minor` is a positive payment magnitude (money,
    integer minor units). A payment CASCADEs from its loan (and, like every
    domain row, from the workspace — spec D7). Append-only-ish leaf: nothing
    references it, so it has no updated_at. Optionally links to the real account
    `transaction` that funded it (SET NULL on tx delete; the payment survives,
    the loan's remaining is unchanged), unique so a transaction funds at most one
    payment — mirrors project_items.transaction_id."""

    __tablename__ = "loan_payments"
    __table_args__ = (
        # A transaction funds at most one loan payment. Postgres treats NULLs as
        # distinct in a UNIQUE, so this blocks a tx funding two payments while
        # still allowing any number of unlinked (NULL) payments.
        UniqueConstraint("transaction_id", name="uq_loan_payments_transaction_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    loan_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("loans.id", ondelete="CASCADE"), nullable=False, index=True
    )
    transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="SET NULL"), index=True
    )
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    paid_on: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
