import uuid

import sqlalchemy as sa

from pecunia.models import ActivityEntry, WorkspaceMembership

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def test_activity_requires_auth(client, initialized_instance):
    assert (await client.get("/api/v1/activity")).status_code == 401


async def test_activity_list_shape(client, initialized_instance):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    resp = await client.get("/api/v1/activity", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert "items" in resp.json() and "next_cursor" in resp.json()


async def test_activity_workspace_scoped(client, initialized_instance, db):
    user = initialized_instance["user"]
    own_ws = await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(WorkspaceMembership.user_id == user.id)
    )
    other_ws = uuid.uuid4()
    db.add(ActivityEntry(workspace_id=own_ws, template_key="t.own", params={}))
    db.add(ActivityEntry(workspace_id=other_ws, template_key="t.other", params={}))
    await db.commit()

    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    resp = await client.get("/api/v1/activity", headers={"Authorization": f"Bearer {token}"})
    items = resp.json()["items"]
    assert any(i["template_key"] == "t.own" for i in items)
    assert all(i["template_key"] != "t.other" for i in items)


async def test_activity_no_workspace_returns_404(client, initialized_instance, user_factory, db):
    await user_factory(email="second@example.com")
    await db.commit()
    token = (
        await client.post(
            "/api/v1/auth/login",
            json={"email": "second@example.com", "password": "correct horse battery staple"},
        )
    ).json()["access_token"]
    resp = await client.get("/api/v1/activity", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404
    assert resp.json()["detail"] == "NO_WORKSPACE"
