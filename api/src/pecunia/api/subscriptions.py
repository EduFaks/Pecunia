import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.subscription import Subscription, SubscriptionStatus
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.subscriptions import (
    UNSET,
    LogoInvalidError,
    NonPositiveAmountError,
    SubscriptionService,
    annual_minor,
    monthly_minor,
)
from pecunia.services.transactions import (
    AccountNotFoundError,
    CategoryNotFoundError,
    ContactNotFoundError,
)

router = APIRouter(
    prefix="/subscriptions",
    tags=["subscriptions"],
    dependencies=[Depends(require_initialized)],
)

BillingFrequency = Literal["weekly", "monthly", "quarterly", "yearly"]


class SubscriptionIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    amount_minor: MinorInt
    currency: CurrencyStr
    billing_frequency: BillingFrequency
    next_renewal: date
    logo: str | None = None
    started_on: date | None = None
    status: SubscriptionStatus = SubscriptionStatus.ACTIVE
    contact_id: uuid.UUID | None = None
    account_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None


class SubscriptionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    amount_minor: MinorInt | None = None
    currency: CurrencyStr | None = None
    billing_frequency: BillingFrequency | None = None
    next_renewal: date | None = None
    status: SubscriptionStatus | None = None
    logo: str | None = None
    started_on: date | None = None
    contact_id: uuid.UUID | None = None
    account_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None


class SubscriptionOut(BaseModel):
    id: uuid.UUID
    name: str
    logo: str | None
    amount_minor: int
    currency: str
    billing_frequency: str
    next_renewal: date
    started_on: date | None
    status: str
    contact_id: uuid.UUID | None
    account_id: uuid.UUID | None
    category_id: uuid.UUID | None
    is_demo: bool
    created_at: datetime
    # Pure cost normalization, integer minor units (see SubscriptionService).
    monthly_minor: int
    annual_minor: int

    @classmethod
    def from_model(cls, sub: Subscription) -> "SubscriptionOut":
        return cls(
            id=sub.id,
            name=sub.name,
            logo=sub.logo,
            amount_minor=sub.amount_minor,
            currency=sub.currency,
            billing_frequency=sub.billing_frequency,
            next_renewal=sub.next_renewal,
            started_on=sub.started_on,
            status=sub.status,
            contact_id=sub.contact_id,
            account_id=sub.account_id,
            category_id=sub.category_id,
            is_demo=sub.is_demo,
            created_at=sub.created_at,
            monthly_minor=monthly_minor(sub.amount_minor, sub.billing_frequency),
            annual_minor=annual_minor(sub.amount_minor, sub.billing_frequency),
        )


class SubscriptionPage(BaseModel):
    items: list[SubscriptionOut]
    next_cursor: str | None


class CurrencyTotal(BaseModel):
    monthly_minor: int
    annual_minor: int
    count: int


def _raise_validation(exc: Exception) -> None:
    """Map the service's validation errors to HTTP — a foreign link is a 404,
    a bad amount/logo a 422 with a domain code."""
    if isinstance(exc, ContactNotFoundError):
        raise HTTPException(status_code=404, detail="CONTACT_NOT_FOUND") from None
    if isinstance(exc, AccountNotFoundError):
        raise HTTPException(status_code=404, detail="ACCOUNT_NOT_FOUND") from None
    if isinstance(exc, CategoryNotFoundError):
        raise HTTPException(status_code=404, detail="CATEGORY_NOT_FOUND") from None
    if isinstance(exc, NonPositiveAmountError):
        raise HTTPException(status_code=422, detail="SUBSCRIPTION_NONPOSITIVE") from None
    if isinstance(exc, LogoInvalidError):
        raise HTTPException(status_code=422, detail="LOGO_INVALID") from None
    raise exc


_VALIDATION_ERRORS = (
    ContactNotFoundError,
    AccountNotFoundError,
    CategoryNotFoundError,
    NonPositiveAmountError,
    LogoInvalidError,
)


async def _get_or_404(
    svc: SubscriptionService, workspace_id: uuid.UUID, subscription_id: uuid.UUID
) -> Subscription:
    sub = await svc.get(workspace_id, subscription_id)
    if sub is None:
        raise HTTPException(status_code=404, detail="SUBSCRIPTION_NOT_FOUND")
    return sub


@router.post("", status_code=201)
async def create_subscription(
    body: SubscriptionIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> SubscriptionOut:
    svc = SubscriptionService(db)
    try:
        sub = await svc.create(
            wsctx.workspace_id,
            name=body.name,
            amount_minor=body.amount_minor,
            currency=body.currency,
            billing_frequency=body.billing_frequency,
            next_renewal=body.next_renewal,
            logo=body.logo,
            started_on=body.started_on,
            status=body.status.value,
            contact_id=body.contact_id,
            account_id=body.account_id,
            category_id=body.category_id,
        )
    except _VALIDATION_ERRORS as exc:
        _raise_validation(exc)
    await db.commit()
    return SubscriptionOut.from_model(sub)


@router.get("")
async def list_subscriptions(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> SubscriptionPage:
    svc = SubscriptionService(db)
    items, next_cursor = await svc.list(wsctx.workspace_id, cursor=cursor, limit=limit)
    return SubscriptionPage(
        items=[SubscriptionOut.from_model(s) for s in items], next_cursor=next_cursor
    )


# Declared before `/{subscription_id}` so "totals" is matched as this route
# rather than parsed as a subscription id.
@router.get("/totals")
async def subscription_totals(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    status: SubscriptionStatus = SubscriptionStatus.ACTIVE,
) -> dict[str, CurrencyTotal]:
    svc = SubscriptionService(db)
    return await svc.totals(wsctx.workspace_id, status=status.value)


@router.get("/{subscription_id}")
async def get_subscription(
    subscription_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> SubscriptionOut:
    svc = SubscriptionService(db)
    sub = await _get_or_404(svc, wsctx.workspace_id, subscription_id)
    return SubscriptionOut.from_model(sub)


@router.patch("/{subscription_id}")
async def update_subscription(
    subscription_id: uuid.UUID,
    body: SubscriptionUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> SubscriptionOut:
    svc = SubscriptionService(db)
    sub = await _get_or_404(svc, wsctx.workspace_id, subscription_id)
    fields = body.model_dump(exclude_unset=True)
    status = fields.get("status")
    try:
        sub = await svc.update(
            sub,
            name=fields.get("name"),
            amount_minor=fields.get("amount_minor"),
            currency=fields.get("currency"),
            billing_frequency=fields.get("billing_frequency"),
            next_renewal=fields.get("next_renewal"),
            status=status.value if status is not None else None,
            logo=fields.get("logo", UNSET),
            started_on=fields.get("started_on", UNSET),
            contact_id=fields.get("contact_id", UNSET),
            account_id=fields.get("account_id", UNSET),
            category_id=fields.get("category_id", UNSET),
        )
    except _VALIDATION_ERRORS as exc:
        _raise_validation(exc)
    await db.commit()
    return SubscriptionOut.from_model(sub)


@router.post("/{subscription_id}/renew")
async def renew_subscription(
    subscription_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> SubscriptionOut:
    svc = SubscriptionService(db)
    sub = await _get_or_404(svc, wsctx.workspace_id, subscription_id)
    sub = await svc.renew(sub)
    await db.commit()
    return SubscriptionOut.from_model(sub)


@router.delete("/{subscription_id}", status_code=204)
async def delete_subscription(
    subscription_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = SubscriptionService(db)
    sub = await _get_or_404(svc, wsctx.workspace_id, subscription_id)
    await svc.delete(sub)
    await db.commit()
