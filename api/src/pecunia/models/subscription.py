import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, String, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, Date, DateTime, Text, Uuid

from pecunia.models.base import Base


class SubscriptionStatus(StrEnum):
    ACTIVE = "active"  # a live subscription you are paying for
    CANCELED = "canceled"  # no longer billed — kept for history


_STATUSES = "','".join(s.value for s in SubscriptionStatus)
# Reuses the finance frequency vocabulary (scheduled/loans): a subscription
# always has a set billing cycle, so the CHECK is unconditional (never NULL).
_FREQUENCIES = "','".join(f for f in ("weekly", "monthly", "quarterly", "yearly"))


class Subscription(Base):
    """A recurring service you pay for — a registry entry, not an auto-poster.
    Carries a `name`, an optional `logo` (a size-capped base64 data-URI, same
    rules as contact `avatar` — validated in the service, excluded from the
    audit allowlist), the `amount_minor` + `currency` it costs, a
    `billing_frequency` and the `next_renewal` date. Optional links tie it to
    the billing `contact` (vendor), the `account` it hits and a `category`
    (each ON DELETE SET NULL — dropping one never destroys the subscription).
    `status` is active|canceled. Planned remains the thing that posts recurring
    transactions; a subscription's "renew" only advances `next_renewal`. Money
    is integer minor units. Mirrors the finance pattern (workspace-scoped +
    is_demo)."""

    __tablename__ = "subscriptions"
    __table_args__ = (
        CheckConstraint(f"status IN ('{_STATUSES}')", name="status_valid"),
        CheckConstraint(
            f"billing_frequency IN ('{_FREQUENCIES}')", name="billing_frequency_valid"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # A base64 data-URI image (data:image/(png|jpeg|webp);base64,…), capped ~64KB
    # and validated in SubscriptionService. Excluded from the audit allowlist
    # (bulky, non-sensitive). Nullable — a subscription renders a monogram
    # fallback when absent, same as contact avatar.
    logo: Mapped[str | None] = mapped_column(Text)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    billing_frequency: Mapped[str] = mapped_column(Text, nullable=False)
    next_renewal: Mapped[date] = mapped_column(Date, nullable=False)
    started_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'"))
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("contacts.id", ondelete="SET NULL"), index=True
    )
    account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), index=True
    )
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), index=True
    )
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
