import uuid
from datetime import UTC, date, datetime, timedelta

import pytest

from pecunia.models import PALETTE
from pecunia.period import current_window

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


# ---------------------------------------------------------------------------
# current_window — pure function, no DB, no clock. Fixed reference dates only.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "period,ref,expected",
    [
        # weekly: ISO week Mon-Sun. Ref mid-week, on the Monday, and on the Sunday.
        ("weekly", date(2026, 9, 9), (date(2026, 9, 7), date(2026, 9, 13))),
        ("weekly", date(2026, 9, 7), (date(2026, 9, 7), date(2026, 9, 13))),
        ("weekly", date(2026, 9, 13), (date(2026, 9, 7), date(2026, 9, 13))),
        # monthly: calendar month. First day, last day, and a non-leap February.
        ("monthly", date(2026, 9, 1), (date(2026, 9, 1), date(2026, 9, 30))),
        ("monthly", date(2026, 9, 30), (date(2026, 9, 1), date(2026, 9, 30))),
        ("monthly", date(2026, 2, 15), (date(2026, 2, 1), date(2026, 2, 28))),
        # quarterly: calendar quarter. Mid-quarter, and both edges of the year.
        ("quarterly", date(2026, 5, 15), (date(2026, 4, 1), date(2026, 6, 30))),
        ("quarterly", date(2026, 1, 1), (date(2026, 1, 1), date(2026, 3, 31))),
        ("quarterly", date(2026, 12, 31), (date(2026, 10, 1), date(2026, 12, 31))),
        # yearly: calendar year.
        ("yearly", date(2026, 6, 15), (date(2026, 1, 1), date(2026, 12, 31))),
    ],
)
def test_current_window(period, ref, expected):
    assert current_window(period, ref) == expected


def test_current_window_unknown_period_raises():
    with pytest.raises(ValueError):
        current_window("daily", date(2026, 1, 1))


# ---------------------------------------------------------------------------
# Budget actual/remaining — real DB, via the HTTP API.
# ---------------------------------------------------------------------------


async def _auth(client, email=LOGIN["email"]):
    token = (
        await client.post(
            "/api/v1/auth/login", json={"email": email, "password": LOGIN["password"]}
        )
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def _account(client, h, **overrides):
    body = {"name": "Checking", "type": "checking", "currency": "BRL", "initial_balance_minor": 1000000}
    body.update(overrides)
    return (await client.post("/api/v1/accounts", json=body, headers=h)).json()


async def _category(client, h, **overrides):
    # A name distinct from every DEFAULT_CATEGORIES entry (services/setup.py
    # seeds those for the workspace) — the workspace already has a real
    # "Groceries"/expense category by the time these tests run, so reusing
    # that name here would collide on (workspace_id, name, kind).
    body = {"name": "Test Category", "kind": "expense", "color": PALETTE[0], "icon": None}
    body.update(overrides)
    return (await client.post("/api/v1/categories", json=body, headers=h)).json()


async def _budget(client, h, category_id, **overrides):
    body = {
        "name": "Groceries",
        "category_id": category_id,
        "period": "monthly",
        "amount_minor": 50000,
        "currency": "BRL",
    }
    body.update(overrides)
    return (await client.post("/api/v1/budgets", json=body, headers=h)).json()


async def _tx(client, h, account_id, **overrides):
    body = {
        "account_id": account_id,
        "amount_minor": -1000,
        "currency": "BRL",
        "description": "x",
        "occurred_on": datetime.now(UTC).date().isoformat(),
    }
    body.update(overrides)
    return (await client.post("/api/v1/transactions", json=body, headers=h)).json()


async def test_monthly_budget_sums_in_window_expenses(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    budget = await _budget(client, h, cat["id"], amount_minor=50000)

    today = datetime.now(UTC).date()
    for amount in (-1000, -2500, -4999):
        await _tx(
            client, h, acc["id"], category_id=cat["id"], amount_minor=amount,
            occurred_on=today.isoformat(),
        )

    got = (await client.get(f"/api/v1/budgets/{budget['id']}", headers=h)).json()
    assert got["actual_minor"] == 1000 + 2500 + 4999
    assert got["remaining_minor"] == 50000 - (1000 + 2500 + 4999)


async def test_transaction_outside_window_excluded(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    budget = await _budget(client, h, cat["id"])

    today = datetime.now(UTC).date()
    # Well outside the current month regardless of when the suite runs.
    outside = today.replace(day=1) - timedelta(days=400)
    await _tx(client, h, acc["id"], category_id=cat["id"], amount_minor=-5000, occurred_on=outside.isoformat())

    got = (await client.get(f"/api/v1/budgets/{budget['id']}", headers=h)).json()
    assert got["actual_minor"] == 0
    assert got["remaining_minor"] == 50000


async def test_transaction_of_another_category_excluded(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    other_cat = await _category(client, h, name="Test Category 2")
    budget = await _budget(client, h, cat["id"])

    await _tx(client, h, acc["id"], category_id=other_cat["id"], amount_minor=-5000)

    got = (await client.get(f"/api/v1/budgets/{budget['id']}", headers=h)).json()
    assert got["actual_minor"] == 0


async def test_transaction_in_another_workspace_excluded(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    cat = await _category(client, h)
    budget = await _budget(client, h, cat["id"])

    other_user = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other_user.id, role="owner"))
    await db.commit()
    other_h = await _auth(client, email="other@example.com")
    other_cat = await _category(client, other_h)
    other_acc = await _account(client, other_h)
    await _tx(client, other_h, other_acc["id"], category_id=other_cat["id"], amount_minor=-5000)

    got = (await client.get(f"/api/v1/budgets/{budget['id']}", headers=h)).json()
    assert got["actual_minor"] == 0


async def test_soft_deleted_transaction_excluded(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    budget = await _budget(client, h, cat["id"])

    tx = await _tx(client, h, acc["id"], category_id=cat["id"], amount_minor=-5000)
    await client.delete(f"/api/v1/transactions/{tx['id']}", headers=h)

    got = (await client.get(f"/api/v1/budgets/{budget['id']}", headers=h)).json()
    assert got["actual_minor"] == 0


async def test_income_transaction_excluded(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h, name="Test Income", kind="income")
    budget = await _budget(client, h, cat["id"])

    await _tx(client, h, acc["id"], category_id=cat["id"], amount_minor=5000)

    got = (await client.get(f"/api/v1/budgets/{budget['id']}", headers=h)).json()
    assert got["actual_minor"] == 0
    assert got["remaining_minor"] == 50000


async def test_categoryless_budget_has_null_actual(client, initialized_instance):
    h = await _auth(client)
    budget = await _budget(client, h, category_id=None)

    got = (await client.get(f"/api/v1/budgets/{budget['id']}", headers=h)).json()
    assert got["actual_minor"] is None
    assert got["remaining_minor"] is None


async def test_actual_minor_uses_injected_reference_date_not_today(db, initialized_instance):
    """Direct service-level test with a fixed reference date far from the
    real clock (2020) — proves actual_minor takes its "now" as a parameter
    rather than calling date.today() internally."""
    from pecunia.models.account import Account
    from pecunia.models.budget import Budget
    from pecunia.models.category import Category
    from pecunia.models.transaction import Transaction
    from pecunia.services.budgets import BudgetService

    ws_id = initialized_instance["workspace_id"]
    account = Account(id=uuid.uuid4(), workspace_id=ws_id, name="Checking", type="checking", currency="BRL")
    category = Category(id=uuid.uuid4(), workspace_id=ws_id, name="Test Category", kind="expense", color=PALETTE[0])
    db.add_all([account, category])
    await db.flush()
    budget = Budget(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        name="Groceries",
        category_id=category.id,
        period="monthly",
        amount_minor=50000,
        currency="BRL",
    )
    db.add(budget)
    await db.flush()

    in_window = Transaction(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        account_id=account.id,
        category_id=category.id,
        amount_minor=-3000,
        currency="BRL",
        description="x",
        occurred_on=date(2020, 1, 15),
    )
    out_of_window = Transaction(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        account_id=account.id,
        category_id=category.id,
        amount_minor=-9000,
        currency="BRL",
        description="x",
        occurred_on=date(2020, 2, 1),
    )
    db.add_all([in_window, out_of_window])
    await db.flush()

    svc = BudgetService(db)
    actual = await svc.actual_minor(budget, ref=date(2020, 1, 20))
    assert actual == 3000


async def test_create_and_list_endpoints_expose_actual_and_remaining(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    created = await _budget(client, h, cat["id"], amount_minor=50000)
    assert created["actual_minor"] == 0
    assert created["remaining_minor"] == 50000

    await _tx(client, h, acc["id"], category_id=cat["id"], amount_minor=-1500)

    lst = (await client.get("/api/v1/budgets", headers=h)).json()
    found = next(b for b in lst["items"] if b["id"] == created["id"])
    assert found["actual_minor"] == 1500
    assert found["remaining_minor"] == 50000 - 1500
