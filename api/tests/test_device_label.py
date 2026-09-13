from pecunia.device_label import device_label

FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
EDGE_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0"


def test_firefox_linux():
    assert device_label(FIREFOX_LINUX) == "Firefox · Linux"


def test_chrome_windows():
    assert device_label(CHROME_WIN) == "Chrome · Windows"


def test_safari_iphone():
    assert device_label(SAFARI_IPHONE) == "Safari · iOS"


def test_edge_beats_chrome_token():
    assert device_label(EDGE_MAC) == "Edge · macOS"


def test_none_and_empty():
    assert device_label(None) is None
    assert device_label("") is None


def test_unknown_agent_returns_none():
    assert device_label("curl/8.9.0") is None
