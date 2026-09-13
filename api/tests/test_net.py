from pecunia.net import client_ip_from_scope


def test_no_forwarded_uses_socket_peer():
    assert client_ip_from_scope("203.0.113.9", None, []) == "203.0.113.9"


def test_forwarded_honored_only_from_trusted_peer():
    # peer is the trusted proxy → trust the leftmost XFF entry
    assert client_ip_from_scope("10.0.0.2", "198.51.100.7, 10.0.0.2", ["10.0.0.2"]) == "198.51.100.7"


def test_forwarded_ignored_from_untrusted_peer():
    assert client_ip_from_scope("203.0.113.9", "1.2.3.4", []) == "203.0.113.9"


def test_empty_forwarded_falls_back_to_peer():
    assert client_ip_from_scope("10.0.0.2", "", ["10.0.0.2"]) == "10.0.0.2"


def test_none_peer_is_none():
    assert client_ip_from_scope(None, None, []) is None


def test_invalid_forwarded_value_falls_back_to_socket_peer():
    # trusted proxy sends a garbage leftmost token ("unknown") — never trust it
    # verbatim into an INET column; fall back to the socket peer.
    assert client_ip_from_scope("10.0.0.2", "unknown, 10.0.0.2", ["10.0.0.2"]) == "10.0.0.2"


def test_valid_forwarded_value_still_parsed():
    assert client_ip_from_scope("10.0.0.2", "198.51.100.7, 10.0.0.2", ["10.0.0.2"]) == "198.51.100.7"
