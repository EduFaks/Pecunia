import uuid
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.models.account import Account
from pecunia.models.loan import Loan
from pecunia.models.scheduled_transaction import ScheduledTransaction
from pecunia.models.subscription import Subscription
from pecunia.period import month_end, shift_month
from pecunia.services.accounts import AccountService
from pecunia.services.analytics import AnalyticsService
from pecunia.services.recurrence import expand_occurrences
from pecunia.services.scoping import scoped_select
from pecunia.services.snapshots import SnapshotService

# How many months of history `_recent_avg_monthly_expense` averages to size
# the uncertainty band — matches the design's "average monthly non-recurring
# expense over the last 6 months" (v1.4 spec, Track O).
_BAND_LOOKBACK_MONTHS = 6


class ForecastService:
    """Projects the next N months of **cash balance** and **net worth**, per
    currency, from the recurring commitments already on file: scheduled
    transactions (signed — income and expense alike), subscription renewals
    (expense) and loan planned payments (cash out). Clock-free: `today` is
    passed in (§4); a pure read — nothing is written, so the caller never
    needs to commit.

    **Net-worth asymmetry (documented, intentional):** a loan's planned
    payment moves the *cash* series (money actually leaves an account) but
    NEVER the *net-worth* series — paying down a loan trades cash for debt
    reduction in equal measure (cash down, debt down), a net-worth-neutral
    swap. Net worth only moves with projected income/expense (scheduled
    transactions + subscriptions).

    **Uncertainty band:** the average monthly NON-recurring expense over the
    last `_BAND_LOOKBACK_MONTHS` months of real history (the average monthly
    *total* expense, reusing `AnalyticsService.cashflow` — the same figure
    the dashboard's cashflow chart draws — minus the workspace's current
    committed monthly expense, `AnalyticsService.committed_monthly`) widens
    `lower_minor`/`upper_minor` around the committed (dashed) center line by
    ± that average, multiplied by how many months out a point sits — the
    farther out, the wider the band. The committed portion is excluded
    because it's already baked into the center line itself (via
    `expand_occurrences` below); only the leftover, unpredictable spend
    should size the uncertainty around it. This is an honest, explainable
    estimate, not a statistical model.
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def forecast(
        self, workspace_id: uuid.UUID, *, today: date, months: int = 6
    ) -> dict[str, dict[str, list[dict]]]:
        months = max(1, min(months, 24))
        # One point per month-end, starting with the month AFTER today's
        # (the current month's ongoing activity is real history, not a
        # projection) through `months` months out.
        point_dates = [month_end(shift_month(today, i)) for i in range(1, months + 1)]
        horizon_end = point_dates[-1]

        cash_start = await self._cash_start(workspace_id)
        net_worth_start = await SnapshotService(self.db).net_worth_as_of(workspace_id, today)

        cash_deltas: dict[str, list[int]] = {}
        net_worth_deltas: dict[str, list[int]] = {}

        def bucket_index(occurred: date) -> int | None:
            for i, point_date in enumerate(point_dates):
                if occurred <= point_date:
                    return i
            return None

        def add(deltas: dict[str, list[int]], currency: str, idx: int, amount: int) -> None:
            deltas.setdefault(currency, [0] * months)[idx] += amount

        # Scheduled transactions: signed amount (income and expense both),
        # moves cash AND net worth alike.
        scheduled = (
            await self.db.execute(
                scoped_select(ScheduledTransaction, workspace_id).where(
                    ScheduledTransaction.is_active.is_(True)
                )
            )
        ).scalars().all()
        for st in scheduled:
            for occurred in expand_occurrences(st.next_due, st.frequency, horizon_end, today=today):
                idx = bucket_index(occurred)
                if idx is None:
                    continue
                add(cash_deltas, st.currency, idx, st.amount_minor)
                add(net_worth_deltas, st.currency, idx, st.amount_minor)

        # Subscription renewals: a positive cost magnitude — an expense,
        # moves cash AND net worth alike.
        subscriptions = (
            await self.db.execute(
                scoped_select(Subscription, workspace_id).where(Subscription.status == "active")
            )
        ).scalars().all()
        for sub in subscriptions:
            for occurred in expand_occurrences(
                sub.next_renewal, sub.billing_frequency, horizon_end, today=today
            ):
                idx = bucket_index(occurred)
                if idx is None:
                    continue
                add(cash_deltas, sub.currency, idx, -sub.amount_minor)
                add(net_worth_deltas, sub.currency, idx, -sub.amount_minor)

        # Loan planned payments: cash out only — net-worth-neutral (see the
        # class docstring's asymmetry note). Same three-column criterion
        # `AnalyticsService.committed_monthly` filters on (next_due,
        # planned_payment_minor, payment_frequency all required) — kept in
        # sync (L2, filter parity) so the dashboard's "committed monthly"
        # tile and this projection always agree on which loans count as
        # committed. A null `payment_frequency` would already yield no
        # occurrences below (`expand_occurrences` returns `[]` for it), so
        # this filter is explicit rather than load-bearing.
        loans = (
            await self.db.execute(
                scoped_select(Loan, workspace_id).where(
                    Loan.next_due.is_not(None),
                    Loan.planned_payment_minor.is_not(None),
                    Loan.payment_frequency.is_not(None),
                )
            )
        ).scalars().all()
        for loan in loans:
            for occurred in expand_occurrences(
                loan.next_due, loan.payment_frequency, horizon_end, today=today
            ):
                idx = bucket_index(occurred)
                if idx is None:
                    continue
                add(cash_deltas, loan.currency, idx, -loan.planned_payment_minor)

        band_avg = await self._recent_avg_monthly_expense(workspace_id, today)

        currencies = set(cash_start) | set(net_worth_start) | set(cash_deltas) | set(net_worth_deltas)
        result: dict[str, dict[str, list[dict]]] = {}
        for currency in currencies:
            avg = band_avg.get(currency, 0)
            c_deltas = cash_deltas.get(currency, [0] * months)
            n_deltas = net_worth_deltas.get(currency, [0] * months)
            result[currency] = {
                "cash": _walk(point_dates, cash_start.get(currency, 0), c_deltas, avg),
                "net_worth": _walk(point_dates, net_worth_start.get(currency, 0), n_deltas, avg),
            }
        return result

    async def _cash_start(self, workspace_id: uuid.UUID) -> dict[str, int]:
        """Current summed account balance per currency — the forecast's cash
        starting point. Reuses `AccountService.balance` per account (initial
        balance + non-deleted transactions), household scale making the
        per-account loop trivial."""
        accounts = (await self.db.execute(scoped_select(Account, workspace_id))).scalars().all()
        account_service = AccountService(self.db)
        totals: dict[str, int] = {}
        for account in accounts:
            totals[account.currency] = totals.get(account.currency, 0) + await account_service.balance(
                account
            )
        return totals

    async def _recent_avg_monthly_expense(self, workspace_id: uuid.UUID, today: date) -> dict[str, int]:
        """Average monthly NON-recurring spend over the last
        `_BAND_LOOKBACK_MONTHS` months — the uncertainty band's per-month
        width. Computed as the average monthly *total* spend (reusing
        `AnalyticsService.cashflow`'s per-currency, zero-filled month axis)
        MINUS the workspace's current committed monthly expense
        (`AnalyticsService.committed_monthly` — subscriptions + loan planned
        payments + recurring planned expenses, each already normalized to a
        monthly figure), floored at 0. The committed portion is subtracted
        because it's already reflected in the forecast's dashed center line
        (via this class's own `expand_occurrences` projections above) —
        widening the band by it again would double-count it. A currency with
        no recent activity, or where committed spend meets or exceeds total
        spend, has no band (0 — the point sits exactly on the committed
        line)."""
        from_date = shift_month(today, -(_BAND_LOOKBACK_MONTHS - 1))
        analytics = AnalyticsService(self.db)
        cashflow = await analytics.cashflow(workspace_id, from_date=from_date, to_date=today)
        committed = await analytics.committed_monthly(workspace_id)
        result: dict[str, int] = {}
        for currency, points in cashflow.items():
            if not points:
                continue
            avg_total = round(sum(point["spend_minor"] for point in points) / len(points))
            committed_total = committed.get(currency, {}).get("total_minor", 0)
            result[currency] = max(0, avg_total - committed_total)
        return result


def _walk(point_dates: list[date], start: int, deltas: list[int], band_avg: int) -> list[dict]:
    """Walks `start` forward by each month's delta, producing one
    `ForecastPoint` dict per month-end — the running value plus a `lower/
    upper` band that widens by `band_avg` for every month out (month 1 = ±1x,
    month 2 = ±2x, ...). Always `projected: True` — this service only ever
    returns future points; the caller appends them after real history."""
    points: list[dict] = []
    running = start
    for i, point_date in enumerate(point_dates):
        running += deltas[i]
        width = band_avg * (i + 1)
        points.append(
            {
                "date": point_date,
                "value_minor": running,
                "lower_minor": running - width,
                "upper_minor": running + width,
                "projected": True,
            }
        )
    return points
