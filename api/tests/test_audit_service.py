import uuid

import sqlalchemy as sa

from pecunia.audit.actions import Actions
from pecunia.context import RequestContext, bind_context, reset_context
from pecunia.models import AuditEvent
from pecunia.services.audit import record_event


async def test_record_event_captures_context(db):
    rid, uid, sid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ctx = RequestContext(request_id=rid, actor_user_id=uid, actor_session_id=sid,
                         client_ip="203.0.113.5", user_agent="ua/1")
    token = bind_context(ctx)
    try:
        await record_event(db, action=Actions.ACCOUNT_CREATED, resource_type="account",
                           resource_id="acc-1", workspace_id=None, metadata={"name": "Checking"})
    finally:
        reset_context(token)
    row = (await db.execute(sa.select(AuditEvent))).scalar_one()
    assert row.action == "account.created"
    assert row.actor_user_id == uid
    assert row.request_id == rid
    assert str(row.ip) == "203.0.113.5"
    assert row.metadata_ == {"name": "Checking"}


async def test_record_event_without_context_still_writes(db):
    await record_event(db, action=Actions.SETUP_COMPLETED)
    row = (await db.execute(sa.select(AuditEvent))).scalar_one()
    assert row.action == "setup.completed"
    assert row.actor_user_id is None


async def test_record_event_scrubs_secret_like_metadata_keys(db):
    await record_event(
        db,
        action=Actions.AUTH_LOGIN_SUCCESS,
        metadata={"email": "a@b.c", "access_token": "xyz"},
    )
    row = (await db.execute(sa.select(AuditEvent))).scalar_one()
    assert row.metadata_ == {"email": "a@b.c"}
