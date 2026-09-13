"""Entrypoint step 1: block until PostgreSQL accepts connections (bounded)."""
import asyncio
import sys
import time

import asyncpg

from pecunia.config import get_settings


async def _try_connect(dsn: str) -> None:
    conn = await asyncpg.connect(dsn)
    await conn.close()


def main(timeout_seconds: int = 60) -> None:
    dsn = get_settings().database_url.replace("postgresql+asyncpg://", "postgresql://")
    deadline = time.monotonic() + timeout_seconds
    attempt = 0
    while True:
        attempt += 1
        try:
            asyncio.run(_try_connect(dsn))
            print(f"pecunia: database ready (attempt {attempt})", flush=True)
            return
        except Exception as exc:  # noqa: BLE001 — any failure means "not ready yet"
            if time.monotonic() > deadline:
                print(f"pecunia: database unreachable after {timeout_seconds}s: {exc}", file=sys.stderr)
                sys.exit(1)
            print(f"pecunia: waiting for database ({type(exc).__name__})", flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
