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

router = APIRouter(prefix="/analytics", tags=["analytics"], dependencies=[Depends(require_initialized)])

# The default reporting window when the caller omits `from`/`to`: a rolling
# 12-month range aligned to month starts (the first of the month 11 months ago
# through today), computed here in the router from the wall clock so the
# service stays clock-free (CONVENTIONS §4).
DEFAULT_MONTHS = 12

FromDate = Annotated[date | None, Query(alias="from")]
ToDate = Annotated[date | None, Query(alias="to")]


def _today() -> date:
    # Wall clock lives in the router (services stay clock-free, §4); UTC .date()
    # matches how the budgets router derives "today".
    return datetime.now(UTC).date()


def _range(from_: date | None, to: date | None) -> tuple[date, date]:
    to_date = to or _today()
    from_date = from_ or shift_month(to_date, -(DEFAULT_MONTHS - 1))
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
) -> dict[str, list[CategorySpend]]:
    from_date, to_date = _range(from_, to)
    return await AnalyticsService(db).spending_by_category(
        wsctx.workspace_id, from_date=from_date, to_date=to_date
    )


@router.get("/spending-by-contact")
async def spending_by_contact(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    from_: FromDate = None,
    to: ToDate = None,
) -> dict[str, list[ContactSpend]]:
    from_date, to_date = _range(from_, to)
    return await AnalyticsService(db).spending_by_contact(
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
    result = await AnalyticsService(db).net_worth_series(
        wsctx.workspace_id, from_date=from_date, to_date=to_date, today=_today()
    )
    # net_worth_series refreshes today's snapshot on read — the router owns commit.
    await db.commit()
    return result


@router.get("/net-worth-composition")
async def net_worth_composition(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    from_: FromDate = None,
    to: ToDate = None,
) -> dict[str, list[CompositionPoint]]:
    from_date, to_date = _range(from_, to)
    # A pure read (components are reconstructed on the fly, nothing captured), so
    # no commit — unlike /net-worth which refreshes today's snapshot.
    return await AnalyticsService(db).net_worth_composition(
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
