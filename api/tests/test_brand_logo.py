"""Best-effort brand-logo resolution (Track W.2): a curated-domain favicon
fetch. `fetch_logo`'s httpx calls are mocked via `httpx.MockTransport` — the
same idiom `test_bank_provider.py` uses — so this suite never hits the real
network. The endpoint test exercises the unknown-brand path only, for the
same reason (a known brand would make a real outbound request)."""

import base64

import httpx
import pytest

from pecunia.services.brand_logo import fetch_logo, resolve_domain

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _auth(client):
    return {
        "Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"
    }


# --------------------------------------------------------------------------- #
# resolve_domain — curated substring matching
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "name,expected",
    [
        ("YouTube", "youtube.com"),
        ("Openai", "openai.com"),
        ("Linked In", "linkedin.com"),
        ("Amazon Prime Br Sao Paulo Bra", "primevideo.com"),
        ("Anthropic Claude Sub", "anthropic.com"),
        ("Cardbankslip", None),
    ],
)
def test_resolve_domain(name, expected):
    assert resolve_domain(name) == expected


# --------------------------------------------------------------------------- #
# fetch_logo — mocked httpx transport, never the real network
# --------------------------------------------------------------------------- #


async def test_fetch_logo_returns_data_uri_for_a_known_brand():
    png_bytes = b"\x89PNG\r\n\x1a\nfake-but-small-png-bytes"

    def handler(request: httpx.Request) -> httpx.Response:
        assert dict(request.url.params) == {"domain": "netflix.com", "sz": "128"}
        return httpx.Response(200, content=png_bytes, headers={"content-type": "image/png"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await fetch_logo("Netflix", client=client)
    assert result is not None
    assert result.startswith("data:image/png;base64,")
    encoded = result.removeprefix("data:image/png;base64,")
    assert base64.b64decode(encoded) == png_bytes


async def test_fetch_logo_non_image_content_type_returns_none():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html></html>", headers={"content-type": "text/html"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await fetch_logo("Netflix", client=client) is None


async def test_fetch_logo_oversized_response_returns_none():
    oversized = b"x" * (48 * 1024 + 1)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=oversized, headers={"content-type": "image/png"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await fetch_logo("Netflix", client=client) is None


async def test_fetch_logo_unknown_brand_makes_no_request():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("fetch_logo must not call out for an unrecognized brand")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await fetch_logo("Cardbankslip", client=client) is None


async def test_fetch_logo_non_200_status_returns_none():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await fetch_logo("Netflix", client=client) is None


async def test_fetch_logo_transport_error_returns_none():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await fetch_logo("Netflix", client=client) is None


# --------------------------------------------------------------------------- #
# Endpoint — GET /subscriptions/brand-logo (unknown-brand path only; a known
# brand would make a real outbound request, which this suite never does)
# --------------------------------------------------------------------------- #


async def test_fetch_logo_at_cap_boundary_passes_subscription_validator():
    """Verify that a logo returned at _MAX_RAW_BYTES boundary stays within the
    subscription logo's 64KB encoded cap and passes the real validator."""
    from pecunia.services.brand_logo import _MAX_RAW_BYTES
    from pecunia.services.subscriptions import MAX_LOGO_BYTES, _validate_logo

    # Generate png_bytes at exactly the cap size
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"x" * (_MAX_RAW_BYTES - 8)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=png_bytes, headers={"content-type": "image/png"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await fetch_logo("Netflix", client=client)

    # Assert the result is not None
    assert result is not None

    # Assert the encoded result stays under the subscription logo limit
    assert len(result.encode("utf-8")) <= MAX_LOGO_BYTES

    # Optionally, assert _validate_logo does not raise
    _validate_logo(result)


async def test_brand_logo_endpoint_unknown_name_returns_null_logo(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get("/api/v1/subscriptions/brand-logo?name=Cardbankslip", headers=h)
    assert resp.status_code == 200
    assert resp.json() == {"logo": None}
