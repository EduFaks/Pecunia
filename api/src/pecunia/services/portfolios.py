import builtins
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.portfolio import Holding, HoldingPrice, Portfolio
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select

# Sentinel distinguishing "field absent from the PATCH body" from "field
# explicitly set to null" for the nullable description/symbol/source columns.
UNSET = object()


class PortfolioService:
    """Portfolio + holding + holding-price business logic. Mirrors the
    Asset/AssetValuation aggregate: a portfolio is an investment account, a
    holding is a position inside it (a Numeric share/unit quantity — NOT money),
    and each holding's manually-recorded unit price is a HoldingPrice with
    as-of history. Market value = round(quantity x latest unit price), computed
    with Decimal and never a float (CONVENTIONS §4).

    Contract: methods flush, never commit — the caller (router) owns the
    transaction boundary (§2). Clock-free: valuation dates are passed in (§4);
    `on_date=None` means "the latest price, whatever its date" (the current
    value), not "today read from the clock"."""

    def __init__(self, db: AsyncSession):
        self.db = db

    # ---- Portfolio CRUD --------------------------------------------------- #

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        name: str,
        currency: str,
        description: str | None = None,
    ) -> Portfolio:
        portfolio = Portfolio(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            currency=currency,
            description=description,
        )
        self.db.add(portfolio)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.PORTFOLIO_CREATED,
                resource_type="portfolio",
                resource_id=str(portfolio.id),
                workspace_id=workspace_id,
                after=project("portfolio", portfolio),
                activity_template=Activity.PORTFOLIO_CREATED,
                activity_params={"name": portfolio.name, "currency": portfolio.currency},
            ),
        )
        return portfolio

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[builtins.list[Portfolio], str | None]:
        # UUID primary keys carry no order — paginate newest-first on
        # created_at, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = scoped_select(Portfolio, workspace_id).order_by(
            Portfolio.created_at.desc(), Portfolio.id.desc()
        )
        return await keyset_page(
            self.db,
            stmt,
            Portfolio.created_at,
            Portfolio.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(
        self, workspace_id: uuid.UUID, portfolio_id: uuid.UUID
    ) -> Portfolio | None:
        return await get_scoped(self.db, Portfolio, portfolio_id, workspace_id)

    async def update(
        self,
        portfolio: Portfolio,
        *,
        name: str | None = None,
        currency: str | None = None,
        description: object = UNSET,
    ) -> Portfolio:
        before = project("portfolio", portfolio)
        if name is not None:
            portfolio.name = name
        if currency is not None:
            portfolio.currency = currency
        if description is not UNSET:
            portfolio.description = description  # type: ignore[assignment]
        portfolio.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.PORTFOLIO_UPDATED,
                resource_type="portfolio",
                resource_id=str(portfolio.id),
                workspace_id=portfolio.workspace_id,
                before=before,
                after=project("portfolio", portfolio),
            ),
        )
        return portfolio

    async def delete(self, portfolio: Portfolio) -> None:
        """Hard delete: holdings and their prices cascade at the DB level via
        their FK ondelete=CASCADE."""
        before = project("portfolio", portfolio)
        await self.db.delete(portfolio)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.PORTFOLIO_DELETED,
                resource_type="portfolio",
                resource_id=str(portfolio.id),
                workspace_id=portfolio.workspace_id,
                before=before,
            ),
        )

    # ---- Holding CRUD (scoped to a portfolio) ----------------------------- #

    async def add_holding(
        self,
        portfolio: Portfolio,
        *,
        name: str,
        quantity: Decimal,
        symbol: str | None = None,
    ) -> Holding:
        holding = Holding(
            id=uuid.uuid4(),
            workspace_id=portfolio.workspace_id,
            portfolio_id=portfolio.id,
            name=name,
            symbol=symbol,
            quantity=quantity,
        )
        self.db.add(holding)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.HOLDING_CREATED,
                resource_type="holding",
                resource_id=str(holding.id),
                workspace_id=holding.workspace_id,
                after=project("holding", holding),
            ),
        )
        return holding

    async def list_holdings(
        self,
        portfolio: Portfolio,
        *,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[builtins.list[Holding], str | None]:
        stmt = (
            scoped_select(Holding, portfolio.workspace_id)
            .where(Holding.portfolio_id == portfolio.id)
            .order_by(Holding.created_at.desc(), Holding.id.desc())
        )
        return await keyset_page(
            self.db,
            stmt,
            Holding.created_at,
            Holding.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get_holding(
        self, workspace_id: uuid.UUID, holding_id: uuid.UUID
    ) -> Holding | None:
        return await get_scoped(self.db, Holding, holding_id, workspace_id)

    async def update_holding(
        self,
        holding: Holding,
        *,
        name: str | None = None,
        quantity: Decimal | None = None,
        symbol: object = UNSET,
    ) -> Holding:
        before = project("holding", holding)
        if name is not None:
            holding.name = name
        if quantity is not None:
            holding.quantity = quantity
        if symbol is not UNSET:
            holding.symbol = symbol  # type: ignore[assignment]
        holding.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.HOLDING_UPDATED,
                resource_type="holding",
                resource_id=str(holding.id),
                workspace_id=holding.workspace_id,
                before=before,
                after=project("holding", holding),
            ),
        )
        return holding

    async def delete_holding(self, holding: Holding) -> None:
        """Hard delete: holding_prices cascade at the DB level via their FK
        ondelete=CASCADE."""
        before = project("holding", holding)
        await self.db.delete(holding)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.HOLDING_DELETED,
                resource_type="holding",
                resource_id=str(holding.id),
                workspace_id=holding.workspace_id,
                before=before,
            ),
        )

    # ---- Prices + valuation ---------------------------------------------- #

    async def latest_unit_price(
        self, holding: Holding, *, on_date: date | None = None
    ) -> int | None:
        """The most recent unit price for `holding` — the latest overall when
        `on_date` is None, or the latest with `as_of <= on_date` otherwise.
        Tiebreakers (as_of, created_at, id) desc mirror the current-value rule
        (CONVENTIONS §6)."""
        conds = [HoldingPrice.holding_id == holding.id]
        if on_date is not None:
            conds.append(HoldingPrice.as_of <= on_date)
        return await self.db.scalar(
            select(HoldingPrice.unit_price_minor)
            .where(*conds)
            .order_by(
                HoldingPrice.as_of.desc(),
                HoldingPrice.created_at.desc(),
                HoldingPrice.id.desc(),
            )
            .limit(1)
        )

    async def record_price(
        self,
        holding: Holding,
        *,
        unit_price_minor: int,
        as_of: date,
        source: str | None = None,
    ) -> HoldingPrice:
        previous = await self.latest_unit_price(holding)
        price = HoldingPrice(
            id=uuid.uuid4(),
            workspace_id=holding.workspace_id,
            holding_id=holding.id,
            unit_price_minor=unit_price_minor,
            as_of=as_of,
            source=source,
        )
        self.db.add(price)
        await self.db.flush()
        # The new row isn't necessarily the new current price (it may be a
        # backfilled price with an earlier as_of) — recompute and only announce
        # a change when the current unit price actually moved.
        new_current = await self.latest_unit_price(holding)
        changed = previous is not None and new_current != previous
        currency = None
        if changed:
            currency = await self.db.scalar(
                select(Portfolio.currency).where(Portfolio.id == holding.portfolio_id)
            )
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.HOLDING_PRICE_RECORDED,
                resource_type="holding_price",
                resource_id=str(price.id),
                workspace_id=holding.workspace_id,
                after=project("holding_price", price),
                activity_template=Activity.HOLDING_PRICE_CHANGED if changed else None,
                activity_params={
                    "holding": holding.name,
                    "from": previous,
                    "to": new_current,
                    "currency": currency,
                }
                if changed
                else None,
            ),
        )
        return price

    async def holding_value_minor(
        self, holding: Holding, *, on_date: date | None = None
    ) -> int:
        """Market value of one holding in minor units: `round(quantity x latest
        unit price)`. Uses Decimal math and Python `round()` to a plain int —
        never a float (CONVENTIONS §4). 0 when the holding has no qualifying
        price."""
        price = await self.latest_unit_price(holding, on_date=on_date)
        if price is None:
            return 0
        # round() on a Decimal returns a plain int (never a float) — the money
        # rule (CONVENTIONS §4). quantity is a Numeric/Decimal, price an int.
        return round(holding.quantity * Decimal(price))

    async def portfolio_value_minor(
        self, portfolio: Portfolio, *, on_date: date | None = None
    ) -> int:
        """Σ of the portfolio's holding values (each rounded independently).
        One currency per portfolio, so this single figure needs no per-currency
        split."""
        holdings = (
            (
                await self.db.execute(
                    scoped_select(Holding, portfolio.workspace_id).where(
                        Holding.portfolio_id == portfolio.id
                    )
                )
            )
            .scalars()
            .all()
        )
        total = 0
        for holding in holdings:
            total += await self.holding_value_minor(holding, on_date=on_date)
        return total

    async def holding_count(self, portfolio: Portfolio) -> int:
        return (
            await self.db.scalar(
                select(func.count())
                .select_from(Holding)
                .where(
                    Holding.workspace_id == portfolio.workspace_id,
                    Holding.portfolio_id == portfolio.id,
                )
            )
        ) or 0
