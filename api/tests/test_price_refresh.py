"""Task 3 (Track Q): `PriceRefreshService` — gathers auto-priceable holdings
(non-null `coingecko_id`), groups them by their *portfolio's* currency (never
cross-currency), calls the injected provider once per currency, and records a
`HoldingPrice` per resolved holding via the existing recording path. Always
uses `FakePriceProvider` — no real network call in this suite."""

import uuid
from datetime import date

import sqlalchemy as sa

from pecunia.models import Holding, HoldingPrice, Portfolio, WorkspaceMembership
from pecunia.services.prices.provider import FakePriceProvider
from pecunia.services.prices.refresh import PriceRefreshService

TODAY = date(2026, 9, 13)


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def _portfolio(db, ws_id, *, currency="USD", name="P"):
    portfolio = Portfolio(id=uuid.uuid4(), workspace_id=ws_id, name=name, currency=currency)
    db.add(portfolio)
    await db.flush()
    return portfolio


async def _holding(db, ws_id, portfolio, *, coingecko_id=None, name="H", quantity="1"):
    holding = Holding(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        portfolio_id=portfolio.id,
        name=name,
        quantity=quantity,
        coingecko_id=coingecko_id,
    )
    db.add(holding)
    await db.flush()
    return holding


async def test_refresh_groups_by_currency_one_call_each_and_never_crosses_currency(
    db, initialized_instance
):
    ws_id = await _ws_id(db, initialized_instance)
    usd_portfolio = await _portfolio(db, ws_id, currency="USD")
    eur_portfolio = await _portfolio(db, ws_id, currency="EUR")
    btc_usd = await _holding(db, ws_id, usd_portfolio, coingecko_id="bitcoin")
    eth_usd = await _holding(db, ws_id, usd_portfolio, coingecko_id="ethereum")
    btc_eur = await _holding(db, ws_id, eur_portfolio, coingecko_id="bitcoin")
    await db.commit()

    provider = FakePriceProvider(
        prices_by_currency={
            "USD": {"bitcoin": 6_500_000, "ethereum": 320_000},
            "EUR": {"bitcoin": 6_000_000},
        }
    )
    result = await PriceRefreshService(db, provider).refresh(ws_id, today=TODAY)
    await db.commit()

    assert result == {"updated": 3, "skipped": 0, "errors": []}
    assert len(provider.calls) == 2  # exactly one call per distinct currency
    calls_by_currency = {currency: ids for ids, currency in provider.calls}
    assert sorted(calls_by_currency["USD"]) == ["bitcoin", "ethereum"]
    assert calls_by_currency["EUR"] == ["bitcoin"]

    # Never cross-currency: the same coin id in two portfolios gets each
    # portfolio's own currency's price, not the other's.
    usd_price = await db.scalar(
        sa.select(HoldingPrice.unit_price_minor).where(HoldingPrice.holding_id == btc_usd.id)
    )
    eur_price = await db.scalar(
        sa.select(HoldingPrice.unit_price_minor).where(HoldingPrice.holding_id == btc_eur.id)
    )
    assert usd_price == 6_500_000
    assert eur_price == 6_000_000

    eth_row = await db.scalar(sa.select(HoldingPrice).where(HoldingPrice.holding_id == eth_usd.id))
    assert eth_row.unit_price_minor == 320_000
    assert eth_row.source == "coingecko"
    assert eth_row.as_of == TODAY


async def test_refresh_skips_a_holding_without_a_coingecko_id(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    portfolio = await _portfolio(db, ws_id)
    await _holding(db, ws_id, portfolio, coingecko_id="bitcoin")
    manual = await _holding(db, ws_id, portfolio, coingecko_id=None)
    await db.commit()

    provider = FakePriceProvider(prices_by_currency={"USD": {"bitcoin": 100}})
    result = await PriceRefreshService(db, provider).refresh(ws_id, today=TODAY)
    await db.commit()

    assert result["updated"] == 1
    # The manual holding was never even sent to the provider.
    assert provider.calls == [(["bitcoin"], "USD")]
    manual_price_count = await db.scalar(
        sa.select(sa.func.count())
        .select_from(HoldingPrice)
        .where(HoldingPrice.holding_id == manual.id)
    )
    assert manual_price_count == 0


async def test_refresh_skips_an_unknown_coin(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    portfolio = await _portfolio(db, ws_id)
    await _holding(db, ws_id, portfolio, coingecko_id="not-a-real-coin")
    await db.commit()

    provider = FakePriceProvider(prices_by_currency={"USD": {}})
    result = await PriceRefreshService(db, provider).refresh(ws_id, today=TODAY)

    assert result == {"updated": 0, "skipped": 1, "errors": []}


async def test_refresh_captures_a_provider_error_without_aborting_other_currencies(
    db, initialized_instance
):
    ws_id = await _ws_id(db, initialized_instance)
    usd_portfolio = await _portfolio(db, ws_id, currency="USD")
    eur_portfolio = await _portfolio(db, ws_id, currency="EUR")
    await _holding(db, ws_id, usd_portfolio, coingecko_id="bitcoin")
    await _holding(db, ws_id, eur_portfolio, coingecko_id="bitcoin")
    await db.commit()

    provider = FakePriceProvider(
        prices_by_currency={"EUR": {"bitcoin": 6_000_000}}, raise_for_currencies={"USD"}
    )
    result = await PriceRefreshService(db, provider).refresh(ws_id, today=TODAY)
    await db.commit()

    assert result["updated"] == 1
    assert result["skipped"] == 1
    assert len(result["errors"]) == 1
    assert "USD" in result["errors"][0]


async def test_refresh_with_no_auto_priceable_holdings_is_a_no_op(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    provider = FakePriceProvider()
    result = await PriceRefreshService(db, provider).refresh(ws_id, today=TODAY)
    assert result == {"updated": 0, "skipped": 0, "errors": []}
    assert provider.calls == []


async def test_refresh_is_workspace_scoped(db, initialized_instance, user_factory):
    """A holding in a different workspace is never touched, even if it also
    carries a coingecko_id."""
    from pecunia.models import Workspace
    from pecunia.models import WorkspaceMembership as WM

    ws_id = await _ws_id(db, initialized_instance)
    other_user = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WM(workspace_id=other_ws.id, user_id=other_user.id, role="owner"))
    other_portfolio = await _portfolio(db, other_ws.id)
    await _holding(db, other_ws.id, other_portfolio, coingecko_id="bitcoin")
    await db.commit()

    provider = FakePriceProvider(prices_by_currency={"USD": {"bitcoin": 100}})
    result = await PriceRefreshService(db, provider).refresh(ws_id, today=TODAY)

    assert result == {"updated": 0, "skipped": 0, "errors": []}
    assert provider.calls == []
