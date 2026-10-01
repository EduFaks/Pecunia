import uuid
from datetime import date, timedelta

import sqlalchemy as sa

from pecunia.models import (
    Account,
    Loan,
    ScheduledTransaction,
    Subscription,
    Transaction,
    WorkspaceMembership,
)
from pecunia.services.safe_to_spend import SafeToSpendService
from pecunia.services.settings import set_monthly_budget

TODAY = date(2026, 9, 13)  # mid-month; Sept 2026 has 30 days


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def _account(db, ws_id, *, currency="BRL", initial=0, name="Acc"):
    acc = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, type="checking",
        currency=currency, initial_balance_minor=initial,
    )
    db.add(acc)
    await db.flush()
    return acc


async def _tx(db, ws_id, account, *, amount, on, currency="BRL"):
    tx = Transaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account.id,
        amount_minor=amount, currency=currency, description="t", occurred_on=on,
    )
    db.add(tx)
    await db.flush()
    return tx


async def _scheduled(
    db, ws_id, account, *, description, amount, next_due,
    currency="BRL", is_active=True, frequency="monthly",
):
    st = ScheduledTransaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account.id,
        amount_minor=amount, currency=currency, description=description,
        frequency=frequency, next_due=next_due, is_active=is_active,
    )
    db.add(st)
    await db.flush()
    return st


async def _subscription(
    db, ws_id, *, name, amount, next_renewal,
    currency="BRL", status="active", billing_frequency="monthly",
):
    sub = Subscription(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, amount_minor=amount,
        currency=currency, billing_frequency=billing_frequency,
        next_renewal=next_renewal, status=status,
    )
    db.add(sub)
    await db.flush()
    return sub


async def _loan(
    db, ws_id, *, name="Loan", direction="borrowed", principal=100_000, currency="BRL",
    planned_payment=None, payment_frequency=None, next_due=None,
):
    loan = Loan(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, direction=direction,
        principal_minor=principal, currency=currency,
        planned_payment_minor=planned_payment, payment_frequency=payment_frequency,
        next_due=next_due,
    )
    db.add(loan)
    await db.flush()
    return loan


async def test_safe_to_spend_core_formula(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="BRL")
    # MTD activity (on/before today): income 300_000, expense 100_000.
    await _tx(db, ws_id, acc, amount=300_000, on=date(2026, 9, 5))
    await _tx(db, ws_id, acc, amount=-100_000, on=date(2026, 9, 10))
    # Remaining-window commitments (after today, still this month).
    await _scheduled(
        db, ws_id, acc, description="Bonus", amount=50_000, next_due=date(2026, 9, 20),
    )
    await _subscription(
        db, ws_id, name="Netflix", amount=20_000, next_renewal=date(2026, 9, 25),
    )

    svc = SafeToSpendService(db)
    out = await svc.compute(ws_id, today=TODAY)

    brl = out["BRL"]
    assert brl["expected_income_minor"] == 350_000
    assert brl["committed_remaining_minor"] == 20_000
    assert brl["spent_mtd_minor"] == 100_000
    assert brl["safe_minor"] == 230_000
    assert brl["displayed_safe_minor"] == 230_000
    assert brl["limited_by"] == "income"
    assert brl["monthly_budget_minor"] is None


async def test_already_due_commitments_not_double_counted(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    # Renews exactly today — d > today excludes it (it's already reflected in
    # spent_mtd if actually paid; the strict filter must not let it bleed in).
    await _subscription(db, ws_id, name="DueToday", amount=15_000, next_renewal=TODAY)
    # A past anchor — expand_occurrences steps past it, so its next occurrence
    # (one month later) falls outside this month's horizon entirely.
    await _subscription(
        db, ws_id, name="PastAnchor", amount=9_000, next_renewal=TODAY - timedelta(days=5),
    )

    svc = SafeToSpendService(db)
    out = await svc.compute(ws_id, today=TODAY)

    assert out["BRL"]["committed_remaining_minor"] == 0


async def test_budget_cap_binds(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="BRL")
    await _tx(db, ws_id, acc, amount=300_000, on=date(2026, 9, 5))
    await _tx(db, ws_id, acc, amount=-100_000, on=date(2026, 9, 10))
    await _scheduled(
        db, ws_id, acc, description="Bonus", amount=50_000, next_due=date(2026, 9, 20),
    )
    await _subscription(
        db, ws_id, name="Netflix", amount=20_000, next_renewal=date(2026, 9, 25),
    )
    # safe = 230_000 (same as the core-formula scenario); budget_remaining =
    # 150_000 - 100_000 = 50_000 < safe -> the budget binds.
    await set_monthly_budget(db, workspace_id=ws_id, monthly_budget_minor=150_000)

    svc = SafeToSpendService(db)
    out = await svc.compute(ws_id, today=TODAY)

    brl = out["BRL"]
    assert brl["safe_minor"] == 230_000
    assert brl["monthly_budget_minor"] == 150_000
    assert brl["displayed_safe_minor"] == 50_000
    assert brl["limited_by"] == "budget"


async def test_days_remaining_and_daily_allowance_last_day(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="BRL")
    last_day = date(2026, 9, 30)
    await _tx(db, ws_id, acc, amount=100_000, on=date(2026, 9, 5))

    svc = SafeToSpendService(db)
    out = await svc.compute(ws_id, today=last_day)

    brl = out["BRL"]
    assert brl["days_remaining"] == 1
    assert brl["daily_allowance_minor"] == max(0, brl["displayed_safe_minor"])


async def test_per_currency_isolation(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    brl_acc = await _account(db, ws_id, currency="BRL", name="BRL")
    await _tx(db, ws_id, brl_acc, amount=50_000, on=date(2026, 9, 5), currency="BRL")
    # A USD subscription must never bleed into BRL's committed figure.
    await _subscription(
        db, ws_id, name="UsdSub", amount=20_000, next_renewal=date(2026, 9, 25), currency="USD",
    )
    await set_monthly_budget(db, workspace_id=ws_id, monthly_budget_minor=10_000)

    svc = SafeToSpendService(db)
    out = await svc.compute(ws_id, today=TODAY)

    assert out["BRL"]["committed_remaining_minor"] == 0
    assert out["BRL"]["monthly_budget_minor"] == 10_000
    assert "USD" in out
    assert out["USD"]["monthly_budget_minor"] is None
    assert out["USD"]["committed_remaining_minor"] == 20_000


async def test_base_currency_always_present_when_empty(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)

    svc = SafeToSpendService(db)
    out = await svc.compute(ws_id, today=TODAY)

    assert "BRL" in out
    assert out["BRL"]["safe_minor"] == 0
    assert out["BRL"]["displayed_safe_minor"] == 0
    assert out["BRL"]["daily_allowance_minor"] == 0
    assert out["BRL"]["days_remaining"] >= 1
