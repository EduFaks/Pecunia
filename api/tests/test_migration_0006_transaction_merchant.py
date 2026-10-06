"""Coverage for 0006_transaction_merchant (Add transactions.merchant, Track W —
subscription detector).

Captures the provider's structured merchant/counterparty name on imported
transactions so recurring-charge detection can group by a stable merchant
rather than the free-text `description`. Nullable and additive: manual rows,
and imported rows that predate this column, simply carry NULL.
"""

import uuid
from datetime import date

import sqlalchemy as sa

from pecunia.models.transaction import Transaction
from pecunia.models import Account


async def test_transaction_merchant_roundtrips_and_is_nullable(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]

    # Create an account for this test
    account = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name="Test", type="checking", currency="BRL"
    )
    db.add(account)
    await db.flush()
    account_id = account.id

    with_merchant = Transaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account_id,
        amount_minor=-1990, currency="BRL", description="NETFLIX",
        occurred_on=date(2026, 9, 1), external_id="ext-1", merchant="Netflix",
    )
    without = Transaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account_id,
        amount_minor=-500, currency="BRL", description="manual",
        occurred_on=date(2026, 9, 2),
    )
    db.add_all([with_merchant, without])
    await db.flush()
    stored = (await db.execute(
        sa.select(Transaction.merchant).where(Transaction.id == with_merchant.id)
    )).scalar_one()
    assert stored == "Netflix"
    null_stored = (await db.execute(
        sa.select(Transaction.merchant).where(Transaction.id == without.id)
    )).scalar_one()
    assert null_stored is None
