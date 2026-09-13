"""``pecunia`` operations CLI — currently just the ``doctor`` diagnostics command.

Each check is a small, mostly-pure function (name, ok, detail, critical) so it can be
unit-tested directly, without a full container: DB/migration checks take an
``AsyncEngine``; storage/secret/backup checks take plain settings values.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import NamedTuple

import sqlalchemy as sa
import typer
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from pecunia.config import Settings, get_settings
from pecunia.secrets import WeakSecretError, resolve_secret_key

app = typer.Typer(help="Pecunia operations CLI.")


@app.callback()
def main() -> None:
    """Pecunia operations CLI.

    A trivial callback — its only purpose is to keep Typer in "group" mode so
    ``doctor`` stays an explicit subcommand name (a `Typer` app with a single
    command collapses to a bare command otherwise, breaking `pecunia doctor`).
    """

# Conventional locations a `pg_dump` might be dropped by a host-cron or compose-sidecar
# backup job (spec: "V1 documents it, `pecunia doctor` checks backup age"). Best-effort
# only — nothing here is required for the app to run.
DEFAULT_BACKUP_DIRS: tuple[Path, ...] = (Path("/backups"), Path("backups"))
BACKUP_GLOBS: tuple[str, ...] = ("*.sql", "*.dump")


class CheckResult(NamedTuple):
    """One diagnostic check's outcome.

    ``critical`` checks must all pass for ``doctor`` to exit 0; a non-critical
    (informational) check is reported but never fails the run.
    """

    name: str
    ok: bool
    detail: str
    critical: bool = True


async def check_database(engine: AsyncEngine) -> CheckResult:
    """Can we open a connection to ``database_url`` and run a trivial query."""
    try:
        async with engine.connect() as conn:
            await conn.execute(sa.text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 — any connection/driver failure is a failed check
        return CheckResult("database", False, f"cannot connect: {exc}")
    return CheckResult("database", True, "connected")


def _current_revision(sync_conn: sa.Connection) -> str | None:
    return MigrationContext.configure(sync_conn).get_current_revision()


async def check_migrations(engine: AsyncEngine, alembic_ini: str = "alembic.ini") -> CheckResult:
    """Compare Alembic's current DB revision against the code's head revision."""
    try:
        script = ScriptDirectory.from_config(Config(alembic_ini))
        head = script.get_current_head()
        async with engine.connect() as conn:
            current = await conn.run_sync(_current_revision)
    except Exception as exc:  # noqa: BLE001 — any failure to determine state is a failed check
        return CheckResult("migrations", False, f"could not determine migration state: {exc}")
    if current == head:
        return CheckResult("migrations", True, f"at head ({head})")
    return CheckResult("migrations", False, f"behind head: current={current!r}, head={head!r}")


def check_storage(*directories: Path) -> CheckResult:
    """Each directory accepts a created-then-removed temp file (i.e. is writable)."""
    problems: list[str] = []
    checked: list[str] = []
    for directory in directories:
        try:
            directory.mkdir(parents=True, exist_ok=True)
            probe = directory / f".pecunia-doctor-{os.getpid()}.tmp"
            probe.write_text("ok")
            probe.unlink()
        except OSError as exc:
            problems.append(f"{directory}: {exc}")
        else:
            checked.append(str(directory))
    if problems:
        return CheckResult("storage", False, "; ".join(problems))
    return CheckResult("storage", True, f"writable: {', '.join(checked)}")


def check_secret(secret_key: str, config_dir: Path) -> CheckResult:
    """A key resolves; if one was generated, its persisted keyfile is 0600."""
    try:
        resolve_secret_key(secret_key, config_dir)
    except WeakSecretError as exc:
        return CheckResult("secret", False, str(exc))
    keyfile = config_dir / "secret_key"
    if not keyfile.exists():
        # A strong key was configured directly — nothing is persisted to disk.
        return CheckResult("secret", True, "resolved from configured PECUNIA_SECRET_KEY")
    mode = keyfile.stat().st_mode & 0o777
    if mode != 0o600:
        return CheckResult(
            "secret", False, f"keyfile {keyfile} has mode {oct(mode)}, expected 0600"
        )
    return CheckResult("secret", True, f"resolved; keyfile {keyfile} is 0600")


def check_backup(backup_dirs: Iterable[Path] = DEFAULT_BACKUP_DIRS) -> CheckResult:
    """Informational only — never fails. Notes the newest `*.sql`/`*.dump` mtime found."""
    newest_path: Path | None = None
    newest_mtime = -1.0
    for directory in backup_dirs:
        if not directory.is_dir():
            continue
        for pattern in BACKUP_GLOBS:
            for candidate in directory.glob(pattern):
                try:
                    mtime = candidate.stat().st_mtime
                except OSError:
                    continue
                if mtime > newest_mtime:
                    newest_mtime, newest_path = mtime, candidate
    if newest_path is None:
        return CheckResult("backup", True, "no backups found (informational)", critical=False)
    age = datetime.now(UTC) - datetime.fromtimestamp(newest_mtime, tz=UTC)
    return CheckResult(
        "backup", True, f"newest backup {newest_path.name} ({age.days}d old)", critical=False
    )


async def _run_db_checks(settings: Settings) -> list[CheckResult]:
    engine = create_async_engine(settings.database_url)
    try:
        return [await check_database(engine), await check_migrations(engine)]
    finally:
        await engine.dispose()


def run_all_checks(settings: Settings) -> list[CheckResult]:
    """Run every check and return results in checklist order."""
    results = asyncio.run(_run_db_checks(settings))
    # The compose volumes are conventionally siblings (`/data/config`, `/data/files`);
    # there's no dedicated "files dir" setting, so this mirrors that layout best-effort.
    files_dir = settings.config_dir.parent / "files"
    results.append(check_storage(settings.config_dir, files_dir))
    results.append(check_secret(settings.secret_key, settings.config_dir))
    results.append(check_backup())
    return results


@app.command()
def doctor() -> None:
    """Run diagnostic checks and print a checklist; exit 1 if a critical check fails."""
    settings = get_settings()
    results = run_all_checks(settings)
    all_critical_ok = True
    for result in results:
        mark = "✓" if result.ok else "✗"
        typer.echo(f"{mark} {result.name}: {result.detail}")
        if result.critical and not result.ok:
            all_critical_ok = False
    raise typer.Exit(code=0 if all_critical_ok else 1)
