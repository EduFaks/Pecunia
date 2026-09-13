import os
import secrets as _secrets
from pathlib import Path

MIN_KEY_LENGTH = 32
PLACEHOLDER_KEYS = {"change-me", "changeme", "secret", "insecure", "example", "password"}


class WeakSecretError(RuntimeError):
    """Raised when a configured PECUNIA_SECRET_KEY is unusable."""


def resolve_secret_key(configured: str, config_dir: Path) -> str:
    if configured:
        if len(configured) < MIN_KEY_LENGTH or configured.lower() in PLACEHOLDER_KEYS:
            raise WeakSecretError(
                "PECUNIA_SECRET_KEY is set but too weak (need 32+ random characters). "
                "Unset it to let Pecunia generate and persist one, or set a strong value."
            )
        return configured

    keyfile = config_dir / "secret_key"
    if keyfile.exists():
        key = keyfile.read_text().strip()
        if key:
            return key

    key = _secrets.token_hex(32)
    config_dir.mkdir(parents=True, exist_ok=True)
    # Write via a 0600 temp file + atomic rename: the key is never observable
    # at its final path incomplete or with wider permissions.
    tmp = keyfile.with_name(f"secret_key.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(key)
    os.replace(tmp, keyfile)
    return key
