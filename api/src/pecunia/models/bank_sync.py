import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, Date, DateTime, Text, Uuid

from pecunia.models.base import Base


class BankConnectionStatus(StrEnum):
    OK = "ok"  # the last sync (or the initial link) succeeded
    ERROR = "error"  # the last sync attempt failed — see `last_error`


_STATUSES = "','".join(s.value for s in BankConnectionStatus)


class BankConnection(Base):
    """A linked Pluggy `item` — one per bank/institution login the workspace
    connected. `pluggy_item_id` is the provider's own id for this connection;
    `institution_name` is display-only (denormalized from Pluggy at link
    time, never re-derived). `status` mirrors the item's health as of the
    last sync attempt (ok|error); `last_error` carries a short provider-side
    message when `status='error'`, and `last_synced_at` is when a sync last
    completed (successfully or not). One connection fans out into any number
    of `BankAccountLink` rows (one per bank account the user chose to sync)."""

    __tablename__ = "bank_connections"
    __table_args__ = (
        CheckConstraint(f"status IN ('{_STATUSES}')", name="status_valid"),
        UniqueConstraint(
            "workspace_id", "pluggy_item_id", name="uq_bank_connections_workspace_id_pluggy_item_id"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    pluggy_item_id: Mapped[str] = mapped_column(Text, nullable=False)
    institution_name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'ok'"))
    last_error: Mapped[str | None] = mapped_column(Text)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)


class BankAccountLink(Base):
    """Ties one Pluggy provider account to exactly one Pecunia `Account`
    (`uq_bank_account_links_account_id` — an account is either fully manual
    or fully synced, never both) under a `BankConnection`. `pluggy_account_id`
    is the provider's id for this account and is unique per workspace
    (`uq_bank_account_links_workspace_id_pluggy_account_id`) — the dedupe key
    the sync uses to find-or-create this link when the user relinks the same
    account. `sync_from` bounds how far back transaction sync reaches (never
    re-imports everything on every run). The remaining columns are
    provider-reported figures the sync writes back for display —
    `provider_balance_minor`/`provider_balance_as_of` (the account's balance
    per the bank, as of when it was last reported) and, for credit cards,
    `credit_limit_minor`/`bill_close_date`/`bill_due_date` — all nullable
    (absent for non-card accounts, or before the first successful sync)."""

    __tablename__ = "bank_account_links"
    __table_args__ = (
        UniqueConstraint("account_id", name="uq_bank_account_links_account_id"),
        UniqueConstraint(
            "workspace_id",
            "pluggy_account_id",
            name="uq_bank_account_links_workspace_id_pluggy_account_id",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    connection_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("bank_connections.id", ondelete="CASCADE"), nullable=False, index=True
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    pluggy_account_id: Mapped[str] = mapped_column(Text, nullable=False)
    sync_from: Mapped[date] = mapped_column(Date, nullable=False)
    provider_balance_minor: Mapped[int | None] = mapped_column(BigInteger)
    provider_balance_as_of: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    credit_limit_minor: Mapped[int | None] = mapped_column(BigInteger)
    bill_close_date: Mapped[date | None] = mapped_column(Date)
    bill_due_date: Mapped[date | None] = mapped_column(Date)
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)


class BankCategoryMapping(Base):
    """A per-workspace mapping from a Pluggy-reported category string
    (`pluggy_category`, provider free text — not an enum) to one of the
    workspace's own `Category` rows. Sync uses this to auto-categorize an
    imported transaction; unmapped provider categories leave `category_id`
    unset on the transaction rather than guessing. `category_id` CASCADEs —
    deleting the category the mapping points to removes the mapping too
    (nothing left for it to resolve to). One mapping per provider category
    per workspace (`uq_bank_category_mappings_workspace_id_pluggy_category`)."""

    __tablename__ = "bank_category_mappings"
    __table_args__ = (
        UniqueConstraint(
            "workspace_id",
            "pluggy_category",
            name="uq_bank_category_mappings_workspace_id_pluggy_category",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    pluggy_category: Mapped[str] = mapped_column(Text, nullable=False)
    category_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
