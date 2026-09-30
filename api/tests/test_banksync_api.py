"""Task 5 (Track T): `/api/v1/bank-sync` router — discovery, links (create/
delete/reconcile), on-demand sync, category mappings, and connection
deletion. Always drives `FakeBankProvider` via
`app.dependency_overrides[get_bank_provider]` — no real network call in this
suite. `BankSyncService` itself (link/import/anchor/reconcile logic) is
covered by test_bank_sync.py; this file is HTTP wiring: status codes, error
mapping, schema shape, auth."""

import uuid
from datetime import UTC, date, datetime

from pecunia.services.banksync.provider import (
    FakeBankProvider,
    ProviderAccount,
    ProviderConnection,
    ProviderTransaction,
)

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _auth(client):
    return {
        "Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"
    }


async def _account(client, h, *, currency="BRL", name="Manual", type="checking"):
    resp = await client.post(
        "/api/v1/accounts", json={"name": name, "type": type, "currency": currency}, headers=h
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _category(client, h, *, name="Food", kind="expense", color="#22d3ee"):
    resp = await client.post(
        "/api/v1/categories", json={"name": name, "kind": kind, "color": color}, headers=h
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _override(app, **kwargs):
    from pecunia.api.banksync import get_bank_provider

    fake = FakeBankProvider(**kwargs)
    app.dependency_overrides[get_bank_provider] = lambda: fake
    return fake


def _provider_account(pluggy_account_id="acc-1", *, type="BANK", subtype="CHECKING_ACCOUNT",
                       name="Checking", balance_minor=0, currency="BRL"):
    return ProviderAccount(
        pluggy_account_id=pluggy_account_id, item_id="item-1", type=type, subtype=subtype,
        name=name, number="0001", balance_minor=balance_minor, currency=currency,
        credit_limit_minor=None, bill_close_date=None, bill_due_date=None,
    )


# --------------------------------------------------------------------------- #
# GET /bank-sync/discovery
# --------------------------------------------------------------------------- #


async def test_discovery_requires_auth(client, initialized_instance):
    resp = await client.get("/api/v1/bank-sync/discovery")
    assert resp.status_code == 401


async def test_discovery_returns_503_without_credentials(client, initialized_instance):
    """No `get_bank_provider` override — default `Settings` has blank Pluggy
    credentials, so the dependency itself must 503 before any provider call."""
    h = await _auth(client)
    resp = await client.get("/api/v1/bank-sync/discovery", headers=h)
    assert resp.status_code == 503
    assert resp.json()["detail"] == "BANK_PROVIDER_UNAVAILABLE"


async def test_discovery_shape_and_linked_annotation(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={
            "item-1": [
                _provider_account("acc-1", balance_minor=0, currency="BRL"),
                _provider_account("acc-2", balance_minor=0, currency="BRL"),
            ]
        },
    )
    link_resp = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": account["id"],
        },
        headers=h,
    )
    assert link_resp.status_code == 201, link_resp.text

    resp = await client.get("/api/v1/bank-sync/discovery", headers=h)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    connection = body[0]
    assert connection["item_id"] == "item-1"
    assert connection["institution_name"] == "Bank"
    assert connection["status"] == "UPDATED"
    accounts_by_id = {a["pluggy_account_id"]: a for a in connection["accounts"]}
    assert accounts_by_id["acc-1"]["linked_account_id"] == account["id"]
    assert accounts_by_id["acc-2"]["linked_account_id"] is None
    assert accounts_by_id["acc-1"]["currency"] == "BRL"


async def test_discovery_provider_error_returns_503(client, app, initialized_instance):
    h = await _auth(client)
    _override(app, raise_all=True)
    resp = await client.get("/api/v1/bank-sync/discovery", headers=h)
    assert resp.status_code == 503
    assert resp.json()["detail"] == "BANK_PROVIDER_UNAVAILABLE"


# --------------------------------------------------------------------------- #
# POST /bank-sync/links
# --------------------------------------------------------------------------- #


async def test_create_link_requires_auth(client, initialized_instance):
    resp = await client.post(
        "/api/v1/bank-sync/links",
        json={"pluggy_item_id": "item-1", "pluggy_account_id": "acc-1", "sync_from": "2026-01-01"},
    )
    assert resp.status_code == 401


async def test_create_link_to_existing_account(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(balance_minor=500_00, currency="BRL")]},
        transactions_by_account={
            "acc-1": [
                ProviderTransaction(
                    external_id="tx-1", date=date(2026, 1, 5), description="Coffee",
                    amount_minor=-100_00, currency="BRL", status="POSTED", pluggy_category=None,
                )
            ]
        },
    )
    resp = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": account["id"],
        },
        headers=h,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["institution_name"] == "Bank"
    assert body["status"] == "ok"
    assert len(body["links"]) == 1
    link = body["links"][0]
    assert link["account_id"] == account["id"]
    assert link["pluggy_account_id"] == "acc-1"
    assert link["provider_balance_minor"] == 500_00
    assert link["derived_balance_minor"] == 500_00

    txs = (
        await client.get(
            "/api/v1/transactions", params={"account_id": account["id"]}, headers=h
        )
    ).json()["items"]
    assert len(txs) == 1
    assert txs[0]["is_imported"] is True


async def test_create_link_with_new_account(client, app, initialized_instance):
    h = await _auth(client)
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={
            "item-1": [_provider_account(name="Poupança", subtype="SAVINGS_ACCOUNT", currency="BRL", balance_minor=0)]
        },
    )
    resp = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "new_account": {"name": "My Savings"},
        },
        headers=h,
    )
    assert resp.status_code == 201, resp.text
    link = resp.json()["links"][0]
    assert link["account_name"] == "My Savings"
    assert link["account_currency"] == "BRL"


async def test_create_link_rejects_both_account_id_and_new_account(client, app, initialized_instance):
    h = await _auth(client)
    # A valid provider override — this test isolates the body validator, not
    # provider availability (with no override, the 503 from get_bank_provider
    # would pre-empt the body-validation 422 since dependencies are solved
    # before deferred body errors are raised).
    _override(app)
    resp = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1", "sync_from": "2026-01-01",
            "account_id": str(uuid.uuid4()), "new_account": {"name": "X"},
        },
        headers=h,
    )
    assert resp.status_code == 422


async def test_create_link_rejects_neither_account_id_nor_new_account(client, app, initialized_instance):
    h = await _auth(client)
    _override(app)
    resp = await client.post(
        "/api/v1/bank-sync/links",
        json={"pluggy_item_id": "item-1", "pluggy_account_id": "acc-1", "sync_from": "2026-01-01"},
        headers=h,
    )
    assert resp.status_code == 422


async def test_create_link_unknown_pluggy_account_returns_404(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h)
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": []},
    )
    resp = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-missing",
            "sync_from": "2026-01-01", "account_id": account["id"],
        },
        headers=h,
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "PLUGGY_ACCOUNT_NOT_FOUND"


async def test_create_link_unknown_account_id_returns_404(client, app, initialized_instance):
    h = await _auth(client)
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=0)]},
    )
    resp = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": str(uuid.uuid4()),
        },
        headers=h,
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "ACCOUNT_NOT_FOUND"


async def test_create_link_currency_mismatch_returns_422(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="USD")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=0)]},
    )
    resp = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": account["id"],
        },
        headers=h,
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "CURRENCY_MISMATCH"


async def test_create_link_account_already_linked_returns_409(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={
            "item-1": [
                _provider_account("acc-1", currency="BRL", balance_minor=0),
                _provider_account("acc-2", currency="BRL", balance_minor=0),
            ]
        },
    )
    first = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": account["id"],
        },
        headers=h,
    )
    assert first.status_code == 201
    second = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-2",
            "sync_from": "2026-01-01", "account_id": account["id"],
        },
        headers=h,
    )
    assert second.status_code == 409
    assert second.json()["detail"] == "ACCOUNT_ALREADY_LINKED"


async def test_create_link_pluggy_account_already_linked_returns_409(client, app, initialized_instance):
    h = await _auth(client)
    account_a = await _account(client, h, currency="BRL", name="A")
    account_b = await _account(client, h, currency="BRL", name="B")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=0)]},
    )
    first = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": account_a["id"],
        },
        headers=h,
    )
    assert first.status_code == 201
    second = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": account_b["id"],
        },
        headers=h,
    )
    assert second.status_code == 409
    assert second.json()["detail"] == "PLUGGY_ACCOUNT_ALREADY_LINKED"


async def test_create_link_provider_error_returns_503(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(app, raise_all=True)
    resp = await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": account["id"],
        },
        headers=h,
    )
    assert resp.status_code == 503
    assert resp.json()["detail"] == "BANK_PROVIDER_UNAVAILABLE"


# --------------------------------------------------------------------------- #
# GET /bank-sync/connections, DELETE /bank-sync/connections/{id}
# --------------------------------------------------------------------------- #


async def test_list_connections_requires_auth(client, initialized_instance):
    resp = await client.get("/api/v1/bank-sync/connections")
    assert resp.status_code == 401


async def test_list_connections_works_offline_without_provider_override(client, app, initialized_instance):
    """No `get_bank_provider` override is installed at all — this route must
    not depend on it (stored state only)."""
    h = await _auth(client)
    resp = await client.get("/api/v1/bank-sync/connections", headers=h)
    assert resp.status_code == 200
    assert resp.json() == []


async def test_list_connections_shows_linked_account(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=0)]},
    )
    await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": account["id"],
        },
        headers=h,
    )
    resp = await client.get("/api/v1/bank-sync/connections", headers=h)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["links"][0]["account_id"] == account["id"]


async def test_delete_connection_requires_auth(client, initialized_instance):
    resp = await client.delete(f"/api/v1/bank-sync/connections/{uuid.uuid4()}")
    assert resp.status_code == 401


async def test_delete_connection_not_found_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.delete(f"/api/v1/bank-sync/connections/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CONNECTION_NOT_FOUND"


async def test_delete_connection_removes_it(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=0)]},
    )
    created = (
        await client.post(
            "/api/v1/bank-sync/links",
            json={
                "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
                "sync_from": "2026-01-01", "account_id": account["id"],
            },
            headers=h,
        )
    ).json()
    resp = await client.delete(f"/api/v1/bank-sync/connections/{created['id']}", headers=h)
    assert resp.status_code == 204
    listed = (await client.get("/api/v1/bank-sync/connections", headers=h)).json()
    assert listed == []


# --------------------------------------------------------------------------- #
# DELETE /bank-sync/links/{link_id}
# --------------------------------------------------------------------------- #


async def test_delete_link_requires_auth(client, initialized_instance):
    resp = await client.delete(f"/api/v1/bank-sync/links/{uuid.uuid4()}")
    assert resp.status_code == 401


async def test_delete_link_not_found_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.delete(f"/api/v1/bank-sync/links/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "LINK_NOT_FOUND"


async def test_delete_link_removes_it_but_keeps_connection(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=0)]},
    )
    created = (
        await client.post(
            "/api/v1/bank-sync/links",
            json={
                "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
                "sync_from": "2026-01-01", "account_id": account["id"],
            },
            headers=h,
        )
    ).json()
    link_id = created["links"][0]["id"]
    resp = await client.delete(f"/api/v1/bank-sync/links/{link_id}", headers=h)
    assert resp.status_code == 204
    listed = (await client.get("/api/v1/bank-sync/connections", headers=h)).json()
    assert len(listed) == 1
    assert listed[0]["links"] == []


# --------------------------------------------------------------------------- #
# POST /bank-sync/links/{link_id}/reconcile
# --------------------------------------------------------------------------- #


async def test_reconcile_requires_auth(client, initialized_instance):
    resp = await client.post(f"/api/v1/bank-sync/links/{uuid.uuid4()}/reconcile")
    assert resp.status_code == 401


async def test_reconcile_link_not_found_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(f"/api/v1/bank-sync/links/{uuid.uuid4()}/reconcile", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "LINK_NOT_FOUND"


async def test_reconcile_returns_204_when_gap_is_zero(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=0)]},
    )
    created = (
        await client.post(
            "/api/v1/bank-sync/links",
            json={
                "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
                "sync_from": "2026-01-01", "account_id": account["id"],
            },
            headers=h,
        )
    ).json()
    link_id = created["links"][0]["id"]
    resp = await client.post(f"/api/v1/bank-sync/links/{link_id}/reconcile", headers=h)
    assert resp.status_code == 204
    assert resp.content == b""


async def test_reconcile_returns_200_with_transaction_when_gap_nonzero(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=500_00)]},
    )
    created = (
        await client.post(
            "/api/v1/bank-sync/links",
            json={
                "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
                "sync_from": "2026-01-01", "account_id": account["id"],
            },
            headers=h,
        )
    ).json()
    link_id = created["links"][0]["id"]
    # Drift the derived balance away from the frozen provider_balance_minor
    # with a manual transaction the sync never sees.
    await client.post(
        "/api/v1/transactions",
        json={
            "account_id": account["id"], "amount_minor": -50_00, "currency": "BRL",
            "description": "Manual", "occurred_on": "2026-02-01",
        },
        headers=h,
    )
    resp = await client.post(f"/api/v1/bank-sync/links/{link_id}/reconcile", headers=h)
    assert resp.status_code == 200
    body = resp.json()
    assert body["amount_minor"] == 50_00
    assert body["account_id"] == account["id"]


# --------------------------------------------------------------------------- #
# POST /bank-sync/sync
# --------------------------------------------------------------------------- #


async def test_sync_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/bank-sync/sync")
    assert resp.status_code == 401


async def test_sync_returns_503_without_credentials(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post("/api/v1/bank-sync/sync", headers=h)
    assert resp.status_code == 503
    assert resp.json()["detail"] == "BANK_PROVIDER_UNAVAILABLE"


async def test_sync_returns_summary_with_no_connections(client, app, initialized_instance):
    h = await _auth(client)
    _override(app, connections=[])
    resp = await client.post("/api/v1/bank-sync/sync", headers=h)
    assert resp.status_code == 200
    assert resp.json() == {"connections": 0, "created": 0, "skipped": 0, "errors": []}


async def test_sync_imports_new_transactions_for_a_linked_account(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=0)]},
    )
    await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": account["id"],
        },
        headers=h,
    )
    # Re-override with a fresh fake exposing a transaction the initial link
    # sync couldn't have seen (it ran before this override existed). Dated
    # near "now" (not the fixed sync_from floor) — a resync's window is the
    # last 7 days before last_synced_at, not the account's full history, so
    # anything further back than that would be (correctly) filtered out.
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={
            "acc-1": [
                ProviderTransaction(
                    external_id="tx-new", date=datetime.now(UTC).date(), description="Groceries",
                    amount_minor=-20_00, currency="BRL", status="POSTED", pluggy_category=None,
                )
            ]
        },
    )
    resp = await client.post("/api/v1/bank-sync/sync", headers=h)
    assert resp.status_code == 200
    body = resp.json()
    assert body["connections"] == 1
    assert body["created"] == 1
    assert body["errors"] == []


async def test_sync_provider_error_returns_503(client, app, initialized_instance):
    h = await _auth(client)
    account = await _account(client, h, currency="BRL")
    _override(
        app,
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_provider_account(currency="BRL", balance_minor=0)]},
    )
    await client.post(
        "/api/v1/bank-sync/links",
        json={
            "pluggy_item_id": "item-1", "pluggy_account_id": "acc-1",
            "sync_from": "2026-01-01", "account_id": account["id"],
        },
        headers=h,
    )
    _override(app, raise_all=True)
    resp = await client.post("/api/v1/bank-sync/sync", headers=h)
    assert resp.status_code == 503
    assert resp.json()["detail"] == "BANK_PROVIDER_UNAVAILABLE"


# --------------------------------------------------------------------------- #
# GET/PUT /bank-sync/category-mappings
# --------------------------------------------------------------------------- #


async def test_list_mappings_requires_auth(client, initialized_instance):
    resp = await client.get("/api/v1/bank-sync/category-mappings")
    assert resp.status_code == 401


async def test_replace_mappings_requires_auth(client, initialized_instance):
    resp = await client.put("/api/v1/bank-sync/category-mappings", json={"mappings": []})
    assert resp.status_code == 401


async def test_list_mappings_empty_by_default(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get("/api/v1/bank-sync/category-mappings", headers=h)
    assert resp.status_code == 200
    assert resp.json() == []


async def test_replace_mappings_round_trips(client, initialized_instance):
    h = await _auth(client)
    category = await _category(client, h, name="Food")
    put_resp = await client.put(
        "/api/v1/bank-sync/category-mappings",
        json={"mappings": [{"pluggy_category": "Food", "category_id": category["id"]}]},
        headers=h,
    )
    assert put_resp.status_code == 200
    assert put_resp.json() == [{"pluggy_category": "Food", "category_id": category["id"]}]

    get_resp = await client.get("/api/v1/bank-sync/category-mappings", headers=h)
    assert get_resp.json() == [{"pluggy_category": "Food", "category_id": category["id"]}]


async def test_replace_mappings_unknown_category_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.put(
        "/api/v1/bank-sync/category-mappings",
        json={"mappings": [{"pluggy_category": "Food", "category_id": str(uuid.uuid4())}]},
        headers=h,
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CATEGORY_NOT_FOUND"


async def test_replace_mappings_replaces_previous_set(client, initialized_instance):
    h = await _auth(client)
    category_a = await _category(client, h, name="Food")
    category_b = await _category(client, h, name="Fuel")
    await client.put(
        "/api/v1/bank-sync/category-mappings",
        json={"mappings": [{"pluggy_category": "Food", "category_id": category_a["id"]}]},
        headers=h,
    )
    resp = await client.put(
        "/api/v1/bank-sync/category-mappings",
        json={"mappings": [{"pluggy_category": "Fuel", "category_id": category_b["id"]}]},
        headers=h,
    )
    assert resp.status_code == 200
    assert resp.json() == [{"pluggy_category": "Fuel", "category_id": category_b["id"]}]
    listed = (await client.get("/api/v1/bank-sync/category-mappings", headers=h)).json()
    assert listed == [{"pluggy_category": "Fuel", "category_id": category_b["id"]}]
