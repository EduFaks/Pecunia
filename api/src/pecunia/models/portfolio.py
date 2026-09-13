import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, ForeignKey, Numeric, String, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, DateTime, Text, Uuid

from pecunia.models.base import Base


class Portfolio(Base):
    """An investment account (a brokerage, a 401k) holding a set of Holdings.
    One currency per portfolio in V1 — its holdings inherit it (no separate
    currency on a holding). Mirrors the Asset aggregate; portfolio value is
    Σ over holdings of quantity × latest manually-recorded unit price."""

    __tablename__ = "portfolios"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)


class Holding(Base):
    """A position inside a Portfolio — a name/symbol plus a quantity. `quantity`
    is NOT money (it is a share/unit count, possibly fractional) so it is
    Numeric(28, 8), not integer minor units; money lives on HoldingPrice.
    Currency is inherited from the portfolio."""

    __tablename__ = "holdings"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    portfolio_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("portfolios.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    symbol: Mapped[str | None] = mapped_column(Text)
    quantity: Mapped[Decimal] = mapped_column(Numeric(28, 8), nullable=False)
    # Nullable — non-null makes the holding auto-priceable (Track Q): the
    # daily job / on-demand refresh look up this CoinGecko coin id and record
    # its price in the parent portfolio's currency. `symbol` stays free-text
    # display-only; this is the unambiguous provider key.
    coingecko_id: Mapped[str | None] = mapped_column(Text)
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)


class HoldingPrice(Base):
    """A manually-recorded unit price for a Holding, as-of a date — the price
    history that lets portfolio value participate in net-worth-over-time.
    Mirrors AssetValuation exactly (append-only history, no updated_at)."""

    __tablename__ = "holding_prices"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    holding_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("holdings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    unit_price_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    as_of: Mapped[date] = mapped_column(Date, nullable=False)
    source: Mapped[str | None] = mapped_column(Text)
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
