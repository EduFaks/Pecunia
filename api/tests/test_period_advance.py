from datetime import date

import pytest

from pecunia.period import advance, next_due_on_or_after


def test_weekly_interval_one_adds_seven_days():
    assert advance(date(2026, 1, 1), "weekly") == date(2026, 1, 8)


def test_weekly_interval_two_adds_fourteen_days():
    assert advance(date(2026, 1, 1), "weekly", 2) == date(2026, 1, 15)


def test_weekly_crosses_month_boundary():
    # +7 days from Jan 28 lands in February — plain day arithmetic, no clamp.
    assert advance(date(2026, 1, 28), "weekly") == date(2026, 2, 4)


def test_monthly_interval_one_adds_one_month():
    assert advance(date(2026, 3, 15), "monthly") == date(2026, 4, 15)


def test_monthly_interval_two_adds_two_months():
    assert advance(date(2026, 3, 15), "monthly", 2) == date(2026, 5, 15)


def test_monthly_clamps_to_end_of_shorter_month():
    # Jan 31 + 1 month has no Feb 31; clamp to Feb 28 (2026 is not a leap year).
    assert advance(date(2026, 1, 31), "monthly") == date(2026, 2, 28)


def test_monthly_clamps_to_end_of_february_in_leap_year():
    # 2028 is a leap year — Jan 31 + 1 month clamps to Feb 29, not Feb 28.
    assert advance(date(2028, 1, 31), "monthly") == date(2028, 2, 29)


def test_monthly_crosses_year_boundary():
    assert advance(date(2026, 12, 15), "monthly") == date(2027, 1, 15)


def test_quarterly_interval_one_adds_three_months():
    assert advance(date(2026, 1, 15), "quarterly") == date(2026, 4, 15)


def test_quarterly_interval_two_adds_six_months():
    assert advance(date(2026, 1, 15), "quarterly", 2) == date(2026, 7, 15)


def test_quarterly_crosses_year_boundary():
    assert advance(date(2026, 11, 15), "quarterly") == date(2027, 2, 15)


def test_yearly_interval_one_adds_twelve_months():
    assert advance(date(2026, 3, 10), "yearly") == date(2027, 3, 10)


def test_yearly_interval_two_adds_twenty_four_months():
    assert advance(date(2026, 3, 10), "yearly", 2) == date(2028, 3, 10)


def test_yearly_clamps_leap_day():
    # Feb 29, 2028 + 1 year has no Feb 29, 2029 — clamp to Feb 28.
    assert advance(date(2028, 2, 29), "yearly") == date(2029, 2, 28)


def test_unknown_frequency_raises_value_error():
    with pytest.raises(ValueError):
        advance(date(2026, 1, 1), "fortnightly")


# --------------------------------------------------------------------------- #
# next_due_on_or_after — rolls a bank's reported bill_due_date (Pluggy always
# reports the last CLOSED bill's due date, a past date) forward to its next
# occurrence on `anchor`'s day-of-month.
# --------------------------------------------------------------------------- #


def test_next_due_lands_on_anchor_day_in_refs_month():
    assert next_due_on_or_after(date(2026, 9, 11), date(2026, 10, 1)) == date(2026, 10, 11)


def test_next_due_stays_in_refs_month_when_day_still_ahead():
    # anchor's day (20) hasn't passed yet in ref's month (ref is day 5) —
    # the next occurrence is this month, regardless of anchor's own month.
    assert next_due_on_or_after(date(2026, 1, 20), date(2026, 3, 5)) == date(2026, 3, 20)


def test_next_due_rolls_to_next_month_when_day_already_passed():
    # anchor's day (5) already passed in ref's month (ref is day 10) — the
    # next occurrence rolls to the following month.
    assert next_due_on_or_after(date(2026, 1, 5), date(2026, 3, 10)) == date(2026, 4, 5)


def test_next_due_clamps_jan_31_anchor_into_february():
    # Anchor's day-of-month (31) has no February equivalent — clamp to
    # Feb 28 (2026 is not a leap year).
    assert next_due_on_or_after(date(2026, 1, 31), date(2026, 2, 1)) == date(2026, 2, 28)


def test_next_due_clamps_jan_31_anchor_into_february_in_leap_year():
    assert next_due_on_or_after(date(2028, 1, 31), date(2028, 2, 1)) == date(2028, 2, 29)


def test_next_due_returns_ref_when_anchor_day_matches_ref_day():
    # Day-of-month equality is all that matters — anchor's own (unrelated,
    # past) month/year don't factor in.
    assert next_due_on_or_after(date(2024, 1, 15), date(2026, 9, 15)) == date(2026, 9, 15)
