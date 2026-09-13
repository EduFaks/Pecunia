from datetime import date

from pecunia.services.recurrence import expand_occurrences


def test_monthly_from_anchor_yields_one_date_per_month_in_horizon():
    result = expand_occurrences(
        date(2026, 9, 1), "monthly", date(2026, 12, 31), today=date(2026, 9, 1)
    )
    assert result == [
        date(2026, 9, 1), date(2026, 10, 1), date(2026, 11, 1), date(2026, 12, 1),
    ]


def test_past_anchor_projects_only_upcoming_occurrences():
    # Anchor is 8 months before today — only occurrences on/after today appear.
    result = expand_occurrences(
        date(2026, 1, 15), "monthly", date(2026, 9, 30), today=date(2026, 9, 1)
    )
    assert result == [date(2026, 9, 15)]


def test_weekly_steps_by_seven_days():
    result = expand_occurrences(
        date(2026, 9, 1), "weekly", date(2026, 9, 22), today=date(2026, 9, 1)
    )
    assert result == [
        date(2026, 9, 1), date(2026, 9, 8), date(2026, 9, 15), date(2026, 9, 22),
    ]


def test_quarterly_steps_by_three_months():
    result = expand_occurrences(
        date(2026, 1, 15), "quarterly", date(2026, 12, 31), today=date(2026, 1, 15)
    )
    assert result == [date(2026, 1, 15), date(2026, 4, 15), date(2026, 7, 15), date(2026, 10, 15)]


def test_yearly_steps_by_twelve_months():
    result = expand_occurrences(
        date(2025, 3, 10), "yearly", date(2027, 12, 31), today=date(2026, 1, 1)
    )
    assert result == [date(2026, 3, 10), date(2027, 3, 10)]


def test_end_of_month_clamps():
    # Jan 31 + 1 month has no Feb 31 — clamp to Feb 28 (2026 not a leap year).
    result = expand_occurrences(
        date(2026, 1, 31), "monthly", date(2026, 2, 28), today=date(2026, 1, 31)
    )
    assert result == [date(2026, 1, 31), date(2026, 2, 28)]


def test_unknown_frequency_returns_empty_list():
    result = expand_occurrences(
        date(2026, 1, 1), "fortnightly", date(2026, 12, 31), today=date(2026, 1, 1)
    )
    assert result == []


def test_none_frequency_returns_empty_list():
    result = expand_occurrences(
        date(2026, 1, 1), None, date(2026, 12, 31), today=date(2026, 1, 1)
    )
    assert result == []


def test_anchor_after_horizon_returns_empty_list():
    result = expand_occurrences(
        date(2027, 1, 1), "monthly", date(2026, 12, 31), today=date(2026, 1, 1)
    )
    assert result == []


def test_horizon_before_today_returns_empty_list():
    result = expand_occurrences(
        date(2026, 1, 1), "monthly", date(2026, 1, 15), today=date(2026, 2, 1)
    )
    assert result == []
