import uuid
from collections.abc import Callable
from datetime import date

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.models.account import Account
from pecunia.models.bank_sync import BankAccountLink
from pecunia.models.loan import Loan, LoanDirection
from pecunia.models.scheduled_transaction import ScheduledTransaction
from pecunia.models.subscription import Subscription
from pecunia.models.transaction import Transaction
from pecunia.period import advance, current_window, month_end, next_due_on_or_after, shift_month
from pecunia.services.accounts import AccountService
from pecunia.services.analytics import AnalyticsService
from pecunia.services.loans import LoanService
from pecunia.services.recurrence import expand_occurrences
from pecunia.services.scoping import scoped_select

# Safety cap on the number of payment occurrences `debt_payoffs` will step
# through before giving up on a loan — guards against an (near-)zero
# `planned_payment_minor` against a large balance looping effectively
# forever. 24 mirrors every other "projection horizon" cap in this module/
# `ForecastService` (`months = max(1, min(months, 24))`): at the common
# monthly cadence this is exactly 24 months; for weekly/quarterly/yearly
# loans it is simply 24 occurrences of THAT loan's own schedule, not a
# fixed calendar horizon — a deliberately simple reading of "24 months of
# stepping", same as the rest of the codebase keeps these caps as plain
# iteration counts rather than date arithmetic.
_PAYOFF_STEP_CAP = 24

# How many months of history the variable (realistic-only) band averages —
# kept in lock-step with `ForecastService._BAND_LOOKBACK_MONTHS` (same
# "average monthly non-recurring expense" basis), surfaced in the response
# as `variable_lookback_months` for the breakdown caption.
_BAND_LOOKBACK_MONTHS = 6

_ZERO_COMPONENTS = {
    "income_minor": 0, "subscriptions_minor": 0, "loans_minor": 0, "card_bills_minor": 0,
}


class ProjectionService:
    """A forward cash projection, per currency, that extends
    `ForecastService`'s month-end axis and uncertainty-band basis with two
    explicit lines and a per-month component breakdown instead of a single
    banded line:

    - **optimistic**: `start` + Σ (scheduled income − subscriptions/recurring
      expenses − loan payments − credit-card bills) — everything already
      committed on file, nothing guessed.
    - **realistic**: `optimistic` minus the CUMULATIVE "variable" band (the
      same average monthly non-recurring spend `ForecastService`'s
      uncertainty band widens by), applied as a constant per-month deduction
      — the honest "if your unplanned spending keeps pace with the last
      `_BAND_LOOKBACK_MONTHS` months" line.

    Every month keeps its own component deltas (`income_minor`,
    `subscriptions_minor`, `loans_minor`, `card_bills_minor`,
    `variable_minor`) so the UI can show what each number is made of, not
    just the running total.

    Credit-card bills are folded in as ONE-TIME outflows at their rolled
    due date (`next_due_on_or_after`), computed with the exact
    `SafeToSpendService` formula (including its `transfer_id IS NULL`
    fix) — never repeated once that bill has landed in its month.

    Clock-free (`today` passed in, CONVENTIONS §4); a pure read — nothing is
    written, so the caller never needs to commit. Per-currency; figures are
    NEVER summed across currencies (§4).
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def project(
        self, workspace_id: uuid.UUID, *, today: date, months: int = 6
    ) -> dict[str, dict]:
        months = max(1, min(months, 24))
        # Same axis ForecastService.forecast builds: one point per month-end,
        # starting the month AFTER today through `months` months out.
        point_dates = [month_end(shift_month(today, i)) for i in range(1, months + 1)]
        horizon_end = point_dates[-1]

        start = await self._cash_start(workspace_id)

        def bucket_index(occurred: date) -> int | None:
            for i, point_date in enumerate(point_dates):
                if occurred <= point_date:
                    return i
            return None

        components: dict[str, dict[str, list[int]]] = {}
        labels: dict[str, list[list[dict]]] = {}

        def bucket(currency: str) -> dict[str, list[int]]:
            if currency not in components:
                components[currency] = {key: [0] * months for key in _ZERO_COMPONENTS}
                labels[currency] = [[] for _ in range(months)]
            return components[currency]

        # Scheduled transactions: positive (income) and negative (recurring
        # expense) both fold in here — the latter into subscriptions_minor,
        # mirroring how AnalyticsService.committed_monthly groups
        # subscriptions + recurring scheduled expenses under one committed
        # bucket (so the component keys stay exactly the five documented
        # above, no extra key for "recurring expenses").
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
                b = bucket(st.currency)
                if st.amount_minor > 0:
                    b["income_minor"][idx] += st.amount_minor
                elif st.amount_minor < 0:
                    b["subscriptions_minor"][idx] += -st.amount_minor

        # Subscription renewals: an expense magnitude, same bucket.
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
                bucket(sub.currency)["subscriptions_minor"][idx] += sub.amount_minor

        # Loan planned payments — same three-column criterion
        # (`next_due`/`planned_payment_minor`/`payment_frequency` all set)
        # `AnalyticsService.committed_monthly`/`ForecastService.forecast` use,
        # kept in sync so every committed-cost view agrees on which loans
        # count.
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
                bucket(loan.currency)["loans_minor"][idx] += loan.planned_payment_minor

        await self._fold_card_bills(
            workspace_id, today=today, horizon_end=horizon_end,
            bucket_index=bucket_index, bucket=bucket, labels=labels,
        )

        band_avg = await self._recent_avg_monthly_expense(workspace_id, today)

        currencies = set(start) | set(components) | set(band_avg)
        result: dict[str, dict] = {}
        for currency in currencies:
            comp = components.get(currency) or {key: [0] * months for key in _ZERO_COMPONENTS}
            lbls = labels.get(currency) or [[] for _ in range(months)]
            avg = band_avg.get(currency, 0)
            base = start.get(currency, 0)

            points: list[dict] = []
            running_optimistic = base
            cumulative_variable = 0
            for i, point_date in enumerate(point_dates):
                delta = (
                    comp["income_minor"][i]
                    - comp["subscriptions_minor"][i]
                    - comp["loans_minor"][i]
                    - comp["card_bills_minor"][i]
                )
                running_optimistic += delta
                cumulative_variable += avg
                points.append(
                    {
                        "date": point_date,
                        "optimistic_minor": running_optimistic,
                        "realistic_minor": running_optimistic - cumulative_variable,
                        "components": {
                            "income_minor": comp["income_minor"][i],
                            "subscriptions_minor": comp["subscriptions_minor"][i],
                            "loans_minor": comp["loans_minor"][i],
                            "card_bills_minor": comp["card_bills_minor"][i],
                            "variable_minor": avg,
                        },
                        "card_bill_labels": lbls[i],
                    }
                )

            result[currency] = {
                "currency": currency,
                "points": points,
                **self._derive(today, base, points),
                "variable_lookback_months": _BAND_LOOKBACK_MONTHS,
            }
        return result

    async def debt_payoffs(self, workspace_id: uuid.UUID, *, today: date) -> list[dict]:
        """A deterministic, no-interest payoff ETA for every BORROWED loan
        with a full payment schedule set (`planned_payment_minor > 0`,
        `payment_frequency` and `next_due` all present) — a `lent` loan is a
        receivable, not a debt, so it is excluded regardless of schedule
        (mirrors the three-field criterion `project`'s loan bucketing and
        `AnalyticsService.committed_monthly`/`ForecastService.forecast`
        already share).

        V1 loans carry no amortization — `LoanService.remaining_minor` is a
        flat `principal − Σ payments` ledger (CONVENTIONS §4) — and interest
        is NOT modeled here either: this is a plain "how many more payments
        at the CURRENT planned amount, from the CURRENT remaining balance"
        projection, not a real amortization schedule with interest accrual.

        Starting from `next_due` stepped forward (via `period.advance`, the
        same cadence-preserving rule `expand_occurrences` uses for every
        other scheduled source) past any occurrence before `today`, each
        step subtracts `planned_payment_minor` from the loan's current
        `remaining_minor` until it reaches zero or below — capped at
        `_PAYOFF_STEP_CAP` occurrences. A loan already at (or past) zero
        needs no further payments: `payments_left=0`, `payoff_date=today`.
        Past the cap without reaching zero, `payoff_date`/`payments_left`
        come back `None` — never paid off at this pace, at least not within
        a horizon worth projecting."""
        loan_service = LoanService(self.db)
        loans = (
            await self.db.execute(
                scoped_select(Loan, workspace_id).where(
                    Loan.direction == LoanDirection.BORROWED,
                    Loan.planned_payment_minor.is_not(None),
                    Loan.planned_payment_minor > 0,
                    Loan.payment_frequency.is_not(None),
                    Loan.next_due.is_not(None),
                )
            )
        ).scalars().all()

        results: list[dict] = []
        for loan in loans:
            remaining_minor = await loan_service.remaining_minor(loan)

            payoff_date: date | None
            payments_left: int | None
            if remaining_minor <= 0:
                payoff_date, payments_left = today, 0
            else:
                due = loan.next_due
                while due < today:
                    due = advance(due, loan.payment_frequency)

                payoff_date, payments_left = None, None
                step_remaining = remaining_minor
                for step in range(1, _PAYOFF_STEP_CAP + 1):
                    step_remaining -= loan.planned_payment_minor
                    if step_remaining <= 0:
                        payoff_date, payments_left = due, step
                        break
                    due = advance(due, loan.payment_frequency)

            results.append({
                "loan_id": loan.id,
                "name": loan.name,
                "remaining_minor": remaining_minor,
                "planned_payment_minor": loan.planned_payment_minor,
                "payment_frequency": loan.payment_frequency,
                "currency": loan.currency,
                "payoff_date": payoff_date,
                "payments_left": payments_left,
            })
        return results

    @staticmethod
    def _derive(today: date, start: int, points: list[dict]) -> dict:
        """`runway_months`/`runway_until`, `lowest_point` and `recovery` —
        all read off the REALISTIC line, and all derived from the SAME
        series: seeded with `{date: today, value: start}` ahead of the
        projected points, so a dip that's already true TODAY (current
        balance already negative) shows up rather than being invisible
        until the next projected point. Deriving `runway_months` from
        `points` alone (ignoring `start`) could report "no risk" (`None`)
        in the same breath `recovery` reports a non-null "recovered from a
        dip" — a self-contradictory payload that hides an already-negative
        balance. So:

        - already overdrawn TODAY (`start < 0`) -> `runway_months = 0`,
          `runway_until = today` — there is no runway left to report.
        - else -> the usual 1-based index into `points` of the first
          realistic-negative month (there is no "month 0" to date in this
          branch, since `start >= 0`).
        - nothing ever negative (including `start`) -> both `None`.
        """
        seeded = [{"date": today, "value": start}] + [
            {"date": p["date"], "value": p["realistic_minor"]} for p in points
        ]

        runway_months: int | None
        runway_until: date | None
        if start < 0:
            runway_months = 0
            runway_until = today
        else:
            runway_months = None
            runway_until = None
            for i, point in enumerate(points):
                if point["realistic_minor"] < 0:
                    runway_months = i + 1
                    runway_until = point["date"]
                    break

        lowest = seeded[0]
        for item in seeded[1:]:
            if item["value"] < lowest["value"]:
                lowest = item

        recovery: dict | None = None
        seen_negative = False
        for item in seeded:
            if seen_negative and item["value"] >= 0:
                recovery = {"date": item["date"], "value_minor": item["value"]}
                break
            if item["value"] < 0:
                seen_negative = True

        return {
            "runway_months": runway_months,
            "runway_until": runway_until,
            "lowest_point": {"value_minor": lowest["value"], "date": lowest["date"]},
            "recovery": recovery,
        }

    async def _fold_card_bills(
        self,
        workspace_id: uuid.UUID,
        *,
        today: date,
        horizon_end: date,
        bucket_index: Callable[[date], int | None],
        bucket: Callable[[str], dict[str, list[int]]],
        labels: dict[str, list[list[dict]]],
    ) -> None:
        """Each linked credit card's upcoming bill, folded in as a one-time
        outflow at its rolled due date — identical formula to
        `SafeToSpendService.compute` (including the `transfer_id IS NULL`
        fix for `card_spend_mtd`), just bucketed onto the month-end axis
        instead of restricted to the current calendar month. Each card
        counted exactly once (it has exactly one next-due bill)."""
        month_start, _ = current_window("monthly", today)
        card_links = (
            await self.db.execute(
                scoped_select(BankAccountLink, workspace_id)
                .join(Account, Account.id == BankAccountLink.account_id)
                .where(
                    Account.type == "credit_card",
                    BankAccountLink.provider_balance_minor.is_not(None),
                    BankAccountLink.bill_due_date.is_not(None),
                )
                .add_columns(Account.currency, Account.name)
            )
        ).all()
        for link, currency, name in card_links:
            rolled_due = next_due_on_or_after(link.bill_due_date, today)
            if rolled_due > horizon_end:
                continue
            idx = bucket_index(rolled_due)
            if idx is None:
                continue
            owed = abs(link.provider_balance_minor)
            card_spend_mtd = await self.db.scalar(
                sa.select(sa.func.coalesce(sa.func.sum(-Transaction.amount_minor), 0)).where(
                    Transaction.workspace_id == workspace_id,
                    Transaction.account_id == link.account_id,
                    Transaction.amount_minor < 0,
                    Transaction.transfer_id.is_(None),
                    Transaction.occurred_on >= month_start,
                    Transaction.occurred_on <= today,
                    Transaction.deleted_at.is_(None),
                )
            )
            bill = max(0, owed - card_spend_mtd)
            bucket(currency)["card_bills_minor"][idx] += bill
            if bill > 0:
                labels[currency][idx].append({"label": name, "amount_minor": bill})

    async def _cash_start(self, workspace_id: uuid.UUID) -> dict[str, int]:
        """Current summed account balance per currency — mirrors
        `ForecastService._cash_start` exactly (per-account
        `AccountService.balance`, grouped by currency)."""
        accounts = (await self.db.execute(scoped_select(Account, workspace_id))).scalars().all()
        account_service = AccountService(self.db)
        totals: dict[str, int] = {}
        for account in accounts:
            totals[account.currency] = totals.get(account.currency, 0) + await account_service.balance(
                account
            )
        return totals

    async def _recent_avg_monthly_expense(self, workspace_id: uuid.UUID, today: date) -> dict[str, int]:
        """The variable (realistic-only) band's per-month width — mirrors
        `ForecastService._recent_avg_monthly_expense` exactly: average
        monthly TOTAL spend over the last `_BAND_LOOKBACK_MONTHS` months
        (`AnalyticsService.cashflow`) minus the workspace's committed
        monthly expense (`AnalyticsService.committed_monthly`), floored at
        0 — the leftover, unpredictable portion not already baked into the
        optimistic line's committed deltas."""
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
