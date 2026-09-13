import uuid
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.transfer import Transfer
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.transfers import (
    AccountNotFoundError,
    CurrencyMismatchError,
    NonPositiveAmountError,
    SameAccountError,
    TransferService,
)

router = APIRouter(prefix="/transfers", tags=["transfers"], dependencies=[Depends(require_initialized)])


class TransferIn(BaseModel):
    from_account_id: uuid.UUID
    to_account_id: uuid.UUID
    amount_minor: MinorInt
    currency: CurrencyStr
    description: str = Field(min_length=1, max_length=500)
    occurred_on: date


class TransferUpdate(BaseModel):
    from_account_id: uuid.UUID | None = None
    to_account_id: uuid.UUID | None = None
    amount_minor: MinorInt | None = None
    description: str | None = Field(default=None, min_length=1, max_length=500)
    occurred_on: date | None = None


class TransferOut(BaseModel):
    id: uuid.UUID
    from_account_id: uuid.UUID
    to_account_id: uuid.UUID
    amount_minor: int
    currency: str
    description: str
    occurred_on: date
    is_demo: bool
    created_at: datetime

    @classmethod
    def from_model(cls, transfer: Transfer) -> "TransferOut":
        return cls(
            id=transfer.id,
            from_account_id=transfer.from_account_id,
            to_account_id=transfer.to_account_id,
            amount_minor=transfer.amount_minor,
            currency=transfer.currency,
            description=transfer.description,
            occurred_on=transfer.occurred_on,
            is_demo=transfer.is_demo,
            created_at=transfer.created_at,
        )


class TransferPage(BaseModel):
    items: list[TransferOut]
    next_cursor: str | None


def _raise_for_validation(exc: Exception) -> None:
    """Map a TransferService validation error to its HTTP status/code."""
    if isinstance(exc, AccountNotFoundError):
        raise HTTPException(status_code=404, detail="ACCOUNT_NOT_FOUND") from None
    if isinstance(exc, SameAccountError):
        raise HTTPException(status_code=422, detail="TRANSFER_SAME_ACCOUNT") from None
    if isinstance(exc, CurrencyMismatchError):
        raise HTTPException(status_code=422, detail="TRANSFER_CURRENCY_MISMATCH") from None
    if isinstance(exc, NonPositiveAmountError):
        raise HTTPException(status_code=422, detail="TRANSFER_NONPOSITIVE") from None
    raise exc


async def _get_or_404(
    svc: TransferService, workspace_id: uuid.UUID, transfer_id: uuid.UUID
) -> Transfer:
    transfer = await svc.get(workspace_id, transfer_id)
    if transfer is None:
        raise HTTPException(status_code=404, detail="TRANSFER_NOT_FOUND")
    return transfer


@router.post("", status_code=201)
async def create_transfer(
    body: TransferIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> TransferOut:
    svc = TransferService(db)
    try:
        transfer = await svc.create(
            wsctx.workspace_id,
            from_account_id=body.from_account_id,
            to_account_id=body.to_account_id,
            amount_minor=body.amount_minor,
            currency=body.currency,
            description=body.description,
            occurred_on=body.occurred_on,
        )
    except (AccountNotFoundError, SameAccountError, CurrencyMismatchError, NonPositiveAmountError) as exc:
        _raise_for_validation(exc)
    await db.commit()
    return TransferOut.from_model(transfer)


@router.get("")
async def list_transfers(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> TransferPage:
    svc = TransferService(db)
    items, next_cursor = await svc.list(wsctx.workspace_id, cursor=cursor, limit=limit)
    return TransferPage(items=[TransferOut.from_model(t) for t in items], next_cursor=next_cursor)


@router.get("/{transfer_id}")
async def get_transfer(
    transfer_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> TransferOut:
    svc = TransferService(db)
    transfer = await _get_or_404(svc, wsctx.workspace_id, transfer_id)
    return TransferOut.from_model(transfer)


@router.patch("/{transfer_id}")
async def update_transfer(
    transfer_id: uuid.UUID,
    body: TransferUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> TransferOut:
    svc = TransferService(db)
    transfer = await _get_or_404(svc, wsctx.workspace_id, transfer_id)
    fields = body.model_dump(exclude_unset=True)
    try:
        transfer = await svc.update(
            transfer,
            amount_minor=fields.get("amount_minor"),
            description=fields.get("description"),
            occurred_on=fields.get("occurred_on"),
            from_account_id=fields.get("from_account_id"),
            to_account_id=fields.get("to_account_id"),
        )
    except (AccountNotFoundError, SameAccountError, CurrencyMismatchError, NonPositiveAmountError) as exc:
        _raise_for_validation(exc)
    await db.commit()
    return TransferOut.from_model(transfer)


@router.delete("/{transfer_id}", status_code=204)
async def delete_transfer(
    transfer_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = TransferService(db)
    transfer = await _get_or_404(svc, wsctx.workspace_id, transfer_id)
    await svc.delete(transfer)
    await db.commit()
