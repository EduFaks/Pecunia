import uuid
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.goal import Goal, GoalSourceKind
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.goals import (
    UNSET,
    GoalCurrencyMismatchError,
    GoalService,
    GoalSourceRequiredError,
    PortfolioNotFoundError,
)
from pecunia.services.transactions import AccountNotFoundError

router = APIRouter(prefix="/goals", tags=["goals"], dependencies=[Depends(require_initialized)])


def _today() -> date:
    return datetime.now(UTC).date()


class GoalIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    target_minor: MinorInt
    currency: CurrencyStr
    target_date: date | None = None
    source_kind: GoalSourceKind = GoalSourceKind.MANUAL
    source_id: uuid.UUID | None = None
    manual_current_minor: MinorInt | None = None


class GoalUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    target_minor: MinorInt | None = None
    currency: CurrencyStr | None = None
    target_date: date | None = None
    source_kind: GoalSourceKind | None = None
    source_id: uuid.UUID | None = None
    manual_current_minor: MinorInt | None = None


class GoalProgress(BaseModel):
    current_minor: int
    target_minor: int
    pct_bps: int


class GoalEta(BaseModel):
    reached_on: date | None
    on_track: bool


class GoalOut(BaseModel):
    id: uuid.UUID
    name: str
    target_minor: int
    currency: str
    target_date: date | None
    source_kind: str
    source_id: uuid.UUID | None
    manual_current_minor: int | None
    created_at: datetime
    progress: GoalProgress
    eta: GoalEta

    @classmethod
    def from_model(cls, goal: Goal, *, progress: dict, eta: dict) -> "GoalOut":
        return cls(
            id=goal.id,
            name=goal.name,
            target_minor=goal.target_minor,
            currency=goal.currency,
            target_date=goal.target_date,
            source_kind=goal.source_kind,
            source_id=goal.source_id,
            manual_current_minor=goal.manual_current_minor,
            created_at=goal.created_at,
            progress=GoalProgress(**progress),
            eta=GoalEta(**eta),
        )


class GoalPage(BaseModel):
    items: list[GoalOut]
    next_cursor: str | None


async def _get_or_404(svc: GoalService, workspace_id: uuid.UUID, goal_id: uuid.UUID) -> Goal:
    goal = await svc.get(workspace_id, goal_id)
    if goal is None:
        raise HTTPException(status_code=404, detail="GOAL_NOT_FOUND")
    return goal


async def _goal_out(svc: GoalService, goal: Goal, *, today: date) -> GoalOut:
    return GoalOut.from_model(
        goal,
        progress=await svc.progress(goal, today=today),
        eta=await svc.eta(goal, today=today),
    )


@router.post("", status_code=201)
async def create_goal(
    body: GoalIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> GoalOut:
    svc = GoalService(db)
    try:
        goal = await svc.create(
            wsctx.workspace_id,
            name=body.name,
            target_minor=body.target_minor,
            currency=body.currency,
            source_kind=body.source_kind,
            target_date=body.target_date,
            source_id=body.source_id,
            manual_current_minor=body.manual_current_minor,
        )
    except GoalSourceRequiredError:
        raise HTTPException(status_code=422, detail="GOAL_SOURCE_REQUIRED") from None
    except GoalCurrencyMismatchError:
        raise HTTPException(status_code=422, detail="GOAL_CURRENCY_MISMATCH") from None
    except AccountNotFoundError:
        raise HTTPException(status_code=404, detail="ACCOUNT_NOT_FOUND") from None
    except PortfolioNotFoundError:
        raise HTTPException(status_code=404, detail="PORTFOLIO_NOT_FOUND") from None
    await db.commit()
    return await _goal_out(svc, goal, today=_today())


@router.get("")
async def list_goals(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> GoalPage:
    svc = GoalService(db)
    items, next_cursor = await svc.list(wsctx.workspace_id, cursor=cursor, limit=limit)
    today = _today()
    return GoalPage(
        items=[await _goal_out(svc, goal, today=today) for goal in items],
        next_cursor=next_cursor,
    )


@router.get("/{goal_id}")
async def get_goal(
    goal_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> GoalOut:
    svc = GoalService(db)
    goal = await _get_or_404(svc, wsctx.workspace_id, goal_id)
    return await _goal_out(svc, goal, today=_today())


@router.patch("/{goal_id}")
async def update_goal(
    goal_id: uuid.UUID,
    body: GoalUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> GoalOut:
    svc = GoalService(db)
    goal = await _get_or_404(svc, wsctx.workspace_id, goal_id)
    fields = body.model_dump(exclude_unset=True)
    source_kind = fields.get("source_kind")
    try:
        goal = await svc.update(
            goal,
            name=fields.get("name"),
            target_minor=fields.get("target_minor"),
            currency=fields.get("currency"),
            source_kind=source_kind.value if source_kind is not None else None,
            target_date=fields.get("target_date", UNSET),
            source_id=fields.get("source_id", UNSET),
            manual_current_minor=fields.get("manual_current_minor", UNSET),
        )
    except GoalSourceRequiredError:
        raise HTTPException(status_code=422, detail="GOAL_SOURCE_REQUIRED") from None
    except GoalCurrencyMismatchError:
        raise HTTPException(status_code=422, detail="GOAL_CURRENCY_MISMATCH") from None
    except AccountNotFoundError:
        raise HTTPException(status_code=404, detail="ACCOUNT_NOT_FOUND") from None
    except PortfolioNotFoundError:
        raise HTTPException(status_code=404, detail="PORTFOLIO_NOT_FOUND") from None
    await db.commit()
    return await _goal_out(svc, goal, today=_today())


@router.delete("/{goal_id}", status_code=204)
async def delete_goal(
    goal_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = GoalService(db)
    goal = await _get_or_404(svc, wsctx.workspace_id, goal_id)
    await svc.delete(goal)
    await db.commit()
