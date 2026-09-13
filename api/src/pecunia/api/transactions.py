import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.api.loans import LoanPaymentOut
from pecunia.db import get_db
from pecunia.models.transaction import Transaction
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.loans import (
    LoanPaymentCurrencyMismatchError,
    LoanService,
    NonPositivePaymentError,
    TransactionAlreadyLinkedError,
    TransactionIsTransferLegError,
)
from pecunia.services.transactions import (
    UNSET,
    AccountNotFoundError,
    CategoryNotFoundError,
    ContactNotFoundError,
    CurrencyMismatchError,
    ManagedByTransferError,
    ProjectNotFoundError,
    TransactionService,
)

router = APIRouter(prefix="/transactions", tags=["transactions"], dependencies=[Depends(require_initialized)])

# `from`/`to` date aliases mirror the analytics/contacts routes (`from` is a
# Python keyword, so it can't be a parameter name directly).
FromDate = Annotated[date | None, Query(alias="from")]
ToDate = Annotated[date | None, Query(alias="to")]


class TransactionIn(BaseModel):
    account_id: uuid.UUID
    category_id: uuid.UUID | None = None
    contact_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    amount_minor: MinorInt
    currency: CurrencyStr
    description: str = Field(min_length=1, max_length=500)
    occurred_on: date


class TransactionUpdate(BaseModel):
    account_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    contact_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    amount_minor: MinorInt | None = None
    currency: CurrencyStr | None = None
    description: str | None = Field(default=None, min_length=1, max_length=500)
    occurred_on: date | None = None


class TransactionOut(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    category_id: uuid.UUID | None
    contact_id: uuid.UUID | None
    project_id: uuid.UUID | None
    transfer_id: uuid.UUID | None
    amount_minor: int
    currency: str
    description: str
    occurred_on: date
    is_demo: bool
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, transaction: Transaction) -> "TransactionOut":
        return cls(
            id=transaction.id,
            account_id=transaction.account_id,
            category_id=transaction.category_id,
            contact_id=transaction.contact_id,
            project_id=transaction.project_id,
            transfer_id=transaction.transfer_id,
            amount_minor=transaction.amount_minor,
            currency=transaction.currency,
            description=transaction.description,
            occurred_on=transaction.occurred_on,
            is_demo=transaction.is_demo,
            deleted_at=transaction.deleted_at,
            created_at=transaction.created_at,
            updated_at=transaction.updated_at,
        )


class TransactionPage(BaseModel):
    items: list[TransactionOut]
    next_cursor: str | None


class ApplyToLoanIn(BaseModel):
    loan_id: uuid.UUID


async def _get_or_404(
    svc: TransactionService, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> Transaction:
    transaction = await svc.get(workspace_id, transaction_id)
    if transaction is None:
        raise HTTPException(status_code=404, detail="TRANSACTION_NOT_FOUND")
    return transaction


@router.post("", status_code=201)
async def create_transaction(
    body: TransactionIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> TransactionOut:
    svc = TransactionService(db)
    try:
        transaction = await svc.create(
            wsctx.workspace_id,
            account_id=body.account_id,
            category_id=body.category_id,
            contact_id=body.contact_id,
            project_id=body.project_id,
            amount_minor=body.amount_minor,
            currency=body.currency,
            description=body.description,
            occurred_on=body.occurred_on,
        )
    except AccountNotFoundError:
        raise HTTPException(status_code=404, detail="ACCOUNT_NOT_FOUND") from None
    except CategoryNotFoundError:
        raise HTTPException(status_code=404, detail="CATEGORY_NOT_FOUND") from None
    except ContactNotFoundError:
        raise HTTPException(status_code=404, detail="CONTACT_NOT_FOUND") from None
    except ProjectNotFoundError:
        raise HTTPException(status_code=404, detail="PROJECT_NOT_FOUND") from None
    except CurrencyMismatchError:
        raise HTTPException(status_code=422, detail="CURRENCY_MISMATCH") from None
    await db.commit()
    return TransactionOut.from_model(transaction)


@router.get("")
async def list_transactions(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    account_id: uuid.UUID | None = None,
    category_id: uuid.UUID | None = None,
    contact_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    q: Annotated[str | None, Query()] = None,
    date_from: FromDate = None,
    date_to: ToDate = None,
    min_amount_minor: Annotated[int | None, Query()] = None,
    max_amount_minor: Annotated[int | None, Query()] = None,
    type: Annotated[Literal["income", "expense", "transfer"] | None, Query()] = None,
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> TransactionPage:
    svc = TransactionService(db)
    items, next_cursor = await svc.list(
        wsctx.workspace_id,
        account_id=account_id,
        category_id=category_id,
        contact_id=contact_id,
        project_id=project_id,
        q=q,
        date_from=date_from,
        date_to=date_to,
        min_amount_minor=min_amount_minor,
        max_amount_minor=max_amount_minor,
        type=type,
        cursor=cursor,
        limit=limit,
    )
    return TransactionPage(
        items=[TransactionOut.from_model(t) for t in items], next_cursor=next_cursor
    )


@router.get("/{transaction_id}")
async def get_transaction(
    transaction_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> TransactionOut:
    svc = TransactionService(db)
    transaction = await _get_or_404(svc, wsctx.workspace_id, transaction_id)
    return TransactionOut.from_model(transaction)


@router.patch("/{transaction_id}")
async def update_transaction(
    transaction_id: uuid.UUID,
    body: TransactionUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> TransactionOut:
    svc = TransactionService(db)
    transaction = await _get_or_404(svc, wsctx.workspace_id, transaction_id)
    fields = body.model_dump(exclude_unset=True)
    try:
        transaction = await svc.update(
            transaction,
            account_id=fields.get("account_id"),
            category_id=fields.get("category_id", UNSET),
            contact_id=fields.get("contact_id", UNSET),
            project_id=fields.get("project_id", UNSET),
            amount_minor=fields.get("amount_minor"),
            currency=fields.get("currency"),
            description=fields.get("description"),
            occurred_on=fields.get("occurred_on"),
        )
    except ManagedByTransferError:
        raise HTTPException(status_code=409, detail="MANAGED_BY_TRANSFER") from None
    except AccountNotFoundError:
        raise HTTPException(status_code=404, detail="ACCOUNT_NOT_FOUND") from None
    except CategoryNotFoundError:
        raise HTTPException(status_code=404, detail="CATEGORY_NOT_FOUND") from None
    except ContactNotFoundError:
        raise HTTPException(status_code=404, detail="CONTACT_NOT_FOUND") from None
    except ProjectNotFoundError:
        raise HTTPException(status_code=404, detail="PROJECT_NOT_FOUND") from None
    except CurrencyMismatchError:
        raise HTTPException(status_code=422, detail="CURRENCY_MISMATCH") from None
    await db.commit()
    return TransactionOut.from_model(transaction)


@router.delete("/{transaction_id}", status_code=204)
async def delete_transaction(
    transaction_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = TransactionService(db)
    transaction = await _get_or_404(svc, wsctx.workspace_id, transaction_id)
    try:
        await svc.soft_delete(transaction)
    except ManagedByTransferError:
        raise HTTPException(status_code=409, detail="MANAGED_BY_TRANSFER") from None
    await db.commit()


@router.post("/{transaction_id}/restore", status_code=204)
async def restore_transaction(
    transaction_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = TransactionService(db)
    transaction = await _get_or_404(svc, wsctx.workspace_id, transaction_id)
    await svc.restore(transaction)
    await db.commit()


@router.post("/{transaction_id}/apply-to-loan", status_code=201)
async def apply_to_loan(
    transaction_id: uuid.UUID,
    body: ApplyToLoanIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> LoanPaymentOut:
    """Apply a transaction to a loan: create a loan payment funded by this
    transaction, deriving the amount from the transaction's magnitude and the
    date from its occurred_on so they always match the tx. One backend path —
    it calls the same record_payment linking logic as the loan-side attach."""
    tx_svc = TransactionService(db)
    transaction = await _get_or_404(tx_svc, wsctx.workspace_id, transaction_id)
    loan_svc = LoanService(db)
    loan = await loan_svc.get(wsctx.workspace_id, body.loan_id)
    if loan is None:
        raise HTTPException(status_code=404, detail="LOAN_NOT_FOUND")
    try:
        payment = await loan_svc.record_payment(
            loan,
            amount_minor=abs(transaction.amount_minor),
            paid_on=transaction.occurred_on,
            transaction_id=transaction.id,
        )
    except NonPositivePaymentError:
        raise HTTPException(status_code=422, detail="LOAN_PAYMENT_NONPOSITIVE") from None
    except TransactionIsTransferLegError:
        raise HTTPException(status_code=422, detail="TRANSACTION_IS_TRANSFER_LEG") from None
    except LoanPaymentCurrencyMismatchError:
        raise HTTPException(status_code=422, detail="LOAN_PAYMENT_CURRENCY_MISMATCH") from None
    except TransactionAlreadyLinkedError:
        raise HTTPException(status_code=409, detail="TRANSACTION_ALREADY_LINKED") from None
    await db.commit()
    return LoanPaymentOut.from_model(payment)
