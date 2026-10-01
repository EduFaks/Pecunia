import uuid
from datetime import date

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.models import (
    Account,
    BankAccountLink,
    InstanceState,
    Loan,
    ScheduledTransaction,
    Subscription,
    Transaction,
)
from pecunia.period import current_window, next_due_on_or_after
from pecunia.services.analytics import AnalyticsService
from pecunia.services.recurrence import expand_occurrences
from pecunia.services.scoping import scoped_select

# Default base currency when instance_state.settings has none set yet — matches
# the setup wizard's own default (api/src/pecunia/api/setup.py).
_DEFAULT_BASE_CURRENCY = "BRL"


class SafeToSpendService:
    """"How much can I still spend this month?" — per currency, for the
    current calendar month `[month_start, month_end]` containing `today`.
    Clock-free: `today` is passed in (§4). A pure read — nothing is written,
    so the caller never needs to commit.

    `expected_income` is this month's income so far (`AnalyticsService.cashflow`)
    plus active scheduled income still due later this month. `committed_remaining`
    is everything still expected to leave the account later this month: active
    subscription renewals, loan planned payments, and active recurring expense
    schedules (the same loan filter `AnalyticsService.committed_monthly` uses —
    `next_due`/`planned_payment_minor`/`payment_frequency` all required).
    `safe_minor = expected_income - committed_remaining - spent_mtd`.

    Only occurrences strictly AFTER `today` count toward the remaining-window
    sums (`expand_occurrences` can return `today` itself) — anything due today
    or earlier is presumed already reflected in `spent_mtd`, so including it
    again would double-count it.

    `committed_remaining` also folds in each linked credit card's upcoming
    bill (`committed_cards`, kept separately from `committed_other` — the
    pre-card subscriptions/loans/scheduled-expense total — so the split can
    be reported). For a card whose rolled-forward due date
    (`next_due_on_or_after(link.bill_due_date, today)`) falls strictly after
    `today` and on/before `month_end`, the owed balance
    (`abs(link.provider_balance_minor)`) minus this month's card spend so far
    is the bill still coming — `card_bill = max(0, owed - card_spend_mtd)`.
    This month's card purchases already sit in `spent_mtd` (via `cashflow`),
    so subtracting `card_spend_mtd` here keeps them from being counted twice;
    only the prior-cycle debt actually due this month is added.

    An optional monthly budget (`instance_state.settings["monthly_budget_minor"]`)
    applies ONLY to the base currency (`instance_state.settings["base_currency"]`,
    default "BRL") — `displayed_safe_minor` is capped at `budget_remaining =
    monthly_budget_minor - spent_mtd` when it binds tighter than `safe_minor`,
    and `limited_by` records which bound won. The base currency always gets an
    entry, even with no activity at all, so a dashboard hero always has
    something to render; any other currency appears only when it has income,
    spend, or a commitment this month.
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def compute(self, workspace_id: uuid.UUID, *, today: date) -> dict[str, dict]:
        month_start, month_end = current_window("monthly", today)

        analytics = AnalyticsService(self.db)
        cashflow = await analytics.cashflow(workspace_id, from_date=month_start, to_date=today)

        income_mtd: dict[str, int] = {}
        spent_mtd: dict[str, int] = {}
        for currency, points in cashflow.items():
            # `from_date`/`to_date` both fall in the same calendar month, so
            # cashflow's month axis is exactly this one point.
            point = points[0] if points else {"income_minor": 0, "spend_minor": 0}
            income_mtd[currency] = point["income_minor"]
            spent_mtd[currency] = point["spend_minor"]

        scheduled_income_remaining: dict[str, int] = {}
        committed_remaining: dict[str, int] = {}

        def add(bucket: dict[str, int], currency: str, amount: int) -> None:
            bucket[currency] = bucket.get(currency, 0) + amount

        scheduled = (
            await self.db.execute(
                scoped_select(ScheduledTransaction, workspace_id).where(
                    ScheduledTransaction.is_active.is_(True)
                )
            )
        ).scalars().all()
        for st in scheduled:
            remaining = [
                d for d in expand_occurrences(st.next_due, st.frequency, month_end, today=today)
                if d > today
            ]
            if not remaining:
                continue
            if st.amount_minor > 0:
                add(scheduled_income_remaining, st.currency, st.amount_minor * len(remaining))
            elif st.amount_minor < 0:
                add(committed_remaining, st.currency, -st.amount_minor * len(remaining))

        subscriptions = (
            await self.db.execute(
                scoped_select(Subscription, workspace_id).where(Subscription.status == "active")
            )
        ).scalars().all()
        for sub in subscriptions:
            remaining = [
                d for d in expand_occurrences(sub.next_renewal, sub.billing_frequency, month_end, today=today)
                if d > today
            ]
            if remaining:
                add(committed_remaining, sub.currency, sub.amount_minor * len(remaining))

        # Same three-column filter as `AnalyticsService.committed_monthly` /
        # `ForecastService.forecast` — a loan not fully scheduled isn't a
        # committed cost yet.
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
            remaining = [
                d for d in expand_occurrences(loan.next_due, loan.payment_frequency, month_end, today=today)
                if d > today
            ]
            if remaining:
                add(committed_remaining, loan.currency, loan.planned_payment_minor * len(remaining))

        # The pre-card committed total, kept aside so the split against
        # committed_cards can be reported below.
        committed_other = dict(committed_remaining)

        committed_cards: dict[str, int] = {}
        card_links = (
            await self.db.execute(
                scoped_select(BankAccountLink, workspace_id)
                .join(Account, Account.id == BankAccountLink.account_id)
                .where(
                    Account.type == "credit_card",
                    BankAccountLink.provider_balance_minor.is_not(None),
                    BankAccountLink.bill_due_date.is_not(None),
                )
                .add_columns(Account.currency)
            )
        ).all()
        for link, currency in card_links:
            next_due = next_due_on_or_after(link.bill_due_date, today)
            if not (today < next_due <= month_end):
                continue
            owed = abs(link.provider_balance_minor)
            card_spend_mtd = await self.db.scalar(
                sa.select(
                    sa.func.coalesce(sa.func.sum(-Transaction.amount_minor), 0)
                ).where(
                    Transaction.workspace_id == workspace_id,
                    Transaction.account_id == link.account_id,
                    Transaction.amount_minor < 0,
                    Transaction.occurred_on >= month_start,
                    Transaction.occurred_on <= today,
                    Transaction.deleted_at.is_(None),
                )
            )
            card_bill = max(0, owed - card_spend_mtd)
            add(committed_cards, currency, card_bill)

        for currency, amount in committed_cards.items():
            add(committed_remaining, currency, amount)

        state = await self.db.get(InstanceState, 1)
        settings = (state.settings if state else None) or {}
        base_currency = settings.get("base_currency", _DEFAULT_BASE_CURRENCY)
        monthly_budget_minor = settings.get("monthly_budget_minor")

        # today is always within [month_start, month_end] (current_window's
        # contract), so this is always >= 1 — no day-zero division risk.
        days_remaining = (month_end - today).days + 1

        currencies = (
            set(income_mtd) | set(spent_mtd)
            | set(scheduled_income_remaining) | set(committed_remaining)
            | {base_currency}
        )

        result: dict[str, dict] = {}
        for currency in currencies:
            spent = spent_mtd.get(currency, 0)
            expected_income = income_mtd.get(currency, 0) + scheduled_income_remaining.get(currency, 0)
            committed = committed_remaining.get(currency, 0)
            cards = committed_cards.get(currency, 0)
            other = committed_other.get(currency, 0)
            safe = expected_income - committed - spent

            budget = monthly_budget_minor if currency == base_currency else None
            if budget is not None:
                budget_remaining = budget - spent
                if budget_remaining < safe:
                    displayed, limited_by = budget_remaining, "budget"
                else:
                    displayed, limited_by = safe, "income"
            else:
                displayed, limited_by = safe, "income"

            result[currency] = {
                "safe_minor": safe,
                "displayed_safe_minor": displayed,
                "limited_by": limited_by,
                "expected_income_minor": expected_income,
                "committed_remaining_minor": committed,
                "committed_cards_minor": cards,
                "committed_other_minor": other,
                "spent_mtd_minor": spent,
                "monthly_budget_minor": budget,
                "days_remaining": days_remaining,
                "daily_allowance_minor": max(0, displayed) // days_remaining,
                "projected_income_minor": expected_income,
                "projected_expense_minor": spent + committed,
            }
        return result
