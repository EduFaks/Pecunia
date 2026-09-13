"""Unit coverage for check_origin's server_names branch. TrustedHostMiddleware
is only installed on the app when settings.server_names is configured (see
main.create_app), and it would 400 a mismatched Host before check_origin ever
ran — so this branch is exercised directly against check_origin instead of
through the client."""

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from pecunia.api.auth import check_origin


def _request(host: str) -> Request:
    scope = {"type": "http", "headers": [(b"host", host.encode())]}
    return Request(scope)


def test_check_origin_rejects_host_outside_server_names(monkeypatch):
    monkeypatch.setenv("PECUNIA_SERVER_NAMES_RAW", "pecunia.example")
    with pytest.raises(HTTPException) as exc_info:
        check_origin(_request("evil.example"))
    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "ORIGIN_MISMATCH"


def test_check_origin_allows_host_in_server_names(monkeypatch):
    monkeypatch.setenv("PECUNIA_SERVER_NAMES_RAW", "pecunia.example")
    check_origin(_request("pecunia.example"))  # must not raise
