import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.loan import Loan, LoanDirection, LoanPayment
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.loans import (
    UNSET,
    LoanPaymentCurrencyMismatchError,
    LoanService,
    NonPositivePaymentError,
    TransactionAlreadyLinkedError,
    TransactionIsTransferLegError,
    TransactionNotFoundError,
)

router = APIRouter(
    prefix="/loans", tags=["loans"], dependencies=[Depends(require_initialized)]
)

PaymentFrequency = Literal["weekly", "monthly", "quarterly", "yearly"]


class LoanIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    direction: LoanDirection = LoanDirection.BORROWED
    principal_minor: MinorInt
    currency: CurrencyStr
    interest_rate_bps: int | None = Field(default=None, ge=0)
    planned_payment_minor: MinorInt | None = None
    payment_frequency: PaymentFrequency | None = None
    next_due: date | None = None
    opened_on: date | None = None
    description: str | None = None


class LoanUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    direction: LoanDirection | None = None
    principal_minor: MinorInt | None = None
    currency: CurrencyStr | None = None
    interest_rate_bps: int | None = Field(default=None, ge=0)
    planned_payment_minor: MinorInt | None = None
    payment_frequency: PaymentFrequency | None = None
    next_due: date | None = None
    opened_on: date | None = None
    description: str | None = None


class LoanOut(BaseModel):
    id: uuid.UUID
    name: str
    direction: str
    principal_minor: int
    currency: str
    interest_rate_bps: int | None
    planned_payment_minor: int | None
    payment_frequency: str | None
    next_due: date | None
    opened_on: date | None
    description: str | None
    is_demo: bool
    created_at: datetime
    paid_total_minor: int
    remaining_minor: int

    @classmethod
    def from_model(
        cls, loan: Loan, *, paid_total_minor: int, remaining_minor: int
    ) -> "LoanOut":
        return cls(
            id=loan.id,
            name=loan.name,
            direction=loan.direction,
            principal_minor=loan.principal_minor,
            currency=loan.currency,
            interest_rate_bps=loan.interest_rate_bps,
            planned_payment_minor=loan.planned_payment_minor,
            payment_frequency=loan.payment_frequency,
            next_due=loan.next_due,
            opened_on=loan.opened_on,
            description=loan.description,
            is_demo=loan.is_demo,
            created_at=loan.created_at,
            paid_total_minor=paid_total_minor,
            remaining_minor=remaining_minor,
        )


class LoanPage(BaseModel):
    items: list[LoanOut]
    next_cursor: str | None


class LoanPaymentIn(BaseModel):
    amount_minor: MinorInt
    paid_on: date
    note: str | None = None
    transaction_id: uuid.UUID | None = None


class LoanPaymentUpdate(BaseModel):
    amount_minor: MinorInt | None = None
    paid_on: date | None = None
    note: str | None = None
    transaction_id: uuid.UUID | None = None


class LoanPaymentOut(BaseModel):
    id: uuid.UUID
    loan_id: uuid.UUID
    transaction_id: uuid.UUID | None
    amount_minor: int
    paid_on: date
    note: str | None
    is_demo: bool
    created_at: datetime

    @classmethod
    def from_model(cls, payment: LoanPayment) -> "LoanPaymentOut":
        return cls(
            id=payment.id,
            loan_id=payment.loan_id,
            transaction_id=payment.transaction_id,
            amount_minor=payment.amount_minor,
            paid_on=payment.paid_on,
            note=payment.note,
            is_demo=payment.is_demo,
            created_at=payment.created_at,
        )


class LoanPaymentPage(BaseModel):
    items: list[LoanPaymentOut]
    next_cursor: str | None


async def _get_or_404(
    svc: LoanService, workspace_id: uuid.UUID, loan_id: uuid.UUID
) -> Loan:
    loan = await svc.get(workspace_id, loan_id)
    if loan is None:
        raise HTTPException(status_code=404, detail="LOAN_NOT_FOUND")
    return loan


async def _get_payment_or_404(
    svc: LoanService, workspace_id: uuid.UUID, loan_id: uuid.UUID, payment_id: uuid.UUID
) -> LoanPayment:
    payment = await svc.get_payment(workspace_id, payment_id)
    if payment is None or payment.loan_id != loan_id:
        raise HTTPException(status_code=404, detail="LOAN_PAYMENT_NOT_FOUND")
    return payment


async def _loan_out(svc: LoanService, loan: Loan) -> LoanOut:
    return LoanOut.from_model(
        loan,
        paid_total_minor=await svc.paid_total_minor(loan),
        remaining_minor=await svc.remaining_minor(loan),
    )


# ---- Loan CRUD ------------------------------------------------------------ #


@router.post("", status_code=201)
async def create_loan(
    body: LoanIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> LoanOut:
    svc = LoanService(db)
    loan = await svc.create(
        wsctx.workspace_id,
        name=body.name,
        direction=body.direction,
        principal_minor=body.principal_minor,
        currency=body.currency,
        interest_rate_bps=body.interest_rate_bps,
        planned_payment_minor=body.planned_payment_minor,
        payment_frequency=body.payment_frequency,
        next_due=body.next_due,
        opened_on=body.opened_on,
        description=body.description,
    )
    await db.commit()
    return await _loan_out(svc, loan)


@router.get("")
async def list_loans(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> LoanPage:
    svc = LoanService(db)
    items, next_cursor = await svc.list(wsctx.workspace_id, cursor=cursor, limit=limit)
    return LoanPage(
        items=[await _loan_out(svc, loan) for loan in items], next_cursor=next_cursor
    )


@router.get("/{loan_id}")
async def get_loan(
    loan_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> LoanOut:
    svc = LoanService(db)
    loan = await _get_or_404(svc, wsctx.workspace_id, loan_id)
    return await _loan_out(svc, loan)


@router.patch("/{loan_id}")
async def update_loan(
    loan_id: uuid.UUID,
    body: LoanUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> LoanOut:
    svc = LoanService(db)
    loan = await _get_or_404(svc, wsctx.workspace_id, loan_id)
    fields = body.model_dump(exclude_unset=True)
    loan = await svc.update(
        loan,
        name=fields.get("name"),
        direction=fields.get("direction"),
        principal_minor=fields.get("principal_minor"),
        currency=fields.get("currency"),
        interest_rate_bps=fields.get("interest_rate_bps", UNSET),
        planned_payment_minor=fields.get("planned_payment_minor", UNSET),
        payment_frequency=fields.get("payment_frequency", UNSET),
        next_due=fields.get("next_due", UNSET),
        opened_on=fields.get("opened_on", UNSET),
        description=fields.get("description", UNSET),
    )
    await db.commit()
    return await _loan_out(svc, loan)


@router.delete("/{loan_id}", status_code=204)
async def delete_loan(
    loan_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = LoanService(db)
    loan = await _get_or_404(svc, wsctx.workspace_id, loan_id)
    await svc.delete(loan)
    await db.commit()


# ---- Payments (nested) ---------------------------------------------------- #


@router.post("/{loan_id}/payments", status_code=201)
async def record_payment(
    loan_id: uuid.UUID,
    body: LoanPaymentIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> LoanPaymentOut:
    svc = LoanService(db)
    loan = await _get_or_404(svc, wsctx.workspace_id, loan_id)
    try:
        payment = await svc.record_payment(
            loan,
            amount_minor=body.amount_minor,
            paid_on=body.paid_on,
            note=body.note,
            transaction_id=body.transaction_id,
        )
    except NonPositivePaymentError:
        raise HTTPException(status_code=422, detail="LOAN_PAYMENT_NONPOSITIVE") from None
    except TransactionNotFoundError:
        raise HTTPException(status_code=404, detail="TRANSACTION_NOT_FOUND") from None
    except TransactionIsTransferLegError:
        raise HTTPException(status_code=422, detail="TRANSACTION_IS_TRANSFER_LEG") from None
    except LoanPaymentCurrencyMismatchError:
        raise HTTPException(status_code=422, detail="LOAN_PAYMENT_CURRENCY_MISMATCH") from None
    except TransactionAlreadyLinkedError:
        raise HTTPException(status_code=409, detail="TRANSACTION_ALREADY_LINKED") from None
    await db.commit()
    return LoanPaymentOut.from_model(payment)


@router.get("/{loan_id}/payments")
async def list_payments(
    loan_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> LoanPaymentPage:
    svc = LoanService(db)
    loan = await _get_or_404(svc, wsctx.workspace_id, loan_id)
    items, next_cursor = await svc.list_payments(loan, cursor=cursor, limit=limit)
    return LoanPaymentPage(
        items=[LoanPaymentOut.from_model(p) for p in items], next_cursor=next_cursor
    )


@router.patch("/{loan_id}/payments/{payment_id}")
async def update_payment(
    loan_id: uuid.UUID,
    payment_id: uuid.UUID,
    body: LoanPaymentUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> LoanPaymentOut:
    svc = LoanService(db)
    await _get_or_404(svc, wsctx.workspace_id, loan_id)
    payment = await _get_payment_or_404(svc, wsctx.workspace_id, loan_id, payment_id)
    fields = body.model_dump(exclude_unset=True)
    try:
        payment = await svc.update_payment(
            payment,
            amount_minor=fields.get("amount_minor"),
            paid_on=fields.get("paid_on"),
            note=fields.get("note", UNSET),
            transaction_id=fields.get("transaction_id", UNSET),
        )
    except NonPositivePaymentError:
        raise HTTPException(status_code=422, detail="LOAN_PAYMENT_NONPOSITIVE") from None
    except TransactionNotFoundError:
        raise HTTPException(status_code=404, detail="TRANSACTION_NOT_FOUND") from None
    except TransactionIsTransferLegError:
        raise HTTPException(status_code=422, detail="TRANSACTION_IS_TRANSFER_LEG") from None
    except LoanPaymentCurrencyMismatchError:
        raise HTTPException(status_code=422, detail="LOAN_PAYMENT_CURRENCY_MISMATCH") from None
    except TransactionAlreadyLinkedError:
        raise HTTPException(status_code=409, detail="TRANSACTION_ALREADY_LINKED") from None
    await db.commit()
    return LoanPaymentOut.from_model(payment)


@router.delete("/{loan_id}/payments/{payment_id}", status_code=204)
async def delete_payment(
    loan_id: uuid.UUID,
    payment_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = LoanService(db)
    await _get_or_404(svc, wsctx.workspace_id, loan_id)
    payment = await _get_payment_or_404(svc, wsctx.workspace_id, loan_id, payment_id)
    await svc.delete_payment(payment)
    await db.commit()
