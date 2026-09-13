import time

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine
from typer.testing import CliRunner

from pecunia.cli import (
    app,
    check_backup,
    check_database,
    check_migrations,
    check_secret,
    check_storage,
)

STRONG_KEY = "s" * 64


async def test_check_database_passes_against_test_container(engine):
    result = await check_database(engine)
    assert result.ok is True
    assert result.name == "database"
    assert result.critical is True


async def test_check_database_fails_on_bad_url():
    # Port 1 on localhost refuses connections immediately — fast, deterministic failure.
    bad_engine = create_async_engine("postgresql+asyncpg://baduser:badpass@localhost:1/nope")
    try:
        result = await check_database(bad_engine)
    finally:
        await bad_engine.dispose()
    assert result.ok is False
    assert result.name == "database"


async def test_check_migrations_reports_at_head(engine):
    # pg_url already ran `alembic upgrade head` once for the whole test session.
    result = await check_migrations(engine)
    assert result.ok is True
    assert result.name == "migrations"
    assert "head" in result.detail.lower()


async def test_check_migrations_reports_behind_when_not_at_head(engine):
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
    async with engine.begin() as conn:
        # Any revision id that isn't head demonstrates "behind" — check_migrations
        # only compares current != head, it doesn't validate the id is real.
        await conn.execute(sa.text("UPDATE alembic_version SET version_num = '0000'"))
    try:
        result = await check_migrations(engine)
        assert result.ok is False
        assert result.name == "migrations"
        assert "behind" in result.detail.lower()
    finally:
        async with engine.begin() as conn:
            await conn.execute(
                sa.text("UPDATE alembic_version SET version_num = :head").bindparams(head=head)
            )


def test_check_storage_passes_on_writable_dir(tmp_path):
    result = check_storage(tmp_path)
    assert result.ok is True
    assert result.name == "storage"


def test_check_storage_passes_on_multiple_writable_dirs(tmp_path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    result = check_storage(a, b)
    assert result.ok is True
    assert a.is_dir()
    assert b.is_dir()


def test_check_storage_fails_on_read_only_dir(tmp_path):
    read_only = tmp_path / "ro"
    read_only.mkdir()
    read_only.chmod(0o500)
    try:
        result = check_storage(read_only)
        assert result.ok is False
        assert "ro" in result.detail
    finally:
        read_only.chmod(0o700)


def test_check_secret_flags_weak_configured_key(tmp_path):
    result = check_secret("change-me", tmp_path)
    assert result.ok is False
    assert result.name == "secret"
    assert result.critical is True


def test_check_secret_passes_with_strong_configured_key(tmp_path):
    result = check_secret(STRONG_KEY, tmp_path)
    assert result.ok is True
    assert "keyfile" not in result.detail  # nothing was generated/persisted


def test_check_secret_passes_and_notes_generated_keyfile_mode(tmp_path):
    result = check_secret("", tmp_path)
    assert result.ok is True
    assert "0600" in result.detail
    assert ((tmp_path / "secret_key").stat().st_mode & 0o777) == 0o600


def test_check_backup_reports_none_found(tmp_path):
    result = check_backup(backup_dirs=[tmp_path / "does-not-exist"])
    assert result.ok is True
    assert result.critical is False
    assert "no backups found" in result.detail.lower()


def test_check_backup_reports_newest_dump(tmp_path):
    (tmp_path / "old.sql").write_text("old")
    time.sleep(0.01)
    (tmp_path / "new.dump").write_text("new")
    result = check_backup(backup_dirs=[tmp_path])
    assert result.ok is True
    assert result.critical is False
    assert "new.dump" in result.detail


def test_check_backup_never_fails_even_on_bogus_dir():
    result = check_backup(backup_dirs=[])
    assert result.ok is True
    assert result.critical is False


def test_doctor_command_exits_zero_when_everything_is_healthy(monkeypatch, tmp_path, pg_url):
    monkeypatch.setenv("PECUNIA_DATABASE_URL", pg_url)
    monkeypatch.setenv("PECUNIA_SECRET_KEY", STRONG_KEY)
    monkeypatch.setenv("PECUNIA_CONFIG_DIR", str(tmp_path / "config"))
    runner = CliRunner()
    result = runner.invoke(app, ["doctor"])
    assert result.exit_code == 0
    assert "database" in result.output
    assert "migrations" in result.output
    assert "storage" in result.output
    assert "secret" in result.output
    assert "backup" in result.output


def test_doctor_command_exits_nonzero_on_critical_failure(monkeypatch, tmp_path, pg_url):
    monkeypatch.setenv("PECUNIA_DATABASE_URL", pg_url)
    monkeypatch.setenv("PECUNIA_SECRET_KEY", "change-me")  # weak — fails the secret check
    monkeypatch.setenv("PECUNIA_CONFIG_DIR", str(tmp_path / "config"))
    runner = CliRunner()
    result = runner.invoke(app, ["doctor"])
    assert result.exit_code == 1
