import uuid
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.contact import Contact, ContactType
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.period import shift_month
from pecunia.services.analytics import AnalyticsService
from pecunia.services.contacts import (
    UNSET,
    AvatarInvalidError,
    ContactService,
    DefaultCategoryNotFoundError,
)

router = APIRouter(prefix="/contacts", tags=["contacts"], dependencies=[Depends(require_initialized)])

# The overview's default reporting window when the caller omits `from`/`to`: a
# rolling 12-month range, matching the `/analytics/*` routes. Computed here in
# the router from the wall clock so the service stays clock-free (§4).
DEFAULT_OVERVIEW_MONTHS = 12

FromDate = Annotated[date | None, Query(alias="from")]
ToDate = Annotated[date | None, Query(alias="to")]


def _today() -> date:
    return datetime.now(UTC).date()


def _range(from_: date | None, to: date | None) -> tuple[date, date]:
    to_date = to or _today()
    from_date = from_ or shift_month(to_date, -(DEFAULT_OVERVIEW_MONTHS - 1))
    return from_date, to_date


class ContactIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: ContactType = ContactType.COMPANY
    avatar: str | None = None
    default_category_id: uuid.UUID | None = None


class ContactUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    type: ContactType | None = None
    avatar: str | None = None
    default_category_id: uuid.UUID | None = None


class ContactOut(BaseModel):
    id: uuid.UUID
    name: str
    default_category_id: uuid.UUID | None
    type: str
    avatar: str | None
    archived_at: datetime | None
    is_demo: bool
    created_at: datetime

    @classmethod
    def from_model(cls, contact: Contact) -> "ContactOut":
        return cls(
            id=contact.id,
            name=contact.name,
            default_category_id=contact.default_category_id,
            type=contact.type,
            avatar=contact.avatar,
            archived_at=contact.archived_at,
            is_demo=contact.is_demo,
            created_at=contact.created_at,
        )


class ContactPage(BaseModel):
    items: list[ContactOut]
    next_cursor: str | None


class ContactCategoryBreakdown(BaseModel):
    """One category's slice of a contact's activity: money received (`in_minor`)
    and money spent (`out_minor`) with this contact under that category. The
    null-category rows come back as an "Uncategorized" bucket
    (`category_id=None, color=None`)."""

    category_id: uuid.UUID | None
    name: str
    color: str | None
    in_minor: int
    out_minor: int


class ContactOverviewCurrency(BaseModel):
    """One currency's totals for a contact over the reporting window — figures
    are never summed across currencies (§4)."""

    money_in_minor: int
    money_out_minor: int
    net_minor: int
    transaction_count: int
    by_category: list[ContactCategoryBreakdown]


async def _get_or_404(
    svc: ContactService, workspace_id: uuid.UUID, contact_id: uuid.UUID
) -> Contact:
    contact = await svc.get(workspace_id, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="CONTACT_NOT_FOUND")
    return contact


@router.post("", status_code=201)
async def create_contact(
    body: ContactIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ContactOut:
    svc = ContactService(db)
    try:
        contact = await svc.create(
            wsctx.workspace_id,
            name=body.name,
            type=body.type.value,
            avatar=body.avatar,
            default_category_id=body.default_category_id,
        )
    except AvatarInvalidError:
        raise HTTPException(status_code=422, detail="AVATAR_INVALID") from None
    except DefaultCategoryNotFoundError:
        raise HTTPException(status_code=422, detail="DEFAULT_CATEGORY_NOT_FOUND") from None
    await db.commit()
    return ContactOut.from_model(contact)


@router.get("")
async def list_contacts(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    include_archived: bool = False,
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> ContactPage:
    svc = ContactService(db)
    items, next_cursor = await svc.list(
        wsctx.workspace_id, include_archived=include_archived, cursor=cursor, limit=limit
    )
    return ContactPage(items=[ContactOut.from_model(c) for c in items], next_cursor=next_cursor)


@router.get("/{contact_id}")
async def get_contact(
    contact_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ContactOut:
    svc = ContactService(db)
    contact = await _get_or_404(svc, wsctx.workspace_id, contact_id)
    return ContactOut.from_model(contact)


@router.get("/{contact_id}/overview")
async def contact_overview(
    contact_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    from_: FromDate = None,
    to: ToDate = None,
) -> dict[str, ContactOverviewCurrency]:
    """Per-currency money-in/out/net + count + a by-category breakdown for one
    contact over `[from, to]` (defaulting to the last 12 months). 404s a
    foreign/missing contact — the same workspace-scoped lookup every other
    contact route uses — before running the aggregation."""
    svc = ContactService(db)
    await _get_or_404(svc, wsctx.workspace_id, contact_id)
    from_date, to_date = _range(from_, to)
    return await AnalyticsService(db).contact_overview(
        wsctx.workspace_id, contact_id, from_date=from_date, to_date=to_date
    )


@router.patch("/{contact_id}")
async def update_contact(
    contact_id: uuid.UUID,
    body: ContactUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ContactOut:
    svc = ContactService(db)
    contact = await _get_or_404(svc, wsctx.workspace_id, contact_id)
    fields = body.model_dump(exclude_unset=True)
    contact_type = fields.get("type")
    try:
        contact = await svc.update(
            contact,
            name=fields.get("name"),
            type=contact_type.value if contact_type is not None else None,
            avatar=fields.get("avatar", UNSET),
            default_category_id=fields.get("default_category_id", UNSET),
        )
    except AvatarInvalidError:
        raise HTTPException(status_code=422, detail="AVATAR_INVALID") from None
    except DefaultCategoryNotFoundError:
        raise HTTPException(status_code=422, detail="DEFAULT_CATEGORY_NOT_FOUND") from None
    await db.commit()
    return ContactOut.from_model(contact)


@router.post("/{contact_id}/archive", status_code=204)
async def archive_contact(
    contact_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = ContactService(db)
    contact = await _get_or_404(svc, wsctx.workspace_id, contact_id)
    await svc.archive(contact)
    await db.commit()
