import uuid
from datetime import UTC, datetime, timedelta

import pytest

from pecunia.security.tokens import (
    ACCESS_TTL,
    KeyRing,
    TokenError,
    create_access_token,
    decode_access_token,
)

RING = KeyRing.single("s" * 64)
USER = uuid.uuid4()
FAMILY = uuid.uuid4()


def test_roundtrip_claims():
    token = create_access_token(user_id=USER, family_id=FAMILY, ring=RING)
    claims = decode_access_token(token, RING)
    assert claims["iss"] == "pecunia"
    assert claims["sub"] == str(USER)
    assert claims["sid"] == str(FAMILY)
    assert uuid.UUID(claims["jti"])
    assert claims["exp"] - claims["iat"] == int(ACCESS_TTL.total_seconds())


def test_expired_token_rejected():
    old = datetime.now(UTC) - timedelta(hours=1)
    token = create_access_token(user_id=USER, family_id=FAMILY, ring=RING, now=old)
    with pytest.raises(TokenError):
        decode_access_token(token, RING)


def test_wrong_key_rejected():
    token = create_access_token(user_id=USER, family_id=FAMILY, ring=RING)
    with pytest.raises(TokenError):
        decode_access_token(token, KeyRing.single("x" * 64))


def test_unknown_kid_rejected():
    other = KeyRing({"9": "y" * 64}, "9")
    token = create_access_token(user_id=USER, family_id=FAMILY, ring=other)
    with pytest.raises(TokenError):
        decode_access_token(token, RING)


def test_key_rotation_old_key_still_verifies():
    old_ring = KeyRing.single("s" * 64)                       # kid "1"
    token = create_access_token(user_id=USER, family_id=FAMILY, ring=old_ring)
    rotated = KeyRing({"1": "s" * 64, "2": "n" * 64}, "2")    # new current, old kept
    assert decode_access_token(token, rotated)["sub"] == str(USER)


def test_garbage_rejected():
    with pytest.raises(TokenError):
        decode_access_token("not.a.jwt", RING)
