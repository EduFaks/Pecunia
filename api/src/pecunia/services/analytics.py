import uuid
from datetime import date, timedelta

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.models.budget import Budget
from pecunia.models.category import Category
from pecunia.models.contact import Contact
from pecunia.models.loan import Loan
from pecunia.models.net_worth_snapshot import NetWorthSnapshot
from pecunia.models.scheduled_transaction import ScheduledTransaction
from pecunia.models.subscription import Subscription
from pecunia.models.transaction import Transaction
from pecunia.period import month_end, month_starts
from pecunia.services.budgets import BudgetService
from pecunia.services.scoping import scoped_select
from pecunia.services.snapshots import SnapshotService

# Deterministic tiebreak for `upcoming`'s merged due list when two items share a
# due date: planned rules, then subscription renewals, then loan payments.
_DUE_KIND_ORDER = {"planned": 0, "subscription": 1, "loan": 2}

# The only cashflow bucketing implemented in v1.1. Kept as a constant so the
# router can constrain the query param to the same set (a future "week" bucket
# would land here and in `cashflow`).
GRANULARITIES = ("month",)


class AnalyticsService:
    """Read-only aggregation queries over the existing finance tables, all
    workspace-scoped (D7) and currency-grouped — figures for different
    currencies are NEVER summed together (CONVENTIONS §4). Income/spend always
    exclude soft-deleted transactions and transfer legs.

    Contract: the aggregation methods are pure reads. `net_worth_series`
    refreshes today's snapshot on read (a write via SnapshotService, which
    flushes) — the caller (router) still owns commit. Clock-free: `today` is
    passed in (§4)."""

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
        self, workspace_id: uuid.UUID, *, from_date: date, to_date: date, today: date
    ) -> dict[str, list[dict]]:
        """Per-currency net-worth series over [from_date, to_date] read from the
        persisted snapshots. Today's snapshot is (re)captured on every read so
        the latest point always reflects current state — same-day activity and
        newly-added currencies included; capture is an idempotent per-currency
        upsert, so this refreshes today's figure rather than duplicating it (a
        second read does not add a row). `{currency: [{date, net_worth_minor},
        ...]}`, ordered oldest first. Clock-free: `today` is a parameter."""
        snapshots = SnapshotService(self.db)
        # Refresh today unconditionally: a same-day transaction, price, payment,
        # or a brand-new-currency account must move the latest point, which a
        # "capture only if today has no snapshot" guard would leave stale. The
        # upsert keeps it idempotent (per (workspace, currency, captured_on)).
        await snapshots.capture(workspace_id, today)

        currencies = (
            await self.db.execute(
                scoped_select(NetWorthSnapshot, workspace_id)
                .with_only_columns(NetWorthSnapshot.currency)
                .where(
                    NetWorthSnapshot.captured_on >= from_date,
                    NetWorthSnapshot.captured_on <= to_date,
                )
                .distinct()
            )
        ).scalars().all()

        result: dict[str, list[dict]] = {}
        for currency in currencies:
            points = await snapshots.series(
                workspace_id, currency, from_date=from_date, to_date=to_date
            )
            result[currency] = [{"date": d, "net_worth_minor": v} for d, v in points]
        return result

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
