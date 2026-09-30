"""Bank-sync provider abstraction (Track T). `BankProvider` is the Protocol
every caller (the sync service, the link/callback API, the scheduler)
depends on; `PluggyProvider` is the real implementation (Pluggy's Open
Finance aggregator API) and `FakeBankProvider` is the hand-rolled test double
every other test in the suite uses instead — no real network call ever runs
in tests.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Protocol
from urllib.parse import parse_qs, urlsplit

import httpx

from pecunia.money import currency_minor_unit_exponent

PLUGGY_BASE_URL = "https://api.pluggy.ai"

# Pluggy's cursor-paginated endpoints (/v2/items, /v2/transactions) return up
# to this many rows per page.
_PAGE_SIZE = 500


class BankProviderError(Exception):
    """Any Pluggy failure — HTTP status (incl. 429), timeout, auth, bad JSON.
    Callers never see httpx."""


@dataclass(frozen=True)
class ProviderConnection:
    item_id: str
    institution_name: str  # item["connector"]["name"] (fallback "" if absent)
    status: str  # raw Pluggy item status, e.g. "UPDATED", "LOGIN_ERROR"


@dataclass(frozen=True)
class ProviderAccount:
    pluggy_account_id: str
    item_id: str
    type: str  # "BANK" | "CREDIT"
    subtype: str  # e.g. "CHECKING_ACCOUNT", "SAVINGS_ACCOUNT", "CREDIT_CARD"
    name: str
    number: str | None
    balance_minor: int  # bank: available funds; card: OWED amount, stored NEGATIVE
    currency: str  # currencyCode
    credit_limit_minor: int | None  # creditData.creditLimit
    bill_close_date: date | None  # creditData.balanceCloseDate
    bill_due_date: date | None  # creditData.balanceDueDate


@dataclass(frozen=True)
class ProviderTransaction:
    external_id: str
    date: date  # from the ISO datetime "date" field
    description: str
    amount_minor: int  # SIGNED, Pecunia convention (see normalization)
    currency: str
    status: str  # "POSTED" | "PENDING" — passed through, the service filters
    pluggy_category: str | None


class BankProvider(Protocol):
    async def fetch_connections(self) -> list[ProviderConnection]: ...

    async def fetch_accounts(self, item_id: str) -> list[ProviderAccount]: ...

    async def fetch_transactions(
        self, pluggy_account_id: str, *, from_date: date
    ) -> list[ProviderTransaction]: ...


def _to_minor(value: float | str, currency: str) -> int:
    """`Decimal(str(value))` avoids a binary-float artifact in the multiply
    (CONVENTIONS §4: money math is never plain float)."""
    factor = 10 ** currency_minor_unit_exponent(currency)
    return round(Decimal(str(value)) * factor)


def _extract_after(next_value: str) -> str:
    """`next` arrives as a full URL, a bare `"?after=...&pageSize=..."` query
    string, or (in principle) a bare cursor token. Pull the `after` value out
    robustly rather than assuming one shape."""
    if "after=" in next_value:
        # Try to extract from urlsplit's query component. If that's empty
        # (e.g., "after=tok-3" without "?"), fall back to the whole string.
        query = urlsplit(next_value).query or next_value
        # Use .get() to avoid KeyError; treat empty or missing as the bare token.
        after_list = parse_qs(query).get("after")
        if after_list:
            return after_list[0]
        return next_value
    return next_value


class PluggyProvider:
    """Real implementation, against Pluggy's Open Finance aggregator API.
    Accepts an injected `httpx.AsyncClient` (tests point it at an
    `httpx.MockTransport`); without one, each call opens and closes its own
    short-lived client. The API key from `/auth` is cached in memory for the
    lifetime of this instance (~2h validity per Pluggy) and transparently
    refreshed once on a 401 — callers never see the auth handshake."""

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        *,
        client: httpx.AsyncClient | None = None,
        timeout: float = 10.0,
    ):
        self._client_id = client_id
        self._client_secret = client_secret
        self._client = client
        self._timeout = timeout
        self._api_key: str | None = None

    async def _auth(self) -> str:
        body = {"clientId": self._client_id, "clientSecret": self._client_secret}
        if self._client is not None:
            response = await self._client.post("/auth", json=body, timeout=self._timeout)
        else:
            async with httpx.AsyncClient(base_url=PLUGGY_BASE_URL) as client:
                response = await client.post("/auth", json=body, timeout=self._timeout)
        response.raise_for_status()
        self._api_key = response.json()["apiKey"]
        return self._api_key

    async def _request(self, path: str, params: dict[str, object]) -> httpx.Response:
        headers = {"X-API-KEY": self._api_key}
        if self._client is not None:
            return await self._client.get(
                path, params=params, headers=headers, timeout=self._timeout
            )
        async with httpx.AsyncClient(base_url=PLUGGY_BASE_URL) as client:
            return await client.get(path, params=params, headers=headers, timeout=self._timeout)

    async def _get(self, path: str, params: dict[str, object]) -> object:
        try:
            if self._api_key is None:
                await self._auth()
            response = await self._request(path, params)
            if response.status_code == 401:
                # Key expired (or was never valid) — re-auth once and retry;
                # a second 401 falls through to raise_for_status() below.
                self._api_key = None
                await self._auth()
                response = await self._request(path, params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError as exc:
            raise BankProviderError(f"Pluggy request to {path} failed: {exc}") from exc
        except ValueError as exc:
            # response.json() raises a plain ValueError (json.JSONDecodeError)
            # on a body that isn't valid JSON.
            raise BankProviderError(
                f"Pluggy response from {path} wasn't valid JSON: {exc}"
            ) from exc
        except KeyError as exc:
            # /auth's body didn't carry the expected "apiKey" field.
            raise BankProviderError(f"Pluggy auth response missing apiKey: {exc}") from exc

    async def _get_paged(self, path: str, params: dict[str, object]) -> list[dict]:
        query: dict[str, object] = {**params, "pageSize": _PAGE_SIZE}
        results: list[dict] = []
        while True:
            page = await self._get(path, query)
            if not isinstance(page, dict):
                raise BankProviderError(f"Pluggy paged response from {path} wasn't a JSON object")
            results.extend(page.get("results") or [])
            next_value = page.get("next")
            if not next_value:
                break
            try:
                after_token = _extract_after(next_value)
            except (KeyError, ValueError, TypeError) as exc:
                raise BankProviderError(
                    f"Pluggy pagination cursor parsing failed for {path}: {exc}"
                ) from exc
            query = {**params, "after": after_token}
        return results

    async def fetch_connections(self) -> list[ProviderConnection]:
        rows = await self._get_paged("/v2/items", {})
        return [
            ProviderConnection(
                item_id=row["id"],
                institution_name=(row.get("connector") or {}).get("name", ""),
                status=row["status"],
            )
            for row in rows
        ]

    async def fetch_accounts(self, item_id: str) -> list[ProviderAccount]:
        data = await self._get("/accounts", {"itemId": item_id})
        if not isinstance(data, dict):
            raise BankProviderError("Pluggy /accounts response wasn't a JSON object")
        return [self._map_account(row, item_id) for row in data.get("results") or []]

    def _map_account(self, row: dict, item_id: str) -> ProviderAccount:
        currency = row["currencyCode"]
        account_type = row["type"]
        balance_minor = _to_minor(row["balance"], currency)
        if account_type == "CREDIT":
            # Pluggy's card `balance` is the amount OWED; Pecunia stores a
            # credit-card balance as a negative figure.
            balance_minor = -balance_minor
        # Each creditData member is independently optional — Pluggy may not
        # yet have a limit, or a billing-cycle date, even while the object
        # itself is present (finding 8: don't assume "creditData present"
        # means "every field in it is present").
        credit_data = row.get("creditData") or {}
        credit_limit = credit_data.get("creditLimit")
        credit_limit_minor = _to_minor(credit_limit, currency) if credit_limit is not None else None
        close_date = credit_data.get("balanceCloseDate")
        bill_close_date = date.fromisoformat(close_date[:10]) if close_date else None
        due_date = credit_data.get("balanceDueDate")
        bill_due_date = date.fromisoformat(due_date[:10]) if due_date else None
        return ProviderAccount(
            pluggy_account_id=row["id"],
            item_id=item_id,
            type=account_type,
            subtype=row["subtype"],
            name=row["name"],
            number=row.get("number"),
            balance_minor=balance_minor,
            currency=currency,
            credit_limit_minor=credit_limit_minor,
            bill_close_date=bill_close_date,
            bill_due_date=bill_due_date,
        )

    async def fetch_transactions(
        self, pluggy_account_id: str, *, from_date: date
    ) -> list[ProviderTransaction]:
        rows = await self._get_paged(
            "/v2/transactions",
            {"accountId": pluggy_account_id, "from": from_date.isoformat()},
        )
        return [self._map_transaction(row) for row in rows]

    def _map_transaction(self, row: dict) -> ProviderTransaction:
        currency = row["currencyCode"]
        # abs-first, then sign by type: fixes Pluggy's credit-card quirk
        # where a purchase arrives as a positive amount with type "DEBIT".
        minor = _to_minor(abs(row["amount"]), currency)
        amount_minor = -minor if row["type"] == "DEBIT" else minor
        return ProviderTransaction(
            external_id=row["id"],
            date=date.fromisoformat(row["date"][:10]),
            description=row["description"],
            amount_minor=amount_minor,
            currency=currency,
            status=row["status"],
            pluggy_category=row.get("category"),
        )


class FakeBankProvider:
    """Test double for `BankProvider`. `.transaction_calls` records every
    `fetch_transactions` call as `(pluggy_account_id, from_date)` so a
    sync-service test can assert "one call per linked account, from the
    right date" without a mocking framework. `raise_all=True` makes every
    method raise `BankProviderError`; `raise_for_items` does the same for
    `fetch_accounts` calls naming one of those item ids specifically;
    `raise_for_accounts` does the same for `fetch_transactions` calls naming
    one of those pluggy_account_ids specifically (simulates one link's
    import failing without touching its siblings)."""

    def __init__(
        self,
        *,
        connections: list[ProviderConnection] | None = None,
        accounts_by_item: dict[str, list[ProviderAccount]] | None = None,
        transactions_by_account: dict[str, list[ProviderTransaction]] | None = None,
        raise_all: bool = False,
        raise_for_items: set[str] | None = None,
        raise_for_accounts: set[str] | None = None,
    ):
        self._connections = connections or []
        self._accounts_by_item = accounts_by_item or {}
        self._transactions_by_account = transactions_by_account or {}
        self._raise_all = raise_all
        self._raise_for_items = raise_for_items or set()
        self._raise_for_accounts = raise_for_accounts or set()
        self.transaction_calls: list[tuple[str, date]] = []

    async def fetch_connections(self) -> list[ProviderConnection]:
        if self._raise_all:
            raise BankProviderError("fake provider failure")
        return list(self._connections)

    async def fetch_accounts(self, item_id: str) -> list[ProviderAccount]:
        if self._raise_all or item_id in self._raise_for_items:
            raise BankProviderError(f"fake provider failure for item {item_id}")
        return list(self._accounts_by_item.get(item_id, []))

    async def fetch_transactions(
        self, pluggy_account_id: str, *, from_date: date
    ) -> list[ProviderTransaction]:
        self.transaction_calls.append((pluggy_account_id, from_date))
        if self._raise_all or pluggy_account_id in self._raise_for_accounts:
            raise BankProviderError(f"fake provider failure for account {pluggy_account_id}")
        rows = self._transactions_by_account.get(pluggy_account_id, [])
        return [row for row in rows if row.date >= from_date]
