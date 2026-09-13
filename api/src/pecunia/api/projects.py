import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import WorkspaceContext, require_initialized, require_workspace
from pecunia.db import get_db
from pecunia.models.project import Project, ProjectItem, ProjectStatus, ProjectType
from pecunia.money import CurrencyStr, MinorInt
from pecunia.pagination import DEFAULT_LIMIT
from pecunia.services.projects import (
    UNSET,
    ProjectService,
    TransactionAlreadyAttachedError,
    TransactionNotFoundError,
)

router = APIRouter(prefix="/projects", tags=["projects"], dependencies=[Depends(require_initialized)])


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    target_amount_minor: MinorInt | None = None
    currency: CurrencyStr
    status: ProjectStatus = ProjectStatus.ACTIVE
    type: ProjectType = ProjectType.SPENDING


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    target_amount_minor: MinorInt | None = None
    currency: CurrencyStr | None = None
    status: ProjectStatus | None = None
    type: ProjectType | None = None


class ProjectOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    target_amount_minor: int | None
    currency: str
    status: str
    type: str
    planned_minor: int  # Σ part estimates (the plan)
    actual_minor: int  # Σ ABS(linked transactions) (the realized funding)
    is_demo: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, project: Project, planned_minor: int, actual_minor: int) -> "ProjectOut":
        return cls(
            id=project.id,
            name=project.name,
            description=project.description,
            target_amount_minor=project.target_amount_minor,
            currency=project.currency,
            status=project.status,
            type=project.type,
            planned_minor=planned_minor,
            actual_minor=actual_minor,
            is_demo=project.is_demo,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )


class ProjectPage(BaseModel):
    items: list[ProjectOut]
    next_cursor: str | None


class ProjectItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    amount_minor: MinorInt


class ProjectItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    amount_minor: MinorInt | None = None


class AttachIn(BaseModel):
    transaction_id: uuid.UUID


class ProjectItemOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    transaction_id: uuid.UUID | None
    name: str
    amount_minor: int
    actual_minor: int | None  # attached tx magnitude, None when unattached
    is_demo: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, item: ProjectItem, actual_minor: int | None = None) -> "ProjectItemOut":
        return cls(
            id=item.id,
            project_id=item.project_id,
            transaction_id=item.transaction_id,
            name=item.name,
            amount_minor=item.amount_minor,
            actual_minor=actual_minor,
            is_demo=item.is_demo,
            created_at=item.created_at,
            updated_at=item.updated_at,
        )


class ProjectItemPage(BaseModel):
    items: list[ProjectItemOut]
    next_cursor: str | None


async def _get_or_404(svc: ProjectService, workspace_id: uuid.UUID, project_id: uuid.UUID) -> Project:
    project = await svc.get(workspace_id, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="PROJECT_NOT_FOUND")
    return project


async def _project_out(svc: ProjectService, project: Project) -> ProjectOut:
    return ProjectOut.from_model(
        project, await svc.planned_minor(project), await svc.actual_minor(project)
    )


async def _get_item_or_404(
    svc: ProjectService, workspace_id: uuid.UUID, project_id: uuid.UUID, item_id: uuid.UUID
) -> ProjectItem:
    item = await svc.get_item(workspace_id, item_id)
    if item is None or item.project_id != project_id:
        raise HTTPException(status_code=404, detail="PROJECT_ITEM_NOT_FOUND")
    return item


@router.post("", status_code=201)
async def create_project(
    body: ProjectIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ProjectOut:
    svc = ProjectService(db)
    project = await svc.create(
        wsctx.workspace_id,
        name=body.name,
        description=body.description,
        target_amount_minor=body.target_amount_minor,
        currency=body.currency,
        status=body.status.value,
        type=body.type.value,
    )
    await db.commit()
    return await _project_out(svc, project)


@router.get("")
async def list_projects(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    status: ProjectStatus | None = None,
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> ProjectPage:
    svc = ProjectService(db)
    items, next_cursor = await svc.list(
        wsctx.workspace_id, status=status.value if status is not None else None, cursor=cursor, limit=limit
    )
    return ProjectPage(
        items=[await _project_out(svc, p) for p in items], next_cursor=next_cursor
    )


@router.get("/{project_id}")
async def get_project(
    project_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ProjectOut:
    svc = ProjectService(db)
    project = await _get_or_404(svc, wsctx.workspace_id, project_id)
    return await _project_out(svc, project)


@router.patch("/{project_id}")
async def update_project(
    project_id: uuid.UUID,
    body: ProjectUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ProjectOut:
    svc = ProjectService(db)
    project = await _get_or_404(svc, wsctx.workspace_id, project_id)
    fields = body.model_dump(exclude_unset=True)
    project = await svc.update(
        project,
        name=fields.get("name"),
        description=fields.get("description", UNSET),
        target_amount_minor=fields.get("target_amount_minor", UNSET),
        currency=fields.get("currency"),
        status=fields["status"].value if fields.get("status") is not None else None,
        type=fields["type"].value if fields.get("type") is not None else None,
    )
    await db.commit()
    return await _project_out(svc, project)


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> None:
    svc = ProjectService(db)
    project = await _get_or_404(svc, wsctx.workspace_id, project_id)
    await svc.delete(project)
    await db.commit()


@router.post("/{project_id}/items", status_code=201)
async def add_project_item(
    project_id: uuid.UUID,
    body: ProjectItemIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ProjectItemOut:
    svc = ProjectService(db)
    project = await _get_or_404(svc, wsctx.workspace_id, project_id)
    item = await svc.add_item(project, name=body.name, amount_minor=body.amount_minor)
    await db.commit()
    return ProjectItemOut.from_model(item, await svc.item_actual_minor(item))


@router.get("/{project_id}/items")
async def list_project_items(
    project_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> ProjectItemPage:
    svc = ProjectService(db)
    project = await _get_or_404(svc, wsctx.workspace_id, project_id)
    items, next_cursor = await svc.list_items(wsctx.workspace_id, project.id, cursor=cursor, limit=limit)
    return ProjectItemPage(
        items=[ProjectItemOut.from_model(i, await svc.item_actual_minor(i)) for i in items],
        next_cursor=next_cursor,
    )


@router.patch("/{project_id}/items/{item_id}")
async def update_project_item(
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ProjectItemUpdate,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ProjectItemOut:
    svc = ProjectService(db)
    project = await _get_or_404(svc, wsctx.workspace_id, project_id)
    item = await _get_item_or_404(svc, wsctx.workspace_id, project.id, item_id)
    fields = body.model_dump(exclude_unset=True)
    item = await svc.update_item(item, name=fields.get("name"), amount_minor=fields.get("amount_minor"))
    await db.commit()
    return ProjectItemOut.from_model(item, await svc.item_actual_minor(item))


@router.post("/{project_id}/items/{item_id}/attach")
async def attach_item_transaction(
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    body: AttachIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ProjectItemOut:
    svc = ProjectService(db)
    project = await _get_or_404(svc, wsctx.workspace_id, project_id)
    item = await _get_item_or_404(svc, wsctx.workspace_id, project.id, item_id)
    try:
        item = await svc.attach_item_transaction(item, body.transaction_id)
    except TransactionNotFoundError:
        raise HTTPException(status_code=404, detail="TRANSACTION_NOT_FOUND") from None
    except TransactionAlreadyAttachedError:
        raise HTTPException(status_code=409, detail="TRANSACTION_ALREADY_ATTACHED") from None
    await db.commit()
    return ProjectItemOut.from_model(item, await svc.item_actual_minor(item))


@router.post("/{project_id}/items/{item_id}/detach")
async def detach_item_transaction(
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> ProjectItemOut:
    svc = ProjectService(db)
    project = await _get_or_404(svc, wsctx.workspace_id, project_id)
    item = await _get_item_or_404(svc, wsctx.workspace_id, project.id, item_id)
    item = await svc.detach_item_transaction(item)
    await db.commit()
    return ProjectItemOut.from_model(item, await svc.item_actual_minor(item))
