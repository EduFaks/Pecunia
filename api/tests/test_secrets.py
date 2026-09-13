import pytest

from pecunia.secrets import WeakSecretError, resolve_secret_key


def test_configured_strong_key_is_used(tmp_path):
    key = "a" * 64
    assert resolve_secret_key(key, tmp_path) == key


def test_short_configured_key_refused(tmp_path):
    with pytest.raises(WeakSecretError):
        resolve_secret_key("too-short", tmp_path)


def test_placeholder_key_refused(tmp_path):
    with pytest.raises(WeakSecretError):
        resolve_secret_key("change-me", tmp_path)


def test_generated_key_is_persisted_and_reused(tmp_path):
    first = resolve_secret_key("", tmp_path)
    second = resolve_secret_key("", tmp_path)
    assert first == second
    assert len(first) == 64  # 32 random bytes, hex-encoded
    keyfile = tmp_path / "secret_key"
    assert keyfile.read_text().strip() == first
    assert (keyfile.stat().st_mode & 0o777) == 0o600


def test_empty_keyfile_is_replaced_with_fresh_key(tmp_path):
    (tmp_path / "secret_key").write_text("")
    key = resolve_secret_key("", tmp_path)
    assert len(key) == 64
    assert (tmp_path / "secret_key").read_text().strip() == key
    assert ((tmp_path / "secret_key").stat().st_mode & 0o777) == 0o600
