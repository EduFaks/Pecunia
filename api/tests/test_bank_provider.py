"""Task 2 (Track T): `BankProvider` protocol, its `PluggyProvider`
implementation, and `FakeBankProvider`. `PluggyProvider`'s tests mock the
httpx transport — no real network call ever runs in this suite (CONVENTIONS:
the provider is injected everywhere else so callers pass a fake)."""

import json
from datetime import date

import httpx
import pytest

from pecunia.services.banksync.provider import (
    PLUGGY_BASE_URL,
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
        if request.url.path == "/v2/items":
            return httpx.Response(200, json={"results": [], "next": None})
        if request.url.path == "/accounts":
            return httpx.Response(200, json={"results": []})
        raise AssertionError(f"unexpected path {request.url.path}")

    provider = _provider(handler)
    await provider.fetch_connections()
    await provider.fetch_accounts("item-1")
    assert calls["auth"] == 1


async def test_auth_body_sends_client_id_and_secret():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(200, json={"results": [], "next": None})

    provider = _provider(handler)
    await provider.fetch_connections()
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
        assert request.url.path == "/v2/items"
        calls["items"] += 1
        if calls["items"] == 1:
            return httpx.Response(401, json={"message": "expired"})
        assert request.headers["X-API-KEY"] == "key-2"
        return httpx.Response(
            200,
            json={
                "results": [{"id": "i1", "status": "UPDATED", "connector": {"name": "Bank"}}],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_connections()
    assert result == [ProviderConnection(item_id="i1", institution_name="Bank", status="UPDATED")]
    assert calls["auth"] == 2
    assert calls["items"] == 2


async def test_second_401_after_reauth_raises_bank_provider_error():
    calls = {"auth": 0, "items": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            calls["auth"] += 1
            return httpx.Response(200, json={"apiKey": f"key-{calls['auth']}"})
        assert request.url.path == "/v2/items"
        calls["items"] += 1
        return httpx.Response(401, json={"message": "expired"})

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connections()
    assert calls["auth"] == 2
    assert calls["items"] == 2


# --------------------------------------------------------------------------- #
# Pagination: all three `next` shapes, aggregated
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
                    "results": [{"id": "i1", "status": "UPDATED", "connector": {"name": "A"}}],
                    "next": "https://api.pluggy.ai/v2/items?after=tok-1&pageSize=500",
                },
            )
        assert params["after"] == "tok-1"
        return httpx.Response(
            200,
            json={
                "results": [{"id": "i2", "status": "OUTDATED", "connector": {"name": "B"}}],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_connections()
    assert result == [
        ProviderConnection(item_id="i1", institution_name="A", status="UPDATED"),
        ProviderConnection(item_id="i2", institution_name="B", status="OUTDATED"),
    ]


async def test_pagination_follows_next_as_a_bare_query_string():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        params = dict(request.url.params)
        if "after" not in params:
            return httpx.Response(
                200,
                json={
                    "results": [{"id": "i1", "status": "UPDATED", "connector": {"name": "A"}}],
                    "next": "?after=tok-2&pageSize=500",
                },
            )
        assert params["after"] == "tok-2"
        return httpx.Response(
            200,
            json={
                "results": [{"id": "i2", "status": "OUTDATED", "connector": {"name": "B"}}],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_connections()
    assert [c.item_id for c in result] == ["i1", "i2"]


async def test_pagination_follows_next_as_a_bare_token():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        params = dict(request.url.params)
        if "after" not in params:
            return httpx.Response(
                200,
                json={
                    "results": [{"id": "i1", "status": "UPDATED", "connector": {"name": "A"}}],
                    "next": "tok-3",
                },
            )
        assert params["after"] == "tok-3"
        return httpx.Response(
            200,
            json={
                "results": [{"id": "i2", "status": "OUTDATED", "connector": {"name": "B"}}],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_connections()
    assert [c.item_id for c in result] == ["i1", "i2"]


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
                200,
                json={
                    "results": [{"id": "i1", "status": "UPDATED", "connector": {"name": "A"}}],
                    "next": "after=tok-3",
                },
            )
        assert params["after"] == "tok-3"
        return httpx.Response(
            200,
            json={
                "results": [{"id": "i2", "status": "OUTDATED", "connector": {"name": "B"}}],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_connections()
    assert [c.item_id for c in result] == ["i1", "i2"]


async def test_pagination_terminates_when_next_key_is_missing():
    """Pagination should terminate when the response has no 'next' key at all,
    same as if next is null."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200,
            json={
                "results": [{"id": "i1", "status": "UPDATED", "connector": {"name": "A"}}],
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_connections()
    assert [c.item_id for c in result] == ["i1"]


async def test_pagination_first_page_requests_page_size_500():
    seen_params = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        seen_params.update(dict(request.url.params))
        return httpx.Response(200, json={"results": [], "next": None})

    provider = _provider(handler)
    await provider.fetch_connections()
    assert seen_params["pageSize"] == "500"


# --------------------------------------------------------------------------- #
# fetch_connections — missing connector fallback
# --------------------------------------------------------------------------- #


async def test_fetch_connections_falls_back_to_empty_institution_name():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(
            200, json={"results": [{"id": "i1", "status": "LOGIN_ERROR"}], "next": None}
        )

    provider = _provider(handler)
    result = await provider.fetch_connections()
    assert result == [ProviderConnection(item_id="i1", institution_name="", status="LOGIN_ERROR")]


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
# fetch_transactions — sign matrix, PENDING passthrough, category
# --------------------------------------------------------------------------- #


async def test_fetch_transactions_bank_debit_is_negative_and_credit_is_positive():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        assert request.url.path == "/v2/transactions"
        params = dict(request.url.params)
        assert params["accountId"] == "acc-1"
        assert params["from"] == "2026-01-01"
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "tx-1",
                        "description": "Groceries",
                        "amount": 50.0,
                        "date": "2026-01-05T12:00:00.000Z",
                        "currencyCode": "BRL",
                        "status": "POSTED",
                        "type": "DEBIT",
                        "category": "Food",
                    },
                    {
                        "id": "tx-2",
                        "description": "Salary",
                        "amount": 1000.0,
                        "date": "2026-01-06T12:00:00.000Z",
                        "currencyCode": "BRL",
                        "status": "POSTED",
                        "type": "CREDIT",
                        "category": None,
                    },
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
                    {
                        "id": "tx-3",
                        "description": "Store purchase",
                        "amount": 100.0,
                        "date": "2026-01-07T12:00:00.000Z",
                        "currencyCode": "BRL",
                        "status": "POSTED",
                        "type": "DEBIT",
                        "category": "Shopping",
                    },
                    {
                        "id": "tx-4",
                        "description": "Card payment",
                        "amount": 200.0,
                        "date": "2026-01-08T12:00:00.000Z",
                        "currencyCode": "BRL",
                        "status": "POSTED",
                        "type": "CREDIT",
                        "category": None,
                    },
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
                    {
                        "id": "tx-5",
                        "description": "Pending charge",
                        "amount": 30.0,
                        "date": "2026-01-09T12:00:00.000Z",
                        "currencyCode": "BRL",
                        "status": "PENDING",
                        "type": "DEBIT",
                        "category": None,
                    }
                ],
                "next": None,
            },
        )

    provider = _provider(handler)
    result = await provider.fetch_transactions("acc-x", from_date=date(2026, 1, 1))
    assert result[0].status == "PENDING"


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
        await provider.fetch_connections()


async def test_invalid_json_body_raises_bank_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        return httpx.Response(200, content=b"not json")

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connections()


async def test_timeout_raises_bank_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            return httpx.Response(200, json={"apiKey": "key-1"})
        raise httpx.TimeoutException("timed out", request=request)

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connections()


async def test_auth_failure_status_raises_bank_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/auth"
        return httpx.Response(500, json={"error": "boom"})

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connections()


async def test_auth_response_missing_api_key_raises_bank_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/auth"
        return httpx.Response(200, json={"unexpected": "shape"})

    provider = _provider(handler)
    with pytest.raises(BankProviderError):
        await provider.fetch_connections()


# --------------------------------------------------------------------------- #
# FakeBankProvider
# --------------------------------------------------------------------------- #


async def test_fake_bank_provider_returns_canned_connections_and_accounts():
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
    assert await fake.fetch_connections() == [conn]
    assert await fake.fetch_accounts("i1") == [account]
    assert await fake.fetch_accounts("unknown-item") == []


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
        await fake.fetch_connections()
    with pytest.raises(BankProviderError):
        await fake.fetch_accounts("item-1")
    with pytest.raises(BankProviderError):
        await fake.fetch_transactions("acc-1", from_date=date(2026, 1, 1))


async def test_fake_bank_provider_raise_for_items_only_affects_that_item():
    fake = FakeBankProvider(
        accounts_by_item={"item-ok": [], "item-bad": []},
        raise_for_items={"item-bad"},
    )
    assert await fake.fetch_accounts("item-ok") == []
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
