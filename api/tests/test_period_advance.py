from datetime import date

import pytest

from pecunia.period import advance


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
