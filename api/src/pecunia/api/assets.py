import uuid
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.asset import Asset, AssetType, AssetValuation
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.assets import UNSET, AssetService

router = APIRouter(prefix="/assets", tags=["assets"], dependencies=[Depends(require_initialized)])


class AssetIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: AssetType
    currency: CurrencyStr
    acquired_on: date | None = None


class AssetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    type: AssetType | None = None
    currency: CurrencyStr | None = None
    acquired_on: date | None = None


class AssetOut(BaseModel):
    id: uuid.UUID
    name: str
    type: str
    currency: str
    acquired_on: date | None
    current_value_minor: int | None
    is_demo: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, asset: Asset, current_value_minor: int | None) -> "AssetOut":
        return cls(
            id=asset.id,
            name=asset.name,
            type=asset.type,
            currency=asset.currency,
            acquired_on=asset.acquired_on,
            current_value_minor=current_value_minor,
            is_demo=asset.is_demo,
            created_at=asset.created_at,
            updated_at=asset.updated_at,
        )


class AssetPage(BaseModel):
    items: list[AssetOut]
    next_cursor: str | None


class AssetValuationIn(BaseModel):
    value_minor: MinorInt
    as_of: date
    source: str | None = None


class AssetValuationUpdate(BaseModel):
    value_minor: MinorInt | None = None
    as_of: date | None = None
    source: str | None = None


class AssetValuationOut(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    value_minor: int
    as_of: date
    source: str | None
    is_demo: bool
    created_at: datetime

    @classmethod
    def from_model(cls, valuation: AssetValuation) -> "AssetValuationOut":
        return cls(
            id=valuation.id,
            asset_id=valuation.asset_id,
            value_minor=valuation.value_minor,
            as_of=valuation.as_of,
            source=valuation.source,
            is_demo=valuation.is_demo,
            created_at=valuation.created_at,
        )


class AssetValuationPage(BaseModel):
    items: list[AssetValuationOut]
    next_cursor: str | None


async def _get_or_404(svc: AssetService, workspace_id: uuid.UUID, asset_id: uuid.UUID) -> Asset:
    asset = await svc.get(workspace_id, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="ASSET_NOT_FOUND")
    return asset


async def _get_valuation_or_404(
    svc: AssetService, workspace_id: uuid.UUID, asset_id: uuid.UUID, valuation_id: uuid.UUID
) -> AssetValuation:
    valuation = await svc.get_valuation(workspace_id, valuation_id)
    if valuation is None or valuation.asset_id != asset_id:
        raise HTTPException(status_code=404, detail="ASSET_VALUATION_NOT_FOUND")
    return valuation


@router.post("", status_code=201)
async def create_asset(
    body: AssetIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> AssetOut:
    svc = AssetService(db)
    asset = await svc.create(
        wsctx.workspace_id,
        name=body.name,
        type=body.type.value,
        currency=body.currency,
        acquired_on=body.acquired_on,
    )
    await db.commit()
    return AssetOut.from_model(asset, await svc.current_value(asset))


@router.get("")
async def list_assets(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> AssetPage:
    svc = AssetService(db)
    items, next_cursor = await svc.list(wsctx.workspace_id, cursor=cursor, limit=limit)
    return AssetPage(
        items=[AssetOut.from_model(a, await svc.current_value(a)) for a in items], next_cursor=next_cursor
    )


@router.get("/{asset_id}")
async def get_asset(
    asset_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> AssetOut:
    svc = AssetService(db)
    asset = await _get_or_404(svc, wsctx.workspace_id, asset_id)
    return AssetOut.from_model(asset, await svc.current_value(asset))


@router.patch("/{asset_id}")
async def update_asset(
    asset_id: uuid.UUID,
    body: AssetUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> AssetOut:
    svc = AssetService(db)
    asset = await _get_or_404(svc, wsctx.workspace_id, asset_id)
    fields = body.model_dump(exclude_unset=True)
    asset = await svc.update(
        asset,
        name=fields.get("name"),
        type=fields["type"].value if fields.get("type") is not None else None,
        currency=fields.get("currency"),
        acquired_on=fields.get("acquired_on", UNSET),
    )
    await db.commit()
    return AssetOut.from_model(asset, await svc.current_value(asset))


@router.delete("/{asset_id}", status_code=204)
async def delete_asset(
    asset_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = AssetService(db)
    asset = await _get_or_404(svc, wsctx.workspace_id, asset_id)
    await svc.delete(asset)
    await db.commit()


@router.post("/{asset_id}/valuations", status_code=201)
async def add_asset_valuation(
    asset_id: uuid.UUID,
    body: AssetValuationIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> AssetValuationOut:
    svc = AssetService(db)
    asset = await _get_or_404(svc, wsctx.workspace_id, asset_id)
    valuation = await svc.add_valuation(
        asset, value_minor=body.value_minor, as_of=body.as_of, source=body.source
    )
    await db.commit()
    return AssetValuationOut.from_model(valuation)


@router.get("/{asset_id}/valuations")
async def list_asset_valuations(
    asset_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> AssetValuationPage:
    svc = AssetService(db)
    asset = await _get_or_404(svc, wsctx.workspace_id, asset_id)
    items, next_cursor = await svc.list_valuations(wsctx.workspace_id, asset.id, cursor=cursor, limit=limit)
    return AssetValuationPage(
        items=[AssetValuationOut.from_model(v) for v in items], next_cursor=next_cursor
    )


@router.patch("/{asset_id}/valuations/{valuation_id}")
async def update_asset_valuation(
    asset_id: uuid.UUID,
    valuation_id: uuid.UUID,
    body: AssetValuationUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> AssetValuationOut:
    svc = AssetService(db)
    asset = await _get_or_404(svc, wsctx.workspace_id, asset_id)
    valuation = await _get_valuation_or_404(svc, wsctx.workspace_id, asset.id, valuation_id)
    fields = body.model_dump(exclude_unset=True)
    valuation = await svc.update_valuation(
        valuation,
        value_minor=fields.get("value_minor"),
        as_of=fields.get("as_of"),
        source=fields.get("source", UNSET),
    )
    await db.commit()
    return AssetValuationOut.from_model(valuation)
