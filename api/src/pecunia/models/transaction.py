import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, ForeignKey, Index, String, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, Date, DateTime, Text, Uuid

from pecunia.models.base import Base


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        # A synced transaction's dedupe key (Track T — bank sync): `external_id`
        # is the provider's own transaction id, set only for rows created by
        # the sync. Partial (`WHERE external_id IS NOT NULL`) so any number of
        # ordinary manual transactions (external_id NULL) coexist per account —
        # only a duplicate non-null pair is rejected.
        Index(
            "uq_transactions_account_id_external_id",
            "account_id",
            "external_id",
            unique=True,
            postgresql_where=text("external_id IS NOT NULL"),
        ),
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
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), index=True
    )
    # A set transfer_id marks this row as one leg of a transfer. CASCADE (not
    # SET NULL like the other tx FKs): a leg has no life without its transfer,
    # so deleting the transfer removes both legs.
    transfer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("transfers.id", ondelete="CASCADE"), index=True
    )
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The provider's own transaction id (Track T — bank sync) — set only for
    # rows the sync created; NULL for manual/transfer-leg transactions. See
    # `uq_transactions_account_id_external_id` above for the dedupe rule.
    external_id: Mapped[str | None] = mapped_column(Text)
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
