import uuid

import sqlalchemy as sa

from pecunia.models import PALETTE, AuditEvent

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
NEW = {"name": "Green Valley Market"}

# A minimal, well-formed base64 data-URI (well under the ~64KB cap).
SMALL_AVATAR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="


async def _auth(client, initialized_instance):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def _category(client, h, **overrides):
    body = {"name": "Test Category", "kind": "expense", "color": PALETTE[0], "icon": None}
    body.update(overrides)
    return (await client.post("/api/v1/categories", json=body, headers=h)).json()


async def _other_workspace_headers(client, user_factory, db):
    """Create a second workspace + owner and return its auth headers."""
    from pecunia.models import Workspace, WorkspaceMembership
    from pecunia.services.categories import seed_default_categories

    other_user = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other_user.id, role="owner"))
    await seed_default_categories(db, other_ws.id)
    await db.commit()
    token = (
        await client.post(
            "/api/v1/auth/login",
            json={"email": "other@example.com", "password": "correct horse battery staple"},
        )
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def test_create_contact(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/contacts", json=NEW, headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Green Valley Market"
    assert body["default_category_id"] is None
    assert body["type"] == "company"  # server default
    assert body["avatar"] is None
    assert body["archived_at"] is None
    assert body["is_demo"] is False
    assert "created_at" in body
    assert uuid.UUID(body["id"])


async def test_create_contact_persists_type(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/contacts", json=NEW | {"type": "person"}, headers=h)
    assert resp.status_code == 201
    assert resp.json()["type"] == "person"
    # and the type survives a re-fetch
    got = (await client.get(f"/api/v1/contacts/{resp.json()['id']}", headers=h)).json()
    assert got["type"] == "person"


async def test_create_contact_rejects_bad_type(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/contacts", json=NEW | {"type": "robot"}, headers=h)
    assert resp.status_code == 422  # enum-typed schema rejects it


async def test_create_contact_with_valid_avatar_round_trips(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/contacts", json=NEW | {"avatar": SMALL_AVATAR}, headers=h)
    assert resp.status_code == 201
    assert resp.json()["avatar"] == SMALL_AVATAR
    got = (await client.get(f"/api/v1/contacts/{resp.json()['id']}", headers=h)).json()
    assert got["avatar"] == SMALL_AVATAR


async def test_create_contact_rejects_invalid_avatar_prefix(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post(
        "/api/v1/contacts", json=NEW | {"avatar": "data:text/plain;base64,aGVsbG8="}, headers=h
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "AVATAR_INVALID"


async def test_create_contact_rejects_oversized_avatar(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    oversized = "data:image/png;base64," + "A" * (65 * 1024)
    resp = await client.post("/api/v1/contacts", json=NEW | {"avatar": oversized}, headers=h)
    assert resp.status_code == 422
    assert resp.json()["detail"] == "AVATAR_INVALID"


async def test_update_contact_avatar_set_and_clear(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/contacts", json=NEW, headers=h)).json()
    # set
    resp = await client.patch(
        f"/api/v1/contacts/{created['id']}", json={"avatar": SMALL_AVATAR}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["avatar"] == SMALL_AVATAR
    # clear (explicit null)
    resp = await client.patch(
        f"/api/v1/contacts/{created['id']}", json={"avatar": None}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["avatar"] is None


async def test_update_contact_rejects_invalid_avatar(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/contacts", json=NEW, headers=h)).json()
    resp = await client.patch(
        f"/api/v1/contacts/{created['id']}", json={"avatar": "not-a-data-uri"}, headers=h
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "AVATAR_INVALID"


async def test_create_contact_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/contacts", json=NEW)
    assert resp.status_code == 401


async def test_create_contact_with_default_category(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    cat = await _category(client, h)
    resp = await client.post(
        "/api/v1/contacts", json=NEW | {"default_category_id": cat["id"]}, headers=h
    )
    assert resp.status_code == 201
    assert resp.json()["default_category_id"] == cat["id"]


async def test_create_contact_with_default_category_from_other_workspace_rejected(
    client, initialized_instance, user_factory, db
):
    h = await _auth(client, initialized_instance)
    other_h = await _other_workspace_headers(client, user_factory, db)
    other_cat = await _category(client, other_h)
    resp = await client.post(
        "/api/v1/contacts", json=NEW | {"default_category_id": other_cat["id"]}, headers=h
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "DEFAULT_CATEGORY_NOT_FOUND"


async def test_list_and_get(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/contacts", json=NEW, headers=h)).json()
    lst = (await client.get("/api/v1/contacts", headers=h)).json()
    assert any(c["id"] == created["id"] for c in lst["items"])
    assert "next_cursor" in lst
    got = await client.get(f"/api/v1/contacts/{created['id']}", headers=h)
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]


async def test_list_pagination_orders_newest_first_with_string_cursor(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    # A fresh workspace starts with no contacts, so the created rows are the
    # only ones — page limit=1 and confirm newest-first keyset order.
    created_ids = []
    for i in range(3):
        c = (await client.post("/api/v1/contacts", json={"name": f"Contact{i}"}, headers=h)).json()
        created_ids.append(c["id"])

    seen = []
    cursor = None
    while len(seen) < len(created_ids):
        params = {"limit": 1, "cursor": cursor} if cursor is not None else {"limit": 1}
        page = (await client.get("/api/v1/contacts", params=params, headers=h)).json()
        seen.extend(c["id"] for c in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert seen == list(reversed(created_ids))  # newest-first, not random UUID order


async def test_get_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.get(f"/api/v1/contacts/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CONTACT_NOT_FOUND"


async def test_update_contact(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/contacts", json=NEW, headers=h)).json()
    resp = await client.patch(
        f"/api/v1/contacts/{created['id']}", json={"name": "Green Valley"}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Green Valley"
    got = (await client.get(f"/api/v1/contacts/{created['id']}", headers=h)).json()
    assert got["name"] == "Green Valley"


async def test_update_contact_type(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/contacts", json=NEW, headers=h)).json()
    assert created["type"] == "company"
    resp = await client.patch(
        f"/api/v1/contacts/{created['id']}", json={"type": "person"}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["type"] == "person"


async def test_update_contact_set_and_clear_default_category(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    cat = await _category(client, h)
    created = (await client.post("/api/v1/contacts", json=NEW, headers=h)).json()
    # set
    resp = await client.patch(
        f"/api/v1/contacts/{created['id']}", json={"default_category_id": cat["id"]}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["default_category_id"] == cat["id"]
    # clear (explicit null)
    resp = await client.patch(
        f"/api/v1/contacts/{created['id']}", json={"default_category_id": None}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["default_category_id"] is None


async def test_update_contact_with_default_category_from_other_workspace_rejected(
    client, initialized_instance, user_factory, db
):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/contacts", json=NEW, headers=h)).json()
    other_h = await _other_workspace_headers(client, user_factory, db)
    other_cat = await _category(client, other_h)
    resp = await client.patch(
        f"/api/v1/contacts/{created['id']}",
        json={"default_category_id": other_cat["id"]},
        headers=h,
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "DEFAULT_CATEGORY_NOT_FOUND"


async def test_update_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.patch(f"/api/v1/contacts/{uuid.uuid4()}", json={"name": "X"}, headers=h)
    assert resp.status_code == 404


async def test_archive(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    contact = (await client.post("/api/v1/contacts", json=NEW, headers=h)).json()
    assert (
        await client.post(f"/api/v1/contacts/{contact['id']}/archive", headers=h)
    ).status_code == 204
    # archived contacts excluded from the default list
    lst = (await client.get("/api/v1/contacts", headers=h)).json()
    assert all(c["id"] != contact["id"] for c in lst["items"])
    # but still fetchable directly, reflecting archived_at
    got = (await client.get(f"/api/v1/contacts/{contact['id']}", headers=h)).json()
    assert got["archived_at"] is not None
    # include_archived=true brings it back
    lst_all = (await client.get("/api/v1/contacts?include_archived=true", headers=h)).json()
    assert any(c["id"] == contact["id"] for c in lst_all["items"])


async def test_archive_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post(f"/api/v1/contacts/{uuid.uuid4()}/archive", headers=h)
    assert resp.status_code == 404


async def test_cross_workspace_access_is_404(client, initialized_instance, user_factory, db):
    h = await _auth(client, initialized_instance)
    contact = (await client.post("/api/v1/contacts", json=NEW, headers=h)).json()
    other_h = await _other_workspace_headers(client, user_factory, db)

    assert (
        await client.get(f"/api/v1/contacts/{contact['id']}", headers=other_h)
    ).status_code == 404
    assert (
        await client.patch(
            f"/api/v1/contacts/{contact['id']}", json={"name": "Hijacked"}, headers=other_h
        )
    ).status_code == 404
    assert (
        await client.post(f"/api/v1/contacts/{contact['id']}/archive", headers=other_h)
    ).status_code == 404
    lst = (await client.get("/api/v1/contacts", headers=other_h)).json()
    assert all(c["id"] != contact["id"] for c in lst["items"])


async def test_contact_created_updated_archived_are_audited(client, initialized_instance, db):
    h = await _auth(client, initialized_instance)
    contact = (await client.post("/api/v1/contacts", json=NEW, headers=h)).json()
    await client.patch(f"/api/v1/contacts/{contact['id']}", json={"name": "Renamed"}, headers=h)
    await client.post(f"/api/v1/contacts/{contact['id']}/archive", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "contact.created" in actions
    assert "contact.updated" in actions
    assert "contact.archived" in actions
