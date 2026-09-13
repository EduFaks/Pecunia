import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from enum import StrEnum

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.audit.actions import Actions
from pecunia.context import set_actor
from pecunia.device_label import device_label
from pecunia.events import DomainEvent, event_bus
from pecunia.models import AuthSession, LoginAttempt, User
from pecunia.security.passwords import DUMMY_HASH, verify_password

REFRESH_ABSOLUTE = timedelta(days=30)
REFRESH_IDLE = timedelta(days=14)
THROTTLE_WINDOW = timedelta(minutes=15)
THROTTLE_MAX_FAILURES = 5


class RevokeReason(StrEnum):
    """Spec D3 / CONVENTIONS §3: lowercase enumerated string, stored as-is in
    auth_sessions.revoke_reason."""

    LOGOUT = "logout"
    LOGOUT_ALL = "logout_all"
    USER_REVOKED = "user_revoked"
    REUSE_DETECTED = "reuse_detected"
    PASSWORD_CHANGED = "password_changed"


class InvalidCredentialsError(Exception):
    pass


class ThrottledError(Exception):
    pass


class InvalidRefreshTokenError(Exception):
    pass


def hash_refresh_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def _new_refresh_token() -> tuple[str, bytes]:
    token = secrets.token_urlsafe(32)
    return token, hash_refresh_token(token)


class AuthService:
    """Auth business logic. Contract: methods flush, never commit — the caller
    (router or fellow service) owns the transaction. Failure paths flush their
    evidence (login attempts, reuse-detection revocations) BEFORE raising, so a
    caller that commits in its except-branch persists them. Plan 03's event
    subscribers rely on this same-transaction discipline."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_session(
        self,
        user: User,
        *,
        client: str,
        ip: str | None,
        user_agent: str | None,
        family_id: uuid.UUID | None = None,
        absolute_expires_at: datetime | None = None,
    ) -> tuple[AuthSession, str]:
        now = datetime.now(UTC)
        token, token_hash = _new_refresh_token()
        session = AuthSession(
            id=uuid.uuid4(),
            user_id=user.id,
            family_id=family_id or uuid.uuid4(),
            token_hash=token_hash,
            client=client,
            expires_at=absolute_expires_at or (now + REFRESH_ABSOLUTE),
            idle_expires_at=now + REFRESH_IDLE,
            ip=ip,
            user_agent=user_agent,
            device_label=device_label(user_agent),
        )
        self.db.add(session)
        await self.db.flush()
        return session, token

    async def login(
        self, *, email: str, password: str, client: str, ip: str | None, user_agent: str | None
    ) -> tuple[User, AuthSession, str]:
        await self._check_throttle(email=email, ip=ip)
        result = await self.db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        candidate_hash = user.password_hash if user is not None else DUMMY_HASH
        ok = verify_password(password, candidate_hash) and user is not None
        self.db.add(LoginAttempt(email_tried=email, ip=ip, succeeded=ok))
        await self.db.flush()
        if not ok:
            # Publish before raising: the router commits in its except-branch,
            # so this audit row must already be in the transaction.
            await event_bus.publish(
                self.db, DomainEvent(action=Actions.AUTH_LOGIN_FAILED, metadata={"email": email})
            )
            raise InvalidCredentialsError()
        session, refresh_token = await self.create_session(
            user, client=client, ip=ip, user_agent=user_agent
        )
        # Attribute the audit row to the user who just authenticated — before
        # this, the request context has no actor yet since get_current_user
        # hasn't run (there's no token to decode on the login request itself).
        set_actor(user.id, session.family_id)
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.AUTH_LOGIN_SUCCESS, resource_type="user", resource_id=str(user.id)
            ),
        )
        return user, session, refresh_token

    async def _check_throttle(self, *, email: str, ip: str | None) -> None:
        cutoff = datetime.now(UTC) - THROTTLE_WINDOW
        conditions = [LoginAttempt.email_tried == email]
        if ip is not None:
            conditions.append(LoginAttempt.ip == ip)
        stmt = (
            select(func.count())
            .select_from(LoginAttempt)
            .where(
                LoginAttempt.occurred_at >= cutoff,
                LoginAttempt.succeeded.is_(False),
                or_(*conditions),
            )
        )
        failures = (await self.db.execute(stmt)).scalar_one()
        if failures >= THROTTLE_MAX_FAILURES:
            # Publish before raising: the router's except-branch for
            # ThrottledError now commits too, so this audit row survives the
            # 429 (mirrors the InvalidCredentialsError branch below it).
            await event_bus.publish(
                self.db, DomainEvent(action=Actions.AUTH_LOGIN_THROTTLED, metadata={"email": email})
            )
            raise ThrottledError()

    async def refresh(
        self, token: str, *, ip: str | None, user_agent: str | None
    ) -> tuple[User, AuthSession, str]:
        token_hash = hash_refresh_token(token)
        result = await self.db.execute(
            select(AuthSession)
            .where(AuthSession.token_hash == token_hash)
            .with_for_update()
            # populate_existing: a concurrent refresh may have superseded this row
            # while we waited on the lock; we must see the committed values, not a
            # stale identity-mapped snapshot.
            .execution_options(populate_existing=True)
        )
        session = result.scalar_one_or_none()
        if session is None:
            raise InvalidRefreshTokenError()
        now = datetime.now(UTC)
        if session.revoked_at is not None or session.superseded_by is not None:
            # Replay of a dead token is evidence of theft: kill the family.
            await self.revoke_family(session.family_id, reason=RevokeReason.REUSE_DETECTED)
            await event_bus.publish(
                self.db,
                DomainEvent(
                    action=Actions.AUTH_SESSION_REUSE_DETECTED,
                    metadata={"family_id": str(session.family_id)},
                ),
            )
            await self.db.flush()
            raise InvalidRefreshTokenError()
        if session.expires_at <= now or session.idle_expires_at <= now:
            raise InvalidRefreshTokenError()
        user = await self.db.get(User, session.user_id)
        if user is None:
            raise InvalidRefreshTokenError()
        new_session, new_token = await self.create_session(
            user,
            client=session.client,
            ip=ip,
            user_agent=user_agent,
            family_id=session.family_id,
            absolute_expires_at=session.expires_at,
        )
        session.superseded_by = new_session.id
        session.last_used_at = now
        await self.db.flush()
        return user, new_session, new_token

    async def revoke_family(self, family_id: uuid.UUID, *, reason: RevokeReason) -> None:
        """Only the DB update — never publishes. Callers with distinct audit
        semantics (logout vs. reuse detection) publish their own event; a
        publish here would double-fire for the reuse-detection path, which
        already publishes AUTH_SESSION_REUSE_DETECTED itself."""
        await self.db.execute(
            update(AuthSession)
            .where(AuthSession.family_id == family_id, AuthSession.revoked_at.is_(None))
            .values(revoked_at=func.now(), revoke_reason=reason)
        )

    async def logout(self, family_id: uuid.UUID) -> None:
        await self.revoke_family(family_id, reason=RevokeReason.LOGOUT)
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.AUTH_LOGOUT, resource_type="session", resource_id=str(family_id)
            ),
        )

    async def logout_all(self, user_id: uuid.UUID) -> None:
        await self.db.execute(
            update(AuthSession)
            .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
            .values(revoked_at=func.now(), revoke_reason=RevokeReason.LOGOUT_ALL)
        )
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.AUTH_LOGOUT_ALL, resource_type="user", resource_id=str(user_id)
            ),
        )

    async def list_sessions(self, user_id: uuid.UUID) -> list[AuthSession]:
        now = datetime.now(UTC)
        stmt = (
            select(AuthSession)
            .where(
                AuthSession.user_id == user_id,
                AuthSession.superseded_by.is_(None),
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
                AuthSession.idle_expires_at > now,
            )
            .order_by(AuthSession.created_at.desc())
        )
        return list((await self.db.execute(stmt)).scalars())

    async def revoke_user_family(self, user_id: uuid.UUID, family_id: uuid.UUID) -> bool:
        count = await self.db.scalar(
            select(func.count())
            .select_from(AuthSession)
            .where(AuthSession.family_id == family_id, AuthSession.user_id == user_id)
        )
        if not count:
            return False
        await self.revoke_family(family_id, reason=RevokeReason.USER_REVOKED)
        await event_bus.publish(
            self.db,
            DomainEvent(
                action=Actions.AUTH_SESSION_REVOKED,
                resource_type="session",
                resource_id=str(family_id),
            ),
        )
        return True

    async def is_family_active(self, family_id: uuid.UUID) -> bool:
        now = datetime.now(UTC)
        count = await self.db.scalar(
            select(func.count())
            .select_from(AuthSession)
            .where(
                AuthSession.family_id == family_id,
                AuthSession.superseded_by.is_(None),
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
                AuthSession.idle_expires_at > now,
            )
        )
        return bool(count)
