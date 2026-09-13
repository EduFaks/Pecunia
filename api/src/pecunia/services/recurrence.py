"""Pure recurrence-occurrence expansion, shared by the forecasting engine
(Track O) to project future dates for scheduled transactions, subscription
renewals and loan payments alike. Clock-free (`today` is passed in, §4) and
dependency-free — reuses `pecunia.period.advance`, the same step logic
`ScheduledTransactionService`/`SubscriptionService` already use to advance
`next_due`/`next_renewal` on post/renew."""

from datetime import date

from pecunia import period

# The recurrence vocabulary `period.advance` understands (weekly/monthly/
# quarterly/yearly — see ScheduleFrequency). Anything else (including None)
# is not a recognized recurrence, so it expands to no occurrences at all.
_VALID_FREQUENCIES = frozenset({"weekly", "monthly", "quarterly", "yearly"})


def expand_occurrences(
    anchor: date, frequency: str | None, horizon_end: date, *, today: date
) -> list[date]:
    """Every occurrence date `d` of a `frequency` recurrence anchored at
    `anchor`, restricted to `today <= d <= horizon_end`, oldest first.

    `anchor` may be in the past (a schedule's `next_due`/`next_renewal` is
    always its *next* occurrence at read time, but a forecast may be asked to
    expand from an older anchor too) — occurrences before `today` are stepped
    past, never returned; only the upcoming ones in the horizon come back.
    Each step reuses `period.advance`, so month-end clamping (Jan 31 + 1mo ->
    Feb 28) matches the same rule scheduled transactions/subscriptions already
    apply when they advance their own `next_due`/`next_renewal`.

    An unknown or missing frequency (including `None`) yields `[]` — nothing
    to project, rather than raising, so a caller can expand a heterogeneous
    mix of sources (e.g. a loan with no `payment_frequency` set) without
    special-casing each one.
    """
    if frequency not in _VALID_FREQUENCIES:
        return []

    occurrences: list[date] = []
    current = anchor
    # Step past any occurrences before today — a past anchor still yields
    # only the upcoming ones.
    while current < today:
        current = period.advance(current, frequency)
    while current <= horizon_end:
        occurrences.append(current)
        current = period.advance(current, frequency)
    return occurrences
