import httpx
import sqlalchemy as sa
from fastapi import Depends


async def test_status_reports_uninitialized(client):
    resp = await client.get("/api/v1/setup/status")
    assert resp.status_code == 200
    assert resp.json() == {"initialized": False}


async def test_require_initialized_blocks_while_uninitialized(app):
    from pecunia.api.deps import require_initialized

    @app.get("/api/v1/_gated", dependencies=[Depends(require_initialized)])
    async def _gated():
        return {"ok": True}

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/v1/_gated")
    assert resp.status_code == 409
    assert resp.json()["detail"] == "SETUP_REQUIRED"


async def test_initialized_flips_status_and_gates(app, db):
    from pecunia.api.deps import require_uninitialized

    @app.get("/api/v1/_setup-only", dependencies=[Depends(require_uninitialized)])
    async def _setup_only():
        return {"ok": True}

    await db.execute(sa.text("UPDATE instance_state SET initialized_at = now() WHERE id = 1"))
    await db.commit()
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            status = await client.get("/api/v1/setup/status")
            gated = await client.get("/api/v1/_setup-only")
        assert status.json() == {"initialized": True}
        assert gated.status_code == 409
        assert gated.json()["detail"] == "SETUP_ALREADY_COMPLETE"
    finally:
        await db.execute(sa.text("UPDATE instance_state SET initialized_at = NULL WHERE id = 1"))
        await db.commit()
