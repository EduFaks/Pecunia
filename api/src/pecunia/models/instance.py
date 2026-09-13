import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import DateTime, Uuid

from pecunia.models.base import Base


class InstanceState(Base):
    """Singleton row (id = 1). initialized_at IS NULL ⇒ wizard mode (spec D4)."""

    __tablename__ = "instance_state"
    __table_args__ = (CheckConstraint("id = 1", name="singleton"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    instance_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    initialized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    settings: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
