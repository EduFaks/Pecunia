from pecunia.security.passwords import hash_password, verify_password


def test_hash_and_verify_roundtrip():
    h = hash_password("correct horse battery staple")
    assert h.startswith("$argon2id$")
    assert verify_password("correct horse battery staple", h) is True


def test_wrong_password_fails():
    h = hash_password("correct horse battery staple")
    assert verify_password("wrong password entirely", h) is False


def test_garbage_hash_returns_false_not_raise():
    assert verify_password("anything", "not-a-hash") is False


def test_hashes_are_salted_unique():
    assert hash_password("same input") != hash_password("same input")


def test_truncated_hash_with_valid_prefix_returns_false_not_raise():
    h = hash_password("correct horse battery staple")
    assert verify_password("correct horse battery staple", h[:20]) is False


def test_dummy_hash_is_real_argon2id_and_never_verifies():
    from pecunia.security.passwords import DUMMY_HASH

    assert DUMMY_HASH.startswith("$argon2id$")
    assert verify_password("pecunia-timing-equalizer", DUMMY_HASH) is True  # it's a real hash…
    assert verify_password("anything else", DUMMY_HASH) is False
