import uuid

import sqlalchemy as sa

from pecunia.events.bus import DomainEvent
from pecunia.models import ActivityEntry
from pecunia.services.activity import project_activity


async def test_event_with_activity_template_projects_entry(db):
    ws = uuid.uuid4()
    ev = DomainEvent(
        action="asset.valuation.updated", resource_type="asset", resource_id="a1",
        workspace_id=ws, activity_template="activity.asset.valuation_changed",
        activity_params={"asset": "Mercedes", "from": 480000, "to": 462000, "currency": "BRL"},
    )
    entry = await project_activity(db, ev)
    assert entry is not None
    row = (await db.execute(sa.select(ActivityEntry))).scalar_one()
    assert row.template_key == "activity.asset.valuation_changed"
    assert row.workspace_id == ws
    assert row.params["to"] == 462000


async def test_event_without_activity_template_is_skipped(db):
    ev = DomainEvent(action="auth.login.failed")
    assert await project_activity(db, ev) is None
    count = (await db.execute(sa.select(sa.func.count()).select_from(ActivityEntry))).scalar_one()
    assert count == 0
