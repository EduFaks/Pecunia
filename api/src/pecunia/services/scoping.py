import uuid

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession


def scoped_select[T](model: type[T], workspace_id: uuid.UUID) -> sa.Select:
    """A SELECT of `model` restricted to one workspace (D7). Every tenant read
    goes through this — never a bare select(model) on finance data."""
    return sa.select(model).where(model.workspace_id == workspace_id)


async def get_scoped[T](
    db: AsyncSession, model: type[T], id_: uuid.UUID, workspace_id: uuid.UUID
) -> T | None:
    row = await db.get(model, id_)
    if row is None or row.workspace_id != workspace_id:
        return None
    return row
