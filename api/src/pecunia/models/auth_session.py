import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, Identity, Index, text
from sqlalchemy.dialects.postgresql import CITEXT, INET
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, DateTime, LargeBinary, Text, Uuid

from pecunia.models.base import Base


class AuthSession(Base):
    """One issued refresh token; a login session is the family of rotations."""

    __tablename__ = "auth_sessions"
    __table_args__ = (
        CheckConstraint("client IN ('web','native')", name="client_valid"),
        CheckConstraint(
            "revoke_reason IS NULL OR revoke_reason IN "
            "('logout','logout_all','user_revoked','reuse_detected','password_changed')",
            name="revoke_reason_valid",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    family_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, unique=True, nullable=False)
    client: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    idle_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoke_reason: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(INET())
    user_agent: Mapped[str | None] = mapped_column(Text)
    device_label: Mapped[str | None] = mapped_column(Text)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    __table_args__ = (
        Index("ix_login_attempts_email_time", "email_tried", "occurred_at"),
        Index("ix_login_attempts_ip_time", "ip", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    email_tried: Mapped[str] = mapped_column(CITEXT(), nullable=False)
    ip: Mapped[str | None] = mapped_column(INET())
    succeeded: Mapped[bool] = mapped_column(Boolean, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False, index=True
    )
