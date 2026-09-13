_BROWSERS = [
    ("Firefox/", "Firefox"),
    ("Edg/", "Edge"),
    ("OPR/", "Opera"),
    ("Chrome/", "Chrome"),
    ("Safari/", "Safari"),
]
_SYSTEMS = [
    ("Windows", "Windows"),
    ("Android", "Android"),
    ("iPhone", "iOS"),
    ("iPad", "iPadOS"),
    ("Mac OS X", "macOS"),
    ("Linux", "Linux"),
]


def device_label(user_agent: str | None) -> str | None:
    """Best-effort 'Firefox · Linux' label for the sessions UI. Display only —
    never a security signal. Order matters: Edge UAs contain 'Chrome/', Chrome
    UAs contain 'Safari/', iPhone UAs contain 'Mac OS X', Android contains 'Linux'."""
    if not user_agent:
        return None
    browser = next((name for token, name in _BROWSERS if token in user_agent), None)
    system = next((name for token, name in _SYSTEMS if token in user_agent), None)
    if browser and system:
        return f"{browser} · {system}"
    return browser or system
