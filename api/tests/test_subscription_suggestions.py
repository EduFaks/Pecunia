import uuid
from datetime import date

from pecunia.models import Account
from pecunia.services.subscriptions import SubscriptionService
from pecunia.services.transactions import TransactionService

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _auth(client):
    return {
        "Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"
    }


async def _svc_account(db, ws_id, *, currency="BRL", name="Checking"):
    account = Account(id=uuid.uuid4(), workspace_id=ws_id, name=name, type="checking", currency=currency)
    db.add(account)
    await db.flush()
    return account


async def test_suggestions_detect_recurring_imported_charges(client, initialized_instance, db):
    """Three monthly Netflix charges via TransactionService.create with
    external_id and merchant are detected as one suggestion candidate."""
    h = await _auth(client)
    ws_id = initialized_instance["workspace_id"]

    # Create an account and three imported Netflix charges.
    account = await _svc_account(db, ws_id)
    svc = TransactionService(db)
    await svc.create(
        ws_id,
        account_id=account.id,
        amount_minor=-1990,
        currency="BRL",
        description="NETFLIX",
        occurred_on=date(2026, 7, 5),
        external_id="netflix-1",
        merchant="Netflix",
    )
    await svc.create(
        ws_id,
        account_id=account.id,
        amount_minor=-1990,
        currency="BRL",
        description="NETFLIX",
        occurred_on=date(2026, 8, 5),
        external_id="netflix-2",
        merchant="Netflix",
    )
    await svc.create(
        ws_id,
        account_id=account.id,
        amount_minor=-1990,
        currency="BRL",
        description="NETFLIX",
        occurred_on=date(2026, 9, 5),
        external_id="netflix-3",
        merchant="Netflix",
    )
    await db.commit()

    # GET /subscriptions/suggestions
    resp = await client.get("/api/v1/subscriptions/suggestions", headers=h)
    assert resp.status_code == 200
    suggestions = resp.json()
    assert len(suggestions) == 1

    c = suggestions[0]
    assert c["merchant"] == "Netflix"
    assert c["suggested_name"] == "Netflix"
    assert c["amount_minor"] == 1990  # positive magnitude
    assert c["currency"] == "BRL"
    assert c["billing_frequency"] == "monthly"
    assert c["occurrences"] == 3
    assert c["first_seen"] == "2026-07-05"
    assert c["last_seen"] == "2026-09-05"
    assert c["suggested_next_renewal"] == "2026-10-05"
    assert c["suggested_category_id"] is None
    assert c["suggested_account_id"] == str(account.id)


async def test_suggestions_excludes_existing_active_subscription(client, initialized_instance, db):
    """When an active subscription for Netflix/BRL/1990/monthly exists,
    the same recurring charges should NOT appear in suggestions."""
    h = await _auth(client)
    ws_id = initialized_instance["workspace_id"]

    # Create the subscription service and add an active Netflix subscription.
    sub_svc = SubscriptionService(db)
    await sub_svc.create(
        ws_id,
        name="Netflix",
        amount_minor=1990,
        currency="BRL",
        billing_frequency="monthly",
        next_renewal=date(2026, 10, 5),
    )

    # Create the same three imported charges.
    account = await _svc_account(db, ws_id)
    txn_svc = TransactionService(db)
    await txn_svc.create(
        ws_id,
        account_id=account.id,
        amount_minor=-1990,
        currency="BRL",
        description="NETFLIX",
        occurred_on=date(2026, 7, 5),
        external_id="netflix-1",
        merchant="Netflix",
    )
    await txn_svc.create(
        ws_id,
        account_id=account.id,
        amount_minor=-1990,
        currency="BRL",
        description="NETFLIX",
        occurred_on=date(2026, 8, 5),
        external_id="netflix-2",
        merchant="Netflix",
    )
    await txn_svc.create(
        ws_id,
        account_id=account.id,
        amount_minor=-1990,
        currency="BRL",
        description="NETFLIX",
        occurred_on=date(2026, 9, 5),
        external_id="netflix-3",
        merchant="Netflix",
    )
    await db.commit()

    # GET /subscriptions/suggestions should return empty (existing sub suppresses it).
    resp = await client.get("/api/v1/subscriptions/suggestions", headers=h)
    assert resp.status_code == 200
    suggestions = resp.json()
    assert suggestions == []
