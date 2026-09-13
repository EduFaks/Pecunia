import httpx


async def test_uncaught_exception_returns_500_with_request_id(app):
    @app.get("/__boom")
    async def _boom():
        raise RuntimeError("boom")

    # raise_app_exceptions=False so the client hands back the 500 response
    # ServerErrorMiddleware built instead of re-raising the RuntimeError.
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/__boom")

    assert resp.status_code == 500
    assert resp.json() == {"detail": "INTERNAL_ERROR"}
    assert "x-request-id" in resp.headers


async def test_normal_response_still_carries_request_id(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/v1/health")

    assert resp.status_code == 200
    assert "x-request-id" in resp.headers
