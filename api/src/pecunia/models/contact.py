import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, ForeignKey, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, DateTime, Text, Uuid

from pecunia.models.base import Base


class ContactType(StrEnum):
    PERSON = "person"  # an individual — a landlord, a freelance client
    COMPANY = "company"  # an organization — a shop, an employer, a utility


_TYPES = "','".join(t.value for t in ContactType)


class Contact(Base):
    """A contact — a party a transaction is with, a person or a company. It is
    direction-agnostic: it works on income and expense alike (an employer, a
    shop, a landlord, a freelance client). Carries an optional default category
    (applied when a transaction gets this contact but no category of its own),
    an optional `avatar` (a size-capped base64 data-URI, validated in the
    service), an archive flag, and the is_demo/timestamps every finance row
    carries. Evolves the earlier Payee entity (migration 0014 renames the
    table forward)."""

    __tablename__ = "contacts"
    __table_args__ = (
        UniqueConstraint("workspace_id", "name", name="uq_contacts_workspace_id_name"),
        CheckConstraint(f"type IN ('{_TYPES}')", name="type_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # person | company — CHECK-guarded (CONVENTIONS §3), server_default 'company'
    # so a contact created without an explicit type reads as a company.
    type: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'company'"))
    # A base64 data-URI image (data:image/(png|jpeg|webp);base64,…), capped ~64KB
    # and validated in ContactService. Excluded from the audit allowlist (bulky,
    # non-sensitive). Nullable — a contact renders a monogram fallback when absent.
    avatar: Mapped[str | None] = mapped_column(Text)
    # A contact's optional default category — applied to a transaction that gets
    # this contact but no category of its own (the apply happens in the
    # transaction service). ON DELETE SET NULL: deleting a category never
    # destroys a contact.
    default_category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL")
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
