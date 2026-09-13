import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.budget import Budget, BudgetPeriod
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.budgets import UNSET, BudgetService, CategoryNotFoundError

router = APIRouter(prefix="/budgets", tags=["budgets"], dependencies=[Depends(require_initialized)])


class BudgetIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    category_id: uuid.UUID | None = None
    period: BudgetPeriod
    amount_minor: MinorInt
    currency: CurrencyStr


class BudgetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    category_id: uuid.UUID | None = None
    period: BudgetPeriod | None = None
    amount_minor: MinorInt | None = None
    currency: CurrencyStr | None = None


class BudgetOut(BaseModel):
    id: uuid.UUID
    name: str
    category_id: uuid.UUID | None
    period: str
    amount_minor: int
    currency: str
    actual_minor: int | None
    remaining_minor: int | None
    is_demo: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, budget: Budget, actual_minor: int | None) -> "BudgetOut":
        return cls(
            id=budget.id,
            name=budget.name,
            category_id=budget.category_id,
            period=budget.period,
            amount_minor=budget.amount_minor,
            currency=budget.currency,
            actual_minor=actual_minor,
            remaining_minor=budget.amount_minor - actual_minor if actual_minor is not None else None,
            is_demo=budget.is_demo,
            created_at=budget.created_at,
            updated_at=budget.updated_at,
        )


class BudgetPage(BaseModel):
    items: list[BudgetOut]
    next_cursor: str | None


async def _get_or_404(svc: BudgetService, workspace_id: uuid.UUID, budget_id: uuid.UUID) -> Budget:
    budget = await svc.get(workspace_id, budget_id)
    if budget is None:
        raise HTTPException(status_code=404, detail="BUDGET_NOT_FOUND")
    return budget


@router.post("", status_code=201)
async def create_budget(
    body: BudgetIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> BudgetOut:
    svc = BudgetService(db)
    try:
        budget = await svc.create(
            wsctx.workspace_id,
            name=body.name,
            category_id=body.category_id,
            period=body.period.value,
            amount_minor=body.amount_minor,
            currency=body.currency,
        )
    except CategoryNotFoundError:
        raise HTTPException(status_code=404, detail="CATEGORY_NOT_FOUND") from None
    await db.commit()
    return BudgetOut.from_model(budget, await svc.actual_minor(budget, datetime.now(UTC).date()))


@router.get("")
async def list_budgets(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> BudgetPage:
    svc = BudgetService(db)
    items, next_cursor = await svc.list(wsctx.workspace_id, cursor=cursor, limit=limit)
    today = datetime.now(UTC).date()
    return BudgetPage(
        items=[BudgetOut.from_model(b, await svc.actual_minor(b, today)) for b in items],
        next_cursor=next_cursor,
    )


@router.get("/{budget_id}")
async def get_budget(
    budget_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> BudgetOut:
    svc = BudgetService(db)
    budget = await _get_or_404(svc, wsctx.workspace_id, budget_id)
    return BudgetOut.from_model(budget, await svc.actual_minor(budget, datetime.now(UTC).date()))


@router.patch("/{budget_id}")
async def update_budget(
    budget_id: uuid.UUID,
    body: BudgetUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> BudgetOut:
    svc = BudgetService(db)
    budget = await _get_or_404(svc, wsctx.workspace_id, budget_id)
    fields = body.model_dump(exclude_unset=True)
    try:
        budget = await svc.update(
            budget,
            name=fields.get("name"),
            category_id=fields.get("category_id", UNSET),
            period=fields["period"].value if fields.get("period") is not None else None,
            amount_minor=fields.get("amount_minor"),
            currency=fields.get("currency"),
        )
    except CategoryNotFoundError:
        raise HTTPException(status_code=404, detail="CATEGORY_NOT_FOUND") from None
    await db.commit()
    return BudgetOut.from_model(budget, await svc.actual_minor(budget, datetime.now(UTC).date()))


@router.delete("/{budget_id}", status_code=204)
async def delete_budget(
    budget_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = BudgetService(db)
    budget = await _get_or_404(svc, wsctx.workspace_id, budget_id)
    await svc.delete(budget)
    await db.commit()
