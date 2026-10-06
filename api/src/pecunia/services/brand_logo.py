"""Best-effort brand-logo resolution for subscription suggestions (Track W.2).
Maps a detected subscription name to a known brand domain and fetches that
domain's favicon from a public favicon service, returned as a size-capped
base64 data-URI suitable for Subscription.logo. Best-effort: any miss (unknown
brand, fetch error, non-image or oversized response) returns None and the UI
falls back to its monogram. SSRF-safe: the fetched domain is always one of the
curated constants below — never anything derived from caller input beyond
substring selection."""

import base64

import httpx

_FAVICON_URL = "https://www.google.com/s2/favicons"
_FAVICON_SIZE = 128
_FETCH_TIMEOUT = 5.0
# Raw-byte cap chosen so the base64 string (~4/3x) stays under the subscription
# logo's 64KB encoded cap (SubscriptionService.MAX_LOGO_BYTES). 48KB raw -> ~64KB b64.
_MAX_RAW_BYTES = 48 * 1024

# Substring (of the lowercased, space-stripped name) -> brand domain. More
# specific keys first so "amazonprime" wins before a bare "amazon".
_BRAND_DOMAINS: list[tuple[str, str]] = [
    ("anthropic", "anthropic.com"),
    ("claude", "claude.ai"),
    ("chatgpt", "openai.com"),
    ("openai", "openai.com"),
    ("amazonprime", "primevideo.com"),
    ("primevideo", "primevideo.com"),
    ("amazon", "amazon.com"),
    ("youtube", "youtube.com"),
    ("netflix", "netflix.com"),
    ("spotify", "spotify.com"),
    ("disney", "disneyplus.com"),
    ("hbomax", "max.com"),
    ("linkedin", "linkedin.com"),
    ("uber", "uber.com"),
    ("splice", "splice.com"),
    ("ouraring", "ouraring.com"),
    ("oura", "ouraring.com"),
    ("reelshort", "reelshort.com"),
    ("apple", "apple.com"),
    ("icloud", "apple.com"),
    ("github", "github.com"),
    ("notion", "notion.so"),
    ("figma", "figma.com"),
    ("dropbox", "dropbox.com"),
    ("adobe", "adobe.com"),
    ("canva", "canva.com"),
    ("duolingo", "duolingo.com"),
    ("deezer", "deezer.com"),
    ("tidal", "tidal.com"),
    ("paramount", "paramountplus.com"),
    ("globoplay", "globo.com"),
    ("playstation", "playstation.com"),
    ("nintendo", "nintendo.com"),
    ("microsoft", "microsoft.com"),
    ("google", "google.com"),
]


def resolve_domain(name: str) -> str | None:
    """The brand domain for a subscription name, or None if unrecognized.
    Case- and space-insensitive substring match against the curated map."""
    key = "".join(name.lower().split())
    for keyword, domain in _BRAND_DOMAINS:
        if keyword in key:
            return domain
    return None


async def fetch_logo(name: str, *, client: httpx.AsyncClient | None = None) -> str | None:
    """Best-effort base64 data-URI logo for a brand name, or None. Resolves the
    brand domain, fetches its favicon, and returns `data:image/png;base64,...`
    when the response is an image within the raw-size cap. Never raises — any
    failure returns None (the UI shows a monogram)."""
    domain = resolve_domain(name)
    if domain is None:
        return None
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=_FETCH_TIMEOUT)
    try:
        resp = await client.get(_FAVICON_URL, params={"domain": domain, "sz": _FAVICON_SIZE})
        if resp.status_code != 200:
            return None
        if not resp.headers.get("content-type", "").startswith("image/"):
            return None
        data = resp.content
        if not data or len(data) > _MAX_RAW_BYTES:
            return None
        return "data:image/png;base64," + base64.b64encode(data).decode("ascii")
    except (httpx.HTTPError, ValueError):
        return None
    finally:
        if owns_client:
            await client.aclose()
