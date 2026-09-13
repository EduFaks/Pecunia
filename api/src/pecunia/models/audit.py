import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Identity, Index, text
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import DateTime, Text, Uuid

from pecunia.models.base import Base


class AuditEvent(Base):
    """Append-only security/technical audit record (spec D3). A DB trigger blocks
    UPDATE/DELETE. Actor/workspace are soft uuid references (no FK) so history
    survives deletion of the referenced rows."""

    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_actor_user_id_occurred_at", "actor_user_id", "occurred_at"),
        Index("ix_audit_events_resource", "resource_type", "resource_id", "occurred_at"),
        Index("ix_audit_events_workspace_id_occurred_at", "workspace_id", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False, index=True
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    actor_session_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    request_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    action: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    resource_type: Mapped[str | None] = mapped_column(Text)
    resource_id: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(INET())
    user_agent: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
