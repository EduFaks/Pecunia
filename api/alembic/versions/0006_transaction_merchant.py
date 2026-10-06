"""Add transactions.merchant (Track W — subscription detector)

Captures the provider's structured merchant/counterparty name on imported
transactions so recurring-charge detection can group by a stable merchant
rather than the free-text `description`. Nullable and additive: manual rows,
and imported rows that predate this column, simply carry NULL.

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("transactions", sa.Column("merchant", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("transactions", "merchant")
