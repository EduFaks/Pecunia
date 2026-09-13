import uuid

from pecunia.models import AuditEvent  # any workspace_id-bearing model works for the helper shape


async def test_scoped_select_filters_by_workspace(db):
    ws1, ws2 = uuid.uuid4(), uuid.uuid4()
    db.add(AuditEvent(action="account.created", workspace_id=ws1))
    db.add(AuditEvent(action="account.created", workspace_id=ws2))
    await db.flush()
    from pecunia.services.scoping import scoped_select

    rows = (await db.execute(scoped_select(AuditEvent, ws1))).scalars().all()
    assert all(r.workspace_id == ws1 for r in rows)
    assert len(rows) == 1
