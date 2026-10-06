import uuid
from datetime import date

from pecunia.services.subscription_detect import (
    DetectTxn,
    ExistingSub,
    detect_candidates,
)


def _txn(merchant, amount_minor, day, *, currency="BRL", category_id=None):
    return DetectTxn(
        merchant=merchant, currency=currency, amount_minor=amount_minor,
        occurred_on=day, category_id=category_id,
    )


def test_monthly_merchant_three_equal_charges_is_one_candidate():
    txns = [
        _txn("Netflix", -1990, date(2026, 7, 5)),
        _txn("Netflix", -1990, date(2026, 8, 5)),
        _txn("Netflix", -1990, date(2026, 9, 5)),
    ]
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert len(out) == 1
    c = out[0]
    assert c.merchant == "Netflix"
    assert c.suggested_name == "Netflix"
    assert c.amount_minor == 1990              # positive magnitude
    assert c.currency == "BRL"
    assert c.billing_frequency == "monthly"
    assert c.occurrences == 3
    assert c.first_seen == date(2026, 7, 5)
    assert c.last_seen == date(2026, 9, 5)
    assert c.suggested_next_renewal == date(2026, 10, 5)  # advance(last, monthly)
    assert c.suggested_category_id is None


def test_amount_within_tolerance_kept_outside_dropped():
    # 19.90, 20.80 (~+4.5%, kept), 30.00 (+50%, dropped) -> 2 kept, monthly
    txns = [
        _txn("Spotify", -1990, date(2026, 7, 10)),
        _txn("Spotify", -2080, date(2026, 8, 10)),
        _txn("Spotify", -3000, date(2026, 9, 10)),
    ]
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert len(out) == 1
    assert out[0].occurrences == 2
    assert out[0].billing_frequency == "monthly"


def test_irregular_gaps_not_a_candidate():
    txns = [
        _txn("Mercado", -5000, date(2026, 7, 3)),
        _txn("Mercado", -5000, date(2026, 7, 19)),   # 16d
        _txn("Mercado", -5000, date(2026, 9, 2)),    # 45d — median gap 30? no: gaps [16,45] median 30.5 -> but spread is irregular
    ]
    # Two gaps 16 and 45; median 30.5 would bucket monthly, but we require the
    # gaps to be consistent — see Step 3's rule. This asserts the irregular set
    # is rejected.
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert out == []


def test_single_occurrence_not_a_candidate():
    out = detect_candidates([_txn("Once", -1000, date(2026, 9, 1))], today=date(2026, 10, 6), existing=[])
    assert out == []


def test_income_and_positive_amounts_ignored():
    # Caller passes only expenses, but guard anyway: a positive amount is not a charge.
    txns = [
        _txn("Salary", 500000, date(2026, 7, 1)),
        _txn("Salary", 500000, date(2026, 8, 1)),
        _txn("Salary", 500000, date(2026, 9, 1)),
    ]
    assert detect_candidates(txns, today=date(2026, 10, 6), existing=[]) == []


def test_existing_active_subscription_excluded():
    txns = [
        _txn("Netflix", -1990, date(2026, 7, 5)),
        _txn("Netflix", -1990, date(2026, 8, 5)),
        _txn("Netflix", -1990, date(2026, 9, 5)),
    ]
    existing = [ExistingSub(name="Netflix", currency="BRL", amount_minor=1990, billing_frequency="monthly")]
    assert detect_candidates(txns, today=date(2026, 10, 6), existing=existing) == []


def test_suggested_category_is_group_mode():
    cat = uuid.uuid4()
    txns = [
        _txn("Netflix", -1990, date(2026, 7, 5), category_id=cat),
        _txn("Netflix", -1990, date(2026, 8, 5), category_id=cat),
        _txn("Netflix", -1990, date(2026, 9, 5), category_id=None),
    ]
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert out[0].suggested_category_id == cat


def test_currencies_isolated():
    txns = [
        _txn("Dropbox", -1000, date(2026, 7, 5), currency="BRL"),
        _txn("Dropbox", -1000, date(2026, 8, 5), currency="BRL"),
        _txn("Dropbox", -1200, date(2026, 7, 5), currency="USD"),
        _txn("Dropbox", -1200, date(2026, 8, 5), currency="USD"),
    ]
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert {c.currency for c in out} == {"BRL", "USD"}
    assert len(out) == 2


def test_sorted_by_amount_desc():
    txns = [
        _txn("Small", -1000, date(2026, 7, 1)), _txn("Small", -1000, date(2026, 8, 1)),
        _txn("Big", -9000, date(2026, 7, 1)), _txn("Big", -9000, date(2026, 8, 1)),
    ]
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert [c.merchant for c in out] == ["Big", "Small"]
