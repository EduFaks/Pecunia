import base64
import binascii
import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


async def cursor_page(
    db: AsyncSession,
    stmt: sa.Select,
    id_col: Any,
    *,
    cursor: int | None,
    limit: int,
    default: int = DEFAULT_LIMIT,
    cap: int = MAX_LIMIT,
) -> tuple[list, int | None]:
    """Newest-first cursor pagination. `stmt` must already be ordered by
    `id_col.desc()`. Returns (items, next_cursor); next_cursor is the last
    returned item's id when a full page was available, else None."""
    n = max(1, min(limit or default, cap))
    q = stmt
    if cursor is not None:
        q = q.where(id_col < cursor)
    q = q.limit(n + 1)
    rows = list((await db.execute(q)).scalars())
    if len(rows) > n:
        rows = rows[:n]
        return rows, rows[-1].id
    return rows, None


def encode_cursor(sort_value: Any, id_: uuid.UUID) -> str:
    """Opaque, URL-safe keyset cursor. Internally `"{sort_value}|{id}"`
    (`sort_value` via `.isoformat()` or a plain string), base64url-encoded so
    the cursor survives any query-string handling — an ISO offset's `+`, for
    instance, can't be silently turned into a space by a naive consumer."""
    sort_str = sort_value.isoformat() if hasattr(sort_value, "isoformat") else sort_value
    raw = f"{sort_str}|{id_}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[Any, uuid.UUID]:
    """Reverse of `encode_cursor`. Raises `ValueError` on a malformed cursor."""
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise ValueError("malformed cursor") from exc
    # rpartition on the last "|" — ISO datetimes never contain "|", so this is
    # safe even though the sort value itself may (in principle) contain one.
    sort_part, sep, id_part = raw.rpartition("|")
    if not sep:
        raise ValueError("malformed cursor")
    parsed_id = uuid.UUID(id_part)
    try:
        parsed_sort: Any = datetime.fromisoformat(sort_part)
    except ValueError:
        parsed_sort = sort_part
    return parsed_sort, parsed_id


async def keyset_page(
    db: AsyncSession,
    stmt: sa.Select,
    sort_col: Any,
    id_col: Any,
    *,
    cursor: str | None,
    limit: int,
    default: int = DEFAULT_LIMIT,
    cap: int = MAX_LIMIT,
    descending: bool = True,
) -> tuple[list, str | None]:
    """Keyset pagination over `(sort_col, id_col)`, for UUID-keyed domain
    tables where primary-key order carries no meaning (a random UUID isn't
    creation order). Newest-first by default (`sort_col DESC, id_col DESC`);
    pass `descending=False` for oldest/soonest-first (`sort_col ASC, id_col
    ASC`, e.g. the Planned domain's `next_due` ascending). `stmt` must already
    be ordered to match `descending` — the id tiebreaker is what keeps rows
    with an equal `sort_col` (e.g. seeded in one transaction) deterministic,
    so every row is still visited exactly once across a full walk.

    `cursor` is the opaque `"{sort_value}|{id}"` string produced by
    `encode_cursor` (typically `next_cursor` echoed back by the caller).
    Returns `(items, next_cursor)`; `next_cursor` is `None` once the final
    page is reached.

    Reading the sort attribute back off a result row is done generically via
    `Column.key` (works for both a mapped `InstrumentedAttribute` like
    `Account.created_at` and a plain `Column`), so callers don't need to pass
    the attribute name separately.
    """
    n = max(1, min(limit or default, cap))
    q = stmt
    if cursor is not None:
        parsed_sort, parsed_id = _decode_cursor(cursor)
        keyset = sa.tuple_(sort_col, id_col)
        cursor_tuple = sa.tuple_(parsed_sort, parsed_id)
        q = q.where(keyset < cursor_tuple if descending else keyset > cursor_tuple)
    q = q.limit(n + 1)
    rows = list((await db.execute(q)).scalars())
    if len(rows) > n:
        rows = rows[:n]
        last = rows[-1]
        next_cursor = encode_cursor(getattr(last, sort_col.key), getattr(last, id_col.key))
        return rows, next_cursor
    return rows, None
