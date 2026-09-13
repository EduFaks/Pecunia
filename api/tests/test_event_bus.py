import pytest

from pecunia.events.bus import DomainEvent, EventBus


@pytest.fixture
def bus():
    b = EventBus()
    yield b
    b.clear()


async def test_publish_invokes_subscribers_in_order(bus):
    calls = []

    async def h1(db, e):
        calls.append(("h1", e.action))

    async def h2(db, e):
        calls.append(("h2", e.action))

    bus.subscribe(h1)
    bus.subscribe(h2)
    await bus.publish(None, DomainEvent(action="account.created"))
    assert calls == [("h1", "account.created"), ("h2", "account.created")]


async def test_no_subscribers_is_noop(bus):
    await bus.publish(None, DomainEvent(action="x.y"))  # must not raise
