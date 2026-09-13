from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import (
    WorkspaceContext,
    get_instance_state,
    require_initialized,
    require_workspace,
)
from pecunia.db import get_db
from pecunia.models.instance import InstanceState
from pecunia.services.demo import (
    DemoAlreadyPresentError,
    demo_counts,
    remove_demo_data,
    seed_demo_data,
)

router = APIRouter(prefix="/demo", tags=["demo"], dependencies=[Depends(require_initialized)])


class DemoStatusOut(BaseModel):
    present: bool
    counts: dict[str, int]


@router.post("", status_code=201)
async def seed_demo(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    state: Annotated[InstanceState, Depends(get_instance_state)],
) -> DemoStatusOut:
    base_currency = (state.settings or {}).get("base_currency")
    if base_currency is None:
        raise HTTPException(status_code=500, detail="INSTANCE_MISCONFIGURED")
    try:
        counts = await seed_demo_data(db, wsctx.workspace_id, base_currency=base_currency)
    except DemoAlreadyPresentError:
        raise HTTPException(status_code=409, detail="DEMO_ALREADY_PRESENT") from None
    await db.commit()
    return DemoStatusOut(present=True, counts=counts)


@router.delete("", status_code=204)
async def delete_demo(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    await remove_demo_data(db, wsctx.workspace_id)
    await db.commit()


@router.get("")
async def get_demo(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> DemoStatusOut:
    counts = await demo_counts(db, wsctx.workspace_id)
    return DemoStatusOut(present=any(counts.values()), counts=counts)
