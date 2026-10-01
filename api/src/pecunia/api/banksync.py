"""`/api/v1/bank-sync` router (Task 5, Track T): discovery of the workspace's
Pluggy connections, linking a discovered account to a Pecunia account (or
creating one), on-demand sync, reconciliation, and the Pluggy-category ->
Pecunia-category mapping table. All business logic lives in
`BankSyncService` (Task 4) — this module is schemas + HTTP wiring + the typed
exception -> HTTPException mapping.

`discover`/`list_connections` return plain dicts shaped for direct
`Model(**dict)` construction; a handful of dict keys the service also carries
(`pluggy_item_id`, `connection_id`, card fields on a discovered account) have
no field on the corresponding Out schema below — pydantic's default
`extra="ignore"` on construction drops them silently, which is fine, they're
just not part of this contract."""

import logging
import uuid
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.api.transactions import TransactionOut
from pecunia.config import get_settings
from pecunia.db import get_db
from pecunia.period import next_due_on_or_after
from pecunia.services.banksync.provider import (
    BankItemNotFoundError,
    BankProvider,
    BankProviderError,
    PluggyProvider,
)
from pecunia.services.banksync.sync import (
    AccountAlreadyLinkedError,
    BankSyncService,
    ConnectionNotFoundError,
    LinkNotFoundError,
    PluggyAccountAlreadyLinkedError,
    PluggyAccountNotFoundError,
)
from pecunia.services.transactions import (
    AccountNotFoundError,
    CategoryNotFoundError,
    CurrencyMismatchError,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/bank-sync", tags=["bank-sync"], dependencies=[Depends(require_initialized)]
)


def get_bank_provider(request: Request) -> BankProvider:
    """One `PluggyProvider` per app instance, lazily created and cached on
    `app.state` (mirrors `portfolios.get_price_provider`). Missing
    credentials (the common case until Task 6 wires real config) surface as a
    503 here rather than failing deep inside an httpx call. Tests override
    this dependency with a `FakeBankProvider`."""
    settings = get_settings()
    if not settings.pluggy_client_id or not settings.pluggy_client_secret:
        raise HTTPException(status_code=503, detail="BANK_PROVIDER_UNAVAILABLE")
    provider = getattr(request.app.state, "bank_provider", None)
    if provider is None:
        provider = PluggyProvider(settings.pluggy_client_id, settings.pluggy_client_secret)
        request.app.state.bank_provider = provider
    return provider


class _NoProvider:
    """Placeholder passed to `BankSyncService` on routes that never touch
    `self.provider` (list/delete/reconcile/mappings) — those routes work
    offline and must not be gated behind `get_bank_provider`'s credential
    check. Every method raises if it's ever actually called, which would
    mean one of those service methods started calling the provider without
    this module being updated to match."""

    async def fetch_connection(self, item_id: str):
        raise NotImplementedError("this route's service methods must never call the provider")

    async def fetch_accounts(self, item_id: str):
        raise NotImplementedError("this route's service methods must never call the provider")

    async def fetch_transactions(self, pluggy_account_id: str, *, from_date: date):
        raise NotImplementedError("this route's service methods must never call the provider")


_NO_PROVIDER = _NoProvider()


# ---- Schemas ---------------------------------------------------------------- #


class BankLinkOut(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    account_name: str | None
    account_currency: str | None
    pluggy_account_id: str
    sync_from: date
    provider_balance_minor: int | None
    provider_balance_as_of: datetime | None
    derived_balance_minor: int | None
    credit_limit_minor: int | None
    bill_close_date: date | None
    bill_due_date: date | None
    next_bill_due_date: date | None


class BankConnectionOut(BaseModel):
    id: uuid.UUID
    institution_name: str
    status: str
    last_error: str | None
    last_synced_at: datetime | None
    links: list[BankLinkOut]


class DiscoveredAccountOut(BaseModel):
    pluggy_account_id: str
    type: str
    subtype: str
    name: str
    number: str | None
    balance_minor: int
    currency: str
    linked_account_id: uuid.UUID | None


class DiscoveredConnectionOut(BaseModel):
    item_id: str
    institution_name: str
    status: str
    accounts: list[DiscoveredAccountOut]


class NewAccountIn(BaseModel):
    name: str | None = None


class LinkIn(BaseModel):
    pluggy_item_id: str
    pluggy_account_id: str
    sync_from: date
    account_id: uuid.UUID | None = None
    new_account: NewAccountIn | None = None

    @model_validator(mode="after")
    def _exactly_one_target(self) -> "LinkIn":
        if (self.account_id is None) == (self.new_account is None):
            raise ValueError(
                "exactly one of account_id or new_account must be set"
            )
        return self


class SyncSummaryOut(BaseModel):
    connections: int
    created: int
    skipped: int
    errors: list[str]


class CategoryMappingIn(BaseModel):
    pluggy_category: str
    category_id: uuid.UUID


class CategoryMappingOut(BaseModel):
    pluggy_category: str
    category_id: uuid.UUID


class MappingsIn(BaseModel):
    mappings: list[CategoryMappingIn]


def _roll_bill_due_dates(connections: list[dict]) -> list[dict]:
    """Router-level roll (finding: `list_connections` itself stays
    clock-free). Pluggy reports a credit card's `bill_due_date` as the last
    CLOSED bill's due date — always a past date — so each link dict gets a
    `next_bill_due_date` rolled forward to its next on-or-after-today
    occurrence, `None` when the link has no `bill_due_date` at all."""
    today = datetime.now(UTC).date()
    for connection in connections:
        for link in connection["links"]:
            link["next_bill_due_date"] = (
                next_due_on_or_after(link["bill_due_date"], today)
                if link["bill_due_date"]
                else None
            )
    return connections


async def _connection_out(
    svc: BankSyncService, workspace_id: uuid.UUID, connection_id: uuid.UUID
) -> BankConnectionOut:
    connections = _roll_bill_due_dates(await svc.list_connections(workspace_id))
    connection = next(c for c in connections if c["id"] == connection_id)
    return BankConnectionOut(**connection)


# ---- Discovery / connections ------------------------------------------------ #


@router.get("/discovery")
async def get_discovery(
    item_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    provider: Annotated[BankProvider, Depends(get_bank_provider)],
) -> DiscoveredConnectionOut:
    """Meu Pluggy's free tier has no client-wide item listing (403
    LIST_ITEMS_FEATURE_NOT_ENABLED) — discovery is by item id, one item at a
    time; the caller supplies the id they copied from the Pluggy dashboard."""
    svc = BankSyncService(db, provider)
    try:
        result = await svc.discover_item(wsctx.workspace_id, item_id)
    except BankItemNotFoundError:
        raise HTTPException(status_code=404, detail="PLUGGY_ITEM_NOT_FOUND") from None
    except BankProviderError as exc:
        logger.warning("Bank provider unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="BANK_PROVIDER_UNAVAILABLE") from None
    return DiscoveredConnectionOut(**result)


@router.get("/connections")
async def list_bank_connections(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> list[BankConnectionOut]:
    svc = BankSyncService(db, _NO_PROVIDER)
    connections = _roll_bill_due_dates(await svc.list_connections(wsctx.workspace_id))
    return [BankConnectionOut(**c) for c in connections]


@router.delete("/connections/{connection_id}", status_code=204)
async def delete_bank_connection(
    connection_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = BankSyncService(db, _NO_PROVIDER)
    try:
        await svc.delete_connection(wsctx.workspace_id, connection_id)
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="CONNECTION_NOT_FOUND") from None
    await db.commit()


# ---- Links ------------------------------------------------------------------- #


@router.post("/links", status_code=201)
async def create_link(
    body: LinkIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    provider: Annotated[BankProvider, Depends(get_bank_provider)],
) -> BankConnectionOut:
    svc = BankSyncService(db, provider)
    try:
        link = await svc.link_account(
            wsctx.workspace_id,
            pluggy_item_id=body.pluggy_item_id,
            pluggy_account_id=body.pluggy_account_id,
            sync_from=body.sync_from,
            today=datetime.now(UTC).date(),
            account_id=body.account_id,
            new_account_name=body.new_account.name if body.new_account else None,
        )
    except PluggyAccountNotFoundError:
        raise HTTPException(status_code=404, detail="PLUGGY_ACCOUNT_NOT_FOUND") from None
    except AccountNotFoundError:
        raise HTTPException(status_code=404, detail="ACCOUNT_NOT_FOUND") from None
    except AccountAlreadyLinkedError:
        raise HTTPException(status_code=409, detail="ACCOUNT_ALREADY_LINKED") from None
    except PluggyAccountAlreadyLinkedError:
        raise HTTPException(status_code=409, detail="PLUGGY_ACCOUNT_ALREADY_LINKED") from None
    except CurrencyMismatchError:
        raise HTTPException(status_code=422, detail="CURRENCY_MISMATCH") from None
    except BankProviderError as exc:
        logger.warning("Bank provider unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="BANK_PROVIDER_UNAVAILABLE") from None
    result = await _connection_out(svc, wsctx.workspace_id, link.connection_id)
    await db.commit()
    return result


@router.delete("/links/{link_id}", status_code=204)
async def delete_link(
    link_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = BankSyncService(db, _NO_PROVIDER)
    try:
        await svc.unlink(wsctx.workspace_id, link_id)
    except LinkNotFoundError:
        raise HTTPException(status_code=404, detail="LINK_NOT_FOUND") from None
    await db.commit()


@router.post("/links/{link_id}/reconcile")
async def reconcile_link(
    link_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> TransactionOut:
    svc = BankSyncService(db, _NO_PROVIDER)
    try:
        transaction = await svc.reconcile(
            wsctx.workspace_id, link_id, today=datetime.now(UTC).date()
        )
    except LinkNotFoundError:
        raise HTTPException(status_code=404, detail="LINK_NOT_FOUND") from None
    await db.commit()
    if transaction is None:
        # Gap was already zero — nothing was posted, nothing to return.
        return Response(status_code=204)
    return TransactionOut.from_model(transaction)


# ---- Sync --------------------------------------------------------------------- #


@router.post("/sync")
async def sync_workspace(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    provider: Annotated[BankProvider, Depends(get_bank_provider)],
) -> SyncSummaryOut:
    svc = BankSyncService(db, provider)
    try:
        result = await svc.sync_workspace(wsctx.workspace_id, today=datetime.now(UTC).date())
    except BankProviderError as exc:
        logger.warning("Bank provider unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="BANK_PROVIDER_UNAVAILABLE") from None
    await db.commit()
    return SyncSummaryOut(**result)


# ---- Category mappings --------------------------------------------------------- #


@router.get("/category-mappings")
async def list_category_mappings(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> list[CategoryMappingOut]:
    svc = BankSyncService(db, _NO_PROVIDER)
    mappings = await svc.list_mappings(wsctx.workspace_id)
    return [
        CategoryMappingOut(pluggy_category=m.pluggy_category, category_id=m.category_id)
        for m in mappings
    ]


@router.put("/category-mappings")
async def replace_category_mappings(
    body: MappingsIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> list[CategoryMappingOut]:
    svc = BankSyncService(db, _NO_PROVIDER)
    try:
        mappings = await svc.replace_mappings(
            wsctx.workspace_id, [(m.pluggy_category, m.category_id) for m in body.mappings]
        )
    except CategoryNotFoundError:
        raise HTTPException(status_code=404, detail="CATEGORY_NOT_FOUND") from None
    await db.commit()
    return [
        CategoryMappingOut(pluggy_category=m.pluggy_category, category_id=m.category_id)
        for m in mappings
    ]
