import re
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models.category import Category
from pecunia.models.contact import Contact, ContactType
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, keyset_page
from pecunia.services.scoping import get_scoped, scoped_select

# Sentinel distinguishing "field not present in the PATCH body" from "field
# explicitly set to null" for the nullable `default_category_id`/`avatar` columns.
UNSET = object()

# An avatar is a base64 data-URI image, downscaled client-side. Cap it server-
# side (~64KB) and require the expected prefix — it is stored inline in the row,
# not behind an image service, so an unbounded/foreign blob has no business here.
_AVATAR_PREFIX = re.compile(r"^data:image/(png|jpeg|webp);base64,")
MAX_AVATAR_BYTES = 64 * 1024


class DefaultCategoryNotFoundError(Exception):
    """Raised when a contact's default_category_id doesn't reference a category
    in the contact's own workspace. The router maps this to 422 — a foreign FK
    on the submitted contact body is a validation error, not a missing-resource
    lookup."""


class AvatarInvalidError(Exception):
    """Raised when a contact's avatar is not a `data:image/(png|jpeg|webp);
    base64,…` data-URI or exceeds the ~64KB cap. The router maps this to 422
    AVATAR_INVALID."""


def _validate_avatar(avatar: str | None) -> None:
    """Guard a contact avatar when one is set: it must be a base64 data-URI of
    an allowed image type and stay within the size cap. None passes (a contact
    may have no avatar)."""
    if avatar is None:
        return
    if not _AVATAR_PREFIX.match(avatar):
        raise AvatarInvalidError()
    if len(avatar.encode("utf-8")) > MAX_AVATAR_BYTES:
        raise AvatarInvalidError()


class ContactService:
    """Contact business logic. Contract: methods flush, never commit — the
    caller (router) owns the transaction boundary (CONVENTIONS §2)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def _validate_default_category(
        self, workspace_id: uuid.UUID, category_id: uuid.UUID
    ) -> Category:
        category = await get_scoped(self.db, Category, category_id, workspace_id)
        if category is None:
            raise DefaultCategoryNotFoundError()
        return category

    async def create(
        self,
        workspace_id: uuid.UUID,
        *,
        name: str,
        type: str = ContactType.COMPANY.value,
        avatar: str | None = None,
        default_category_id: uuid.UUID | None = None,
    ) -> Contact:
        _validate_avatar(avatar)
        if default_category_id is not None:
            await self._validate_default_category(workspace_id, default_category_id)
        contact = Contact(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            type=type,
            avatar=avatar,
            default_category_id=default_category_id,
        )
        self.db.add(contact)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.CONTACT_CREATED,
                resource_type="contact",
                resource_id=str(contact.id),
                workspace_id=workspace_id,
                after=project("contact", contact),
            ),
        )
        return contact

    async def list(
        self,
        workspace_id: uuid.UUID,
        *,
        include_archived: bool = False,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> tuple[list[Contact], str | None]:
        stmt = scoped_select(Contact, workspace_id)
        if not include_archived:
            stmt = stmt.where(Contact.archived_at.is_(None))
        # UUID primary keys carry no order — paginate newest-first on
        # created_at, with id as a deterministic tiebreaker (CONVENTIONS §6).
        stmt = stmt.order_by(Contact.created_at.desc(), Contact.id.desc())
        return await keyset_page(
            self.db,
            stmt,
            Contact.created_at,
            Contact.id,
            cursor=cursor,
            limit=limit,
            default=DEFAULT_LIMIT,
            cap=MAX_LIMIT,
        )

    async def get(self, workspace_id: uuid.UUID, contact_id: uuid.UUID) -> Contact | None:
        return await get_scoped(self.db, Contact, contact_id, workspace_id)

    async def update(
        self,
        contact: Contact,
        *,
        name: str | None = None,
        type: str | None = None,
        avatar: object = UNSET,
        default_category_id: object = UNSET,
    ) -> Contact:
        if avatar is not UNSET:
            _validate_avatar(avatar)
        if default_category_id is not UNSET and default_category_id is not None:
            await self._validate_default_category(contact.workspace_id, default_category_id)
        before = project("contact", contact)
        if name is not None:
            contact.name = name
        if type is not None:
            contact.type = type
        if avatar is not UNSET:
            contact.avatar = avatar
        if default_category_id is not UNSET:
            contact.default_category_id = default_category_id
        contact.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.CONTACT_UPDATED,
                resource_type="contact",
                resource_id=str(contact.id),
                workspace_id=contact.workspace_id,
                before=before,
                after=project("contact", contact),
            ),
        )
        return contact

    async def archive(self, contact: Contact) -> Contact:
        contact.archived_at = datetime.now(UTC)
        contact.updated_at = datetime.now(UTC)
        await self.db.flush()
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.CONTACT_ARCHIVED,
                resource_type="contact",
                resource_id=str(contact.id),
                workspace_id=contact.workspace_id,
                after=project("contact", contact),
            ),
        )
        return contact
