import re

from pecunia.audit.allowlists import ALLOWLISTS

FORBIDDEN = re.compile(r"password|secret|token|hash|key", re.IGNORECASE)


def test_no_allowlist_field_is_secret_like():
    offenders = [
        (rt, f) for rt, fields in ALLOWLISTS.items() for f in fields if FORBIDDEN.search(f)
    ]
    assert offenders == [], f"secret-like fields allow-listed: {offenders}"
