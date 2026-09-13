"""Period-window math for budget-vs-actual reporting.

Pure and clock-free by design: `current_window` takes the reference date as a
parameter rather than reading the system clock, so it is unit-testable with
fixed dates in isolation. Runtime callers (the budgets router) pass
`date.today()`; tests pass whatever fixed date the scenario needs.
"""

import calendar
from datetime import date, timedelta


def current_window(period: str, ref: date) -> tuple[date, date]:
    """Return the inclusive (start, end) dates of the current `period`
    window containing `ref`.

    - weekly: the ISO week (Monday-Sunday) containing `ref`.
    - monthly: the calendar month containing `ref`.
    - quarterly: the calendar quarter (Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec).
    - yearly: the calendar year containing `ref`.
    """
    if period == "weekly":
        start = ref - timedelta(days=ref.isoweekday() - 1)
        end = start + timedelta(days=6)
        return start, end
    if period == "monthly":
        start = ref.replace(day=1)
        end = ref.replace(day=calendar.monthrange(ref.year, ref.month)[1])
        return start, end
    if period == "quarterly":
        quarter_start_month = ((ref.month - 1) // 3) * 3 + 1
        quarter_end_month = quarter_start_month + 2
        start = date(ref.year, quarter_start_month, 1)
        end = date(ref.year, quarter_end_month, calendar.monthrange(ref.year, quarter_end_month)[1])
        return start, end
    if period == "yearly":
        return date(ref.year, 1, 1), date(ref.year, 12, 31)
    raise ValueError(f"unknown period: {period!r}")


_ADVANCE_MONTHS = {"monthly": 1, "quarterly": 3, "yearly": 12}


def advance(d: date, frequency: str, interval: int = 1) -> date:
    """The next occurrence of a `frequency` recurrence `interval` periods after
    `d`. Pure and clock-free — the recurrence math for scheduled transactions.

    - weekly: `d` + 7 * `interval` days.
    - monthly/quarterly/yearly: `d` shifted 1/3/12 * `interval` calendar months,
      keeping the day-of-month but clamping to the target month's last day when
      the day doesn't exist there (Jan 31 + 1 month → Feb 28/29). Reuses the
      same `shift_month` + end-of-month logic `current_window` relies on.

    Raises ValueError on an unknown frequency.
    """
    if frequency == "weekly":
        return d + timedelta(days=7 * interval)
    months = _ADVANCE_MONTHS.get(frequency)
    if months is None:
        raise ValueError(f"unknown frequency: {frequency!r}")
    target = shift_month(d, months * interval)  # first of the target month
    return target.replace(day=min(d.day, month_end(target).day))


def month_end(ref: date) -> date:
    """The last calendar day of the month containing `ref`. Clock-free."""
    return ref.replace(day=calendar.monthrange(ref.year, ref.month)[1])


def shift_month(ref: date, delta: int) -> date:
    """The first day of the month `delta` calendar months away from `ref`'s
    month (negative `delta` goes back). Clock-free; pair with `month_end` to
    land on that month's last day."""
    index = ref.year * 12 + (ref.month - 1) + delta
    year, month = divmod(index, 12)
    return date(year, month + 1, 1)


def month_starts(from_date: date, to_date: date) -> list[date]:
    """The first-of-month dates spanning `from_date`'s month through
    `to_date`'s month, inclusive, oldest first — the continuous month axis a
    range chart buckets against. Empty when `to_date` precedes `from_date`'s
    month. Clock-free."""
    starts: list[date] = []
    cur = from_date.replace(day=1)
    while cur <= to_date:
        starts.append(cur)
        cur = shift_month(cur, 1)
    return starts
