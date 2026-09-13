"""Task 2 (Track Q): `CryptoPriceProvider` protocol, its `CoinGeckoPriceProvider`
implementation, and `FakePriceProvider`. `CoinGeckoPriceProvider`'s tests mock
the httpx transport — no real network call ever runs in this suite
(CONVENTIONS: the provider is injected everywhere else so callers pass a
fake)."""

import httpx
import pytest

from pecunia.services.prices.provider import (
    COINGECKO_BASE_URL,
    CoinGeckoPriceProvider,
    FakePriceProvider,
    PriceProviderError,
)


def _mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url=COINGECKO_BASE_URL)


# --------------------------------------------------------------------------- #
# CoinGeckoPriceProvider.prices()
# --------------------------------------------------------------------------- #


async def test_prices_parses_simple_price_body_into_minor_units():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v3/simple/price"
        assert dict(request.url.params) == {"ids": "bitcoin,ethereum", "vs_currencies": "usd"}
        return httpx.Response(
            200, json={"bitcoin": {"usd": 65000.5}, "ethereum": {"usd": 3200.12}}
        )

    provider = CoinGeckoPriceProvider(client=_mock_client(handler))
    result = await provider.prices(["bitcoin", "ethereum"], "USD")
    assert result == {"bitcoin": 6_500_050, "ethereum": 320_012}


async def test_prices_omits_an_id_coingecko_has_no_data_for():
    def handler(request: httpx.Request) -> httpx.Response:
        # CoinGecko itself simply drops an id it doesn't recognize.
        return httpx.Response(200, json={"bitcoin": {"usd": 100.0}})

    provider = CoinGeckoPriceProvider(client=_mock_client(handler))
    result = await provider.prices(["bitcoin", "not-a-real-coin"], "USD")
    assert result == {"bitcoin": 10_000}
    assert "not-a-real-coin" not in result


async def test_prices_zero_decimal_currency_uses_factor_one():
    def handler(request: httpx.Request) -> httpx.Response:
        assert dict(request.url.params)["vs_currencies"] == "jpy"
        return httpx.Response(200, json={"bitcoin": {"jpy": 9_000_000}})

    provider = CoinGeckoPriceProvider(client=_mock_client(handler))
    result = await provider.prices(["bitcoin"], "JPY")
    assert result == {"bitcoin": 9_000_000}


async def test_prices_empty_ids_returns_empty_without_a_call():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("should never be called with an empty id list")

    provider = CoinGeckoPriceProvider(client=_mock_client(handler))
    assert await provider.prices([], "USD") == {}


async def test_http_error_status_raises_price_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "rate limited"})

    provider = CoinGeckoPriceProvider(client=_mock_client(handler))
    with pytest.raises(PriceProviderError):
        await provider.prices(["bitcoin"], "USD")


async def test_timeout_raises_price_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out", request=request)

    provider = CoinGeckoPriceProvider(client=_mock_client(handler))
    with pytest.raises(PriceProviderError):
        await provider.prices(["bitcoin"], "USD")


async def test_unparsable_response_raises_price_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not json")

    provider = CoinGeckoPriceProvider(client=_mock_client(handler))
    with pytest.raises(PriceProviderError):
        await provider.prices(["bitcoin"], "USD")


# --------------------------------------------------------------------------- #
# FakePriceProvider
# --------------------------------------------------------------------------- #


async def test_fake_price_provider_returns_canned_values_and_records_calls():
    fake = FakePriceProvider(prices_by_currency={"USD": {"bitcoin": 6_500_000}})
    result = await fake.prices(["bitcoin", "ethereum"], "USD")
    assert result == {"bitcoin": 6_500_000}
    assert "ethereum" not in result
    assert fake.calls == [(["bitcoin", "ethereum"], "USD")]


async def test_fake_price_provider_raises_on_demand():
    fake = FakePriceProvider(raise_for_currencies={"EUR"})
    with pytest.raises(PriceProviderError):
        await fake.prices(["bitcoin"], "EUR")
