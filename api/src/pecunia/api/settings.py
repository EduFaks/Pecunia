"""`/api/v1/settings` router: the first settings-WRITE endpoint. Preferences
set at setup (base_currency, locale, ...) stay read-only — this router only
ever merges in extra keys, the first being the optional monthly budget
(`instance_state.settings["monthly_budget_minor"]`), which the safe-to-spend
metric reads. Business logic (the merge, the audit event) lives in
`services/settings.py`; this module is schemas + HTTP wiring + the commit."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.services.settings import set_monthly_budget

router = APIRouter(
    prefix="/settings", tags=["settings"], dependencies=[Depends(require_initialized)]
)


class MonthlyBudgetIn(BaseModel):
    monthly_budget_minor: int | None = Field(default=None, ge=0)


class MonthlyBudgetOut(BaseModel):
    monthly_budget_minor: int | None


@router.put("/monthly-budget")
async def put_monthly_budget(
    body: MonthlyBudgetIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> MonthlyBudgetOut:
    merged = await set_monthly_budget(
        db, workspace_id=wsctx.workspace_id, monthly_budget_minor=body.monthly_budget_minor
    )
    await db.commit()
    return MonthlyBudgetOut(monthly_budget_minor=merged.get("monthly_budget_minor"))
