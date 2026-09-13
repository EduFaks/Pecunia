import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.activity.templates import Activity
from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.category import DEFAULT_CATEGORIES, Category
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select

# Sentinel distinguishing "field not present in the PATCH body" from "field
# explicitly set to null" for the nullable `icon` column.
UNSET = object()


async def seed_default_categories(
    db: AsyncSession, workspace_id: uuid.UUID, *, is_demo: bool = False
) -> list[Category]:
    """Insert the default category set (pecunia.models.category.DEFAULT_CATEGORIES)
    for a workspace — real categories at setup (is_demo=False, the default),
    or flagged is_demo=True when seeding the demo dataset.

    Contract: flushes, never commits — the caller owns the transaction
    boundary (CONVENTIONS §2).
    """
    categories = [
        Category(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=defaults["name"],
            kind=defaults["kind"],
            color=defaults["color"],
            icon=defaults.get("icon"),
            is_demo=is_demo,
        )
        for defaults in DEFAULT_CATEGORIES
    ]
    db.add_all(categories)
    await db.flush()
    return categories


class CategoryService:
    """Category business logic. Contract: methods flush, never commit — the
    caller (router) owns the transaction boundary (CONVENTIONS §2)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        name: str,
        kind: str,
        color: str,
        icon: str | None = None,
    ) -> Category:
        category = Category(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            kind=kind,
            color=color,
            icon=icon,
        )
        self.db.add(category)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.CATEGORY_CREATED,
                resource_type="category",
                resource_id=str(category.id),
                workspace_id=workspace_id,
                after=project("category", category),
                activity_template=Activity.CATEGORY_CREATED,
                activity_params={"name": category.name, "kind": category.kind},
            ),
        )
        return category

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        include_archived: bool = False,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[Category], str | None]:
        stmt = scoped_select(Category, workspace_id)
        if not include_archived:
            stmt = stmt.where(Category.archived_at.is_(None))
        # UUID primary keys carry no order — paginate newest-first on
        # created_at, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = stmt.order_by(Category.created_at.desc(), Category.id.desc())
        return await keyset_page(
            self.db,
            stmt,
            Category.created_at,
            Category.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(self, workspace_id: uuid.UUID, category_id: uuid.UUID) -> Category | None:
        return await get_scoped(self.db, Category, category_id, workspace_id)

    async def update(
        self,
        category: Category,
        *,
        name: str | None = None,
        kind: str | None = None,
        color: str | None = None,
        icon: object = UNSET,
    ) -> Category:
        before = project("category", category)
        if name is not None:
            category.name = name
        if kind is not None:
            category.kind = kind
        if color is not None:
            category.color = color
        if icon is not UNSET:
            category.icon = icon
        category.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.CATEGORY_UPDATED,
                resource_type="category",
                resource_id=str(category.id),
                workspace_id=category.workspace_id,
                before=before,
                after=project("category", category),
            ),
        )
        return category

    async def archive(self, category: Category) -> Category:
        category.archived_at = datetime.now(UTC)
        category.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.CATEGORY_ARCHIVED,
                resource_type="category",
                resource_id=str(category.id),
                workspace_id=category.workspace_id,
                after=project("category", category),
            ),
        )
        return category
