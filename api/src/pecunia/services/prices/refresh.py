import uuid
from collections import defaultdict
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.models.portfolio import Holding, Portfolio
from pecunia.services.portfolios import PortfolioService
from pecunia.services.prices.provider import CryptoPriceProvider, PriceProviderError
from pecunia.services.scoping import scoped_select


class PriceRefreshService:
    """Refreshes every auto-priceable holding (non-null `coingecko_id`) in a
    workspace from an injected `CryptoPriceProvider`. Groups holdings by
    their *portfolio's* currency — a price is always in the parent
    portfolio's currency, never cross-currency (CONVENTIONS §4) — so a coin
    held in two portfolios with different currencies gets one provider call
    each, never a shared price. Reuses `PortfolioService.record_price` for
    the actual write, so net-worth/analytics invalidation is unchanged.

    Contract: flushes, never commits — the caller (router, or the daily
    scheduler) owns the transaction boundary. Clock-free: `today` is passed
    in, never read from the clock here."""

    def __init__(self, db: AsyncSession, provider: CryptoPriceProvider):
        self.db = db
        self.provider = provider

    async def refresh(self, workspace_id: uuid.UUID, *, today: date) -> dict[str, object]:
        holdings = (
            (
                await self.db.execute(
                    scoped_select(Holding, workspace_id).where(Holding.coingecko_id.is_not(None))
                )
            )
            .scalars()
            .all()
        )
        if not holdings:
            return {"updated": 0, "skipped": 0, "errors": []}

        portfolio_ids = {holding.portfolio_id for holding in holdings}
        portfolios = (
            (
                await self.db.execute(
                    scoped_select(Portfolio, workspace_id).where(Portfolio.id.in_(portfolio_ids))
                )
            )
            .scalars()
            .all()
        )
        currency_by_portfolio = {p.id: p.currency for p in portfolios}

        by_currency: dict[str, list[Holding]] = defaultdict(list)
        for holding in holdings:
            currency = currency_by_portfolio.get(holding.portfolio_id)
            if currency is not None:
                by_currency[currency].append(holding)

        portfolio_svc = PortfolioService(self.db)
        updated = 0
        skipped = 0
        errors: list[str] = []
        for currency, currency_holdings in by_currency.items():
            ids = [holding.coingecko_id for holding in currency_holdings]
            try:
                prices = await self.provider.prices(ids, currency)
            except PriceProviderError as exc:
                errors.append(f"{currency}: {exc}")
                skipped += len(currency_holdings)
                continue
            for holding in currency_holdings:
                unit_price_minor = prices.get(holding.coingecko_id)
                if unit_price_minor is None:
                    skipped += 1
                    continue
                await portfolio_svc.record_price(
                    holding, unit_price_minor=unit_price_minor, as_of=today, source="coingecko"
                )
                updated += 1

        return {"updated": updated, "skipped": skipped, "errors": errors}
