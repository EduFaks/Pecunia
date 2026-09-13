from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.account import Account
from pecunia.models.transaction import Transaction
from pecunia.models.transfer import Transfer
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select


class AccountNotFoundError(Exception):
    """Raised when a transfer references an account that doesn't exist in the
    caller's workspace. The router maps this to 404."""


class SameAccountError(Exception):
    """Raised when from_account_id == to_account_id — a transfer moves money
    between two *different* accounts. The router maps this to 422."""


class CurrencyMismatchError(Exception):
    """Raised when either account's currency differs from the transfer's
    currency (V1 has no FX — a transfer is same-currency only). The router
    maps this to 422."""


class NonPositiveAmountError(Exception):
    """Raised when amount_minor <= 0 — a transfer's amount is a positive
    magnitude in the shared currency. The router maps this to 422."""


class TransferService:
    """Transfer business logic. A transfer is the first-class object; each
    create/update keeps its two transaction legs in sync (a -amount leg on the
    source account, a +amount leg on the destination). Contract: methods flush,
    never commit — the caller (router) owns the transaction boundary
    (CONVENTIONS §2)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def _validate(
        self,
        workspace_id: uuid.UUID,
        from_account_id: uuid.UUID,
        to_account_id: uuid.UUID,
        amount_minor: int,
        currency: str,
    ) -> None:
        from_account = await get_scoped(self.db, Account, from_account_id, workspace_id)
        if from_account is None:
            raise AccountNotFoundError()
        to_account = await get_scoped(self.db, Account, to_account_id, workspace_id)
        if to_account is None:
            raise AccountNotFoundError()
        if from_account_id == to_account_id:
            raise SameAccountError()
        if from_account.currency != currency or to_account.currency != currency:
            raise CurrencyMismatchError()
        if amount_minor <= 0:
            raise NonPositiveAmountError()

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        from_account_id: uuid.UUID,
        to_account_id: uuid.UUID,
        amount_minor: int,
        currency: str,
        description: str,
        occurred_on: date,
    ) -> Transfer:
        await self._validate(workspace_id, from_account_id, to_account_id, amount_minor, currency)
        transfer = Transfer(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            from_account_id=from_account_id,
            to_account_id=to_account_id,
            amount_minor=amount_minor,
            currency=currency,
            description=description,
            occurred_on=occurred_on,
        )
        self.db.add(transfer)
        # Flush to get transfer.id before creating the legs that reference it.
        await self.db.flush()
        # Two ordinary transaction legs, each carrying transfer_id: -amount on
        # the source, +amount on the destination. No category/contact/project —
        # legs relocate money, they don't earn or spend it (Track E excludes
        # transfer_id-set rows from income/spend).
        self.db.add_all(
            [
                Transaction(
                    id=uuid.uuid4(),
                    workspace_id=workspace_id,
                    account_id=from_account_id,
                    transfer_id=transfer.id,
                    amount_minor=-amount_minor,
                    currency=currency,
                    description=description,
                    occurred_on=occurred_on,
                ),
                Transaction(
                    id=uuid.uuid4(),
                    workspace_id=workspace_id,
                    account_id=to_account_id,
                    transfer_id=transfer.id,
                    amount_minor=amount_minor,
                    currency=currency,
                    description=description,
                    occurred_on=occurred_on,
                ),
            ]
        )
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.TRANSFER_CREATED,
                resource_type="transfer",
                resource_id=str(transfer.id),
                workspace_id=workspace_id,
                after=project("transfer", transfer),
                activity_template=Activity.TRANSFER_CREATED,
                activity_params={
                    "description": transfer.description,
                    "amount_minor": transfer.amount_minor,
                    "currency": transfer.currency,
                },
            ),
        )
        return transfer

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[Transfer], str | None]:
        # UUID primary keys carry no order — paginate newest-first on
        # created_at, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = scoped_select(Transfer, workspace_id).order_by(
            Transfer.created_at.desc(), Transfer.id.desc()
        )
        return await keyset_page(
            self.db,
            stmt,
            Transfer.created_at,
            Transfer.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(self, workspace_id: uuid.UUID, transfer_id: uuid.UUID) -> Transfer | None:
        return await get_scoped(self.db, Transfer, transfer_id, workspace_id)

    async def legs(self, transfer: Transfer) -> list[Transaction]:
        """The transfer's two leg transactions, ordered from-leg then to-leg."""
        rows = (
            (await self.db.execute(select(Transaction).where(Transaction.transfer_id == transfer.id)))
            .scalars()
            .all()
        )
        by_account = {row.account_id: row for row in rows}
        return [by_account[transfer.from_account_id], by_account[transfer.to_account_id]]

    async def update(
        self,
        transfer: Transfer,
        *,
        amount_minor: int | None = None,
        description: str | None = None,
        occurred_on: date | None = None,
        from_account_id: uuid.UUID | None = None,
        to_account_id: uuid.UUID | None = None,
    ) -> Transfer:
        target_from = from_account_id if from_account_id is not None else transfer.from_account_id
        target_to = to_account_id if to_account_id is not None else transfer.to_account_id
        target_amount = amount_minor if amount_minor is not None else transfer.amount_minor
        # Re-validate BEFORE mutating anything (currency is fixed — V1 has no FX,
        # so both accounts must still match the transfer's existing currency).
        await self._validate(
            transfer.workspace_id, target_from, target_to, target_amount, transfer.currency
        )
        before = project("transfer", transfer)
        # Capture the legs by their CURRENT accounts before re-pointing.
        from_leg, to_leg = await self.legs(transfer)
        transfer.from_account_id = target_from
        transfer.to_account_id = target_to
        transfer.amount_minor = target_amount
        if description is not None:
            transfer.description = description
        if occurred_on is not None:
            transfer.occurred_on = occurred_on
        transfer.updated_at = datetime.now(UTC)
        # Re-sync both legs: re-point account_id (if the accounts changed) and
        # re-sign the amount (-amount on the source, +amount on the destination).
        for leg, account_id, signed in (
            (from_leg, target_from, -target_amount),
            (to_leg, target_to, target_amount),
        ):
            leg.account_id = account_id
            leg.amount_minor = signed
            leg.currency = transfer.currency
            if description is not None:
                leg.description = description
            if occurred_on is not None:
                leg.occurred_on = occurred_on
            leg.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.TRANSFER_UPDATED,
                resource_type="transfer",
                resource_id=str(transfer.id),
                workspace_id=transfer.workspace_id,
                before=before,
                after=project("transfer", transfer),
            ),
        )
        return transfer

    async def delete(self, transfer: Transfer) -> None:
        """Hard delete — the transactions.transfer_id FK ondelete=CASCADE removes
        both legs, so deleting the transfer reverts both account balances."""
        workspace_id = transfer.workspace_id
        transfer_id = transfer.id
        before = project("transfer", transfer)
        await self.db.delete(transfer)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.TRANSFER_DELETED,
                resource_type="transfer",
                resource_id=str(transfer_id),
                workspace_id=workspace_id,
                before=before,
            ),
        )
