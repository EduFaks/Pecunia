import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, Date, DateTime, Text, Uuid

from pecunia.models.base import Base


class ScheduleFrequency(StrEnum):
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    YEARLY = "yearly"


_FREQUENCIES = "','".join(f.value for f in ScheduleFrequency)


class ScheduledTransaction(Base):
    """A recurring money rule — salary, rent, a subscription — the user knows
    is coming: an account, a signed amount, an optional category/contact, a
    frequency and the next date it is due. It is a *rule*, never a transaction:
    the user posts it (which creates a real Transaction and advances
    `next_due`) or skips it. No auto-posting (see services.scheduled_transactions,
    Task 2). `amount_minor` is signed, same convention as transactions
    (negative = expense, positive = income)."""

    __tablename__ = "scheduled_transactions"
    __table_args__ = (
        CheckConstraint(f"frequency IN ('{_FREQUENCIES}')", name="frequency_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), index=True
    )
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("contacts.id", ondelete="SET NULL"), index=True
    )
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    frequency: Mapped[str] = mapped_column(Text, nullable=False)
    interval_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    next_due: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date | None] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
