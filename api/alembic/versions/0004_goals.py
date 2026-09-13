"""Add goals table (Track S — savings goals, v1.4)

A savings goal's progress is DERIVED from a chosen source (an account
balance, a portfolio value, net worth, or a manual figure) rather than
tracked via its own deposit ledger — see `pecunia.services.goals.GoalService`
and `pecunia.models.goal.Goal`. `source_id` deliberately carries no foreign
key: depending on `source_kind` it references either `accounts` or
`portfolios` (or neither, for `net_worth`/`manual`), and a single column
can't FK to two different tables — the service layer validates it resolves
to a real row in the goal's own workspace.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "goals",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("target_minor", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("target_date", sa.Date(), nullable=True),
        sa.Column("source_kind", sa.Text(), server_default=sa.text("'manual'"), nullable=False),
        sa.Column("source_id", sa.Uuid(), nullable=True),
        sa.Column("manual_current_minor", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "source_kind IN ('account','portfolio','net_worth','manual')",
            name=op.f("ck_goals_source_kind_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_goals_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goals")),
    )
    op.create_index(op.f("ix_goals_workspace_id"), "goals", ["workspace_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_goals_workspace_id"), table_name="goals")
    op.drop_table("goals")
