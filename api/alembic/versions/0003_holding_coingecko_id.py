"""Add holdings.coingecko_id (Track Q — crypto price sync)

Additive, hand-written migration on top of 0002_loan_contact (live DB — never
edit 0001/0002 in place). Adds a nullable `coingecko_id` on `holdings`: a
non-null value marks the holding as auto-priceable via CoinGecko's `simple/
price`. No index — the daily/on-demand refresh already scopes its scan to one
workspace at a time via the existing `holdings.workspace_id` index, and a
personal instance's holding count is small.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("holdings", sa.Column("coingecko_id", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("holdings", "coingecko_id")
