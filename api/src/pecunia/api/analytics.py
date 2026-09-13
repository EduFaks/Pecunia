import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.period import shift_month
from pecunia.services.analytics import AnalyticsService
from pecunia.services.forecast import ForecastService

router = APIRouter(prefix="/analytics", tags=["analytics"], dependencies=[Depends(require_initialized)])

# The default reporting window when the caller omits `from`/`to`: a rolling
# 12-month range aligned to month starts (the first of the month 11 months ago
# through today), computed here in the router from the wall clock so the
# service stays clock-free (CONVENTIONS §4).
DEFAULT_MONTHS = 12

FromDate = Annotated[date | None, Query(alias="from")]
ToDate = Annotated[date | None, Query(alias="to")]
AllTime = Annotated[bool, Query(alias="all")]


def _today() -> date:
    # Wall clock lives in the router (services stay clock-free, §4); UTC .date()
    # matches how the budgets router derives "today".
    return datetime.now(UTC).date()


def _range(from_: date | None, to: date | None) -> tuple[date, date]:
    to_date = to or _today()
    from_date = from_ or shift_month(to_date, -(DEFAULT_MONTHS - 1))
    return from_date, to_date


async def _range_all(
    svc: AnalyticsService,
    workspace_id: uuid.UUID,
    from_: date | None,
    to: date | None,
    all_: bool,
) -> tuple[date, date]:
    """Like `_range`, plus the Insights screens' "all time" option: when
    `all_` is set and `from_` is not explicitly given, `from` extends back to
    the workspace's `earliest_activity_date` instead of the rolling 12-month
    default. An explicit `from` always wins over `all_` (an explicit bound is
    a real request; `all_` only fills in the omitted default)."""
    to_date = to or _today()
    if from_ is not None:
        from_date = from_
    elif all_:
        from_date = await svc.earliest_activity_date(workspace_id, today=_today())
    else:
        from_date = shift_month(to_date, -(DEFAULT_MONTHS - 1))
    return from_date, to_date


class CashflowPoint(BaseModel):
    period_start: date
    income_minor: int
    spend_minor: int


class CategorySpend(BaseModel):
    category_id: uuid.UUID | None
    name: str
    color: str | None
    spend_minor: int


class ContactSpend(BaseModel):
    contact_id: uuid.UUID | None
    name: str
    spend_minor: int


class NetWorthPoint(BaseModel):
    date: date
    net_worth_minor: int


class CompositionPoint(BaseModel):
    period_start: date
    cash_minor: int
    assets_minor: int
    investments_minor: int
    debts_minor: int


class UpcomingDue(BaseModel):
    kind: Literal["planned", "subscription", "loan"]
    id: uuid.UUID
    label: str
    due_on: date
    amount_minor: int | None  # loans may have no planned payment
    currency: str
    direction: str | None = None  # loans only (borrowed/lent)


class OverBudget(BaseModel):
    budget_id: uuid.UUID
    label: str
    amount_minor: int
    actual_minor: int
    over_minor: int
    currency: str


class Upcoming(BaseModel):
    due: list[UpcomingDue]
    over_budget: list[OverBudget]


class ForecastPoint(BaseModel):
    date: date
    value_minor: int
    lower_minor: int
    upper_minor: int
    projected: bool


class ForecastMetrics(BaseModel):
    cash: list[ForecastPoint]
    net_worth: list[ForecastPoint]


class SavingsOut(BaseModel):
    income_minor: int
    spend_minor: int
    saved_minor: int
    rate_bps: int
    prev_saved_minor: int
    prev_rate_bps: int


class CommittedMonthlyOut(BaseModel):
    total_minor: int
    subscriptions_minor: int
    loans_minor: int
    planned_minor: int


class Mover(BaseModel):
    label: str
    delta_minor: int


class NetWorthChangeOut(BaseModel):
    now_minor: int
    start_of_month_minor: int
    delta_minor: int
    pct_bps: int
    movers: list[Mover]


class SummaryOut(BaseModel):
    savings: SavingsOut
    committed_monthly: CommittedMonthlyOut
    net_worth_change: NetWorthChangeOut


@router.get("/cashflow")
async def cashflow(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    from_: FromDate = None,
    to: ToDate = None,
    granularity: Literal["month"] = "month",
) -> dict[str, list[CashflowPoint]]:
    from_date, to_date = _range(from_, to)
    return await AnalyticsService(db).cashflow(
        wsctx.workspace_id, from_date=from_date, to_date=to_date, granularity=granularity
    )


@router.get("/spending-by-category")
async def spending_by_category(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    from_: FromDate = None,
    to: ToDate = None,
    all_: AllTime = False,
) -> dict[str, list[CategorySpend]]:
    svc = AnalyticsService(db)
    from_date, to_date = await _range_all(svc, wsctx.workspace_id, from_, to, all_)
    return await svc.spending_by_category(
        wsctx.workspace_id, from_date=from_date, to_date=to_date
    )


@router.get("/spending-by-contact")
async def spending_by_contact(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    from_: FromDate = None,
    to: ToDate = None,
    all_: AllTime = False,
) -> dict[str, list[ContactSpend]]:
    svc = AnalyticsService(db)
    from_date, to_date = await _range_all(svc, wsctx.workspace_id, from_, to, all_)
    return await svc.spending_by_contact(
        wsctx.workspace_id, from_date=from_date, to_date=to_date
    )


@router.get("/net-worth")
async def net_worth(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    from_: FromDate = None,
    to: ToDate = None,
) -> dict[str, list[NetWorthPoint]]:
    from_date, to_date = _range(from_, to)
    # A pure read (net_worth_series reconstructs every point on the fly, same
    # as net_worth_composition) — no commit needed.
    return await AnalyticsService(db).net_worth_series(
        wsctx.workspace_id, from_date=from_date, to_date=to_date
    )


@router.get("/net-worth-composition")
async def net_worth_composition(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    from_: FromDate = None,
    to: ToDate = None,
    all_: AllTime = False,
) -> dict[str, list[CompositionPoint]]:
    svc = AnalyticsService(db)
    from_date, to_date = await _range_all(svc, wsctx.workspace_id, from_, to, all_)
    # A pure read (components are reconstructed on the fly, nothing captured), so
    # no commit.
    return await svc.net_worth_composition(
        wsctx.workspace_id, from_date=from_date, to_date=to_date
    )


@router.get("/upcoming")
async def upcoming(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    within_days: Annotated[int, Query(ge=1, le=365)] = 30,
    limit: Annotated[int, Query(ge=1, le=50)] = 8,
) -> Upcoming:
    # A pure read; the wall clock lives here so the service stays clock-free (§4).
    return await AnalyticsService(db).upcoming(
        wsctx.workspace_id, today=_today(), within_days=within_days, limit=limit
    )


@router.get("/forecast")
async def forecast(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    months: Annotated[int, Query(ge=1, le=24)] = 6,
) -> dict[str, ForecastMetrics]:
    # A pure read (nothing captured/persisted); the wall clock lives here so
    # the service stays clock-free (§4).
    return await ForecastService(db).forecast(wsctx.workspace_id, today=_today(), months=months)


@router.get("/summary")
async def summary(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> dict[str, SummaryOut]:
    # A pure read; the wall clock lives here so the service stays clock-free (§4).
    return await AnalyticsService(db).summary(wsctx.workspace_id, today=_today())
