import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt

ISSUER = "pecunia"
ALGORITHM = "HS256"
ACCESS_TTL = timedelta(minutes=15)


class TokenError(Exception):
    """Any reason an access token is unusable (malformed, expired, bad key…)."""


@dataclass(frozen=True)
class KeyRing:
    keys: dict[str, str]
    current: str

    @classmethod
    def single(cls, secret: str) -> "KeyRing":
        return cls(keys={"1": secret}, current="1")


def create_access_token(
    *,
    user_id: uuid.UUID,
    family_id: uuid.UUID,
    ring: KeyRing,
    now: datetime | None = None,
    ttl: timedelta = ACCESS_TTL,
) -> str:
    now = now or datetime.now(UTC)
    claims = {
        "iss": ISSUER,
        "sub": str(user_id),
        "sid": str(family_id),
        "jti": str(uuid.uuid4()),
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
    }
    return jwt.encode(
        claims, ring.keys[ring.current], algorithm=ALGORITHM, headers={"kid": ring.current}
    )


def decode_access_token(token: str, ring: KeyRing) -> dict:
    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc
    key = ring.keys.get(kid or "")
    if key is None:
        raise TokenError("unknown key id")
    try:
        return jwt.decode(
            token,
            key,
            algorithms=[ALGORITHM],
            issuer=ISSUER,
            options={"require": ["exp", "iat", "iss", "sub", "sid", "jti"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc
