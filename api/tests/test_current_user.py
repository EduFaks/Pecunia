import uuid
from typing import Annotated

import httpx
import pytest
from fastapi import Depends

from conftest import TEST_SECRET_KEY
from pecunia.security.tokens import KeyRing, create_access_token
from pecunia.services.auth import AuthService

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"


def _mint(user_id: uuid.UUID, family_id: uuid.UUID) -> str:
    return create_access_token(
        user_id=user_id, family_id=family_id, ring=KeyRing.single(TEST_SECRET_KEY)
    )


@pytest.fixture
async def me_app(app):
    from pecunia.api.deps import AuthContext, get_current_user

    @app.get("/api/v1/_whoami")
    async def _whoami(ctx: Annotated[AuthContext, Depends(get_current_user)]):
        return {"user_id": str(ctx.user.id), "family_id": str(ctx.family_id)}

    return app


@pytest.fixture
async def me_client(me_app):
    transport = httpx.ASGITransport(app=me_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def test_valid_token_resolves_user(db, user_factory, me_client):
    user = await user_factory()
    session, _ = await AuthService(db).create_session(user, client="web", ip=None, user_agent=UA)
    await db.commit()
    resp = await me_client.get(
        "/api/v1/_whoami", headers={"Authorization": f"Bearer {_mint(user.id, session.family_id)}"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"user_id": str(user.id), "family_id": str(session.family_id)}


async def test_missing_and_garbage_tokens_rejected(me_client):
    assert (await me_client.get("/api/v1/_whoami")).status_code == 401
    resp = await me_client.get("/api/v1/_whoami", headers={"Authorization": "Bearer junk"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "NOT_AUTHENTICATED"


async def test_unknown_session_family_rejected(db, user_factory, me_client):
    user = await user_factory()
    await db.commit()
    resp = await me_client.get(
        "/api/v1/_whoami", headers={"Authorization": f"Bearer {_mint(user.id, uuid.uuid4())}"}
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "SESSION_REVOKED"


async def test_revocation_lag_is_bounded_by_cache_and_invalidate_is_instant(
    db, user_factory, me_app, me_client
):
    user = await user_factory()
    svc = AuthService(db)
    session, _ = await svc.create_session(user, client="web", ip=None, user_agent=UA)
    await db.commit()
    token = _mint(user.id, session.family_id)
    headers = {"Authorization": f"Bearer {token}"}

    assert (await me_client.get("/api/v1/_whoami", headers=headers)).status_code == 200
    # Revoke WITHOUT invalidating: the cached 'alive' answer still serves (the ≤30s lag).
    await svc.revoke_family(session.family_id, reason="logout")
    await db.commit()
    assert (await me_client.get("/api/v1/_whoami", headers=headers)).status_code == 200
    # Invalidate (what every revocation endpoint does in-process): instant rejection.
    me_app.state.session_cache.invalidate(session.family_id)
    resp = await me_client.get("/api/v1/_whoami", headers=headers)
    assert resp.status_code == 401
    assert resp.json()["detail"] == "SESSION_REVOKED"


@pytest.fixture
async def fresh_app(app):
    from pecunia.api.deps import AuthContext, get_current_user_fresh

    @app.get("/api/v1/_fresh")
    async def _fresh(ctx: Annotated[AuthContext, Depends(get_current_user_fresh)]):
        return {"user_id": str(ctx.user.id)}

    return app


async def test_fresh_dependency_bypasses_stale_cache(db, user_factory, fresh_app):
    user = await user_factory()
    svc = AuthService(db)
    session, _ = await svc.create_session(user, client="web", ip=None, user_agent=UA)
    await db.commit()
    token = _mint(user.id, session.family_id)
    headers = {"Authorization": f"Bearer {token}"}
    transport = httpx.ASGITransport(app=fresh_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/api/v1/_fresh", headers=headers)).status_code == 200
        # Revoke WITHOUT invalidating the cache: fresh path must reject instantly.
        await svc.revoke_family(session.family_id, reason="logout")
        await db.commit()
        resp = await client.get("/api/v1/_fresh", headers=headers)
    assert resp.status_code == 401
    assert resp.json()["detail"] == "SESSION_REVOKED"


async def test_malformed_claim_uuids_yield_401_not_500(me_client):
    token = create_access_token(
        user_id=uuid.uuid4(), family_id=uuid.uuid4(), ring=KeyRing.single(TEST_SECRET_KEY)
    )
    # Forge a validly-signed token whose sid is not a UUID.
    import jwt as pyjwt
    claims = pyjwt.decode(token, TEST_SECRET_KEY, algorithms=["HS256"], options={"verify_aud": False})
    claims["sid"] = "not-a-uuid"
    forged = pyjwt.encode(claims, TEST_SECRET_KEY, algorithm="HS256", headers={"kid": "1"})
    resp = await me_client.get("/api/v1/_whoami", headers={"Authorization": f"Bearer {forged}"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "NOT_AUTHENTICATED"
