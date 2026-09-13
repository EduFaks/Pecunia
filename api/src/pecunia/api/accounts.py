import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.account import Account, AccountType
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.accounts import AccountCurrencyChangeError, AccountService

router = APIRouter(prefix="/accounts", tags=["accounts"], dependencies=[Depends(require_initialized)])


class AccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: AccountType
    currency: CurrencyStr
    initial_balance_minor: MinorInt = 0


class AccountUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    type: AccountType | None = None
    currency: CurrencyStr | None = None


class AccountOut(BaseModel):
    id: uuid.UUID
    name: str
    type: str
    currency: str
    initial_balance_minor: int
    balance_minor: int
    is_demo: bool
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, account: Account, balance_minor: int) -> "AccountOut":
        return cls(
            id=account.id,
            name=account.name,
            type=account.type,
            currency=account.currency,
            initial_balance_minor=account.initial_balance_minor,
            balance_minor=balance_minor,
            is_demo=account.is_demo,
            archived_at=account.archived_at,
            created_at=account.created_at,
            updated_at=account.updated_at,
        )


class AccountPage(BaseModel):
    items: list[AccountOut]
    next_cursor: str | None


async def _get_or_404(svc: AccountService, workspace_id: uuid.UUID, account_id: uuid.UUID) -> Account:
    account = await svc.get(workspace_id, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="ACCOUNT_NOT_FOUND")
    return account


@router.post("", status_code=201)
async def create_account(
    body: AccountIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> AccountOut:
    svc = AccountService(db)
    account = await svc.create(
        wsctx.workspace_id,
        name=body.name,
        type=body.type.value,
        currency=body.currency,
        initial_balance_minor=body.initial_balance_minor,
    )
    await db.commit()
    return AccountOut.from_model(account, await svc.balance(account))


@router.get("")
async def list_accounts(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    include_archived: bool = False,
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> AccountPage:
    svc = AccountService(db)
    items, next_cursor = await svc.list(
        wsctx.workspace_id, include_archived=include_archived, cursor=cursor, limit=limit
    )
    return AccountPage(
        items=[AccountOut.from_model(a, await svc.balance(a)) for a in items], next_cursor=next_cursor
    )


@router.get("/{account_id}")
async def get_account(
    account_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> AccountOut:
    svc = AccountService(db)
    account = await _get_or_404(svc, wsctx.workspace_id, account_id)
    return AccountOut.from_model(account, await svc.balance(account))


@router.patch("/{account_id}")
async def update_account(
    account_id: uuid.UUID,
    body: AccountUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> AccountOut:
    svc = AccountService(db)
    account = await _get_or_404(svc, wsctx.workspace_id, account_id)
    fields = body.model_dump(exclude_unset=True)
    try:
        account = await svc.update(
            account,
            name=fields.get("name"),
            type=fields["type"].value if fields.get("type") is not None else None,
            currency=fields.get("currency"),
        )
    except AccountCurrencyChangeError:
        raise HTTPException(status_code=409, detail="ACCOUNT_HAS_TRANSACTIONS") from None
    await db.commit()
    return AccountOut.from_model(account, await svc.balance(account))


@router.post("/{account_id}/archive", status_code=204)
async def archive_account(
    account_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = AccountService(db)
    account = await _get_or_404(svc, wsctx.workspace_id, account_id)
    await svc.archive(account)
    await db.commit()
