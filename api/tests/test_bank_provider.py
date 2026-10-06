"""Task 2 (Track T) + fix wave 2 (Meu Pluggy free tier): `BankProvider`
protocol, its `PluggyProvider` implementation, and `FakeBankProvider`.
`PluggyProvider`'s tests mock the httpx transport — no real network call
ever runs in this suite (CONVENTIONS: the provider is injected everywhere
else so callers pass a fake).

Verified live against Meu Pluggy's free tier (2026-10-01): client-wide item
listing (`GET /v2/items`) 403s (commercial opt-in) — discovery is by item id
(`GET /items/{id}`) instead. `GET /v2/transactions` only accepts `accountId`
(+ `after`) — `pageSize`/`from` both 400. The date-window filter moved
client-side."""

import json
from datetime import date

import httpx
import pytest

import pecunia.services.banksync.provider as provider_module
from pecunia.services.banksync.provider import (
    PLUGGY_BASE_URL,
    BankItemNotFoundError,
    BankProviderError,
    FakeBankProvider,
    PluggyProvider,
    ProviderAccount,
    ProviderConnection,
    ProviderTransaction,
)


def _mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url=PLUGGY_BASE_URL)


def _provider(handler) -> PluggyProvider:
    return PluggyProvider("client-id", "client-secret", client=_mock_client(handler))


def _tx_json(external_id: str, iso_date: str, **overrides) -> dict:
    row = {
        "id": external_id,
        "description": "Purchase",
        "amount": 50.0,
        "date": f"{iso_date}T12:00:00.000Z",
        "currencyCode": "BRL",
        "status": "POSTED",
        "type": "DEBIT",
        "category": None,
    }
    row.update(overrides)
    return row


# --------------------------------------------------------------------------- #
# Auth: once, cached, reused
# --------------------------------------------------------------------------- #


async def test_auth_happens_once_and_the_key_is_reused_across_calls():
    calls = {"auth": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            calls["auth"] += 1
            assert request.method == "POST"
            return httpx.Response(200, json={"apiKey": "key-1"})
        assert request.headers["X-API-KEY"] == "key-1"
        if request.url.path == "/items/item-1":
            return httpx.Response(
                200, json={"id": "item-1", "status": "UPDATED", "connector": {"name": "Bank"}}
            )
        if request.url.path == "/accounts":
            return httpx.Response(200, json={"results": []})
        raise AssertionError(f"unexpected path {request.url.path}")

    provider = _provider(handler)
    await provider.fetch_connection("item-1")
    await provider.fetch_accounts("item-1")
    assert calls["auth"] == 1


async def test_auth_body_sends_client_id_and_secret():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200, json={"id": "item-1", "status": "UPDATED", "connector": {"name": "Bank"}}
        )

    provider = _provider(handler)
    await provider.fetch_connection("item-1")
    assert seen["body"] == {"clientId": "client-id", "clientSecret": "client-secret"}


# --------------------------------------------------------------------------- #
# 401 handling: single re-auth + retry, then error on a second 401
# --------------------------------------------------------------------------- #


async def test_single_401_triggers_one_reauth_and_retry_then_succeeds():
    calls = {"auth": 0, "items": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            calls["auth"] += 1
            return httpx.Response(200, json={"apiKey": f"key-{calls['auth']}"})
        assert request.url.path == "/items/item-1"
        calls["items"] += 1
        if calls["items"] == 1:
            return httpx.Response(401, json={"message": "expired"})
        assert request.headers["X-API-KEY"] == "key-2"
        return httpx.Response(
            200, json={"id": "item-1", "status": "UPDATED", "connector": {"name": "Bank"}}
        )

    provider = _provider(handler)
    result = await provider.fetch_connection("item-1")
    assert result == ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")
    assert calls["auth"] == 2
    assert calls["items"] == 2


async def test_second_401_after_reauth_raises_bank_provider_error():
    calls = {"auth": 0, "items": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            calls["auth"] += 1
            return httpx.Response(200, json={"apiKey": f"key-{calls['auth']}"})
        assert request.url.path == "/items/item-1"
        calls["items"] += 1
        return httpx.Response(401, json={"message": "expired"})

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connection("item-1")
    assert calls["auth"] == 2
    assert calls["items"] == 2


# --------------------------------------------------------------------------- #
# fetch_connection — mapping, fallback, 404 -> BankItemNotFoundError
# --------------------------------------------------------------------------- #


async def test_fetch_connection_maps_item_fields():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        assert request.url.path == "/items/item-1"
        return httpx.Response(
            200, json={"id": "item-1", "status": "UPDATED", "connector": {"name": "MeuPluggy"}}
        )

    provider = _provider(handler)
    result = await provider.fetch_connection("item-1")
    assert result == ProviderConnection(
        item_id="item-1", institution_name="MeuPluggy", status="UPDATED"
    )


async def test_expired_api_key_403_triggers_reauth_then_succeeds():
    """Pluggy rejects an expired/invalid apiKey with HTTP 403
    (codeDescription API_KEY_MISSING_OR_INVALID), NOT 401 — the provider must
    re-auth once on that signal and retry, exactly as it does for a 401."""
    calls = {"auth": 0, "item": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            calls["auth"] += 1
            return httpx.Response(200, json={"apiKey": f"key-{calls['auth']}"})
        calls["item"] += 1
        if calls["item"] == 1:
            return httpx.Response(
                403,
                json={
                    "code": 403,
                    "codeDescription": "API_KEY_MISSING_OR_INVALID",
                    "message": "Missing or invalid authorization token",
                },
            )
        return httpx.Response(200, json={"id": "item-1", "status": "UPDATED"})

    provider = _provider(handler)
    result = await provider.fetch_connection("item-1")
    assert result.item_id == "item-1"
    assert calls["auth"] == 2  # initial + one re-auth on the 403
    assert calls["item"] == 2  # failed once, retried once


async def test_persistent_api_key_403_raises_after_one_reauth():
    """A second API_KEY 403 after re-auth must surface as BankProviderError,
    never loop."""
    calls = {"auth": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            calls["auth"] += 1
            return httpx.Response(200, json={"apiKey": "key"})
        return httpx.Response(
            403, json={"code": 403, "codeDescription": "API_KEY_MISSING_OR_INVALID"}
        )

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connection("item-1")
    assert calls["auth"] == 2  # exactly one re-auth, no infinite loop


async def test_non_apikey_403_does_not_trigger_reauth():
    """A 403 for any OTHER reason (feature/consent block) is NOT an auth
    failure — it must raise without re-authing."""
    calls = {"auth": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            calls["auth"] += 1
            return httpx.Response(200, json={"apiKey": "key"})
        return httpx.Response(
            403, json={"code": 403, "codeDescription": "FEATURE_NOT_ENABLED"}
        )

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connection("item-1")
    assert calls["auth"] == 1  # no re-auth for a non-apikey 403


async def test_fetch_connection_falls_back_to_empty_institution_name():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(200, json={"id": "i1", "status": "LOGIN_ERROR"})

    provider = _provider(handler)
    result = await provider.fetch_connection("i1")
    assert result == ProviderConnection(item_id="i1", institution_name="", status="LOGIN_ERROR")


async def test_fetch_connection_404_raises_bank_item_not_found_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(404, json={"message": "Item not found"})

    provider = _provider(handler)
    with pytest.raises(BankItemNotFoundError):
        await provider.fetch_connection("missing-item")


async def test_fetch_connection_400_invalid_id_raises_bank_item_not_found_error():
    """Pluggy answers 400 ("Invalid id, not an uuid" — verified live) when the
    caller-supplied item id is malformed; from the user's perspective that is
    the same "no such item" case as a 404, not a provider outage."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(400, json={"message": "Invalid id, not an uuid"})

    provider = _provider(handler)
    with pytest.raises(BankItemNotFoundError):
        await provider.fetch_connection("not-a-uuid")


async def test_transient_connect_error_is_retried_then_succeeds(monkeypatch):
    """EAI_AGAIN ("Temporary failure in name resolution") surfaces as
    httpx.ConnectError; a transient one must be retried, not fail the call."""
    monkeypatch.setattr(provider_module, "_RETRY_BACKOFF_SECONDS", 0)
    state = {"gets": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        state["gets"] += 1
        if state["gets"] == 1:
            raise httpx.ConnectError("Temporary failure in name resolution")
        return httpx.Response(
            200, json={"id": "item-1", "connector": {"name": "MeuPluggy"}, "status": "UPDATED"}
        )

    provider = _provider(handler)
    conn = await provider.fetch_connection("item-1")
    assert conn.item_id == "item-1"
    assert state["gets"] == 2  # failed once, retried once, succeeded


async def test_transient_connect_error_exhausts_retries_then_raises(monkeypatch):
    monkeypatch.setattr(provider_module, "_RETRY_BACKOFF_SECONDS", 0)
    state = {"gets": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        state["gets"] += 1
        raise httpx.ConnectError("Temporary failure in name resolution")

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connection("item-1")
    assert state["gets"] == provider_module._MAX_ATTEMPTS  # tried the full budget


async def test_http_status_error_is_not_retried(monkeypatch):
    """A 500 is a server answer, not a transient connect failure — it must be
    raised on the first attempt, never retried."""
    monkeypatch.setattr(provider_module, "_RETRY_BACKOFF_SECONDS", 0)
    state = {"gets": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        state["gets"] += 1
        return httpx.Response(500, json={"error": "boom"})

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connection("item-1")
    assert state["gets"] == 1  # no retry on an HTTP status error


async def test_fetch_connection_non_404_error_raises_plain_bank_provider_error_not_item_not_found():
    """Any other failure (500, timeout, etc) must stay a plain
    BankProviderError, not the 404-specific subclass — only a clean 404 is
    "that id doesn't exist"."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(500, json={"error": "boom"})

    provider = _provider(handler)
    with pytest.raises(BankProviderError) as exc_info:
        await provider.fetch_connection("item-1")
    assert not isinstance(exc_info.value, BankItemNotFoundError)


# --------------------------------------------------------------------------- #
# fetch_accounts — money, card negation, creditData present/absent
# --------------------------------------------------------------------------- #


async def test_fetch_accounts_converts_minor_units_bank_account():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        assert request.url.path == "/accounts"
        assert dict(request.url.params)["itemId"] == "item-1"
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "acc-1",
                        "type": "BANK",
                        "subtype": "CHECKING_ACCOUNT",
                        "name": "Checking",
                        "number": "0001",
                        "balance": 1234.56,
                        "currencyCode": "BRL",
                        "creditData": None,
                    }
                ]
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_accounts("item-1")
    assert result == [
        ProviderAccount(
            pluggy_account_id="acc-1",
            item_id="item-1",
            type="BANK",
            subtype="CHECKING_ACCOUNT",
            name="Checking",
            number="0001",
            balance_minor=123_456,
            currency="BRL",
            credit_limit_minor=None,
            bill_close_date=None,
            bill_due_date=None,
        )
    ]


async def test_fetch_accounts_negates_credit_card_balance_and_maps_credit_data():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "acc-2",
                        "type": "CREDIT",
                        "subtype": "CREDIT_CARD",
                        "name": "Card",
                        "number": "1111",
                        "balance": 543.21,
                        "currencyCode": "BRL",
                        "creditData": {
                            "creditLimit": 5000.0,
                            "balanceCloseDate": "2026-09-20T00:00:00.000Z",
                            "balanceDueDate": "2026-09-27T00:00:00.000Z",
                        },
                    }
                ]
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_accounts("item-2")
    account = result[0]
    assert account.balance_minor == -54_321
    assert account.credit_limit_minor == 500_000
    assert account.bill_close_date == date(2026, 9, 20)
    assert account.bill_due_date == date(2026, 9, 27)


async def test_fetch_accounts_tolerates_partial_credit_data_with_null_limit():
    """Finding 8: a creditData object with some members null (e.g. Pluggy
    hasn't reported a credit limit yet) must not crash — each of
    limit/close/due is independently optional."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "acc-partial",
                        "type": "CREDIT",
                        "subtype": "CREDIT_CARD",
                        "name": "Card",
                        "number": "2222",
                        "balance": 100.0,
                        "currencyCode": "BRL",
                        "creditData": {
                            "creditLimit": None,
                            "balanceCloseDate": "2026-09-20T00:00:00.000Z",
                            "balanceDueDate": "2026-09-27T00:00:00.000Z",
                        },
                    }
                ]
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_accounts("item-partial")
    account = result[0]
    assert account.credit_limit_minor is None
    assert account.bill_close_date == date(2026, 9, 20)
    assert account.bill_due_date == date(2026, 9, 27)


async def test_fetch_accounts_tolerates_partial_credit_data_with_null_dates():
    """Finding 8: the close/due dates can independently be null (e.g. a
    limit is known but the current billing cycle hasn't been computed yet)."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "acc-partial-2",
                        "type": "CREDIT",
                        "subtype": "CREDIT_CARD",
                        "name": "Card",
                        "number": "3333",
                        "balance": 100.0,
                        "currencyCode": "BRL",
                        "creditData": {
                            "creditLimit": 1000.0,
                            "balanceCloseDate": None,
                            "balanceDueDate": None,
                        },
                    }
                ]
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_accounts("item-partial-2")
    account = result[0]
    assert account.credit_limit_minor == 100_000
    assert account.bill_close_date is None
    assert account.bill_due_date is None


async def test_fetch_accounts_missing_number_is_none():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "acc-3",
                        "type": "BANK",
                        "subtype": "SAVINGS_ACCOUNT",
                        "name": "Savings",
                        "number": None,
                        "balance": 10.0,
                        "currencyCode": "USD",
                        "creditData": None,
                    }
                ]
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_accounts("item-3")
    assert result[0].number is None


# --------------------------------------------------------------------------- #
# fetch_transactions — request shape (accountId ONLY), sign matrix, PENDING
# passthrough, category, client-side date filtering, pagination
# --------------------------------------------------------------------------- #


async def test_fetch_transactions_request_carries_only_account_id_no_page_size_no_from():
    """Meu Pluggy's free tier 400s if `pageSize` or `from` is present —
    verified live 2026-10-01. The request must carry accountId alone."""
    seen_params = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        assert request.url.path == "/v2/transactions"
        seen_params.append(dict(request.url.params))
        return httpx.Response(200, json={"results": [], "next": None})

    provider = _provider(handler)
    await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert seen_params == [{"accountId": "acc-1"}]


async def test_fetch_transactions_bank_debit_is_negative_and_credit_is_positive():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        assert request.url.path == "/v2/transactions"
        params = dict(request.url.params)
        assert params == {"accountId": "acc-1"}
        return httpx.Response(
            200,
            json={
                "results": [
                    _tx_json("tx-1", "2026-01-05", description="Groceries", amount=50.0, type="DEBIT", category="Food"),
                    _tx_json("tx-2", "2026-01-06", description="Salary", amount=1000.0, type="CREDIT", category=None),
                ],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert result == [
        ProviderTransaction(
            external_id="tx-1",
            date=date(2026, 1, 5),
            description="Groceries",
            amount_minor=-5_000,
            currency="BRL",
            status="POSTED",
            pluggy_category="Food",
        ),
        ProviderTransaction(
            external_id="tx-2",
            date=date(2026, 1, 6),
            description="Salary",
            amount_minor=100_000,
            currency="BRL",
            status="POSTED",
            pluggy_category=None,
        ),
    ]


async def test_fetch_transactions_credit_card_purchase_quirk_is_corrected():
    """Pluggy's credit-card quirk: a purchase arrives as amount=+100.0 with
    type=DEBIT (not negative like a bank debit). abs-then-sign-by-type fixes
    this: the purchase must still land negative."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [
                    _tx_json("tx-3", "2026-01-07", description="Store purchase", amount=100.0, type="DEBIT", category="Shopping"),
                    _tx_json("tx-4", "2026-01-08", description="Card payment", amount=200.0, type="CREDIT", category=None),
                ],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_transactions("card-acc", from_date=date(2026, 1, 1))
    assert result[0].amount_minor == -10_000
    assert result[1].amount_minor == 20_000


async def test_fetch_transactions_pending_rows_pass_through_with_status():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [
                    _tx_json("tx-5", "2026-01-09", description="Pending charge", amount=30.0, status="PENDING", category=None),
                ],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-x", from_date=date(2026, 1, 1))
    assert result[0].status == "PENDING"


async def test_fetch_transactions_filters_rows_older_than_from_date_client_side():
    """The date window used to be a server-side `from` param; Meu Pluggy's
    free tier rejects that param, so it's now applied client-side after
    fetching every page."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [
                    _tx_json("tx-old", "2025-12-31"),
                    _tx_json("tx-new", "2026-01-05"),
                ],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert [t.external_id for t in result] == ["tx-new"]


# --------------------------------------------------------------------------- #
# Pagination: all three `next` shapes, aggregated — exercised via
# fetch_transactions, the only remaining _get_paged consumer
# --------------------------------------------------------------------------- #


async def test_pagination_follows_next_as_a_full_url():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        params = dict(request.url.params)
        if "after" not in params:
            return httpx.Response(
                200,
                json={
                    "results": [_tx_json("tx-1", "2026-01-05")],
                    "next": "https://api.pluggy.ai/v2/transactions?after=tok-1",
                },
            )
        assert params["after"] == "tok-1"
        return httpx.Response(200, json={"results": [_tx_json("tx-2", "2026-01-06")], "next": None})

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert [t.external_id for t in result] == ["tx-1", "tx-2"]


async def test_pagination_follows_next_as_a_bare_query_string():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        params = dict(request.url.params)
        if "after" not in params:
            return httpx.Response(
                200, json={"results": [_tx_json("tx-1", "2026-01-05")], "next": "?after=tok-2"}
            )
        assert params["after"] == "tok-2"
        return httpx.Response(200, json={"results": [_tx_json("tx-2", "2026-01-06")], "next": None})

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert [t.external_id for t in result] == ["tx-1", "tx-2"]


async def test_pagination_follows_next_as_a_bare_token():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        params = dict(request.url.params)
        if "after" not in params:
            return httpx.Response(
                200, json={"results": [_tx_json("tx-1", "2026-01-05")], "next": "tok-3"}
            )
        assert params["after"] == "tok-3"
        return httpx.Response(200, json={"results": [_tx_json("tx-2", "2026-01-06")], "next": None})

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert [t.external_id for t in result] == ["tx-1", "tx-2"]


async def test_pagination_follows_next_as_bare_query_string_without_question_mark():
    """Pluggy pagination `next` can be a bare query string like "after=tok-3"
    (without the leading "?"). This must be parsed robustly without leaking
    a raw KeyError."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        params = dict(request.url.params)
        if "after" not in params:
            return httpx.Response(
                200, json={"results": [_tx_json("tx-1", "2026-01-05")], "next": "after=tok-3"}
            )
        assert params["after"] == "tok-3"
        return httpx.Response(200, json={"results": [_tx_json("tx-2", "2026-01-06")], "next": None})

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert [t.external_id for t in result] == ["tx-1", "tx-2"]


async def test_pagination_terminates_when_next_key_is_missing():
    """Pagination should terminate when the response has no 'next' key at all,
    same as if next is null."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(200, json={"results": [_tx_json("tx-1", "2026-01-05")]})

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert [t.external_id for t in result] == ["tx-1"]


async def test_pagination_requests_never_carry_a_page_size_param():
    """Finding (fix wave 2): unlike the old /v2/items listing, no page here
    may ever carry `pageSize` — Meu Pluggy 400s on it."""
    seen_params = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        params = dict(request.url.params)
        seen_params.append(params)
        if "after" not in params:
            return httpx.Response(
                200, json={"results": [_tx_json("tx-1", "2026-01-05")], "next": "?after=tok-1"}
            )
        return httpx.Response(200, json={"results": [_tx_json("tx-2", "2026-01-06")], "next": None})

    provider = _provider(handler)
    await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert all("pageSize" not in p for p in seen_params)
    assert all("from" not in p for p in seen_params)


async def test_pagination_repeated_cursor_raises_bank_provider_error():
    """Finding 9: a `next` cursor that never advances (Pluggy returning the
    same `after` token again) must not spin forever — it's a provider
    misbehavior, surfaced as a BankProviderError."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200, json={"results": [_tx_json("tx-1", "2026-01-05")], "next": "?after=tok-stuck"}
        )

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))


async def test_pagination_exceeding_page_cap_raises_bank_provider_error():
    """Finding 9: even a cursor that keeps legitimately advancing must not
    loop unbounded — a page cap guards against a runaway or malicious feed."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        calls["n"] += 1
        return httpx.Response(
            200,
            json={
                "results": [_tx_json(f"tx-{calls['n']}", "2026-01-05")],
                "next": f"?after=tok-{calls['n']}",
            },
        )

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))


# --------------------------------------------------------------------------- #
# Error handling: HTTP status, invalid JSON, timeout
# --------------------------------------------------------------------------- #


async def test_server_error_status_raises_bank_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(500, json={"error": "boom"})

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connection("item-1")


async def test_invalid_json_body_raises_bank_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(200, content=b"not json")

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connection("item-1")


async def test_timeout_raises_bank_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        raise httpx.TimeoutException("timed out", request=request)

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connection("item-1")


async def test_auth_failure_status_raises_bank_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/auth"
        return httpx.Response(500, json={"error": "boom"})

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connection("item-1")


async def test_auth_response_missing_api_key_raises_bank_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/auth"
        return httpx.Response(200, json={"unexpected": "shape"})

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connection("item-1")


# --------------------------------------------------------------------------- #
# FakeBankProvider
# --------------------------------------------------------------------------- #


async def test_fake_bank_provider_returns_canned_connection_and_accounts():
    conn = ProviderConnection(item_id="i1", institution_name="Bank", status="UPDATED")
    account = ProviderAccount(
        pluggy_account_id="acc-1",
        item_id="i1",
        type="BANK",
        subtype="CHECKING_ACCOUNT",
        name="Checking",
        number="0001",
        balance_minor=1_000,
        currency="BRL",
        credit_limit_minor=None,
        bill_close_date=None,
        bill_due_date=None,
    )
    fake = FakeBankProvider(connections=[conn], accounts_by_item={"i1": [account]})
    assert await fake.fetch_connection("i1") == conn
    assert await fake.fetch_accounts("i1") == [account]
    assert await fake.fetch_accounts("unknown-item") == []


async def test_fake_bank_provider_fetch_connection_unknown_item_raises_bank_item_not_found_error():
    fake = FakeBankProvider(
        connections=[ProviderConnection(item_id="i1", institution_name="Bank", status="UPDATED")]
    )
    with pytest.raises(BankItemNotFoundError):
        await fake.fetch_connection("unknown-item")


async def test_fake_bank_provider_filters_transactions_by_from_date_and_records_calls():
    older = ProviderTransaction(
        external_id="tx-old",
        date=date(2026, 1, 1),
        description="Old",
        amount_minor=-100,
        currency="BRL",
        status="POSTED",
        pluggy_category=None,
    )
    newer = ProviderTransaction(
        external_id="tx-new",
        date=date(2026, 1, 10),
        description="New",
        amount_minor=-200,
        currency="BRL",
        status="POSTED",
        pluggy_category=None,
    )
    fake = FakeBankProvider(transactions_by_account={"acc-1": [older, newer]})
    result = await fake.fetch_transactions("acc-1", from_date=date(2026, 1, 5))
    assert result == [newer]
    assert fake.transaction_calls == [("acc-1", date(2026, 1, 5))]


async def test_fake_bank_provider_raise_all_affects_every_method():
    fake = FakeBankProvider(raise_all=True)
    with pytest.raises(BankProviderError):
        await fake.fetch_connection("item-1")
    with pytest.raises(BankProviderError):
        await fake.fetch_accounts("item-1")
    with pytest.raises(BankProviderError):
        await fake.fetch_transactions("acc-1", from_date=date(2026, 1, 1))


async def test_fake_bank_provider_raise_for_items_affects_connection_and_accounts():
    fake = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-ok", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-ok": [], "item-bad": []},
        raise_for_items={"item-bad"},
    )
    assert await fake.fetch_connection("item-ok") == ProviderConnection(
        item_id="item-ok", institution_name="Bank", status="UPDATED"
    )
    assert await fake.fetch_accounts("item-ok") == []
    with pytest.raises(BankProviderError):
        await fake.fetch_connection("item-bad")
    with pytest.raises(BankProviderError):
        await fake.fetch_accounts("item-bad")


async def test_fake_bank_provider_raise_for_accounts_only_affects_that_account():
    fake = FakeBankProvider(
        transactions_by_account={"acc-ok": [], "acc-bad": []},
        raise_for_accounts={"acc-bad"},
    )
    assert await fake.fetch_transactions("acc-ok", from_date=date(2026, 1, 1)) == []
    with pytest.raises(BankProviderError):
        await fake.fetch_transactions("acc-bad", from_date=date(2026, 1, 1))


# --------------------------------------------------------------------------- #
# Task 2: merchant capture
# --------------------------------------------------------------------------- #


async def test_map_transaction_captures_merchant_name():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "t1",
                        "date": "2026-09-01T00:00:00.000Z",
                        "description": "NETFLIX.COM",
                        "amount": 19.90,
                        "currencyCode": "BRL",
                        "type": "DEBIT",
                        "status": "POSTED",
                        "merchant": {"name": "Netflix", "businessName": "Netflix Servicos"},
                    }
                ],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert result[0].merchant == "Netflix"


async def test_map_transaction_falls_back_to_business_name():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "t2",
                        "date": "2026-09-01T00:00:00.000Z",
                        "description": "SPOTIFY",
                        "amount": 21.90,
                        "currencyCode": "BRL",
                        "type": "DEBIT",
                        "status": "POSTED",
                        "merchant": {"businessName": "Spotify Brasil"},
                    }
                ],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert result[0].merchant == "Spotify Brasil"


async def test_map_transaction_merchant_absent_is_none():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "t3",
                        "date": "2026-09-01T00:00:00.000Z",
                        "description": "PIX",
                        "amount": 50.0,
                        "currencyCode": "BRL",
                        "type": "DEBIT",
                        "status": "POSTED",
                    }
                ],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-1", from_date=date(2026, 1, 1))
    assert result[0].merchant is None
