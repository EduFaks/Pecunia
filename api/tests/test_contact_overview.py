import uuid
from datetime import UTC, date, datetime

import sqlalchemy as sa

from pecunia.models import (
    Account,
    Category,
    Contact,
    Transaction,
    Transfer,
    Workspace,
    WorkspaceMembership,
)
from pecunia.services.analytics import AnalyticsService

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}

FROM = date(2026, 3, 1)
TO = date(2026, 3, 31)


async def _auth(client):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def _account(db, ws_id, *, currency="USD", name="Acc"):
    acc = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, type="checking",
        currency=currency, initial_balance_minor=0,
    )
    db.add(acc)
    await db.flush()
    return acc


async def _tx(
    db, ws_id, account, *, amount, on, currency="USD",
    deleted=False, category_id=None, contact_id=None, transfer_id=None,
):
    tx = Transaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account.id,
        amount_minor=amount, currency=currency, description="t", occurred_on=on,
        category_id=category_id, contact_id=contact_id, transfer_id=transfer_id,
        deleted_at=datetime.now(UTC) if deleted else None,
    )
    db.add(tx)
    await db.flush()
    return tx


async def _category(db, ws_id, *, name, kind="expense", color="#22d3ee"):
    cat = Category(id=uuid.uuid4(), workspace_id=ws_id, name=name, kind=kind, color=color)
    db.add(cat)
    await db.flush()
    return cat


async def _contact(db, ws_id, *, name):
    contact = Contact(id=uuid.uuid4(), workspace_id=ws_id, name=name)
    db.add(contact)
    await db.flush()
    return contact


async def _transfer_leg_with_contact(db, ws_id, from_acc, to_acc, contact, *, amount, on):
    """A transfer whose out-leg carries this contact — the overview must still
    exclude it (a transfer leg is not spend/income), proving `transfer_id IS
    NULL` filters it regardless of the contact link."""
    transfer = Transfer(
        id=uuid.uuid4(), workspace_id=ws_id,
        from_account_id=from_acc.id, to_account_id=to_acc.id,
        amount_minor=amount, currency="USD", description="xfer", occurred_on=on,
    )
    db.add(transfer)
    await db.flush()
    await _tx(db, ws_id, from_acc, amount=-amount, on=on, transfer_id=transfer.id, contact_id=contact.id)
    await _tx(db, ws_id, to_acc, amount=amount, on=on, transfer_id=transfer.id, contact_id=contact.id)
    return transfer


async def _other_workspace(db, user_factory):
    other = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other.id, role="owner"))
    await db.flush()
    return other_ws


# ------------------------------------------------------------------ service


async def test_contact_overview_in_out_net_count_and_by_category(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, name="A")
    acc_b = await _account(db, ws_id, name="B")
    acme = await _contact(db, ws_id, name="Acme")
    groceries = await _category(db, ws_id, name="OvGroceries", color="#22d3ee")
    salary = await _category(db, ws_id, name="OvSalary", kind="income", color="#a78bfa")

    # in: 5_000 (salary) ; out: 3_000 (groceries) + 1_000 (uncategorized) = 4_000 ; count 3
    await _tx(db, ws_id, acc, amount=5_000, on=date(2026, 3, 2), category_id=salary.id, contact_id=acme.id)
    await _tx(db, ws_id, acc, amount=-3_000, on=date(2026, 3, 3), category_id=groceries.id, contact_id=acme.id)
    await _tx(db, ws_id, acc, amount=-1_000, on=date(2026, 3, 4), contact_id=acme.id)  # uncategorized
    # excluded: soft-deleted, transfer leg (both with this contact), other contact
    await _tx(db, ws_id, acc, amount=-9_999, on=date(2026, 3, 5), category_id=groceries.id, contact_id=acme.id, deleted=True)
    await _transfer_leg_with_contact(db, ws_id, acc, acc_b, acme, amount=8_000, on=date(2026, 3, 6))
    other = await _contact(db, ws_id, name="Other")
    await _tx(db, ws_id, acc, amount=-2_000, on=date(2026, 3, 7), contact_id=other.id)

    overview = await AnalyticsService(db).contact_overview(
        ws_id, acme.id, from_date=FROM, to_date=TO
    )

    assert set(overview) == {"USD"}
    usd = overview["USD"]
    assert usd["money_in_minor"] == 5_000
    assert usd["money_out_minor"] == 4_000
    assert usd["net_minor"] == 1_000
    assert usd["transaction_count"] == 3
    # by-category: sorted by out desc — groceries (3_000), uncategorized (1_000),
    # then the income-only salary bucket last.
    by_cat = usd["by_category"]
    assert by_cat[0] == {"category_id": groceries.id, "name": "OvGroceries", "color": "#22d3ee", "in_minor": 0, "out_minor": 3_000}
    assert by_cat[1] == {"category_id": None, "name": "Uncategorized", "color": None, "in_minor": 0, "out_minor": 1_000}
    assert by_cat[2] == {"category_id": salary.id, "name": "OvSalary", "color": "#a78bfa", "in_minor": 5_000, "out_minor": 0}


async def test_contact_overview_excludes_transfers_and_soft_deleted(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, name="A")
    acc_b = await _account(db, ws_id, name="B")
    contact = await _contact(db, ws_id, name="Acme")
    # one real expense keeps the currency present; everything else is excluded
    await _tx(db, ws_id, acc, amount=-1_000, on=date(2026, 3, 2), contact_id=contact.id)
    await _tx(db, ws_id, acc, amount=-50_000, on=date(2026, 3, 3), contact_id=contact.id, deleted=True)
    await _transfer_leg_with_contact(db, ws_id, acc, acc_b, contact, amount=99_000, on=date(2026, 3, 4))

    overview = await AnalyticsService(db).contact_overview(
        ws_id, contact.id, from_date=FROM, to_date=TO
    )

    usd = overview["USD"]
    assert usd["money_out_minor"] == 1_000  # not 51_000, not 100_000
    assert usd["money_in_minor"] == 0
    assert usd["transaction_count"] == 1


async def test_contact_overview_is_per_currency(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    usd_acc = await _account(db, ws_id, currency="USD", name="U")
    eur_acc = await _account(db, ws_id, currency="EUR", name="E")
    contact = await _contact(db, ws_id, name="Acme")
    await _tx(db, ws_id, usd_acc, amount=-1_000, on=date(2026, 3, 2), contact_id=contact.id)
    await _tx(db, ws_id, eur_acc, amount=-800, on=date(2026, 3, 3), currency="EUR", contact_id=contact.id)

    overview = await AnalyticsService(db).contact_overview(
        ws_id, contact.id, from_date=FROM, to_date=TO
    )

    assert set(overview) == {"USD", "EUR"}
    assert overview["USD"]["money_out_minor"] == 1_000
    assert overview["EUR"]["money_out_minor"] == 800  # never summed into USD


async def test_contact_overview_is_workspace_scoped(db, initialized_instance, user_factory):
    """A contact and its transactions live in one workspace; querying that
    contact under a *different* workspace_id surfaces nothing (the workspace
    filter is applied alongside the contact filter)."""
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, name="A")
    contact = await _contact(db, ws_id, name="Acme")
    await _tx(db, ws_id, acc, amount=-1_000, on=date(2026, 3, 2), contact_id=contact.id)
    other_ws = await _other_workspace(db, user_factory)

    overview = await AnalyticsService(db).contact_overview(
        other_ws.id, contact.id, from_date=FROM, to_date=TO
    )
    assert overview == {}


# ------------------------------------------------------------------ endpoint


async def test_contact_overview_endpoint_requires_auth(client, initialized_instance):
    resp = await client.get(f"/api/v1/contacts/{uuid.uuid4()}/overview")
    assert resp.status_code == 401


async def test_contact_overview_endpoint_returns_shape(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, name="A")
    contact = await _contact(db, ws_id, name="Acme")
    await _tx(db, ws_id, acc, amount=5_000, on=date(2026, 3, 2), contact_id=contact.id)
    await _tx(db, ws_id, acc, amount=-2_000, on=date(2026, 3, 3), contact_id=contact.id)
    await db.commit()
    h = await _auth(client)

    resp = await client.get(
        f"/api/v1/contacts/{contact.id}/overview",
        params={"from": "2026-03-01", "to": "2026-03-31"},
        headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["USD"]["money_in_minor"] == 5_000
    assert body["USD"]["money_out_minor"] == 2_000
    assert body["USD"]["net_minor"] == 3_000
    assert body["USD"]["transaction_count"] == 2
    assert isinstance(body["USD"]["by_category"], list)


async def test_contact_overview_endpoint_default_range_ok(client, db, initialized_instance):
    """Omitting from/to falls back to the router's last-12-months default."""
    ws_id = await _ws_id(db, initialized_instance)
    contact = await _contact(db, ws_id, name="Acme")
    await db.commit()
    h = await _auth(client)

    resp = await client.get(f"/api/v1/contacts/{contact.id}/overview", headers=h)
    assert resp.status_code == 200
    assert isinstance(resp.json(), dict)


async def test_contact_overview_endpoint_404_for_missing_contact(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get(f"/api/v1/contacts/{uuid.uuid4()}/overview", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CONTACT_NOT_FOUND"


async def test_contact_overview_endpoint_404_for_foreign_contact(
    client, db, initialized_instance, user_factory
):
    """A contact in another workspace is a 404 for this workspace, never a
    peek into its data."""
    from pecunia.services.categories import seed_default_categories

    other_ws = await _other_workspace(db, user_factory)
    await seed_default_categories(db, other_ws.id)
    foreign_contact = await _contact(db, other_ws.id, name="Foreign")
    await db.commit()
    h = await _auth(client)

    resp = await client.get(f"/api/v1/contacts/{foreign_contact.id}/overview", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CONTACT_NOT_FOUND"
