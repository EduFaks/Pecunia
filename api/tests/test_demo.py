import uuid

import sqlalchemy as sa

from pecunia.models import (
    Account,
    ActivityEntry,
    Asset,
    AssetValuation,
    AuditEvent,
    Budget,
    Category,
    Contact,
    Project,
    ProjectItem,
    Transaction,
    WorkspaceMembership,
)

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}

# All 7 finance tables, matching the demo response's `counts` keys.
DOMAIN_TABLES = (Account, Transaction, Project, ProjectItem, Asset, AssetValuation, Budget)
# Tables that carry a currency column (project_items/asset_valuations don't).
CURRENCIED_TABLES = (Account, Transaction, Project, Asset, Budget)


async def _auth(client, initialized_instance):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def _workspace_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def test_seed_creates_full_dataset_in_base_currency(client, initialized_instance, db):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/demo", headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["present"] is True
    counts = body["counts"]
    assert counts == {
        "accounts": 3,
        # 22 ordinary transactions + 2 transfer legs (the one demo transfer)
        "transactions": 24,
        "projects": 1,
        "project_items": 3,
        "assets": 1,
        "asset_valuations": 3,
        "budgets": 1,
    }

    ws_id = await _workspace_id(db, initialized_instance)

    for model in DOMAIN_TABLES:
        rows = (await db.execute(sa.select(model).where(model.workspace_id == ws_id))).scalars().all()
        assert rows, f"{model.__name__} has no demo rows"
        assert all(r.is_demo for r in rows), f"{model.__name__} has a non-demo row"

    for model in CURRENCIED_TABLES:
        rows = (await db.execute(sa.select(model).where(model.workspace_id == ws_id))).scalars().all()
        assert all(r.currency == "BRL" for r in rows), f"{model.__name__} not in base currency"

    # account types cover checking/savings/credit_card
    account_types = {
        a.type for a in (await db.execute(sa.select(Account).where(Account.workspace_id == ws_id))).scalars()
    }
    assert account_types == {"checking", "savings", "credit_card"}

    # the project's items reach its target
    project = (await db.execute(sa.select(Project).where(Project.workspace_id == ws_id))).scalar_one()
    items = (
        await db.execute(sa.select(ProjectItem).where(ProjectItem.project_id == project.id))
    ).scalars().all()
    assert sum(i.amount_minor for i in items) >= project.target_amount_minor

    # the asset's valuations show a decline over time
    asset = (await db.execute(sa.select(Asset).where(Asset.workspace_id == ws_id))).scalar_one()
    assert asset.type == "vehicle"
    vals = (
        await db.execute(
            sa.select(AssetValuation).where(AssetValuation.asset_id == asset.id).order_by(AssetValuation.as_of)
        )
    ).scalars().all()
    assert len(vals) >= 2
    assert vals[0].value_minor > vals[-1].value_minor

    # transactions span roughly the last 2 months and mix inflow/outflow
    txns = (
        await db.execute(sa.select(Transaction).where(Transaction.workspace_id == ws_id))
    ).scalars().all()
    assert any(t.amount_minor > 0 for t in txns)
    assert any(t.amount_minor < 0 for t in txns)


async def test_seed_gives_every_transaction_a_contact_entity(client, initialized_instance, db):
    """Contacts are first-class entities (no free-text contact string): the demo
    dataset must promote every transaction's contact to a Contact row and set
    contact_id on the transaction. Regression guard — demo transactions used to
    show no contact once the free-text column was dropped."""
    h = await _auth(client, initialized_instance)
    assert (await client.post("/api/v1/demo", headers=h)).status_code == 201
    ws_id = await _workspace_id(db, initialized_instance)

    contacts = (
        await db.execute(sa.select(Contact).where(Contact.workspace_id == ws_id))
    ).scalars().all()
    assert contacts, "demo seeded no contacts"
    assert all(p.is_demo for p in contacts)
    # some contacts carry a default category, exercising that feature
    assert any(p.default_category_id is not None for p in contacts)

    # Transfer legs (transfer_id set) are a deliberately contact-less transaction
    # kind — they relocate money rather than pay anyone — so scope the
    # every-transaction-has-a-contact guard to ordinary (non-leg) transactions.
    txns = (
        await db.execute(
            sa.select(Transaction).where(
                Transaction.workspace_id == ws_id, Transaction.transfer_id.is_(None)
            )
        )
    ).scalars().all()
    assert txns
    assert all(t.contact_id is not None for t in txns), "every demo transaction must have a contact_id"
    contact_ids = {p.id for p in contacts}
    assert all(t.contact_id in contact_ids for t in txns)


async def test_seed_reuses_existing_default_categories_instead_of_reinserting(
    client, initialized_instance, db
):
    """The real onboarding flow (services/setup.initialize_instance) already
    seeds the workspace's default categories (is_demo=False) before a user
    ever reaches the demo wizard step. `initialized_instance` mirrors that
    now, so this reproduces the actual bug: seeding demo data on a workspace
    that already has its default categories used to raise IntegrityError on
    the (workspace_id, name, kind) unique constraint -> 500. Demo must not
    re-insert the defaults, and should categorize its transactions using the
    ones that already exist instead of leaving everything uncategorized."""
    h = await _auth(client, initialized_instance)
    ws_id = await _workspace_id(db, initialized_instance)

    categories_before = (
        await db.execute(sa.select(Category).where(Category.workspace_id == ws_id))
    ).scalars().all()
    assert len(categories_before) == 11  # DEFAULT_CATEGORIES, seeded by setup

    resp = await client.post("/api/v1/demo", headers=h)
    assert resp.status_code == 201  # was 500 (IntegrityError) before the fix

    categories_after = (
        await db.execute(sa.select(Category).where(Category.workspace_id == ws_id))
    ).scalars().all()
    # no duplicate/demo categories were inserted — still exactly the 11
    # real defaults, none of them flagged is_demo
    assert len(categories_after) == 11
    assert all(not c.is_demo for c in categories_after)

    txns = (
        await db.execute(sa.select(Transaction).where(Transaction.workspace_id == ws_id))
    ).scalars().all()
    assert txns  # sanity: the demo dataset was actually seeded
    assert any(t.category_id is not None for t in txns), "demo transactions should be categorized"

    budgets = (
        await db.execute(sa.select(Budget).where(Budget.workspace_id == ws_id))
    ).scalars().all()
    assert any(b.category_id is not None for b in budgets), "demo budget should be categorized"


async def test_real_account_created_before_seed_is_not_demo_and_survives_removal(
    client, initialized_instance
):
    h = await _auth(client, initialized_instance)
    real = (
        await client.post(
            "/api/v1/accounts",
            json={"name": "My Real Checking", "type": "checking", "currency": "BRL"},
            headers=h,
        )
    ).json()
    assert real["is_demo"] is False

    await client.post("/api/v1/demo", headers=h)
    still_there = await client.get(f"/api/v1/accounts/{real['id']}", headers=h)
    assert still_there.status_code == 200
    assert still_there.json()["is_demo"] is False

    resp = await client.delete("/api/v1/demo", headers=h)
    assert resp.status_code == 204

    after_removal = await client.get(f"/api/v1/accounts/{real['id']}", headers=h)
    assert after_removal.status_code == 200
    assert after_removal.json()["is_demo"] is False


async def test_remove_deletes_all_demo_domain_rows_only(client, initialized_instance, db):
    h = await _auth(client, initialized_instance)
    real = (
        await client.post(
            "/api/v1/accounts",
            json={"name": "My Real Checking", "type": "checking", "currency": "BRL"},
            headers=h,
        )
    ).json()
    await client.post("/api/v1/demo", headers=h)
    ws_id = await _workspace_id(db, initialized_instance)

    resp = await client.delete("/api/v1/demo", headers=h)
    assert resp.status_code == 204
    assert resp.content == b""

    for model in DOMAIN_TABLES:
        demo_left = await db.scalar(
            sa.select(sa.func.count())
            .select_from(model)
            .where(model.workspace_id == ws_id, model.is_demo.is_(True))
        )
        assert demo_left == 0, f"{model.__name__} still has demo rows"

    real_accounts = (
        await db.execute(sa.select(Account).where(Account.workspace_id == ws_id))
    ).scalars().all()
    assert [a.id for a in real_accounts] == [uuid.UUID(real["id"])]


async def test_remove_does_not_touch_audit_or_activity_history(client, initialized_instance, db):
    h = await _auth(client, initialized_instance)
    # Demo-seeded rows carry no activity_template (no activity entries of
    # their own), so the count that matters here is a *real* resource's
    # activity trail — created before the demo is seeded at all.
    await client.post(
        "/api/v1/accounts",
        json={"name": "My Real Checking", "type": "checking", "currency": "BRL"},
        headers=h,
    )
    activity_count_before = await db.scalar(sa.select(sa.func.count()).select_from(ActivityEntry))
    assert activity_count_before > 0

    await client.post("/api/v1/demo", headers=h)

    resp = await client.delete("/api/v1/demo", headers=h)
    assert resp.status_code == 204

    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "data.demo_seeded" in actions
    assert "data.demo_removed" in actions

    # the real account's activity entry survived demo seed + removal
    # unchanged — removal touches only demo domain rows, never
    # activity_entries (a historical record, per the demo-removal-scope decision)
    activity_count_after = await db.scalar(sa.select(sa.func.count()).select_from(ActivityEntry))
    assert activity_count_after == activity_count_before


async def test_seed_twice_returns_409(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    first = await client.post("/api/v1/demo", headers=h)
    assert first.status_code == 201
    second = await client.post("/api/v1/demo", headers=h)
    assert second.status_code == 409
    assert second.json()["detail"] == "DEMO_ALREADY_PRESENT"


async def test_get_demo_reflects_presence(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    before = await client.get("/api/v1/demo", headers=h)
    assert before.status_code == 200
    assert before.json()["present"] is False
    assert all(v == 0 for v in before.json()["counts"].values())

    await client.post("/api/v1/demo", headers=h)
    mid = await client.get("/api/v1/demo", headers=h)
    assert mid.status_code == 200
    assert mid.json()["present"] is True
    assert mid.json()["counts"]["accounts"] == 3

    await client.delete("/api/v1/demo", headers=h)
    after = await client.get("/api/v1/demo", headers=h)
    assert after.json()["present"] is False


async def test_demo_endpoints_require_auth(client, initialized_instance):
    assert (await client.post("/api/v1/demo")).status_code == 401
    assert (await client.get("/api/v1/demo")).status_code == 401
    assert (await client.delete("/api/v1/demo")).status_code == 401


async def test_demo_scoped_to_workspace(client, initialized_instance, db, user_factory):
    from pecunia.models import Workspace

    h = await _auth(client, initialized_instance)
    await client.post("/api/v1/demo", headers=h)

    other_user = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other_user.id, role="owner"))
    await db.commit()

    other_token = (
        await client.post(
            "/api/v1/auth/login",
            json={"email": "other@example.com", "password": "correct horse battery staple"},
        )
    ).json()["access_token"]
    other_h = {"Authorization": f"Bearer {other_token}"}

    other_status = await client.get("/api/v1/demo", headers=other_h)
    assert other_status.json()["present"] is False
