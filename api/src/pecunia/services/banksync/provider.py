"""Bank-sync provider abstraction (Track T). `BankProvider` is the Protocol
every caller (the sync service, the link/callback API, the scheduler)
depends on; `PluggyProvider` is the real implementation (Pluggy's Open
Finance aggregator API) and `FakeBankProvider` is the hand-rolled test double
every other test in the suite uses instead — no real network call ever runs
in tests.

Fix wave 2 (Meu Pluggy free tier, verified live 2026-10-01): client-wide item
listing (`GET /v2/items`) is a commercial opt-in Pecunia's tier doesn't have
— it 403s. Discovery is instead by item id (`GET /items/{id}`), one item at a
time. `GET /v2/transactions` on this tier only accepts `accountId` (+ `after`
cursor) — `pageSize`/`from` both 400. The date-window filter that used to be
server-side (`from`) is now applied client-side after fetching.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Protocol
from urllib.parse import parse_qs, urlsplit

import httpx

from pecunia.money import currency_minor_unit_exponent

logger = logging.getLogger(__name__)

PLUGGY_BASE_URL = "https://api.pluggy.ai"

# A transient connection/DNS failure (EAI_AGAIN — "Temporary failure in name
# resolution", seen live from Docker's embedded resolver when a whole-workspace
# "sync now" bursts many lookups back-to-back) means "retry might work", so it
# should not fail a sync on the first miss. Total attempts per request, with a
# short linear backoff between them.
_MAX_ATTEMPTS = 3
_RETRY_BACKOFF_SECONDS = 0.5

# Pluggy rejects a missing/expired/invalid apiKey with HTTP 403 and this body
# code (verified live) — NOT 401. So an expired cached key surfaces as 403,
# and the provider must re-auth on it just as it would on a 401, or every call
# fails forever once the ~2h key expires (until the process restarts). A 403
# for any OTHER reason (feature/consent block) is left alone.
_API_KEY_FAILURE_CODE = "API_KEY_MISSING_OR_INVALID"


def _is_api_key_failure(response: httpx.Response) -> bool:
    """True when Pluggy is rejecting the apiKey itself (so re-auth may help):
    HTTP 401, or a 403 whose JSON body's `codeDescription` is
    `API_KEY_MISSING_OR_INVALID`. Any other 403 is a real authorization/
    feature block, not a stale key, and must NOT trigger a re-auth."""
    if response.status_code == 401:
        return True
    if response.status_code == 403:
        try:
            body = response.json()
        except ValueError:
            return False
        return isinstance(body, dict) and body.get("codeDescription") == _API_KEY_FAILURE_CODE
    return False

# A hard ceiling on pages followed for one _get_paged call — guards against a
# cursor that keeps legitimately advancing but never actually terminates
# (finding 9). 200 pages is comfortably beyond any personal-scale workspace's
# transaction volume (a real ~12-month history came back in a single page).
_MAX_PAGES = 200


class BankProviderError(Exception):
    """Any Pluggy failure — HTTP status (incl. 429), timeout, auth, bad JSON.
    Callers never see httpx."""


class BankItemNotFoundError(BankProviderError):
    """A clean 404 from `GET /items/{id}` — the item id the caller named
    doesn't (or no longer) exist on the provider. Distinct from every other
    `BankProviderError` so the service can mark a connection ITEM_NOT_FOUND
    rather than treating it as a generic provider outage."""


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
    merchant: str | None = None  # Pluggy's merchant.name / businessName, else None


class BankProvider(Protocol):
    async def fetch_connection(self, item_id: str) -> ProviderConnection: ...

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
    `httpx.MockTransport`); without one, a single pooled client is lazily
    created and reused for this instance's whole lifetime — so one DNS
    resolution plus HTTP keep-alive serves an entire sync instead of a fresh
    DNS lookup and TLS handshake per call. That per-call churn is what buried
    Docker's embedded resolver under the all-connections "sync now" burst and
    surfaced as EAI_AGAIN; a transient connection/DNS error is also retried
    (see `_send`). The API key from `/auth` is cached in memory for the
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
        self._owned_client: httpx.AsyncClient | None = None
        self._timeout = timeout
        self._api_key: str | None = None

    def _get_client(self) -> httpx.AsyncClient:
        """The injected client (tests) wins; otherwise lazily create one pooled
        client and reuse it, so DNS is resolved once and the connection to
        api.pluggy.ai is kept alive across the many calls of a sync."""
        if self._client is not None:
            return self._client
        if self._owned_client is None:
            self._owned_client = httpx.AsyncClient(base_url=PLUGGY_BASE_URL)
        return self._owned_client

    async def aclose(self) -> None:
        """Close the pooled client, if one was created. Safe to call more than
        once and when only an injected client was ever used (that one is owned
        by the test and left untouched)."""
        if self._owned_client is not None:
            await self._owned_client.aclose()
            self._owned_client = None

    async def _send(self, method: str, path: str, **kwargs: object) -> httpx.Response:
        """One HTTP request, retrying only a transient connection/DNS failure
        (`httpx.ConnectError`/`ConnectTimeout` — which is how EAI_AGAIN
        surfaces) with a short backoff. HTTP status errors are NOT retried here
        — `_get` decides what a 4xx/5xx means."""
        kwargs.setdefault("timeout", self._timeout)
        client = self._get_client()
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                return await client.request(method, path, **kwargs)
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                if attempt >= _MAX_ATTEMPTS:
                    raise
                logger.warning(
                    "Pluggy %s %s transient connection failure "
                    "(attempt %d/%d), retrying: %s",
                    method, path, attempt, _MAX_ATTEMPTS, exc,
                )
                await asyncio.sleep(_RETRY_BACKOFF_SECONDS * attempt)
        raise AssertionError("unreachable")  # pragma: no cover

    async def _auth(self) -> str:
        body = {"clientId": self._client_id, "clientSecret": self._client_secret}
        response = await self._send("POST", "/auth", json=body)
        response.raise_for_status()
        self._api_key = response.json()["apiKey"]
        return self._api_key

    async def _request(self, path: str, params: dict[str, object]) -> httpx.Response:
        headers = {"X-API-KEY": self._api_key}
        return await self._send("GET", path, params=params, headers=headers)

    async def _get(
        self,
        path: str,
        params: dict[str, object],
        *,
        not_found_error: type[BankProviderError] | None = None,
    ) -> object:
        try:
            if self._api_key is None:
                await self._auth()
            response = await self._request(path, params)
            if _is_api_key_failure(response):
                # Key expired (or was never valid) — re-auth once and retry; a
                # second failure falls through to raise_for_status() below (we
                # never loop). Pluggy signals this with 401 OR a 403 whose body
                # code is API_KEY_MISSING_OR_INVALID (see _is_api_key_failure).
                self._api_key = None
                await self._auth()
                response = await self._request(path, params)
            if not_found_error is not None and response.status_code in (400, 404):
                # On an endpoint keyed by a caller-supplied id (e.g.
                # /items/{id}), a clean 404 means "that id doesn't exist" and
                # a 400 means the id itself is malformed ("Invalid id, not an
                # uuid" — verified live) — both are the caller's id being
                # wrong, not a provider outage, so raise the caller's distinct
                # subclass instead of falling through to the generic error.
                logger.warning(
                    "Pluggy request to %s returned %s", path, response.status_code
                )
                raise not_found_error(f"Pluggy resource not found at {path}")
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError as exc:
            # Log path + exception string only — never headers, params, the
            # request body, the client secret, or the api key. httpx's
            # exception string carries method+URL, which is fine.
            logger.warning("Pluggy request to %s failed: %s", path, exc)
            raise BankProviderError(f"Pluggy request to {path} failed: {exc}") from exc
        except ValueError as exc:
            # response.json() raises a plain ValueError (json.JSONDecodeError)
            # on a body that isn't valid JSON.
            logger.warning("Pluggy response from %s wasn't valid JSON: %s", path, exc)
            raise BankProviderError(
                f"Pluggy response from {path} wasn't valid JSON: {exc}"
            ) from exc
        except KeyError as exc:
            # /auth's body didn't carry the expected "apiKey" field.
            logger.warning("Pluggy auth response missing apiKey (requested %s): %s", path, exc)
            raise BankProviderError(f"Pluggy auth response missing apiKey: {exc}") from exc

    async def _get_paged(self, path: str, params: dict[str, object]) -> list[dict]:
        """Cursor-paginates `path`, re-sending the caller's own `params`
        (unchanged) on every page plus `after` once a `next` cursor appears.
        Meu Pluggy's free tier 400s if `pageSize` (or any param it doesn't
        expect) is present, so — unlike the client-wide listing endpoints
        this used to also serve — no page-size param is ever sent here."""
        query: dict[str, object] = dict(params)
        results: list[dict] = []
        previous_after: str | None = None
        for _ in range(_MAX_PAGES):
            page = await self._get(path, query)
            if not isinstance(page, dict):
                logger.warning("Pluggy paged response from %s wasn't a JSON object", path)
                raise BankProviderError(f"Pluggy paged response from {path} wasn't a JSON object")
            results.extend(page.get("results") or [])
            next_value = page.get("next")
            if not next_value:
                return results
            try:
                after_token = _extract_after(next_value)
            except (KeyError, ValueError, TypeError) as exc:
                logger.warning("Pluggy pagination cursor parsing failed for %s: %s", path, exc)
                raise BankProviderError(
                    f"Pluggy pagination cursor parsing failed for {path}: {exc}"
                ) from exc
            # A cursor that doesn't advance would otherwise spin forever —
            # guard against a misbehaving/looping feed (finding 9).
            if after_token == previous_after:
                logger.warning(
                    "Pluggy pagination for %s returned a repeated cursor %r", path, after_token
                )
                raise BankProviderError(
                    f"Pluggy pagination for {path} returned a repeated cursor {after_token!r}"
                )
            previous_after = after_token
            query = {**params, "after": after_token}
        logger.warning("Pluggy pagination for %s exceeded %s pages", path, _MAX_PAGES)
        raise BankProviderError(f"Pluggy pagination for {path} exceeded {_MAX_PAGES} pages")

    async def fetch_connection(self, item_id: str) -> ProviderConnection:
        data = await self._get(
            f"/items/{item_id}", {}, not_found_error=BankItemNotFoundError
        )
        if not isinstance(data, dict):
            raise BankProviderError(f"Pluggy /items/{item_id} response wasn't a JSON object")
        return ProviderConnection(
            item_id=data["id"],
            institution_name=(data.get("connector") or {}).get("name", ""),
            status=data["status"],
        )

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
        # Meu Pluggy's free tier only accepts `accountId` here — `pageSize`
        # and `from` both 400 ("property ... should not exist"). The
        # from_date window is instead applied client-side, below, after
        # mapping every page.
        rows = await self._get_paged("/v2/transactions", {"accountId": pluggy_account_id})
        transactions = [self._map_transaction(row) for row in rows]
        return [t for t in transactions if t.date >= from_date]

    def _map_transaction(self, row: dict) -> ProviderTransaction:
        currency = row["currencyCode"]
        # abs-first, then sign by type: fixes Pluggy's credit-card quirk
        # where a purchase arrives as a positive amount with type "DEBIT".
        minor = _to_minor(abs(row["amount"]), currency)
        amount_minor = -minor if row["type"] == "DEBIT" else minor
        merchant_obj = row.get("merchant") or {}
        merchant = merchant_obj.get("name") or merchant_obj.get("businessName")
        return ProviderTransaction(
            external_id=row["id"],
            date=date.fromisoformat(row["date"][:10]),
            description=row["description"],
            amount_minor=amount_minor,
            currency=currency,
            status=row["status"],
            pluggy_category=row.get("category"),
            merchant=merchant,
        )


class FakeBankProvider:
    """Test double for `BankProvider`. `.transaction_calls` records every
    `fetch_transactions` call as `(pluggy_account_id, from_date)` so a
    sync-service test can assert "one call per linked account, from the
    right date" without a mocking framework. `raise_all=True` makes every
    method raise `BankProviderError`; `raise_for_items` does the same for
    `fetch_connection`/`fetch_accounts` calls naming one of those item ids
    specifically; `raise_for_accounts` does the same for `fetch_transactions`
    calls naming one of those pluggy_account_ids specifically (simulates one
    link's import failing without touching its siblings)."""

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

    async def fetch_connection(self, item_id: str) -> ProviderConnection:
        if self._raise_all or item_id in self._raise_for_items:
            raise BankProviderError(f"fake provider failure for item {item_id}")
        connection = next((c for c in self._connections if c.item_id == item_id), None)
        if connection is None:
            raise BankItemNotFoundError(f"fake provider: unknown item {item_id}")
        return connection

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
