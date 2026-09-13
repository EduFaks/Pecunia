import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

import sqlalchemy as sa

from pecunia.models import (
    Account,
    Asset,
    AssetValuation,
    Holding,
    HoldingPrice,
    Loan,
    LoanPayment,
    NetWorthSnapshot,
    Portfolio,
    Transaction,
    Workspace,
    WorkspaceMembership,
)
from pecunia.services.snapshots import SnapshotService

MID = date(2026, 6, 15)


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def _account(db, ws_id, *, currency="USD", initial=0, name="Acc"):
    acc = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, type="checking",
        currency=currency, initial_balance_minor=initial,
    )
    db.add(acc)
    await db.flush()
    return acc


async def _tx(db, ws_id, account, *, amount, on, currency="USD", deleted=False):
    tx = Transaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account.id,
        amount_minor=amount, currency=currency, description="t", occurred_on=on,
        deleted_at=datetime.now(UTC) if deleted else None,
    )
    db.add(tx)
    await db.flush()
    return tx


async def _asset(db, ws_id, *, currency="USD", name="A"):
    asset = Asset(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, type="other", currency=currency,
    )
    db.add(asset)
    await db.flush()
    return asset


async def _valuation(db, ws_id, asset, *, value, as_of):
    val = AssetValuation(
        id=uuid.uuid4(), workspace_id=ws_id, asset_id=asset.id,
        value_minor=value, as_of=as_of,
    )
    db.add(val)
    await db.flush()
    return val


async def _fixture(db, ws_id):
    """A known multi-currency workspace state.

    USD @ 2026-06-15:
      Account A: initial 10_000 + (+5_000 on 03-01) + (-2_000 on 06-01) = 13_000
                 (a +900_000 on 12-01 is after the date; a -50_000 soft-deleted
                 tx on 03-01 is excluded)
      Account B: initial 0 + (+3_000 on 02-01) = 3_000
      Asset X:   latest valuation as_of <= date = 25_000 (a 900_000 on 12-01 is
                 after the date and ignored)
      Asset Z:   only valuation is on 12-01 (after the date) -> contributes 0
      => USD = 13_000 + 3_000 + 25_000 = 41_000
    EUR @ 2026-06-15:
      Asset Y:   40_000  => EUR = 40_000
    """
    acc_a = await _account(db, ws_id, currency="USD", initial=10_000, name="A")
    await _tx(db, ws_id, acc_a, amount=5_000, on=date(2026, 3, 1))
    await _tx(db, ws_id, acc_a, amount=-2_000, on=date(2026, 6, 1))
    await _tx(db, ws_id, acc_a, amount=900_000, on=date(2026, 12, 1))
    await _tx(db, ws_id, acc_a, amount=-50_000, on=date(2026, 3, 1), deleted=True)

    acc_b = await _account(db, ws_id, currency="USD", initial=0, name="B")
    await _tx(db, ws_id, acc_b, amount=3_000, on=date(2026, 2, 1))

    asset_x = await _asset(db, ws_id, currency="USD", name="X")
    await _valuation(db, ws_id, asset_x, value=20_000, as_of=date(2026, 1, 1))
    await _valuation(db, ws_id, asset_x, value=25_000, as_of=date(2026, 5, 1))
    await _valuation(db, ws_id, asset_x, value=900_000, as_of=date(2026, 12, 1))

    asset_z = await _asset(db, ws_id, currency="USD", name="Z")
    await _valuation(db, ws_id, asset_z, value=99_999, as_of=date(2026, 12, 1))

    asset_y = await _asset(db, ws_id, currency="EUR", name="Y")
    await _valuation(db, ws_id, asset_y, value=40_000, as_of=date(2026, 4, 1))


async def test_net_worth_as_of_reconstructs_per_currency(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _fixture(db, ws_id)

    result = await SnapshotService(db).net_worth_as_of(ws_id, MID)

    assert result == {"USD": 41_000, "EUR": 40_000}


async def test_net_worth_as_of_never_sums_across_currencies(db, initialized_instance):
    """USD and EUR stay separate keys — never collapsed into one figure."""
    ws_id = await _ws_id(db, initialized_instance)
    await _fixture(db, ws_id)

    result = await SnapshotService(db).net_worth_as_of(ws_id, MID)

    assert set(result) == {"USD", "EUR"}
    assert result["USD"] == 41_000
    assert result["EUR"] == 40_000


async def test_net_worth_as_of_is_workspace_scoped(db, initialized_instance, user_factory):
    ws_id = await _ws_id(db, initialized_instance)
    await _fixture(db, ws_id)

    other = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other.id, role="owner"))
    other_acc = await _account(db, other_ws.id, currency="USD", initial=1_000_000)
    await _tx(db, other_ws.id, other_acc, amount=1_000_000, on=date(2026, 1, 1))

    result = await SnapshotService(db).net_worth_as_of(ws_id, MID)
    assert result == {"USD": 41_000, "EUR": 40_000}


async def _portfolio(db, ws_id, *, currency="USD", name="P"):
    p = Portfolio(id=uuid.uuid4(), workspace_id=ws_id, name=name, currency=currency)
    db.add(p)
    await db.flush()
    return p


async def _holding(db, ws_id, portfolio, *, quantity, name="H"):
    hd = Holding(
        id=uuid.uuid4(), workspace_id=ws_id, portfolio_id=portfolio.id,
        name=name, quantity=Decimal(quantity),
    )
    db.add(hd)
    await db.flush()
    return hd


async def _price(db, ws_id, holding, *, unit_price_minor, as_of):
    pr = HoldingPrice(
        id=uuid.uuid4(), workspace_id=ws_id, holding_id=holding.id,
        unit_price_minor=unit_price_minor, as_of=as_of,
    )
    db.add(pr)
    await db.flush()
    return pr


async def test_net_worth_includes_portfolio_at_and_after_price_date(db, initialized_instance):
    """A holding raises net worth by round(quantity x latest unit price <= date),
    and contributes nothing before its first price's as_of."""
    ws_id = await _ws_id(db, initialized_instance)
    p = await _portfolio(db, ws_id, currency="USD")
    hd = await _holding(db, ws_id, p, quantity="1.5")
    await _price(db, ws_id, hd, unit_price_minor=1000, as_of=date(2026, 6, 1))
    svc = SnapshotService(db)

    # Before the price date: the holding has no price <= date, so it drops out
    # entirely (no USD bucket exists from this workspace state).
    before = await svc.net_worth_as_of(ws_id, date(2026, 5, 31))
    assert before.get("USD", 0) == 0

    # On/after the price date: 1.5 * 1000 = 1500 (exact, rounded per holding).
    on = await svc.net_worth_as_of(ws_id, date(2026, 6, 1))
    assert on["USD"] == 1500
    after = await svc.net_worth_as_of(ws_id, date(2026, 7, 1))
    assert after["USD"] == 1500


async def test_net_worth_portfolio_is_a_separate_currency_bucket(db, initialized_instance):
    """A EUR portfolio never merges into the USD figure — currencies stay split
    (CONVENTIONS §4: never summed across currencies)."""
    ws_id = await _ws_id(db, initialized_instance)
    usd_p = await _portfolio(db, ws_id, currency="USD", name="US")
    usd_h = await _holding(db, ws_id, usd_p, quantity="2")
    await _price(db, ws_id, usd_h, unit_price_minor=1000, as_of=date(2026, 1, 1))
    eur_p = await _portfolio(db, ws_id, currency="EUR", name="EU")
    eur_h = await _holding(db, ws_id, eur_p, quantity="0.15")
    await _price(db, ws_id, eur_h, unit_price_minor=6_000_000, as_of=date(2026, 1, 1))

    result = await SnapshotService(db).net_worth_as_of(ws_id, MID)

    assert result["USD"] == 2000  # 2 * 1000
    assert result["EUR"] == 900_000  # round(0.15 * 6_000_000)
    assert set(result) == {"USD", "EUR"}


async def test_net_worth_portfolio_is_workspace_scoped(db, initialized_instance, user_factory):
    """A holding in another workspace never leaks into this workspace's totals."""
    ws_id = await _ws_id(db, initialized_instance)
    p = await _portfolio(db, ws_id, currency="USD")
    hd = await _holding(db, ws_id, p, quantity="2")
    await _price(db, ws_id, hd, unit_price_minor=1000, as_of=date(2026, 1, 1))

    other = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other.id, role="owner"))
    other_p = await _portfolio(db, other_ws.id, currency="USD", name="Other P")
    other_h = await _holding(db, other_ws.id, other_p, quantity="999")
    await _price(db, other_ws.id, other_h, unit_price_minor=1_000_000, as_of=date(2026, 1, 1))

    result = await SnapshotService(db).net_worth_as_of(ws_id, MID)
    assert result == {"USD": 2000}


async def test_net_worth_components_as_of_breaks_out_four_parts(db, initialized_instance):
    """The four net-worth ingredients are kept SEPARATE per currency, and their
    per-currency sum equals `net_worth_as_of` for the same date EXACTLY."""
    ws_id = await _ws_id(db, initialized_instance)
    # cash: two USD accounts with dated tx (future + soft-deleted excluded)
    acc_a = await _account(db, ws_id, currency="USD", initial=10_000, name="A")
    await _tx(db, ws_id, acc_a, amount=5_000, on=date(2026, 3, 1))
    await _tx(db, ws_id, acc_a, amount=-2_000, on=date(2026, 6, 1))
    await _tx(db, ws_id, acc_a, amount=900_000, on=date(2026, 12, 1))  # future -> excluded
    await _tx(db, ws_id, acc_a, amount=-50_000, on=date(2026, 3, 1), deleted=True)  # excluded
    acc_b = await _account(db, ws_id, currency="USD", initial=0, name="B")
    await _tx(db, ws_id, acc_b, amount=3_000, on=date(2026, 2, 1))
    # assets: USD asset, latest valuation <= MID is 25_000 (future 900_000 ignored)
    asset_x = await _asset(db, ws_id, currency="USD", name="X")
    await _valuation(db, ws_id, asset_x, value=20_000, as_of=date(2026, 1, 1))
    await _valuation(db, ws_id, asset_x, value=25_000, as_of=date(2026, 5, 1))
    await _valuation(db, ws_id, asset_x, value=900_000, as_of=date(2026, 12, 1))
    # investments: USD portfolio holding -> round(1.5 * 1000) = 1_500
    p = await _portfolio(db, ws_id, currency="USD")
    hd = await _holding(db, ws_id, p, quantity="1.5")
    await _price(db, ws_id, hd, unit_price_minor=1000, as_of=date(2026, 6, 1))
    # debts: a borrowed USD loan, part-paid -> remaining 18_000, signed negative
    loan = await _loan(db, ws_id, direction="borrowed", principal=30_000)
    await _payment(db, ws_id, loan, amount=12_000, paid_on=date(2026, 3, 1))
    # a second currency stays its own bucket
    asset_y = await _asset(db, ws_id, currency="EUR", name="Y")
    await _valuation(db, ws_id, asset_y, value=40_000, as_of=date(2026, 4, 1))

    svc = SnapshotService(db)
    components = await svc.net_worth_components_as_of(ws_id, MID)

    assert components["USD"] == {
        "cash_minor": 16_000,  # 10_000 + 5_000 - 2_000 + 3_000
        "assets_minor": 25_000,
        "investments_minor": 1_500,
        "debts_minor": -18_000,  # borrowed (30_000 - 12_000 paid), signed negative
    }
    assert components["EUR"] == {
        "cash_minor": 0,
        "assets_minor": 40_000,
        "investments_minor": 0,
        "debts_minor": 0,
    }

    # CRUCIAL: total == Σ of the four parts, per currency, exactly (no drift).
    totals = await svc.net_worth_as_of(ws_id, MID)
    assert totals == {"USD": 24_500, "EUR": 40_000}
    assert set(components) == set(totals)
    for currency, parts in components.items():
        assert sum(parts.values()) == totals[currency]


async def test_net_worth_components_debts_sign_convention(db, initialized_instance):
    """borrowed -> a negative debts term (liability); lent -> positive (receivable)."""
    ws_id = await _ws_id(db, initialized_instance)
    await _loan(db, ws_id, direction="borrowed", principal=5_000, currency="USD", name="B")
    await _loan(db, ws_id, direction="lent", principal=8_000, currency="USD", name="L")

    components = await SnapshotService(db).net_worth_components_as_of(ws_id, MID)

    # -5_000 (borrowed) + 8_000 (lent) = 3_000
    assert components["USD"]["debts_minor"] == 3_000


async def test_net_worth_components_sum_matches_total_on_shared_fixture(db, initialized_instance):
    """Parity holds on the full shared fixture too — the refactor can't drift."""
    ws_id = await _ws_id(db, initialized_instance)
    await _fixture(db, ws_id)
    svc = SnapshotService(db)

    components = await svc.net_worth_components_as_of(ws_id, MID)
    totals = await svc.net_worth_as_of(ws_id, MID)

    assert set(components) == set(totals)
    for currency, parts in components.items():
        assert (
            parts["cash_minor"]
            + parts["assets_minor"]
            + parts["investments_minor"]
            + parts["debts_minor"]
        ) == totals[currency]


async def test_capture_is_idempotent_and_updates_on_change(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _fixture(db, ws_id)
    svc = SnapshotService(db)

    await svc.capture(ws_id, MID)
    await svc.capture(ws_id, MID)  # same date again -> no duplicate

    usd_rows = (
        await db.execute(
            sa.select(NetWorthSnapshot).where(
                NetWorthSnapshot.workspace_id == ws_id,
                NetWorthSnapshot.currency == "USD",
                NetWorthSnapshot.captured_on == MID,
            )
        )
    ).scalars().all()
    assert len(usd_rows) == 1
    assert usd_rows[0].net_worth_minor == 41_000

    # A new USD transaction on/before the date moves net worth; re-capturing
    # the same date updates the row in place rather than inserting a second.
    acc = (
        await db.execute(sa.select(Account).where(Account.workspace_id == ws_id).limit(1))
    ).scalar_one()
    await _tx(db, ws_id, acc, amount=7_000, on=date(2026, 6, 10))
    await svc.capture(ws_id, MID)

    usd_rows = (
        await db.execute(
            sa.select(NetWorthSnapshot).where(
                NetWorthSnapshot.workspace_id == ws_id,
                NetWorthSnapshot.currency == "USD",
                NetWorthSnapshot.captured_on == MID,
            )
        )
    ).scalars().all()
    assert len(usd_rows) == 1
    assert usd_rows[0].net_worth_minor == 48_000


async def test_capture_flags_is_demo(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _fixture(db, ws_id)

    await SnapshotService(db).capture(ws_id, MID, is_demo=True)

    rows = (
        await db.execute(
            sa.select(NetWorthSnapshot).where(NetWorthSnapshot.workspace_id == ws_id)
        )
    ).scalars().all()
    assert rows
    assert all(r.is_demo for r in rows)


async def test_backfill_writes_one_point_per_month(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 1, 15))

    today = date(2026, 9, 12)
    await SnapshotService(db).backfill(ws_id, months=3, today=today)

    dates = (
        await db.execute(
            sa.select(NetWorthSnapshot.captured_on)
            .where(
                NetWorthSnapshot.workspace_id == ws_id,
                NetWorthSnapshot.currency == "USD",
            )
            .order_by(NetWorthSnapshot.captured_on)
        )
    ).scalars().all()
    # last day of each of the last 3 months, with `today` as the final point
    assert dates == [date(2026, 7, 31), date(2026, 8, 31), date(2026, 9, 12)]


async def test_series_returns_ordered_points_in_range(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 1, 15))

    today = date(2026, 9, 12)
    svc = SnapshotService(db)
    await svc.backfill(ws_id, months=3, today=today)

    full = await svc.series(ws_id, "USD", from_date=date(2026, 7, 1), to_date=today)
    assert [d for d, _ in full] == [date(2026, 7, 31), date(2026, 8, 31), date(2026, 9, 12)]
    assert all(isinstance(v, int) for _, v in full)

    # the from/to window clips the ends
    clipped = await svc.series(
        ws_id, "USD", from_date=date(2026, 8, 1), to_date=date(2026, 8, 31)
    )
    assert [d for d, _ in clipped] == [date(2026, 8, 31)]


# --------------------------------------------------------------------------- #
# Loans — a signed net-worth term (borrowed subtracts, lent adds)
# --------------------------------------------------------------------------- #


async def _loan(db, ws_id, *, direction, principal, currency="USD", name="Loan"):
    loan = Loan(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, direction=direction,
        principal_minor=principal, currency=currency,
    )
    db.add(loan)
    await db.flush()
    return loan


async def _payment(db, ws_id, loan, *, amount, paid_on):
    p = LoanPayment(
        id=uuid.uuid4(), workspace_id=ws_id, loan_id=loan.id,
        amount_minor=amount, paid_on=paid_on,
    )
    db.add(p)
    await db.flush()
    return p


async def test_borrowed_loan_reduces_net_worth_by_remaining(db, initialized_instance):
    """A borrowed loan is a liability: it SUBTRACTS its remaining balance."""
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _loan(db, ws_id, direction="borrowed", principal=30_000)

    result = await SnapshotService(db).net_worth_as_of(ws_id, MID)
    # 100_000 asset side minus the 30_000 owed (no payments yet)
    assert result["USD"] == 70_000
    _ = acc


async def test_lent_loan_increases_net_worth_by_remaining(db, initialized_instance):
    """A lent loan is a receivable: it ADDS its remaining balance."""
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=100_000)
    await _loan(db, ws_id, direction="lent", principal=30_000)

    result = await SnapshotService(db).net_worth_as_of(ws_id, MID)
    assert result["USD"] == 130_000


async def test_earlier_payment_lowers_borrowed_liability_at_later_date(db, initialized_instance):
    """As a borrowed loan is paid down, the liability shrinks — so net worth
    RISES at a later snapshot date once earlier-dated payments land."""
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=100_000)
    loan = await _loan(db, ws_id, direction="borrowed", principal=30_000)
    # a payment dated before MID
    await _payment(db, ws_id, loan, amount=12_000, paid_on=date(2026, 3, 1))
    svc = SnapshotService(db)

    # Before the payment: full 30_000 liability -> 70_000.
    early = await svc.net_worth_as_of(ws_id, date(2026, 2, 1))
    assert early["USD"] == 70_000
    # On/after the payment: remaining is 30_000 - 12_000 = 18_000 -> 82_000.
    later = await svc.net_worth_as_of(ws_id, MID)
    assert later["USD"] == 82_000
    assert later["USD"] > early["USD"]


async def test_overpaid_borrowed_loan_contributes_zero(db, initialized_instance):
    """Remaining floors at 0: an overpaid loan neither subtracts nor swings
    net worth positive."""
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=100_000)
    loan = await _loan(db, ws_id, direction="borrowed", principal=10_000)
    await _payment(db, ws_id, loan, amount=15_000, paid_on=date(2026, 1, 1))

    result = await SnapshotService(db).net_worth_as_of(ws_id, MID)
    assert result["USD"] == 100_000


async def test_foreign_currency_loan_stays_its_own_bucket(db, initialized_instance):
    """A loan in another currency is never summed into a different currency's
    figure (§4)."""
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=100_000)
    await _loan(db, ws_id, direction="borrowed", principal=5_000, currency="EUR")

    result = await SnapshotService(db).net_worth_as_of(ws_id, MID)
    assert result["USD"] == 100_000
    assert result["EUR"] == -5_000  # a EUR-only liability
    assert set(result) == {"USD", "EUR"}


async def test_loan_net_worth_is_workspace_scoped(db, initialized_instance, user_factory):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=100_000)
    await _loan(db, ws_id, direction="borrowed", principal=20_000)

    other = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other.id, role="owner"))
    await _loan(db, other_ws.id, direction="borrowed", principal=999_000, name="Other loan")

    result = await SnapshotService(db).net_worth_as_of(ws_id, MID)
    assert result["USD"] == 80_000


async def test_series_is_workspace_scoped(db, initialized_instance, user_factory):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 1, 15))

    other = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other.id, role="owner"))
    await _account(db, other_ws.id, currency="USD", initial=555_000)

    today = date(2026, 9, 12)
    svc = SnapshotService(db)
    await svc.backfill(ws_id, months=3, today=today)
    await svc.backfill(other_ws.id, months=3, today=today)

    mine = await svc.series(ws_id, "USD", from_date=date(2026, 1, 1), to_date=today)
    assert [v for _, v in mine] == [110_000, 110_000, 110_000]
