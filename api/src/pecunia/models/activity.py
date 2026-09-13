import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Identity, Index, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import DateTime, Text, Uuid

from pecunia.models.base import Base


class ActivityEntry(Base):
    """Human-friendly product-history entry (spec Activity vs Audit). A curated
    projection of domain events; rendered client-side from template_key + params."""

    __tablename__ = "activity_entries"
    __table_args__ = (
        Index("ix_activity_entries_workspace_id_occurred_at", "workspace_id", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    template_key: Mapped[str] = mapped_column(Text, nullable=False)
    params: Mapped[dict] = mapped_column(JSONB, nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    resource_type: Mapped[str | None] = mapped_column(Text)
    resource_id: Mapped[str | None] = mapped_column(Text)
