import re
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import AfterValidator, BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.category import PALETTE, Category, CategoryKind
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.categories import UNSET, CategoryService

router = APIRouter(prefix="/categories", tags=["categories"], dependencies=[Depends(require_initialized)])


def _validate_color(color: str) -> str:
    if color not in PALETTE:
        raise ValueError("color must be one of the allowed palette values")
    return color


ColorStr = Annotated[str, AfterValidator(_validate_color)]

_ICON_RE = re.compile(r"^[a-z0-9-]+$")


def _validate_icon(icon: str) -> str:
    if not _ICON_RE.match(icon) or len(icon) > 40:
        raise ValueError("icon must be a lowercase lucide name ([a-z0-9-], <=40 chars)")
    return icon


IconStr = Annotated[str, AfterValidator(_validate_icon)]


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: CategoryKind
    color: ColorStr
    icon: IconStr | None = None


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    kind: CategoryKind | None = None
    color: ColorStr | None = None
    icon: IconStr | None = None


class CategoryOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: str
    color: str
    icon: str | None
    archived_at: datetime | None
    is_demo: bool

    @classmethod
    def from_model(cls, category: Category) -> "CategoryOut":
        return cls(
            id=category.id,
            name=category.name,
            kind=category.kind,
            color=category.color,
            icon=category.icon,
            archived_at=category.archived_at,
            is_demo=category.is_demo,
        )


class CategoryPage(BaseModel):
    items: list[CategoryOut]
    next_cursor: str | None


async def _get_or_404(svc: CategoryService, workspace_id: uuid.UUID, category_id: uuid.UUID) -> Category:
    category = await svc.get(workspace_id, category_id)
    if category is None:
        raise HTTPException(status_code=404, detail="CATEGORY_NOT_FOUND")
    return category


@router.post("", status_code=201)
async def create_category(
    body: CategoryIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> CategoryOut:
    svc = CategoryService(db)
    category = await svc.create(
        wsctx.workspace_id,
        name=body.name,
        kind=body.kind.value,
        color=body.color,
        icon=body.icon,
    )
    await db.commit()
    return CategoryOut.from_model(category)


@router.get("")
async def list_categories(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    include_archived: bool = False,
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> CategoryPage:
    svc = CategoryService(db)
    items, next_cursor = await svc.list(
        wsctx.workspace_id, include_archived=include_archived, cursor=cursor, limit=limit
    )
    return CategoryPage(items=[CategoryOut.from_model(c) for c in items], next_cursor=next_cursor)


@router.get("/{category_id}")
async def get_category(
    category_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> CategoryOut:
    svc = CategoryService(db)
    category = await _get_or_404(svc, wsctx.workspace_id, category_id)
    return CategoryOut.from_model(category)


@router.patch("/{category_id}")
async def update_category(
    category_id: uuid.UUID,
    body: CategoryUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> CategoryOut:
    svc = CategoryService(db)
    category = await _get_or_404(svc, wsctx.workspace_id, category_id)
    fields = body.model_dump(exclude_unset=True)
    category = await svc.update(
        category,
        name=fields.get("name"),
        kind=fields["kind"].value if fields.get("kind") is not None else None,
        color=fields.get("color"),
        icon=fields.get("icon", UNSET),
    )
    await db.commit()
    return CategoryOut.from_model(category)


@router.post("/{category_id}/archive", status_code=204)
async def archive_category(
    category_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = CategoryService(db)
    category = await _get_or_404(svc, wsctx.workspace_id, category_id)
    await svc.archive(category)
    await db.commit()
