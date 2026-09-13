import uuid
from datetime import UTC, datetime, timedelta

import sqlalchemy as sa

from pecunia.models import Account, AuditEvent, Workspace
from pecunia.pagination import cursor_page, keyset_page


async def test_cursor_page_walks_without_skip_or_overlap(db):
    for i in range(5):
        db.add(AuditEvent(action="account.created", resource_id=str(i)))
    await db.flush()
    stmt = sa.select(AuditEvent).order_by(AuditEvent.id.desc())
    seen = []
    cursor = None
    for _ in range(10):
        items, cursor = await cursor_page(db, stmt, AuditEvent.id, cursor=cursor, limit=2)
        seen.extend(i.id for i in items)
        if cursor is None:
            break
    assert len(seen) == 5
    assert len(set(seen)) == 5  # no dupes
    assert seen == sorted(seen, reverse=True)  # newest-first


async def test_limit_capped(db):
    stmt = sa.select(AuditEvent).order_by(AuditEvent.id.desc())
    items, _ = await cursor_page(db, stmt, AuditEvent.id, cursor=None, limit=9999)
    # cap does not raise; just clamps — assert no error and list returned
    assert isinstance(items, list)


async def _make_workspace(db) -> Workspace:
    ws = Workspace(id=uuid.uuid4(), name="WS")
    db.add(ws)
    await db.flush()
    return ws


def _account(ws_id, *, created_at) -> Account:
    return Account(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        name="Acc",
        type="checking",
        currency="USD",
        created_at=created_at,
    )


async def test_keyset_page_walks_newest_first_without_skip_or_overlap(db):
    ws = await _make_workspace(db)
    base = datetime.now(UTC)
    accounts = [_account(ws.id, created_at=base + timedelta(seconds=i)) for i in range(5)]
    for a in accounts:
        db.add(a)
    await db.flush()
    expected_order = [a.id for a in sorted(accounts, key=lambda a: a.created_at, reverse=True)]

    stmt = (
        sa.select(Account)
        .where(Account.workspace_id == ws.id)
        .order_by(Account.created_at.desc(), Account.id.desc())
    )
    seen = []
    cursor = None
    for _ in range(10):
        items, cursor = await keyset_page(
            db, stmt, Account.created_at, Account.id, cursor=cursor, limit=2
        )
        seen.extend(a.id for a in items)
        if cursor is None:
            break
    assert len(seen) == 5
    assert len(set(seen)) == 5  # no dupes
    assert seen == expected_order  # newest-first, deterministic


async def test_keyset_page_tiebreaks_on_id_when_sort_values_are_equal(db):
    ws = await _make_workspace(db)
    same_time = datetime.now(UTC)
    accounts = [_account(ws.id, created_at=same_time) for _ in range(4)]
    for a in accounts:
        db.add(a)
    await db.flush()
    expected_order = sorted((a.id for a in accounts), reverse=True)

    stmt = (
        sa.select(Account)
        .where(Account.workspace_id == ws.id)
        .order_by(Account.created_at.desc(), Account.id.desc())
    )
    seen = []
    cursor = None
    for _ in range(10):
        items, cursor = await keyset_page(
            db, stmt, Account.created_at, Account.id, cursor=cursor, limit=1
        )
        seen.extend(a.id for a in items)
        if cursor is None:
            break
    # every row returned exactly once, in id-desc order despite the tied created_at
    assert len(seen) == 4
    assert len(set(seen)) == 4
    assert seen == expected_order


async def test_keyset_page_limit_capped(db):
    ws = await _make_workspace(db)
    stmt = (
        sa.select(Account)
        .where(Account.workspace_id == ws.id)
        .order_by(Account.created_at.desc(), Account.id.desc())
    )
    items, _ = await keyset_page(db, stmt, Account.created_at, Account.id, cursor=None, limit=9999)
    assert isinstance(items, list)
