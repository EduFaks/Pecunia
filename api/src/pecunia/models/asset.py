import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import BigInteger, CheckConstraint, Date, ForeignKey, String, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, DateTime, Text, Uuid

from pecunia.models.base import Base


class AssetType(StrEnum):
    VEHICLE = "vehicle"
    PROPERTY = "property"
    INVESTMENT = "investment"
    WATCH = "watch"
    OTHER = "other"


_TYPES = "','".join(t.value for t in AssetType)


class Asset(Base):
    __tablename__ = "assets"
    __table_args__ = (
        CheckConstraint(f"type IN ('{_TYPES}')", name="type_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    acquired_on: Mapped[date | None] = mapped_column(Date)
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)


class AssetValuation(Base):
    __tablename__ = "asset_valuations"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    asset_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    value_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    as_of: Mapped[date] = mapped_column(Date, nullable=False)
    source: Mapped[str | None] = mapped_column(Text)
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
