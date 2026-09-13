import uuid

from pecunia.context import (
    RequestContext,
    bind_context,
    current_context,
    reset_context,
    set_actor,
)


def test_bind_and_read_context():
    assert current_context() is None
    ctx = RequestContext(request_id=uuid.uuid4(), client_ip="127.0.0.1", user_agent="ua")
    token = bind_context(ctx)
    try:
        got = current_context()
        assert got is ctx
        uid, sid = uuid.uuid4(), uuid.uuid4()
        set_actor(uid, sid)
        assert current_context().actor_user_id == uid
        assert current_context().actor_session_id == sid
    finally:
        reset_context(token)
    assert current_context() is None


def test_set_actor_without_context_is_noop():
    set_actor(uuid.uuid4(), uuid.uuid4())  # must not raise
    assert current_context() is None
