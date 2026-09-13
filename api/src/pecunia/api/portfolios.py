import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.portfolio import Holding, HoldingPrice, Portfolio
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.portfolios import UNSET, PortfolioService
from pecunia.services.prices.provider import (
    CoinGeckoPriceProvider,
    CryptoPriceProvider,
    filter_coins,
)
from pecunia.services.prices.refresh import PriceRefreshService

router = APIRouter(
    prefix="/portfolios", tags=["portfolios"], dependencies=[Depends(require_initialized)]
)

# quantity is a share/unit count (fractional), NOT money — a Numeric(28, 8)
# mirror of the column, so a value that would overflow the column fails
# validation (422) rather than at the DB (500).
QuantityDecimal = Annotated[Decimal, Field(max_digits=28, decimal_places=8)]


class PortfolioIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    currency: CurrencyStr
    description: str | None = None


class PortfolioUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    currency: CurrencyStr | None = None
    description: str | None = None


class PortfolioOut(BaseModel):
    id: uuid.UUID
    name: str
    currency: str
    description: str | None
    is_demo: bool
    created_at: datetime
    value_minor: int
    holding_count: int

    @classmethod
    def from_model(cls, portfolio: Portfolio, *, value_minor: int, holding_count: int) -> "PortfolioOut":
        return cls(
            id=portfolio.id,
            name=portfolio.name,
            currency=portfolio.currency,
            description=portfolio.description,
            is_demo=portfolio.is_demo,
            created_at=portfolio.created_at,
            value_minor=value_minor,
            holding_count=holding_count,
        )


class PortfolioPage(BaseModel):
    items: list[PortfolioOut]
    next_cursor: str | None


class HoldingIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    quantity: QuantityDecimal
    symbol: str | None = Field(default=None, max_length=32)
    # Non-null makes the holding auto-priceable (Track Q): the CoinGecko coin
    # id (e.g. "bitcoin"), picked via GET /portfolios/coins.
    coingecko_id: str | None = Field(default=None, max_length=200)


class HoldingUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    quantity: QuantityDecimal | None = None
    symbol: str | None = Field(default=None, max_length=32)
    coingecko_id: str | None = Field(default=None, max_length=200)


class HoldingOut(BaseModel):
    id: uuid.UUID
    portfolio_id: uuid.UUID
    name: str
    symbol: str | None
    quantity: str
    coingecko_id: str | None
    latest_unit_price_minor: int | None
    # Provenance of the latest price — null until a price has ever been
    # recorded. `source="coingecko"` for an automated refresh, whatever the
    # user typed (or None) for a manual `POST .../prices`.
    latest_price_source: str | None
    latest_price_as_of: date | None
    value_minor: int
    is_demo: bool
    created_at: datetime

    @classmethod
    def from_model(
        cls,
        holding: Holding,
        *,
        latest_unit_price_minor: int | None,
        latest_price_source: str | None,
        latest_price_as_of: date | None,
        value_minor: int,
    ) -> "HoldingOut":
        return cls(
            id=holding.id,
            portfolio_id=holding.portfolio_id,
            name=holding.name,
            symbol=holding.symbol,
            quantity=str(holding.quantity),
            coingecko_id=holding.coingecko_id,
            latest_unit_price_minor=latest_unit_price_minor,
            latest_price_source=latest_price_source,
            latest_price_as_of=latest_price_as_of,
            value_minor=value_minor,
            is_demo=holding.is_demo,
            created_at=holding.created_at,
        )


class HoldingPage(BaseModel):
    items: list[HoldingOut]
    next_cursor: str | None


class HoldingPriceIn(BaseModel):
    unit_price_minor: MinorInt
    as_of: date
    source: str | None = None


class HoldingPriceOut(BaseModel):
    id: uuid.UUID
    holding_id: uuid.UUID
    unit_price_minor: int
    as_of: date
    source: str | None
    is_demo: bool
    created_at: datetime

    @classmethod
    def from_model(cls, price: HoldingPrice) -> "HoldingPriceOut":
        return cls(
            id=price.id,
            holding_id=price.holding_id,
            unit_price_minor=price.unit_price_minor,
            as_of=price.as_of,
            source=price.source,
            is_demo=price.is_demo,
            created_at=price.created_at,
        )


async def _get_or_404(
    svc: PortfolioService, workspace_id: uuid.UUID, portfolio_id: uuid.UUID
) -> Portfolio:
    portfolio = await svc.get(workspace_id, portfolio_id)
    if portfolio is None:
        raise HTTPException(status_code=404, detail="PORTFOLIO_NOT_FOUND")
    return portfolio


async def _get_holding_or_404(
    svc: PortfolioService,
    workspace_id: uuid.UUID,
    portfolio_id: uuid.UUID,
    holding_id: uuid.UUID,
) -> Holding:
    holding = await svc.get_holding(workspace_id, holding_id)
    if holding is None or holding.portfolio_id != portfolio_id:
        raise HTTPException(status_code=404, detail="HOLDING_NOT_FOUND")
    return holding


async def _portfolio_out(svc: PortfolioService, portfolio: Portfolio) -> PortfolioOut:
    return PortfolioOut.from_model(
        portfolio,
        value_minor=await svc.portfolio_value_minor(portfolio),
        holding_count=await svc.holding_count(portfolio),
    )


async def _holding_out(svc: PortfolioService, holding: Holding) -> HoldingOut:
    price = await svc.latest_price(holding)
    return HoldingOut.from_model(
        holding,
        latest_unit_price_minor=price.unit_price_minor if price else None,
        latest_price_source=price.source if price else None,
        latest_price_as_of=price.as_of if price else None,
        value_minor=await svc.holding_value_minor(holding),
    )


def get_price_provider(request: Request) -> CryptoPriceProvider:
    """One `CoinGeckoPriceProvider` per app instance, lazily created and
    cached on `app.state` (mirrors `deps.session_cache`) — so its `coins()`
    memoization (Task 4) actually spans requests instead of being rebuilt
    (and re-fetching) on every call. Tests override this dependency with a
    `FakePriceProvider` — this is the only place the real provider is ever
    constructed for a request."""
    provider = getattr(request.app.state, "price_provider", None)
    if provider is None:
        provider = CoinGeckoPriceProvider()
        request.app.state.price_provider = provider
    return provider


# ---- Portfolio CRUD ------------------------------------------------------- #


@router.post("", status_code=201)
async def create_portfolio(
    body: PortfolioIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> PortfolioOut:
    svc = PortfolioService(db)
    portfolio = await svc.create(
        wsctx.workspace_id, name=body.name, currency=body.currency, description=body.description
    )
    await db.commit()
    return await _portfolio_out(svc, portfolio)


@router.get("")
async def list_portfolios(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> PortfolioPage:
    svc = PortfolioService(db)
    items, next_cursor = await svc.list(wsctx.workspace_id, cursor=cursor, limit=limit)
    return PortfolioPage(
        items=[await _portfolio_out(svc, p) for p in items], next_cursor=next_cursor
    )


class RefreshPricesOut(BaseModel):
    updated: int
    skipped: int
    errors: list[str]


class CoinOut(BaseModel):
    id: str
    symbol: str
    name: str


# ---- Crypto price sync (Track Q) ------------------------------------------ #
#
# Registered before the `/{portfolio_id}` routes below — Starlette matches
# routes by path *structure*, not parameter type, so a literal one-segment
# path like this one must be declared ahead of `/{portfolio_id}` or it would
# be swallowed by it (portfolio_id="refresh-prices"/"coins" would fail UUID
# validation with a 422 instead of ever reaching this handler).


@router.post("/refresh-prices")
async def refresh_prices(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    provider: Annotated[CryptoPriceProvider, Depends(get_price_provider)],
) -> RefreshPricesOut:
    result = await PriceRefreshService(db, provider).refresh(
        wsctx.workspace_id, today=datetime.now(UTC).date()
    )
    await db.commit()
    return RefreshPricesOut(**result)


@router.get("/coins")
async def search_coins(
    provider: Annotated[CryptoPriceProvider, Depends(get_price_provider)],
    # require_workspace (not just require_initialized) gates this behind auth
    # like every other portfolios route, even though it reads nothing
    # workspace-scoped — the picker is only ever shown to a logged-in user.
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    q: str | None = None,
) -> list[CoinOut]:
    coins = await provider.coins()
    return [CoinOut(**coin) for coin in filter_coins(coins, q)]


@router.get("/{portfolio_id}")
async def get_portfolio(
    portfolio_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> PortfolioOut:
    svc = PortfolioService(db)
    portfolio = await _get_or_404(svc, wsctx.workspace_id, portfolio_id)
    return await _portfolio_out(svc, portfolio)


@router.patch("/{portfolio_id}")
async def update_portfolio(
    portfolio_id: uuid.UUID,
    body: PortfolioUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> PortfolioOut:
    svc = PortfolioService(db)
    portfolio = await _get_or_404(svc, wsctx.workspace_id, portfolio_id)
    fields = body.model_dump(exclude_unset=True)
    portfolio = await svc.update(
        portfolio,
        name=fields.get("name"),
        currency=fields.get("currency"),
        description=fields.get("description", UNSET),
    )
    await db.commit()
    return await _portfolio_out(svc, portfolio)


@router.delete("/{portfolio_id}", status_code=204)
async def delete_portfolio(
    portfolio_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = PortfolioService(db)
    portfolio = await _get_or_404(svc, wsctx.workspace_id, portfolio_id)
    await svc.delete(portfolio)
    await db.commit()


# ---- Holding CRUD (nested) ------------------------------------------------ #


@router.post("/{portfolio_id}/holdings", status_code=201)
async def add_holding(
    portfolio_id: uuid.UUID,
    body: HoldingIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> HoldingOut:
    svc = PortfolioService(db)
    portfolio = await _get_or_404(svc, wsctx.workspace_id, portfolio_id)
    holding = await svc.add_holding(
        portfolio,
        name=body.name,
        quantity=body.quantity,
        symbol=body.symbol,
        coingecko_id=body.coingecko_id,
    )
    await db.commit()
    return await _holding_out(svc, holding)


@router.get("/{portfolio_id}/holdings")
async def list_holdings(
    portfolio_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> HoldingPage:
    svc = PortfolioService(db)
    portfolio = await _get_or_404(svc, wsctx.workspace_id, portfolio_id)
    items, next_cursor = await svc.list_holdings(portfolio, cursor=cursor, limit=limit)
    return HoldingPage(items=[await _holding_out(svc, h) for h in items], next_cursor=next_cursor)


@router.get("/{portfolio_id}/holdings/{holding_id}")
async def get_holding(
    portfolio_id: uuid.UUID,
    holding_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> HoldingOut:
    svc = PortfolioService(db)
    await _get_or_404(svc, wsctx.workspace_id, portfolio_id)
    holding = await _get_holding_or_404(svc, wsctx.workspace_id, portfolio_id, holding_id)
    return await _holding_out(svc, holding)


@router.patch("/{portfolio_id}/holdings/{holding_id}")
async def update_holding(
    portfolio_id: uuid.UUID,
    holding_id: uuid.UUID,
    body: HoldingUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> HoldingOut:
    svc = PortfolioService(db)
    await _get_or_404(svc, wsctx.workspace_id, portfolio_id)
    holding = await _get_holding_or_404(svc, wsctx.workspace_id, portfolio_id, holding_id)
    fields = body.model_dump(exclude_unset=True)
    holding = await svc.update_holding(
        holding,
        name=fields.get("name"),
        quantity=fields.get("quantity"),
        symbol=fields.get("symbol", UNSET),
        coingecko_id=fields.get("coingecko_id", UNSET),
    )
    await db.commit()
    return await _holding_out(svc, holding)


@router.delete("/{portfolio_id}/holdings/{holding_id}", status_code=204)
async def delete_holding(
    portfolio_id: uuid.UUID,
    holding_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = PortfolioService(db)
    await _get_or_404(svc, wsctx.workspace_id, portfolio_id)
    holding = await _get_holding_or_404(svc, wsctx.workspace_id, portfolio_id, holding_id)
    await svc.delete_holding(holding)
    await db.commit()


# ---- Prices --------------------------------------------------------------- #


@router.post("/{portfolio_id}/holdings/{holding_id}/prices", status_code=201)
async def record_holding_price(
    portfolio_id: uuid.UUID,
    holding_id: uuid.UUID,
    body: HoldingPriceIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> HoldingPriceOut:
    svc = PortfolioService(db)
    await _get_or_404(svc, wsctx.workspace_id, portfolio_id)
    holding = await _get_holding_or_404(svc, wsctx.workspace_id, portfolio_id, holding_id)
    price = await svc.record_price(
        holding, unit_price_minor=body.unit_price_minor, as_of=body.as_of, source=body.source
    )
    await db.commit()
    return HoldingPriceOut.from_model(price)
