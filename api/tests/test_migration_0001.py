"""Coverage for the single squashed migration (0001_initial).

The `pg_url` session fixture (conftest.py) already applies this migration to
a fresh, empty Postgres via `alembic upgrade head` before any test runs — so
every test in the suite exercises "the migration applies cleanly". This file
adds the one load-bearing assertion (`test_schema_parity`: the migrated
schema round-trips against `Base.metadata` with zero drift) plus a spot-check
per structural invariant category the old per-migration tests covered:
a CHECK constraint, a SET NULL foreign key, and a UNIQUE constraint.
"""

import uuid
from datetime import date

import pytest
import sqlalchemy as sa

from pecunia.models import (
    Account,
    AuthSession,
    Loan,
    LoanPayment,
    Transaction,
    User,
    WorkspaceMembership,
)


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def test_auth_session_revoke_reason_check_constraint(db):
    """CHECK: ck_auth_sessions_revoke_reason_valid rejects anything outside
    the RevokeReason enum (NULL is allowed — a still-live session)."""
    user = User(id=uuid.uuid4(), email="a@b.c", name="A", password_hash="x")
    db.add(user)
    await db.flush()
    db.add(
        AuthSession(
            id=uuid.uuid4(),
            user_id=user.id,
            family_id=uuid.uuid4(),
            token_hash=b"j" * 32,
            client="web",
            expires_at=sa.func.now(),
            idle_expires_at=sa.func.now(),
            revoke_reason="not_a_real_reason",
        )
    )
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_deleting_transaction_sets_loan_payment_transaction_id_null(db, initialized_instance):
    """SET NULL: fk_loan_payments_transaction_id_transactions un-links a
    payment from its funding transaction on delete rather than blocking the
    delete or cascading — the payment itself survives."""
    ws_id = await _ws_id(db, initialized_instance)
    account = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name="Checking", type="checking", currency="USD"
    )
    loan = Loan(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        name="Car loan",
        direction="borrowed",
        principal_minor=2_500_000,
        currency="USD",
    )
    db.add_all([account, loan])
    await db.flush()
    tx = Transaction(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        account_id=account.id,
        amount_minor=-45_000,
        currency="USD",
        description="loan payment",
        occurred_on=date(2026, 9, 11),
    )
    db.add(tx)
    await db.flush()
    payment = LoanPayment(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        loan_id=loan.id,
        amount_minor=45_000,
        paid_on=date(2026, 9, 11),
        transaction_id=tx.id,
    )
    db.add(payment)
    await db.flush()
    payment_id = payment.id

    await db.delete(tx)
    await db.flush()
    db.expire_all()

    still_there = await db.get(LoanPayment, payment_id)
    assert still_there is not None
    assert still_there.transaction_id is None


async def test_loan_payment_transaction_id_is_unique(db, initialized_instance):
    """UNIQUE: uq_loan_payments_transaction_id — a single transaction funds
    at most one loan payment."""
    ws_id = await _ws_id(db, initialized_instance)
    account = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name="Checking", type="checking", currency="USD"
    )
    loan = Loan(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        name="Car loan",
        direction="borrowed",
        principal_minor=2_500_000,
        currency="USD",
    )
    db.add_all([account, loan])
    await db.flush()
    tx = Transaction(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        account_id=account.id,
        amount_minor=-45_000,
        currency="USD",
        description="loan payment",
        occurred_on=date(2026, 9, 11),
    )
    db.add(tx)
    await db.flush()
    db.add(
        LoanPayment(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            loan_id=loan.id,
            amount_minor=45_000,
            paid_on=date(2026, 9, 11),
            transaction_id=tx.id,
        )
    )
    await db.flush()
    db.add(
        LoanPayment(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            loan_id=loan.id,
            amount_minor=45_000,
            paid_on=date(2026, 10, 11),
            transaction_id=tx.id,
        )
    )
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_schema_parity(engine):
    """The absolute requirement: the migrated schema reproduces
    Base.metadata byte-for-byte, names included — no drift."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    import pecunia.models  # noqa: F401
    from pecunia.models.base import Base

    def _diff(c):
        return compare_metadata(MigrationContext.configure(c), Base.metadata)

    async with engine.connect() as conn:
        diffs = await conn.run_sync(_diff)
    meaningful = [
        d for d in diffs if not (d[0] == "remove_table" and d[1].name == "alembic_version")
    ]
    assert meaningful == [], f"drift: {meaningful}"
