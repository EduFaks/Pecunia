import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, String, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Date, DateTime, Text, Uuid

from pecunia.models.base import Base


class GoalSourceKind(StrEnum):
    ACCOUNT = "account"  # progress reads AccountService.balance
    PORTFOLIO = "portfolio"  # progress reads PortfolioService.portfolio_value_minor
    NET_WORTH = "net_worth"  # progress reads SnapshotService.net_worth_as_of
    MANUAL = "manual"  # progress is the user-entered manual_current_minor figure


_SOURCE_KINDS = "','".join(k.value for k in GoalSourceKind)


class Goal(Base):
    """A savings goal — a target amount (and optional target date) whose
    current progress is DERIVED from a chosen source rather than tracked via
    its own deposit/contribution ledger (v1.4 spec, Track S): an account's
    balance, a portfolio's market value, the workspace's net worth (as-of
    today, in `currency`), or a manually-entered figure
    (`manual_current_minor`). `source_id` is the referenced account/portfolio
    id for the `account`/`portfolio` kinds — deliberately NOT a foreign key
    (depending on `source_kind` it references one of two different tables, or
    neither); `GoalService` validates it resolves to a real row in the goal's
    own workspace. `currency` MUST equal the source's own currency for
    `account`/`portfolio` goals (CONVENTIONS §4 — never cross-currency;
    enforced in `GoalService`, not at the DB level — nothing here to CHECK
    against another table's row)."""

    __tablename__ = "goals"
    __table_args__ = (
        CheckConstraint(f"source_kind IN ('{_SOURCE_KINDS}')", name="source_kind_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    target_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    target_date: Mapped[date | None] = mapped_column(Date)
    source_kind: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'manual'")
    )
    source_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    manual_current_minor: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
