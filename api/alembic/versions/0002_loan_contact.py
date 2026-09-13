"""Add loans.contact_id (the lender/lendee link)

Additive, FK-safe migration on top of the squashed 0001_initial (live DB —
never edit 0001 in place). Adds a nullable `contact_id` on `loans`, FK to
`contacts` with ON DELETE SET NULL (mirrors scheduled_transactions/
subscriptions: deleting a contact never deletes or blocks-deletes a loan, it
just un-links it), indexed for the `?contact_id=` list filter.

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("loans", sa.Column("contact_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_loans_contact_id_contacts"),
        "loans",
        "contacts",
        ["contact_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(op.f("ix_loans_contact_id"), "loans", ["contact_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_loans_contact_id"), table_name="loans")
    op.drop_constraint(op.f("fk_loans_contact_id_contacts"), "loans", type_="foreignkey")
    op.drop_column("loans", "contact_id")
