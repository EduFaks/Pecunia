"""Crypto price provider abstraction (Track Q). `CryptoPriceProvider` is the
Protocol every caller (`PriceRefreshService`, the coin-search endpoint)
depends on; `CoinGeckoPriceProvider` is the real implementation (CoinGecko's
keyless public API) and `FakePriceProvider` is the test double every other
test in the suite uses instead — no real network call ever runs in tests.
"""

from decimal import Decimal
from typing import Protocol

import httpx

from pecunia.money import currency_minor_unit_exponent

COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3"

# Cap on the coin-search proxy's response (Task 4) — a searchable picker
# backing an autocomplete field, not a full-list dump.
COIN_SEARCH_LIMIT = 20


class PriceProviderError(Exception):
    """A price/coin-list fetch failed — HTTP status, timeout, connection
    error, or a response that didn't parse the way the caller expected.
    Every provider method catches its own httpx/JSON exceptions and raises
    this instead, so callers (PriceRefreshService, the coins endpoint) never
    have to know about httpx at all."""


class CryptoPriceProvider(Protocol):
    async def prices(self, ids: list[str], vs_currency: str) -> dict[str, int]:
        """Unit price, in `vs_currency` minor units, per resolved coin id. A
        coin id CoinGecko doesn't know — or that has no price in this
        currency — is simply absent from the result, never a KeyError."""
        ...

    async def coins(self) -> list[dict[str, str]]:
        """The full coin list, as `{"id", "symbol", "name"}` dicts."""
        ...


class CoinGeckoPriceProvider:
    """Real implementation. Accepts an injected `httpx.AsyncClient` (tests
    point it at an `httpx.MockTransport`); without one, each call opens and
    closes its own short-lived client. `coins()` fetches CoinGecko's
    `/coins/list` once and memoizes it for the lifetime of this instance —
    callers that want that memoization to span requests (the coin-search
    endpoint) must reuse one provider instance rather than building a fresh
    one per call."""

    def __init__(self, *, client: httpx.AsyncClient | None = None, timeout: float = 10.0):
        self._client = client
        self._timeout = timeout
        self._coins_cache: list[dict[str, str]] | None = None

    async def _get(self, path: str, params: dict[str, str]) -> object:
        try:
            if self._client is not None:
                response = await self._client.get(path, params=params, timeout=self._timeout)
            else:
                async with httpx.AsyncClient(base_url=COINGECKO_BASE_URL) as client:
                    response = await client.get(path, params=params, timeout=self._timeout)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError as exc:
            raise PriceProviderError(f"CoinGecko request to {path} failed: {exc}") from exc
        except ValueError as exc:
            # response.json() raises a plain ValueError (json.JSONDecodeError)
            # on a body that isn't valid JSON.
            raise PriceProviderError(f"CoinGecko response from {path} wasn't valid JSON: {exc}") from exc

    async def prices(self, ids: list[str], vs_currency: str) -> dict[str, int]:
        if not ids:
            return {}
        currency_key = vs_currency.lower()
        data = await self._get(
            "/simple/price", {"ids": ",".join(ids), "vs_currencies": currency_key}
        )
        if not isinstance(data, dict):
            raise PriceProviderError("CoinGecko simple/price returned an unexpected shape")
        factor = 10 ** currency_minor_unit_exponent(vs_currency)
        result: dict[str, int] = {}
        for coin_id in ids:
            entry = data.get(coin_id)
            if not isinstance(entry, dict):
                continue
            major = entry.get(currency_key)
            if major is None:
                continue
            # Decimal(str(...)) avoids a binary-float artifact in the
            # multiply (CONVENTIONS §4: money math is never plain float).
            result[coin_id] = round(Decimal(str(major)) * factor)
        return result

    async def coins(self) -> list[dict[str, str]]:
        if self._coins_cache is not None:
            return self._coins_cache
        data = await self._get("/coins/list", {})
        if not isinstance(data, list):
            raise PriceProviderError("CoinGecko coins/list returned an unexpected shape")
        self._coins_cache = [
            {"id": coin["id"], "symbol": coin["symbol"], "name": coin["name"]} for coin in data
        ]
        return self._coins_cache


class FakePriceProvider:
    """Test double for `CryptoPriceProvider`. `prices_by_currency` is
    `{vs_currency: {coin_id: unit_price_minor}}`; a currency in
    `raise_for_currencies` makes `prices()` raise `PriceProviderError`
    instead. Every `prices()` call is recorded in `.calls` (ids, currency) so
    a refresh-service test can assert "one call per currency" without a
    mocking framework."""

    def __init__(
        self,
        *,
        prices_by_currency: dict[str, dict[str, int]] | None = None,
        coins: list[dict[str, str]] | None = None,
        raise_for_currencies: set[str] | None = None,
    ):
        self._prices_by_currency = prices_by_currency or {}
        self._coins = coins or []
        self._raise_for_currencies = raise_for_currencies or set()
        self.calls: list[tuple[list[str], str]] = []
        self.coins_calls = 0

    async def prices(self, ids: list[str], vs_currency: str) -> dict[str, int]:
        self.calls.append((list(ids), vs_currency))
        if vs_currency in self._raise_for_currencies:
            raise PriceProviderError(f"fake provider failure for {vs_currency}")
        by_id = self._prices_by_currency.get(vs_currency, {})
        return {coin_id: by_id[coin_id] for coin_id in ids if coin_id in by_id}

    async def coins(self) -> list[dict[str, str]]:
        self.coins_calls += 1
        return self._coins


def filter_coins(
    coins: list[dict[str, str]], q: str | None, *, limit: int = COIN_SEARCH_LIMIT
) -> list[dict[str, str]]:
    """Case-insensitive substring match on symbol OR name, capped at
    `limit`. A falsy `q` (None or "") just returns the first `limit` coins
    as-is — the picker's initial "browse" state before the user types."""
    needle = (q or "").strip().lower()
    if not needle:
        return coins[:limit]
    matches = [c for c in coins if needle in c["symbol"].lower() or needle in c["name"].lower()]
    return matches[:limit]
