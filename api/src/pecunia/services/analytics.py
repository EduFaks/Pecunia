import uuid
from datetime import date, timedelta

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.models.asset import AssetValuation
from pecunia.models.budget import Budget
from pecunia.models.category import Category
from pecunia.models.contact import Contact
from pecunia.models.loan import Loan, LoanPayment
from pecunia.models.portfolio import HoldingPrice
from pecunia.models.scheduled_transaction import ScheduledTransaction
from pecunia.models.subscription import Subscription
from pecunia.models.transaction import Transaction
from pecunia.period import current_window, month_end, month_starts, shift_month
from pecunia.services.budgets import BudgetService
from pecunia.services.scoping import scoped_select
from pecunia.services.snapshots import SnapshotService
from pecunia.services.subscriptions import monthly_minor

# Deterministic tiebreak for `upcoming`'s merged due list when two items share a
# due date: planned rules, then subscription renewals, then loan payments.
_DUE_KIND_ORDER = {"planned": 0, "subscription": 1, "loan": 2}

# The only cashflow bucketing implemented in v1.1. Kept as a constant so the
# router can constrain the query param to the same set (a future "week" bucket
# would land here and in `cashflow`).
GRANULARITIES = ("month",)

# `net_worth_components_as_of`'s four bucket keys, labeled for `summary`'s
# net-worth-change "top movers" (matches the labels the composition chart's
# legend already uses, `web/src/features/analytics/NetWorthComposition.tsx`).
_COMPONENT_LABELS = {
    "cash_minor": "Cash",
    "assets_minor": "Assets",
    "investments_minor": "Investments",
    "debts_minor": "Debts",
}
_ZERO_COMPONENTS = {"cash_minor": 0, "assets_minor": 0, "investments_minor": 0, "debts_minor": 0}

# How many top movers `summary`'s net-worth-change surfaces.
_TOP_MOVERS = 3


def _rate_bps(saved_minor: int, income_minor: int) -> int:
    """A savings rate in basis points (`saved / income`), or 0 when there was
    no income to rate against — never a division by zero."""
    return round(saved_minor / income_minor * 10_000) if income_minor > 0 else 0


def _empty_savings() -> dict:
    return {
        "income_minor": 0, "spend_minor": 0, "saved_minor": 0, "rate_bps": 0,
        "prev_saved_minor": 0, "prev_rate_bps": 0,
    }


def _empty_committed_monthly() -> dict:
    return {"total_minor": 0, "subscriptions_minor": 0, "loans_minor": 0, "planned_minor": 0}


def _empty_net_worth_change() -> dict:
    return {"now_minor": 0, "start_of_month_minor": 0, "delta_minor": 0, "pct_bps": 0, "movers": []}


class AnalyticsService:
    """Read-only aggregation queries over the existing finance tables, all
    workspace-scoped (D7) and currency-grouped — figures for different
    currencies are NEVER summed together (CONVENTIONS §4). Income/spend always
    exclude soft-deleted transactions and transfer legs.

    Contract: every method here is a pure read — nothing is written, so the
    caller never needs to commit after calling into this service.
    `net_worth_series` and `net_worth_composition` both reconstruct their
    points on the fly from dated data (accounts/transactions, asset
    valuations, holding prices, loan payments) rather than reading the
    persisted `net_worth_snapshots` table, so neither depends on a snapshot
    ever having been captured. Clock-free: dates are passed in (§4)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def cashflow(
        self,
        workspace_id: uuid.UUID,
        *,
        from_date: date,
        to_date: date,
        granularity: str = "month",
    ) -> dict[str, list[dict]]:
        """Per-currency income vs. spend, bucketed by calendar month across the
        inclusive [from_date, to_date] window.

        Returns `{currency: [{period_start, income_minor, spend_minor}, ...]}`.
        Every month in the range is emitted for each currency that has activity
        — including zero months — so a chart draws a continuous axis. Income =
        Σ positive `amount_minor`; spend = Σ ABS(negative `amount_minor`); both
        exclude soft-deleted transactions and transfer legs.
        """
        if granularity != "month":
            raise ValueError(f"unsupported granularity: {granularity!r}")

        year_col = sa.cast(sa.func.extract("year", Transaction.occurred_on), sa.Integer)
        month_col = sa.cast(sa.func.extract("month", Transaction.occurred_on), sa.Integer)
        income = sa.func.coalesce(
            sa.func.sum(sa.case((Transaction.amount_minor > 0, Transaction.amount_minor), else_=0)), 0
        )
        spend = sa.func.coalesce(
            sa.func.sum(sa.case((Transaction.amount_minor < 0, -Transaction.amount_minor), else_=0)), 0
        )
        stmt = (
            sa.select(
                Transaction.currency,
                year_col.label("yr"),
                month_col.label("mo"),
                income.label("income"),
                spend.label("spend"),
            )
            .where(
                Transaction.workspace_id == workspace_id,
                Transaction.deleted_at.is_(None),
                Transaction.transfer_id.is_(None),
                Transaction.occurred_on >= from_date,
                Transaction.occurred_on <= to_date,
            )
            .group_by(Transaction.currency, year_col, month_col)
        )

        # currency -> {month_start: (income, spend)}
        buckets: dict[str, dict[date, tuple[int, int]]] = {}
        for currency, yr, mo, inc, spent in (await self.db.execute(stmt)).all():
            buckets.setdefault(currency, {})[date(yr, mo, 1)] = (int(inc), int(spent))

        axis = month_starts(from_date, to_date)
        result: dict[str, list[dict]] = {}
        for currency, by_month in buckets.items():
            result[currency] = [
                {
                    "period_start": m,
                    "income_minor": by_month.get(m, (0, 0))[0],
                    "spend_minor": by_month.get(m, (0, 0))[1],
                }
                for m in axis
            ]
        return result

    async def spending_by_category(
        self, workspace_id: uuid.UUID, *, from_date: date, to_date: date
    ) -> dict[str, list[dict]]:
        """Per-currency expense magnitude grouped by category over [from_date,
        to_date]. `{currency: [{category_id, name, color, spend_minor}, ...]}`,
        sorted by spend descending. Null-category expenses collapse into an
        "Uncategorized" bucket (`category_id=None, color=None`). Excludes
        soft-deleted transactions and transfer legs."""
        spend = sa.func.sum(-Transaction.amount_minor)
        stmt = (
            sa.select(
                Transaction.currency,
                Transaction.category_id,
                Category.name,
                Category.color,
                spend.label("spend"),
            )
            .outerjoin(Category, Category.id == Transaction.category_id)
            .where(*self._expense_predicates(workspace_id, from_date, to_date))
            .group_by(Transaction.currency, Transaction.category_id, Category.name, Category.color)
        )
        result: dict[str, list[dict]] = {}
        for currency, category_id, name, color, total in (await self.db.execute(stmt)).all():
            row = (
                {"category_id": category_id, "name": name, "color": color, "spend_minor": int(total)}
                if category_id is not None
                else {"category_id": None, "name": "Uncategorized", "color": None, "spend_minor": int(total)}
            )
            result.setdefault(currency, []).append(row)
        for rows in result.values():
            rows.sort(key=lambda r: r["spend_minor"], reverse=True)
        return result

    async def spending_by_contact(
        self, workspace_id: uuid.UUID, *, from_date: date, to_date: date
    ) -> dict[str, list[dict]]:
        """Per-currency expense magnitude grouped by contact over [from_date,
        to_date]. `{currency: [{contact_id, name, spend_minor}, ...]}`, sorted by
        spend descending. Null-contact expenses collapse into a "No contact"
        bucket. Excludes soft-deleted transactions and transfer legs."""
        spend = sa.func.sum(-Transaction.amount_minor)
        stmt = (
            sa.select(
                Transaction.currency,
                Transaction.contact_id,
                Contact.name,
                spend.label("spend"),
            )
            .outerjoin(Contact, Contact.id == Transaction.contact_id)
            .where(*self._expense_predicates(workspace_id, from_date, to_date))
            .group_by(Transaction.currency, Transaction.contact_id, Contact.name)
        )
        result: dict[str, list[dict]] = {}
        for currency, contact_id, name, total in (await self.db.execute(stmt)).all():
            row = (
                {"contact_id": contact_id, "name": name, "spend_minor": int(total)}
                if contact_id is not None
                else {"contact_id": None, "name": "No contact", "spend_minor": int(total)}
            )
            result.setdefault(currency, []).append(row)
        for rows in result.values():
            rows.sort(key=lambda r: r["spend_minor"], reverse=True)
        return result

    async def contact_overview(
        self, workspace_id: uuid.UUID, contact_id: uuid.UUID, *, from_date: date, to_date: date
    ) -> dict[str, dict]:
        """Per-currency money-in/out/net + count + a by-category breakdown for a
        single contact over [from_date, to_date]. Shape:

            {currency: {
                "money_in_minor": int,   # Σ positive amount_minor
                "money_out_minor": int,  # Σ ABS(negative amount_minor)
                "net_minor": int,        # in - out
                "transaction_count": int,
                "by_category": [{category_id, name, color, in_minor, out_minor}, ...],
            }}

        `by_category` groups this contact's activity by category (null-category
        rows collapse into an "Uncategorized" bucket, `category_id=None,
        color=None`), sorted by out (spend) descending then in descending, so
        the biggest spend leads and income-only categories trail. Like every
        other aggregation here it excludes soft-deleted transactions and
        transfer legs, is workspace-scoped (D7), and NEVER sums figures across
        currencies (§4). Clock-free: the window is passed in."""
        in_sum = sa.func.coalesce(
            sa.func.sum(sa.case((Transaction.amount_minor > 0, Transaction.amount_minor), else_=0)), 0
        )
        out_sum = sa.func.coalesce(
            sa.func.sum(sa.case((Transaction.amount_minor < 0, -Transaction.amount_minor), else_=0)), 0
        )
        count_col = sa.func.count()
        stmt = (
            sa.select(
                Transaction.currency,
                Transaction.category_id,
                Category.name,
                Category.color,
                in_sum.label("in_minor"),
                out_sum.label("out_minor"),
                count_col.label("cnt"),
            )
            .outerjoin(Category, Category.id == Transaction.category_id)
            .where(
                Transaction.workspace_id == workspace_id,
                Transaction.contact_id == contact_id,
                Transaction.deleted_at.is_(None),
                Transaction.transfer_id.is_(None),
                Transaction.occurred_on >= from_date,
                Transaction.occurred_on <= to_date,
            )
            .group_by(Transaction.currency, Transaction.category_id, Category.name, Category.color)
        )

        result: dict[str, dict] = {}
        for currency, category_id, name, color, in_minor, out_minor, cnt in (
            await self.db.execute(stmt)
        ).all():
            bucket = result.setdefault(
                currency,
                {
                    "money_in_minor": 0,
                    "money_out_minor": 0,
                    "net_minor": 0,
                    "transaction_count": 0,
                    "by_category": [],
                },
            )
            bucket["money_in_minor"] += int(in_minor)
            bucket["money_out_minor"] += int(out_minor)
            bucket["transaction_count"] += int(cnt)
            bucket["by_category"].append(
                {
                    "category_id": category_id,
                    "name": name,
                    "color": color,
                    "in_minor": int(in_minor),
                    "out_minor": int(out_minor),
                }
                if category_id is not None
                else {
                    "category_id": None,
                    "name": "Uncategorized",
                    "color": None,
                    "in_minor": int(in_minor),
                    "out_minor": int(out_minor),
                }
            )
        for bucket in result.values():
            bucket["net_minor"] = bucket["money_in_minor"] - bucket["money_out_minor"]
            bucket["by_category"].sort(key=lambda r: (r["out_minor"], r["in_minor"]), reverse=True)
        return result

    async def net_worth_series(
        self, workspace_id: uuid.UUID, *, from_date: date, to_date: date
    ) -> dict[str, list[dict]]:
        """Per-currency net-worth series over [from_date, to_date], RECONSTRUCTED
        at one point per month — exactly the same month axis and reconstruction
        `net_worth_composition` uses (`SnapshotService.net_worth_as_of`, the sum
        of that method's four components), just collapsed to the one headline
        figure instead of kept as separate parts. This means the series draws
        real history for a workspace with dated assets/loans/prices but few or
        no persisted snapshots — it no longer depends on `net_worth_snapshots`
        ever having been captured (that table and `SnapshotService.capture`/
        `backfill` still exist and are still written elsewhere; this method
        just no longer reads or writes them).

        Returns `{currency: [{date, net_worth_minor}, ...]}`, oldest first —
        same shape/keys the frontend already reads. The month axis matches
        `net_worth_composition`: the month-end of each month in the window,
        with the final month clamped to `to_date` itself. Every currency with
        any activity gets the full, continuous axis (0 at a point with no
        activity yet). Currencies are never summed together (§4). A pure
        read — unlike the old snapshot-capturing version, this never writes,
        so the caller need not commit. Clock-free: the window is passed in."""
        snapshots = SnapshotService(self.db)
        point_dates = [min(month_end(m), to_date) for m in month_starts(from_date, to_date)]

        by_currency: dict[str, dict[date, int]] = {}
        for on_date in point_dates:
            for currency, net_worth_minor in (
                await snapshots.net_worth_as_of(workspace_id, on_date)
            ).items():
                by_currency.setdefault(currency, {})[on_date] = net_worth_minor

        result: dict[str, list[dict]] = {}
        for currency, by_date in by_currency.items():
            result[currency] = [
                {"date": d, "net_worth_minor": by_date.get(d, 0)} for d in point_dates
            ]
        return result

    async def earliest_activity_date(self, workspace_id: uuid.UUID, *, today: date) -> date:
        """The earliest dated activity anywhere in this workspace's finance
        data — the `from` bound for an "all time" Insights range (`all=true`
        on net-worth-composition/spending-by-category/spending-by-contact).
        The minimum across `transactions.occurred_on`, `asset_valuations.as_of`,
        `holding_prices.as_of`, `loan_payments.paid_on`, `loans.opened_on`, and
        `subscriptions.started_on` — whichever of those exist for this
        workspace. Falls back to `today` when the workspace has none of them
        (an empty/brand-new workspace has no history to extend to). Clock-free:
        `today` is passed in (§4)."""
        candidates: list[date] = []
        for model, column in (
            (Transaction, Transaction.occurred_on),
            (AssetValuation, AssetValuation.as_of),
            (HoldingPrice, HoldingPrice.as_of),
            (LoanPayment, LoanPayment.paid_on),
            (Loan, Loan.opened_on),
            (Subscription, Subscription.started_on),
        ):
            earliest = await self.db.scalar(
                scoped_select(model, workspace_id).with_only_columns(sa.func.min(column))
            )
            if earliest is not None:
                candidates.append(earliest)
        return min(candidates) if candidates else today

    async def net_worth_composition(
        self, workspace_id: uuid.UUID, *, from_date: date, to_date: date
    ) -> dict[str, list[dict]]:
        """Per-currency net-worth *composition* over [from_date, to_date]: what
        net worth is made of — cash, assets, investments, and (signed) debts —
        reconstructed at one point per month across the window.

        Returns `{currency: [{period_start, cash_minor, assets_minor,
        investments_minor, debts_minor}, ...]}`, oldest first. Each point is
        `SnapshotService.net_worth_components_as_of(period_start)` — so a point's
        four parts sum to the net-worth figure the line chart draws for the same
        month (they share the same underlying computation).

        The month axis matches the net-worth snapshot backfill cadence: the
        month-end of each month in the range, with the final month clamped to
        `to_date` itself (so the current month lands on "today" rather than a
        future month-end). Every currency with any activity gets the full,
        continuous axis — a bucket with no activity at a point is 0 — so a chart
        draws an unbroken series. Currencies are never summed together (§4).
        Clock-free: the window is passed in; unlike `net_worth_series` this is a
        pure read (nothing is captured), so the caller need not commit.
        """
        snapshots = SnapshotService(self.db)
        # month-end of each month in the window, clamping the final (current)
        # month to to_date — matching the snapshot backfill's per-month cadence.
        point_dates = [min(month_end(m), to_date) for m in month_starts(from_date, to_date)]

        # currency -> {point_date: {cash_minor, assets_minor, investments_minor, debts_minor}}
        by_currency: dict[str, dict[date, dict[str, int]]] = {}
        for on_date in point_dates:
            for currency, parts in (
                await snapshots.net_worth_components_as_of(workspace_id, on_date)
            ).items():
                by_currency.setdefault(currency, {})[on_date] = parts

        zero = {"cash_minor": 0, "assets_minor": 0, "investments_minor": 0, "debts_minor": 0}
        result: dict[str, list[dict]] = {}
        for currency, by_date in by_currency.items():
            result[currency] = [
                {"period_start": d, **by_date.get(d, zero)} for d in point_dates
            ]
        return result

    async def upcoming(
        self,
        workspace_id: uuid.UUID,
        *,
        today: date,
        within_days: int = 30,
        limit: int = 8,
    ) -> dict[str, list[dict]]:
        """What's coming for this workspace, in two lists.

        `due` is one date-sorted list of the soonest dated items falling in the
        inclusive horizon `today <= due_on <= today + within_days`, capped at
        `limit`. Only items due today or later are surfaced — overdue rows
        (`due_on < today`) are deliberately excluded here; the Planned and Loans
        screens own those. Each item is `{kind, id, label, due_on, amount_minor,
        currency}` (loan rows also carry `direction`):
          - `planned`: active `ScheduledTransaction` (`is_active`) by `next_due`
            — label = description, `amount_minor` signed (expense/income).
          - `subscription`: active `Subscription` by `next_renewal` — label =
            name, `amount_minor` the (expense) cost.
          - `loan`: `Loan` with a non-null `next_due` — label = name,
            `amount_minor` = `planned_payment_minor` (may be null), plus
            `direction` (borrowed/lent).
        Ties on `due_on` break by kind (planned < subscription < loan) then id,
        so the order is stable.

        `over_budget` lists budgets whose spend has exceeded their limit in the
        current period window containing `today` — `actual_minor(budget, today) >
        amount_minor` — as `{budget_id, label (category name), amount_minor,
        actual_minor, over_minor, currency}`, biggest overrun first. Budgets
        with no category (nothing to measure) are skipped. The budget-vs-actual
        figure is `BudgetService.actual_minor`, reused verbatim.

        Workspace-scoped (D7); each item keeps its own currency and figures are
        never summed across currencies (§4). Clock-free: `today` is passed in.
        """
        horizon = today + timedelta(days=within_days)
        due: list[dict] = []

        planned = (
            await self.db.execute(
                scoped_select(ScheduledTransaction, workspace_id).where(
                    ScheduledTransaction.is_active.is_(True),
                    ScheduledTransaction.next_due >= today,
                    ScheduledTransaction.next_due <= horizon,
                )
            )
        ).scalars().all()
        for st in planned:
            due.append(
                {
                    "kind": "planned",
                    "id": st.id,
                    "label": st.description,
                    "due_on": st.next_due,
                    "amount_minor": st.amount_minor,
                    "currency": st.currency,
                }
            )

        subscriptions = (
            await self.db.execute(
                scoped_select(Subscription, workspace_id).where(
                    Subscription.status == "active",
                    Subscription.next_renewal >= today,
                    Subscription.next_renewal <= horizon,
                )
            )
        ).scalars().all()
        for sub in subscriptions:
            due.append(
                {
                    "kind": "subscription",
                    "id": sub.id,
                    "label": sub.name,
                    "due_on": sub.next_renewal,
                    "amount_minor": sub.amount_minor,
                    "currency": sub.currency,
                }
            )

        loans = (
            await self.db.execute(
                scoped_select(Loan, workspace_id).where(
                    Loan.next_due.is_not(None),
                    Loan.next_due >= today,
                    Loan.next_due <= horizon,
                )
            )
        ).scalars().all()
        for loan in loans:
            due.append(
                {
                    "kind": "loan",
                    "id": loan.id,
                    "label": loan.name,
                    "due_on": loan.next_due,
                    "amount_minor": loan.planned_payment_minor,
                    "currency": loan.currency,
                    "direction": loan.direction,
                }
            )

        due.sort(key=lambda d: (d["due_on"], _DUE_KIND_ORDER[d["kind"]], str(d["id"])))
        due = due[:limit]

        # over_budget: reuse BudgetService.actual_minor for the spend-vs-limit
        # figure; join Category only to label the nudge with the category name.
        budgets = BudgetService(self.db)
        rows = (
            await self.db.execute(
                scoped_select(Budget, workspace_id)
                .add_columns(Category.name)
                .outerjoin(Category, Category.id == Budget.category_id)
            )
        ).all()
        over_budget: list[dict] = []
        for budget, category_name in rows:
            actual = await budgets.actual_minor(budget, today)
            if actual is None:  # no category -> nothing to measure against
                continue
            if actual > budget.amount_minor:
                over_budget.append(
                    {
                        "budget_id": budget.id,
                        "label": category_name,
                        "amount_minor": budget.amount_minor,
                        "actual_minor": actual,
                        "over_minor": actual - budget.amount_minor,
                        "currency": budget.currency,
                    }
                )
        over_budget.sort(key=lambda b: (-b["over_minor"], str(b["budget_id"])))

        return {"due": due, "over_budget": over_budget}

    async def summary(self, workspace_id: uuid.UUID, *, today: date) -> dict[str, dict]:
        """The dashboard's three KPI tiles, per currency (never summed across
        currencies, §4): `{currency: {savings, committed_monthly,
        net_worth_change}}`. Clock-free: `today` is passed in. A pure read —
        nothing is written, so the caller never needs to commit.

        - **savings**: this calendar month's income/spend so far (reusing
          `cashflow`) plus the prior month's, for the dashboard's trend arrow.
        - **committed_monthly**: Σ active subscriptions + Σ loan planned
          payments + Σ active recurring planned EXPENSES (never income),
          each normalized to a monthly figure by its own cycle/frequency
          (`monthly_minor`, the same normalization the subscription rollup
          uses) — "what leaves before you spend anything."
        - **net_worth_change**: `net_worth_as_of(today)` vs. the start of the
          current month, plus the top (up to `_TOP_MOVERS`) non-zero
          component deltas (cash/assets/investments/debts) by magnitude — a
          component that didn't move is never listed as a "mover."

        A currency present in one bucket but not another (e.g. committed
        costs in a currency with no transactions this/last month) still gets
        an entry, with that bucket's figures all zero.
        """
        start_of_month, _ = current_window("monthly", today)
        prior_month_ref = shift_month(today, -1)
        prior_month_start, _ = current_window("monthly", prior_month_ref)

        savings = await self._savings(
            workspace_id, current_start=start_of_month, prior_start=prior_month_start, today=today
        )
        committed = await self._committed_monthly(workspace_id)
        net_worth_change = await self._net_worth_change(
            workspace_id, today=today, start_of_month=start_of_month
        )

        currencies = set(savings) | set(committed) | set(net_worth_change)
        return {
            currency: {
                "savings": savings.get(currency, _empty_savings()),
                "committed_monthly": committed.get(currency, _empty_committed_monthly()),
                "net_worth_change": net_worth_change.get(currency, _empty_net_worth_change()),
            }
            for currency in currencies
        }

    async def _savings(
        self, workspace_id: uuid.UUID, *, current_start: date, prior_start: date, today: date
    ) -> dict[str, dict]:
        """Per-currency savings for the current month (through `today`) and
        the prior month (for the trend arrow), from one `cashflow` call
        spanning both months."""
        points = await self.cashflow(workspace_id, from_date=prior_start, to_date=today)
        result: dict[str, dict] = {}
        for currency, monthly_points in points.items():
            by_month = {p["period_start"]: p for p in monthly_points}
            current = by_month.get(current_start, {"income_minor": 0, "spend_minor": 0})
            prior = by_month.get(prior_start, {"income_minor": 0, "spend_minor": 0})
            saved = current["income_minor"] - current["spend_minor"]
            prev_saved = prior["income_minor"] - prior["spend_minor"]
            result[currency] = {
                "income_minor": current["income_minor"],
                "spend_minor": current["spend_minor"],
                "saved_minor": saved,
                "rate_bps": _rate_bps(saved, current["income_minor"]),
                "prev_saved_minor": prev_saved,
                "prev_rate_bps": _rate_bps(prev_saved, prior["income_minor"]),
            }
        return result

    async def _committed_monthly(self, workspace_id: uuid.UUID) -> dict[str, dict]:
        """Per-currency Σ active subscriptions + Σ loan planned payments + Σ
        active recurring planned expenses, each normalized to a monthly
        figure by its own cycle/frequency (`monthly_minor`)."""
        result: dict[str, dict] = {}

        def bucket(currency: str) -> dict[str, int]:
            return result.setdefault(
                currency,
                {"total_minor": 0, "subscriptions_minor": 0, "loans_minor": 0, "planned_minor": 0},
            )

        subscriptions = (
            await self.db.execute(
                scoped_select(Subscription, workspace_id).where(Subscription.status == "active")
            )
        ).scalars().all()
        for sub in subscriptions:
            amount = monthly_minor(sub.amount_minor, sub.billing_frequency)
            b = bucket(sub.currency)
            b["subscriptions_minor"] += amount
            b["total_minor"] += amount

        # A loan with no `payment_frequency` set has nothing to normalize
        # against — skipped, same as the forecast engine's cash projection.
        loans = (
            await self.db.execute(
                scoped_select(Loan, workspace_id).where(
                    Loan.planned_payment_minor.is_not(None),
                    Loan.payment_frequency.is_not(None),
                )
            )
        ).scalars().all()
        for loan in loans:
            amount = monthly_minor(loan.planned_payment_minor, loan.payment_frequency)
            b = bucket(loan.currency)
            b["loans_minor"] += amount
            b["total_minor"] += amount

        # Only active EXPENSE schedules count as a committed cost — a
        # recurring income schedule (positive amount_minor) is money coming
        # in, not a commitment leaving before you spend anything.
        planned = (
            await self.db.execute(
                scoped_select(ScheduledTransaction, workspace_id).where(
                    ScheduledTransaction.is_active.is_(True),
                    ScheduledTransaction.amount_minor < 0,
                )
            )
        ).scalars().all()
        for st in planned:
            amount = monthly_minor(-st.amount_minor, st.frequency)
            b = bucket(st.currency)
            b["planned_minor"] += amount
            b["total_minor"] += amount

        return result

    async def _net_worth_change(
        self, workspace_id: uuid.UUID, *, today: date, start_of_month: date
    ) -> dict[str, dict]:
        """Per-currency net-worth change from the start of the current month
        to `today`, plus the top non-zero component movers. Reuses
        `SnapshotService.net_worth_components_as_of` at both dates — the same
        reconstruction the composition chart draws — so `now_minor`/
        `start_of_month_minor` (each the sum of their four parts) can never
        drift from the movers they're built from."""
        snapshots = SnapshotService(self.db)
        now_components = await snapshots.net_worth_components_as_of(workspace_id, today)
        start_components = await snapshots.net_worth_components_as_of(workspace_id, start_of_month)

        result: dict[str, dict] = {}
        for currency in set(now_components) | set(start_components):
            now_parts = now_components.get(currency, _ZERO_COMPONENTS)
            start_parts = start_components.get(currency, _ZERO_COMPONENTS)
            now_total = sum(now_parts.values())
            start_total = sum(start_parts.values())
            delta = now_total - start_total

            movers = sorted(
                (
                    {
                        "label": label,
                        "delta_minor": now_parts.get(key, 0) - start_parts.get(key, 0),
                    }
                    for key, label in _COMPONENT_LABELS.items()
                ),
                key=lambda m: abs(m["delta_minor"]),
                reverse=True,
            )
            movers = [m for m in movers if m["delta_minor"] != 0][:_TOP_MOVERS]

            result[currency] = {
                "now_minor": now_total,
                "start_of_month_minor": start_total,
                "delta_minor": delta,
                "pct_bps": round(delta / start_total * 10_000) if start_total != 0 else 0,
                "movers": movers,
            }
        return result

    @staticmethod
    def _expense_predicates(workspace_id: uuid.UUID, from_date: date, to_date: date) -> tuple:
        """Shared filter for the spending breakdowns: this workspace's non-
        deleted, non-transfer expense rows (`amount_minor < 0`) in range."""
        return (
            Transaction.workspace_id == workspace_id,
            Transaction.amount_minor < 0,
            Transaction.deleted_at.is_(None),
            Transaction.transfer_id.is_(None),
            Transaction.occurred_on >= from_date,
            Transaction.occurred_on <= to_date,
        )
