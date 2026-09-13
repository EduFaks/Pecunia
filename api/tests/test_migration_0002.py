"""Coverage for 0002_loan_contact (loans.contact_id, additive on top of 0001).

The `pg_url` session fixture (conftest.py) already applies every migration up
to head — including this one — before any test runs, so schema-parity is
already re-checked by test_migration_0001.py::test_schema_parity on every
run. This file adds the one behavioral assertion specific to 0002: the new
FK is ON DELETE SET NULL, not CASCADE.
"""

import uuid

import sqlalchemy as sa

from pecunia.models import Contact, Loan, WorkspaceMembership


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def test_deleting_contact_sets_loan_contact_id_null(db, initialized_instance):
    """SET NULL: fk_loans_contact_id_contacts un-links a loan from its contact
    on delete rather than blocking the delete or cascading — the loan itself
    survives with contact_id cleared."""
    ws_id = await _ws_id(db, initialized_instance)
    contact = Contact(id=uuid.uuid4(), workspace_id=ws_id, name="Bank")
    loan = Loan(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        name="Car loan",
        direction="borrowed",
        principal_minor=2_500_000,
        currency="USD",
    )
    db.add_all([contact, loan])
    await db.flush()
    loan.contact_id = contact.id
    await db.flush()
    loan_id = loan.id

    await db.delete(contact)
    await db.flush()
    db.expire_all()

    survivor = await db.get(Loan, loan_id)
    assert survivor is not None
    assert survivor.contact_id is None
