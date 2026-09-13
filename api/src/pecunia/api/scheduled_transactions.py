import uuid
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.api.transactions import TransactionOut
from pecunia.db import get_db
from pecunia.models.scheduled_transaction import ScheduledTransaction, ScheduleFrequency
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.scheduled_transactions import (
    UNSET,
    InvalidFrequencyError,
    ScheduledTransactionService,
    ScheduleZeroAmountError,
)
from pecunia.services.transactions import (
    AccountNotFoundError,
    CategoryNotFoundError,
    ContactNotFoundError,
    CurrencyMismatchError,
)

router = APIRouter(prefix="/planned", tags=["planned"], dependencies=[Depends(require_initialized)])


class ScheduleIn(BaseModel):
    account_id: uuid.UUID
    category_id: uuid.UUID | None = None
    contact_id: uuid.UUID | None = None
    amount_minor: MinorInt
    currency: CurrencyStr
    description: str = Field(min_length=1, max_length=500)
    frequency: ScheduleFrequency
    interval_count: int = Field(default=1, ge=1)
    next_due: date
    end_date: date | None = None


class ScheduleUpdate(BaseModel):
    account_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    contact_id: uuid.UUID | None = None
    amount_minor: MinorInt | None = None
    currency: CurrencyStr | None = None
    description: str | None = Field(default=None, min_length=1, max_length=500)
    frequency: ScheduleFrequency | None = None
    interval_count: int | None = Field(default=None, ge=1)
    next_due: date | None = None
    end_date: date | None = None
    is_active: bool | None = None


class PostIn(BaseModel):
    on_date: date | None = None


class ScheduledTransactionOut(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    category_id: uuid.UUID | None
    contact_id: uuid.UUID | None
    amount_minor: int
    currency: str
    description: str
    frequency: str
    interval_count: int
    next_due: date
    end_date: date | None
    is_active: bool
    is_demo: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, sched: ScheduledTransaction) -> "ScheduledTransactionOut":
        return cls(
            id=sched.id,
            account_id=sched.account_id,
            category_id=sched.category_id,
            contact_id=sched.contact_id,
            amount_minor=sched.amount_minor,
            currency=sched.currency,
            description=sched.description,
            frequency=sched.frequency,
            interval_count=sched.interval_count,
            next_due=sched.next_due,
            end_date=sched.end_date,
            is_active=sched.is_active,
            is_demo=sched.is_demo,
            created_at=sched.created_at,
            updated_at=sched.updated_at,
        )


class SchedulePage(BaseModel):
    items: list[ScheduledTransactionOut]
    next_cursor: str | None


class PostOut(BaseModel):
    schedule: ScheduledTransactionOut
    transaction: TransactionOut


async def _get_or_404(
    svc: ScheduledTransactionService, workspace_id: uuid.UUID, scheduled_transaction_id: uuid.UUID
) -> ScheduledTransaction:
    sched = await svc.get(workspace_id, scheduled_transaction_id)
    if sched is None:
        raise HTTPException(status_code=404, detail="SCHEDULED_TRANSACTION_NOT_FOUND")
    return sched


def _raise_validation(exc: Exception) -> None:
    """Map the service's shared validation errors to HTTP — identical mapping
    to the transaction router, plus the schedule-specific codes."""
    if isinstance(exc, AccountNotFoundError):
        raise HTTPException(status_code=404, detail="ACCOUNT_NOT_FOUND") from None
    if isinstance(exc, CategoryNotFoundError):
        raise HTTPException(status_code=404, detail="CATEGORY_NOT_FOUND") from None
    if isinstance(exc, ContactNotFoundError):
        raise HTTPException(status_code=404, detail="CONTACT_NOT_FOUND") from None
    if isinstance(exc, CurrencyMismatchError):
        raise HTTPException(status_code=422, detail="CURRENCY_MISMATCH") from None
    if isinstance(exc, ScheduleZeroAmountError):
        raise HTTPException(status_code=422, detail="SCHEDULE_ZERO_AMOUNT") from None
    if isinstance(exc, InvalidFrequencyError):
        raise HTTPException(status_code=422, detail="SCHEDULE_INVALID_FREQUENCY") from None
    raise exc


_VALIDATION_ERRORS = (
    AccountNotFoundError,
    CategoryNotFoundError,
    ContactNotFoundError,
    CurrencyMismatchError,
    ScheduleZeroAmountError,
    InvalidFrequencyError,
)


@router.post("", status_code=201)
async def create_schedule(
    body: ScheduleIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ScheduledTransactionOut:
    svc = ScheduledTransactionService(db)
    try:
        sched = await svc.create(
            wsctx.workspace_id,
            account_id=body.account_id,
            amount_minor=body.amount_minor,
            currency=body.currency,
            description=body.description,
            frequency=body.frequency.value,
            next_due=body.next_due,
            category_id=body.category_id,
            contact_id=body.contact_id,
            interval_count=body.interval_count,
            end_date=body.end_date,
        )
    except _VALIDATION_ERRORS as exc:
        _raise_validation(exc)
    await db.commit()
    return ScheduledTransactionOut.from_model(sched)


@router.get("")
async def list_schedules(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    is_active: bool | None = None,
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> SchedulePage:
    svc = ScheduledTransactionService(db)
    items, next_cursor = await svc.list(
        wsctx.workspace_id, is_active=is_active, cursor=cursor, limit=limit
    )
    return SchedulePage(
        items=[ScheduledTransactionOut.from_model(s) for s in items], next_cursor=next_cursor
    )


@router.get("/{scheduled_transaction_id}")
async def get_schedule(
    scheduled_transaction_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ScheduledTransactionOut:
    svc = ScheduledTransactionService(db)
    sched = await _get_or_404(svc, wsctx.workspace_id, scheduled_transaction_id)
    return ScheduledTransactionOut.from_model(sched)


@router.patch("/{scheduled_transaction_id}")
async def update_schedule(
    scheduled_transaction_id: uuid.UUID,
    body: ScheduleUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ScheduledTransactionOut:
    svc = ScheduledTransactionService(db)
    sched = await _get_or_404(svc, wsctx.workspace_id, scheduled_transaction_id)
    fields = body.model_dump(exclude_unset=True)
    # is_active is the dedicated pause/resume toggle (set_active) — pop it so
    # the general update path handles only the content fields.
    try:
        if "is_active" in fields:
            sched = await svc.set_active(sched, fields.pop("is_active"))
        if fields:
            sched = await svc.update(
                sched,
                account_id=fields.get("account_id"),
                category_id=fields.get("category_id", UNSET),
                contact_id=fields.get("contact_id", UNSET),
                amount_minor=fields.get("amount_minor"),
                currency=fields.get("currency"),
                description=fields.get("description"),
                frequency=fields.get("frequency"),
                interval_count=fields.get("interval_count"),
                next_due=fields.get("next_due"),
                end_date=fields.get("end_date", UNSET),
            )
    except _VALIDATION_ERRORS as exc:
        _raise_validation(exc)
    await db.commit()
    return ScheduledTransactionOut.from_model(sched)


@router.post("/{scheduled_transaction_id}/post", status_code=201)
async def post_schedule(
    scheduled_transaction_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    body: PostIn | None = None,
) -> PostOut:
    svc = ScheduledTransactionService(db)
    sched = await _get_or_404(svc, wsctx.workspace_id, scheduled_transaction_id)
    try:
        sched, transaction = await svc.post(
            sched, today=datetime.now(UTC).date(), on_date=body.on_date if body else None
        )
    except _VALIDATION_ERRORS as exc:
        _raise_validation(exc)
    await db.commit()
    return PostOut(
        schedule=ScheduledTransactionOut.from_model(sched),
        transaction=TransactionOut.from_model(transaction),
    )


@router.post("/{scheduled_transaction_id}/skip")
async def skip_schedule(
    scheduled_transaction_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ScheduledTransactionOut:
    svc = ScheduledTransactionService(db)
    sched = await _get_or_404(svc, wsctx.workspace_id, scheduled_transaction_id)
    sched = await svc.skip(sched)
    await db.commit()
    return ScheduledTransactionOut.from_model(sched)


@router.delete("/{scheduled_transaction_id}", status_code=204)
async def delete_schedule(
    scheduled_transaction_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = ScheduledTransactionService(db)
    sched = await _get_or_404(svc, wsctx.workspace_id, scheduled_transaction_id)
    await svc.delete(sched)
    await db.commit()
