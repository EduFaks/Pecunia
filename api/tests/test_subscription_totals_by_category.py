
from pecunia.models import PALETTE

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _auth(client):
    return {
        "Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"
    }


async def _sub(client, h, **overrides):
    body = {
        "name": "Netflix",
        "amount_minor": 1500,
        "currency": "USD",
        "billing_frequency": "monthly",
        "next_renewal": "2026-10-01",
    }
    body.update(overrides)
    return (await client.post("/api/v1/subscriptions", json=body, headers=h)).json()


async def _category(client, h, **overrides):
    body = {
        "name": "Entertainment",
        "kind": "expense",
        "color": PALETTE[0],
        "icon": "tv",
    }
    body.update(overrides)
    return (await client.post("/api/v1/categories", json=body, headers=h)).json()


async def test_subscription_totals_by_category(client, initialized_instance):
    """Test that subscription totals include per-category breakdowns."""
    h = await _auth(client)

    # Create two categories
    cat_a = await _category(client, h, name="A")

    # Seed subscriptions in one currency:
    # - Two monthly subs in category A: 1000 + 2000 = 3000/mo
    # - One yearly sub with no category: 12000/yr = 1000/mo
    await _sub(client, h, name="Sub A1", amount_minor=1000, currency="USD",
               billing_frequency="monthly", category_id=cat_a["id"])
    await _sub(client, h, name="Sub A2", amount_minor=2000, currency="USD",
               billing_frequency="monthly", category_id=cat_a["id"])
    await _sub(client, h, name="Sub None", amount_minor=12000, currency="USD",
               billing_frequency="yearly")

    # Call totals endpoint
    resp = await client.get("/api/v1/subscriptions/totals", headers=h)
    assert resp.status_code == 200

    body = resp.json()["USD"]

    # Verify existing rollup fields are unchanged
    assert body["monthly_minor"] == 1000 + 2000 + 1000  # 4000
    assert body["annual_minor"] == 12000 + 24000 + 12000  # 48000
    assert body["count"] == 3

    # Verify by_category structure
    assert "by_category" in body
    cats = {c["name"]: c for c in body["by_category"]}

    # Category A should have the two monthly subs
    assert "A" in cats
    assert cats["A"]["monthly_minor"] == 1000 + 2000  # 3000
    assert cats["A"]["annual_minor"] == 12000 + 24000  # 36000
    assert cats["A"]["count"] == 2
    assert cats["A"]["category_id"] == str(cat_a["id"])

    # Uncategorized bucket
    uncategorized = next(c for c in body["by_category"] if c["category_id"] is None)
    assert uncategorized["name"] is None
    assert uncategorized["monthly_minor"] == 1000
    assert uncategorized["annual_minor"] == 12000
    assert uncategorized["count"] == 1
