import uuid
from datetime import date
from decimal import Decimal

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.models.account import Account
from pecunia.models.asset import Asset, AssetValuation
from pecunia.models.loan import Loan, LoanDirection, LoanPayment
from pecunia.models.net_worth_snapshot import NetWorthSnapshot
from pecunia.models.portfolio import Holding, HoldingPrice, Portfolio
from pecunia.models.transaction import Transaction
from pecunia.period import month_end, shift_month
from pecunia.services.scoping import scoped_select


class SnapshotService:
    """Net-worth snapshot logic: reconstruct net worth as of a date, capture it
    idempotently, backfill a history, and read a series for the graph.

    Contract: methods flush, never commit — the caller (router) owns the
    transaction boundary (CONVENTIONS §2). Clock-free: every date is passed in,
    never read from the system clock (§4)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def net_worth_as_of(
        self, workspace_id: uuid.UUID, on_date: date
    ) -> dict[str, int]:
        """Per-currency net worth for the workspace as of `on_date`.

        Currencies are never summed together (§4): the result is a
        `{currency: net_worth_minor}` map, one entry per currency present.

        This is exactly the per-currency sum of the four
        `net_worth_components_as_of` buckets (cash + assets + investments +
        debts). Deriving the headline figure from the component breakdown keeps
        the two provably in lock-step — the total can never drift from the parts
        the composition chart draws (that identity is asserted in the tests).
        See `net_worth_components_as_of` for the per-bucket rules.
        """
        components = await self.net_worth_components_as_of(workspace_id, on_date)
        return {
            currency: parts["cash_minor"]
            + parts["assets_minor"]
            + parts["investments_minor"]
            + parts["debts_minor"]
            for currency, parts in components.items()
        }

    async def net_worth_components_as_of(
        self, workspace_id: uuid.UUID, on_date: date
    ) -> dict[str, dict[str, int]]:
        """Per-currency net-worth broken into its four ingredients as of
        `on_date`, kept SEPARATE instead of summed into one accumulator (which
        is what `net_worth_as_of` does on top of this). Shape:

            {currency: {"cash_minor", "assets_minor", "investments_minor",
                        "debts_minor"}}

        Currencies are never summed together (§4). A currency appears only if it
        has activity in at least one bucket; a bucket with no activity for a
        present currency is 0.

        - `cash_minor` (Accounts): each account's `initial_balance_minor` plus
          the sum of its non-deleted transactions with `occurred_on <= on_date`,
          grouped by the account's currency.
        - `assets_minor` (Assets): each asset's latest valuation with `as_of <=
          on_date`, summed per the asset's currency. An asset with no valuation
          on/before `on_date` contributes nothing (it is simply absent). Assets
          are hard-deleted (no archived state), so every existing asset counts.
        - `investments_minor` (Portfolios): each holding valued as `round(current
          quantity x latest HoldingPrice.unit_price_minor with as_of <=
          on_date)`, summed per the holding's PORTFOLIO currency. A holding with
          no price on/before `on_date` contributes nothing. **Documented
          approximation:** V1 keeps no per-holding quantity history (no buy/sell
          ledger), so a past date is valued with the *current* quantity at that
          date's price — exact going forward, a reasonable estimate for the
          backfilled past.
        - `debts_minor` (Loans): the SIGNED net-debt term — Σ over loans of each
          loan's remaining balance, reconstructed from its payment ledger as
          `max(principal_minor − Σ payments with paid_on <= on_date, 0)`, applied
          as a signed term to its own currency: a `borrowed` loan SUBTRACTS its
          remaining (a liability, so a net liability is NEGATIVE — a stacked
          chart places it below zero), a `lent` loan ADDS it (a receivable). V1
          does not amortize interest — remaining is principal minus payments
          only. A fully-paid loan (remaining 0) drops out.
        """
        components: dict[str, dict[str, int]] = {}

        def bucket(currency: str) -> dict[str, int]:
            return components.setdefault(
                currency,
                {"cash_minor": 0, "assets_minor": 0, "investments_minor": 0, "debts_minor": 0},
            )

        def add(currency: str, key: str, amount: int) -> None:
            bucket(currency)[key] += int(amount)

        # Account opening balances, grouped by the account's currency. An
        # account with no qualifying transactions still contributes its
        # initial balance, which the transaction sum below would otherwise miss.
        init_stmt = (
            sa.select(Account.currency, sa.func.coalesce(sa.func.sum(Account.initial_balance_minor), 0))
            .where(Account.workspace_id == workspace_id)
            .group_by(Account.currency)
        )
        for currency, amount in (await self.db.execute(init_stmt)).all():
            add(currency, "cash_minor", amount)

        # Non-deleted transactions dated on/before on_date, grouped by the
        # owning account's currency (an account's currency is fixed once it has
        # transactions, so the account currency is the authoritative bucket).
        tx_stmt = (
            sa.select(Account.currency, sa.func.coalesce(sa.func.sum(Transaction.amount_minor), 0))
            .join(Transaction, Transaction.account_id == Account.id)
            .where(
                Account.workspace_id == workspace_id,
                Transaction.deleted_at.is_(None),
                Transaction.occurred_on <= on_date,
            )
            .group_by(Account.currency)
        )
        for currency, amount in (await self.db.execute(tx_stmt)).all():
            add(currency, "cash_minor", amount)

        # Each asset's latest valuation with as_of <= on_date. row_number()
        # over (as_of, created_at, id) desc mirrors AssetService.current_value's
        # tiebreakers; rn == 1 is that latest row. Assets with no valuation in
        # range produce no rows and so drop out of the sum.
        ranked = (
            sa.select(
                Asset.currency.label("currency"),
                AssetValuation.value_minor.label("value_minor"),
                sa.func.row_number()
                .over(
                    partition_by=AssetValuation.asset_id,
                    order_by=(
                        AssetValuation.as_of.desc(),
                        AssetValuation.created_at.desc(),
                        AssetValuation.id.desc(),
                    ),
                )
                .label("rn"),
            )
            .join(Asset, Asset.id == AssetValuation.asset_id)
            .where(
                Asset.workspace_id == workspace_id,
                AssetValuation.as_of <= on_date,
            )
            .subquery()
        )
        asset_stmt = (
            sa.select(ranked.c.currency, sa.func.sum(ranked.c.value_minor))
            .where(ranked.c.rn == 1)
            .group_by(ranked.c.currency)
        )
        for currency, amount in (await self.db.execute(asset_stmt)).all():
            add(currency, "assets_minor", amount)

        # Each holding's latest price with as_of <= on_date (same row_number()
        # tiebreakers as assets). Value = round(quantity x unit_price) rounded
        # per holding — matching PortfolioService.holding_value_minor — then
        # bucketed by the PORTFOLIO's currency. The rounding of a Numeric x
        # BigInteger product is done in Python with Decimal (never a float, and
        # never a rounded-sum that would drift from the per-holding figures);
        # household scale makes the per-row loop trivial. Holdings with no price
        # in range produce no rows and drop out.
        holdings_ranked = (
            sa.select(
                Portfolio.currency.label("currency"),
                Holding.quantity.label("quantity"),
                HoldingPrice.unit_price_minor.label("unit_price_minor"),
                sa.func.row_number()
                .over(
                    partition_by=HoldingPrice.holding_id,
                    order_by=(
                        HoldingPrice.as_of.desc(),
                        HoldingPrice.created_at.desc(),
                        HoldingPrice.id.desc(),
                    ),
                )
                .label("rn"),
            )
            .join(Holding, Holding.id == HoldingPrice.holding_id)
            .join(Portfolio, Portfolio.id == Holding.portfolio_id)
            .where(
                Holding.workspace_id == workspace_id,
                HoldingPrice.as_of <= on_date,
            )
            .subquery()
        )
        holding_stmt = sa.select(
            holdings_ranked.c.currency,
            holdings_ranked.c.quantity,
            holdings_ranked.c.unit_price_minor,
        ).where(holdings_ranked.c.rn == 1)
        for currency, quantity, unit_price_minor in (
            await self.db.execute(holding_stmt)
        ).all():
            add(currency, "investments_minor", round(quantity * Decimal(unit_price_minor)))

        # Loans: each loan's remaining = max(principal − Σ payments dated on/
        # before on_date, 0), applied as a signed term to the loan's currency —
        # a borrowed loan is a liability (subtract), a lent loan a receivable
        # (add). The payment sum is a per-loan LEFT JOIN so a loan with no
        # payments still contributes its full principal. Integer minor units
        # only (§4); a fully-paid loan (remaining 0) is skipped so it never
        # conjures a spurious 0 bucket for its currency.
        paid_subq = (
            sa.select(
                LoanPayment.loan_id.label("loan_id"),
                sa.func.coalesce(sa.func.sum(LoanPayment.amount_minor), 0).label("paid"),
            )
            .where(LoanPayment.paid_on <= on_date)
            .group_by(LoanPayment.loan_id)
            .subquery()
        )
        loan_stmt = (
            sa.select(
                Loan.currency,
                Loan.direction,
                Loan.principal_minor,
                sa.func.coalesce(paid_subq.c.paid, 0),
            )
            .join(paid_subq, paid_subq.c.loan_id == Loan.id, isouter=True)
            .where(Loan.workspace_id == workspace_id)
        )
        for currency, direction, principal_minor, paid in (
            await self.db.execute(loan_stmt)
        ).all():
            remaining = max(int(principal_minor) - int(paid), 0)
            if remaining == 0:
                continue
            add(currency, "debts_minor", remaining if direction == LoanDirection.LENT else -remaining)

        return components

    async def capture(
        self, workspace_id: uuid.UUID, on_date: date, *, is_demo: bool = False
    ) -> None:
        """Compute net worth as of `on_date` and upsert one snapshot row per
        currency, idempotent on (workspace_id, currency, captured_on): an
        existing row's figure is updated, otherwise a row is inserted."""
        totals = await self.net_worth_as_of(workspace_id, on_date)
        for currency, net_worth_minor in totals.items():
            existing = await self.db.scalar(
                scoped_select(NetWorthSnapshot, workspace_id).where(
                    NetWorthSnapshot.currency == currency,
                    NetWorthSnapshot.captured_on == on_date,
                )
            )
            if existing is not None:
                existing.net_worth_minor = net_worth_minor
            else:
                self.db.add(
                    NetWorthSnapshot(
                        id=uuid.uuid4(),
                        workspace_id=workspace_id,
                        captured_on=on_date,
                        currency=currency,
                        net_worth_minor=net_worth_minor,
                        is_demo=is_demo,
                    )
                )
        await self.db.flush()

    async def backfill(
        self,
        workspace_id: uuid.UUID,
        *,
        months: int = 12,
        today: date,
        is_demo: bool = False,
    ) -> None:
        """Capture snapshots at the last day of each of the last `months`
        months, using `today` itself as the final (current-month) point — so a
        graph has history from day one. Idempotent per date."""
        for on_date in _backfill_dates(months, today):
            await self.capture(workspace_id, on_date, is_demo=is_demo)

    async def series(
        self,
        workspace_id: uuid.UUID,
        currency: str,
        *,
        from_date: date,
        to_date: date,
    ) -> list[tuple[date, int]]:
        """Ordered (captured_on, net_worth_minor) points for one currency in the
        inclusive [from_date, to_date] window."""
        rows = (
            await self.db.execute(
                scoped_select(NetWorthSnapshot, workspace_id)
                .where(
                    NetWorthSnapshot.currency == currency,
                    NetWorthSnapshot.captured_on >= from_date,
                    NetWorthSnapshot.captured_on <= to_date,
                )
                .order_by(NetWorthSnapshot.captured_on.asc())
            )
        ).scalars().all()
        return [(r.captured_on, r.net_worth_minor) for r in rows]


def _backfill_dates(months: int, today: date) -> list[date]:
    """The `months` capture dates, oldest first: the month-end of each prior
    month, then `today` for the current month. months=1 yields just `today`."""
    dates = [month_end(shift_month(today, -i)) for i in range(months - 1, 0, -1)]
    dates.append(today)
    return dates
