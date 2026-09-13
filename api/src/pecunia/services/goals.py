import uuid
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.account import Account
from pecunia.models.goal import Goal, GoalSourceKind
from pecunia.models.portfolio import Portfolio
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.accounts import AccountService
from pecunia.services.forecast import ForecastService
from pecunia.services.portfolios import PortfolioService
from pecunia.services.scoping import get_scoped, scoped_select
from pecunia.services.snapshots import SnapshotService

# Reuse the transaction domain's account lookup exception so the router maps
# a foreign/missing account source_id to the same 404 ACCOUNT_NOT_FOUND the
# rest of the app uses (mirrors ScheduledTransactionService/SubscriptionService).
from pecunia.services.transactions import AccountNotFoundError

# Sentinel distinguishing "field absent from the PATCH body" from "field
# explicitly set to null" for the nullable target_date/source_id/
# manual_current_minor columns.
UNSET = object()

# The forecast horizon an ETA walk looks across (v1.4 spec, Track S: "within
# the 6-month horizon") — ForecastService's own default.
_ETA_HORIZON_MONTHS = 6


class PortfolioNotFoundError(Exception):
    """Raised when a goal's `source_id` doesn't reference a portfolio in the
    goal's own workspace (source_kind='portfolio'). The router maps this to
    404 PORTFOLIO_NOT_FOUND."""


class GoalSourceRequiredError(Exception):
    """Raised when source_kind is 'account'/'portfolio' but no `source_id` is
    given — those two kinds need a concrete row to read progress from. The
    router maps this to 422 GOAL_SOURCE_REQUIRED."""


class GoalCurrencyMismatchError(Exception):
    """Raised when a goal's `currency` differs from its source's own currency
    (source_kind='account'/'portfolio') — CONVENTIONS §4, never cross-
    currency: a foreign-currency target would corrupt `progress`/`eta`. The
    router maps this to 422 GOAL_CURRENCY_MISMATCH."""


class GoalService:
    """Savings-goal business logic (v1.4 spec, Track S). A goal's progress is
    DERIVED from a chosen source — an account balance, a portfolio's market
    value, the workspace's net worth, or a manually-entered figure — never
    from its own deposit/contribution ledger (that's explicitly deferred).

    Contract: methods flush, never commit — the caller (router) owns the
    transaction boundary (CONVENTIONS §2). Clock-free: `today` is passed in
    to `progress`/`eta`, never read from the system clock (§4)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    # ---- CRUD --------------------------------------------------------- #

    async def _validate_source(
        self,
        workspace_id: uuid.UUID,
        *,
        source_kind: str,
        source_id: uuid.UUID | None,
        currency: str,
    ) -> None:
        """Validate a source before it's written: `account`/`portfolio` need a
        `source_id` that resolves to a real row in this workspace (else
        GoalSourceRequiredError / AccountNotFoundError / PortfolioNotFoundError)
        whose OWN currency matches `currency` (else GoalCurrencyMismatchError —
        never cross-currency, §4). `net_worth`/`manual` need neither — a
        net-worth goal's currency is a free choice (net worth is tracked per
        currency already) and a manual goal has no row to compare against."""
        if source_kind == GoalSourceKind.ACCOUNT:
            if source_id is None:
                raise GoalSourceRequiredError()
            account = await get_scoped(self.db, Account, source_id, workspace_id)
            if account is None:
                raise AccountNotFoundError()
            if account.currency != currency:
                raise GoalCurrencyMismatchError()
        elif source_kind == GoalSourceKind.PORTFOLIO:
            if source_id is None:
                raise GoalSourceRequiredError()
            portfolio = await get_scoped(self.db, Portfolio, source_id, workspace_id)
            if portfolio is None:
                raise PortfolioNotFoundError()
            if portfolio.currency != currency:
                raise GoalCurrencyMismatchError()

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        name: str,
        target_minor: int,
        currency: str,
        source_kind: str = GoalSourceKind.MANUAL,
        target_date: date | None = None,
        source_id: uuid.UUID | None = None,
        manual_current_minor: int | None = None,
    ) -> Goal:
        await self._validate_source(
            workspace_id, source_kind=source_kind, source_id=source_id, currency=currency
        )
        goal = Goal(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            target_minor=target_minor,
            currency=currency,
            target_date=target_date,
            source_kind=source_kind,
            # A source_id/manual figure only means something for its own
            # kind — never persist a stale one that no longer applies.
            source_id=source_id
            if source_kind in (GoalSourceKind.ACCOUNT, GoalSourceKind.PORTFOLIO)
            else None,
            manual_current_minor=manual_current_minor
            if source_kind == GoalSourceKind.MANUAL
            else None,
        )
        self.db.add(goal)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.GOAL_CREATED,
                resource_type="goal",
                resource_id=str(goal.id),
                workspace_id=workspace_id,
                after=project("goal", goal),
                activity_template=Activity.GOAL_CREATED,
                activity_params={
                    "name": goal.name,
                    "currency": goal.currency,
                    "target_minor": goal.target_minor,
                },
            ),
        )
        return goal

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[Goal], str | None]:
        # UUID primary keys carry no order — paginate newest-first on
        # created_at, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = scoped_select(Goal, workspace_id).order_by(Goal.created_at.desc(), Goal.id.desc())
        return await keyset_page(
            self.db,
            stmt,
            Goal.created_at,
            Goal.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(self, workspace_id: uuid.UUID, goal_id: uuid.UUID) -> Goal | None:
        return await get_scoped(self.db, Goal, goal_id, workspace_id)

    async def update(
        self,
        goal: Goal,
        *,
        name: str | None = None,
        target_minor: int | None = None,
        currency: str | None = None,
        source_kind: str | None = None,
        target_date: object = UNSET,
        source_id: object = UNSET,
        manual_current_minor: object = UNSET,
    ) -> Goal:
        # Validate the EFFECTIVE post-update source (unchanged fields fall
        # back to the goal's current value) BEFORE mutating anything, so a
        # rejected switch (e.g. a currency mismatch) leaves the goal
        # untouched (mirrors LoanService/ScheduledTransactionService.update).
        effective_kind = source_kind if source_kind is not None else goal.source_kind
        effective_currency = currency if currency is not None else goal.currency
        effective_source_id = source_id if source_id is not UNSET else goal.source_id
        await self._validate_source(
            goal.workspace_id,
            source_kind=effective_kind,
            source_id=effective_source_id,  # type: ignore[arg-type]
            currency=effective_currency,
        )

        before = project("goal", goal)
        if name is not None:
            goal.name = name
        if target_minor is not None:
            goal.target_minor = target_minor
        if currency is not None:
            goal.currency = currency
        if target_date is not UNSET:
            goal.target_date = target_date  # type: ignore[assignment]
        if source_kind is not None:
            goal.source_kind = source_kind
        if source_id is not UNSET:
            goal.source_id = source_id  # type: ignore[assignment]
        if manual_current_minor is not UNSET:
            goal.manual_current_minor = manual_current_minor  # type: ignore[assignment]
        # A source_id/manual figure only means something for its own kind —
        # clear whichever no longer applies after the update above, exactly
        # as `create` never persists one for the wrong kind.
        if goal.source_kind not in (GoalSourceKind.ACCOUNT, GoalSourceKind.PORTFOLIO):
            goal.source_id = None
        if goal.source_kind != GoalSourceKind.MANUAL:
            goal.manual_current_minor = None
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.GOAL_UPDATED,
                resource_type="goal",
                resource_id=str(goal.id),
                workspace_id=goal.workspace_id,
                before=before,
                after=project("goal", goal),
            ),
        )
        return goal

    async def delete(self, goal: Goal) -> None:
        before = project("goal", goal)
        await self.db.delete(goal)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.GOAL_DELETED,
                resource_type="goal",
                resource_id=str(goal.id),
                workspace_id=goal.workspace_id,
                before=before,
            ),
        )

    # ---- Progress / ETA ------------------------------------------------- #

    async def _current_minor(self, goal: Goal, *, today: date) -> int:
        """The goal's current value, resolved from its source. A dangling
        `source_id` (the referenced account/portfolio was since deleted —
        possible since `source_id` carries no FK, see `Goal`'s docstring)
        reads as 0 rather than raising: a goal outliving its source is an
        edge case, not a request that should ever 500."""
        if goal.source_kind == GoalSourceKind.ACCOUNT:
            account = (
                await get_scoped(self.db, Account, goal.source_id, goal.workspace_id)
                if goal.source_id is not None
                else None
            )
            return await AccountService(self.db).balance(account) if account is not None else 0
        if goal.source_kind == GoalSourceKind.PORTFOLIO:
            portfolio = (
                await get_scoped(self.db, Portfolio, goal.source_id, goal.workspace_id)
                if goal.source_id is not None
                else None
            )
            return (
                await PortfolioService(self.db).portfolio_value_minor(portfolio, on_date=today)
                if portfolio is not None
                else 0
            )
        if goal.source_kind == GoalSourceKind.NET_WORTH:
            totals = await SnapshotService(self.db).net_worth_as_of(goal.workspace_id, today)
            return totals.get(goal.currency, 0)
        # manual
        return goal.manual_current_minor or 0

    async def progress(self, goal: Goal, *, today: date) -> dict:
        """`{current_minor, target_minor, pct_bps}` — `current_minor` resolved
        from the goal's source as of `today` (clock-free); `pct_bps` is
        `current/target` in basis points (10_000 = 100%), unclamped (a goal
        past its target reports > 10_000 — the caller/frontend decides how to
        cap the visual), `0` when `target_minor` isn't positive (nothing to
        divide by, not an error)."""
        current = await self._current_minor(goal, today=today)
        target = goal.target_minor
        pct_bps = round(current / target * 10_000) if target > 0 else 0
        return {"current_minor": current, "target_minor": target, "pct_bps": pct_bps}

    async def eta(self, goal: Goal, *, today: date) -> dict:
        """`{reached_on: date | None, on_track: bool}` — when this goal is
        projected to reach `target_minor`, walking `ForecastService.forecast`
        (Track O) forward from `today` over its default 6-month horizon. A
        goal already at/past its target reports `reached_on=today` immediately
        (no forecast needed).

        **Documented approximation (v1.4 spec, Track S).**
        `ForecastService` projects the workspace's AGGREGATE `net_worth` and
        `cash` per currency — never per-account/-portfolio (there is no
        per-source contribution model, and this method does not invent one).
        For a `net_worth` goal this is exact: the goal walks that currency's
        `net_worth` series directly, month by month, until a point's
        `value_minor >= target_minor`.

        For an `account`/`portfolio`/`manual` goal there is nothing
        source-specific to walk, so this applies one GENERIC monthly
        contribution to the source's current value: the average month-over-
        month delta of the currency's projected `cash` series (the forecast's
        proxy for "money you're setting aside" — projected income minus
        expenses minus loan payments), averaged across the whole horizon
        (not just the first pair of points) so one unusually light/heavy
        month doesn't skew the whole projection. That SAME per-currency
        contribution applies to every account/portfolio/manual goal in that
        currency regardless of which one they actually draw from — a known,
        coarse approximation, not a per-account forecast.
        """
        current = await self._current_minor(goal, today=today)
        if current >= goal.target_minor:
            return {"reached_on": today, "on_track": True}

        forecast = await ForecastService(self.db).forecast(
            goal.workspace_id, today=today, months=_ETA_HORIZON_MONTHS
        )
        currency_data = forecast.get(goal.currency)
        if currency_data is None:
            return {"reached_on": None, "on_track": False}

        if goal.source_kind == GoalSourceKind.NET_WORTH:
            for point in currency_data["net_worth"]:
                if point["value_minor"] >= goal.target_minor:
                    return {"reached_on": point["date"], "on_track": True}
            return {"reached_on": None, "on_track": False}

        cash_series = currency_data["cash"]
        deltas = [
            cash_series[i]["value_minor"] - cash_series[i - 1]["value_minor"]
            for i in range(1, len(cash_series))
        ]
        monthly_contribution = round(sum(deltas) / len(deltas)) if deltas else 0

        running = current
        for point in cash_series:
            running += monthly_contribution
            if running >= goal.target_minor:
                return {"reached_on": point["date"], "on_track": True}
        return {"reached_on": None, "on_track": False}
