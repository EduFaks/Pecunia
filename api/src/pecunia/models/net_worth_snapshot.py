import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, ForeignKey, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, Date, DateTime, Uuid

from pecunia.models.base import Base


class NetWorthSnapshot(Base):
    """A persisted per-currency net-worth figure for a workspace on a given
    day. One row per (workspace_id, currency, captured_on) — captured
    idempotently so a repeated capture updates the figure rather than
    duplicating it. Reconstructed from account balances + asset valuations as
    of the captured date (see services.snapshots.SnapshotService)."""

    __tablename__ = "net_worth_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "workspace_id", "currency", "captured_on",
            name="uq_net_worth_snapshots_workspace_id_currency_captured_on",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    captured_on: Mapped[date] = mapped_column(Date, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    net_worth_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
