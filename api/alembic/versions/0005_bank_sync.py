"""Add bank-sync tables + transactions.external_id (Track T — bank sync via
Pluggy, v1.5)

Three new workspace-scoped tables lay the data foundation a later Pluggy
provider/service builds on:

- `bank_connections` — one row per linked Pluggy `item` (a bank/institution
  login). `pluggy_item_id` is unique per workspace — the dedupe key the link
  flow uses to find-or-create a connection rather than duplicating it on a
  re-link. `status` (ok|error) plus `last_error`/`last_synced_at` track the
  health of the most recent sync attempt.
- `bank_account_links` — ties exactly one Pecunia `accounts` row to one
  Pluggy provider account under a connection: explicit link-or-create, never
  auto-created behind the user's back. `account_id` is unique (an account is
  either fully manual or fully synced, never both); `pluggy_account_id` is
  unique per workspace (the provider account's own dedupe key). `sync_from`
  bounds how far back transaction sync reaches; the balance/credit-card
  columns are provider-reported figures the sync writes back for display.
- `bank_category_mappings` — a per-workspace mapping from a Pluggy category
  string to one of the workspace's own categories, unique per (workspace,
  provider category) — the auto-categorization lookup a sync consults before
  leaving an imported transaction's category unset.

`transactions.external_id` carries the provider's own transaction id for a
row the sync created (NULL for manual/transfer-leg transactions). Its partial
unique index — `WHERE external_id IS NOT NULL` — is the dedupe key that lets
a re-sync recognize a transaction it already imported without touching the
many existing NULL rows: Postgres does not treat a plain UNIQUE index as
satisfied by multiple NULLs the way a partial index scoped to non-null values
makes explicit, so this is a tombstone/dedupe key, not a NOT NULL column —
a transaction never loses its `external_id` once synced (soft-deleting it
instead, via the existing `deleted_at`, keeps the id from being reused).

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "bank_connections",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("pluggy_item_id", sa.Text(), nullable=False),
        sa.Column("institution_name", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'ok'"), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_demo", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('ok','error')", name=op.f("ck_bank_connections_status_valid")
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_bank_connections_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bank_connections")),
        sa.UniqueConstraint(
            "workspace_id",
            "pluggy_item_id",
            name="uq_bank_connections_workspace_id_pluggy_item_id",
        ),
    )
    op.create_index(
        op.f("ix_bank_connections_workspace_id"), "bank_connections", ["workspace_id"], unique=False
    )

    op.create_table(
        "bank_account_links",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("connection_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("pluggy_account_id", sa.Text(), nullable=False),
        sa.Column("sync_from", sa.Date(), nullable=False),
        sa.Column("provider_balance_minor", sa.BigInteger(), nullable=True),
        sa.Column("provider_balance_as_of", sa.DateTime(timezone=True), nullable=True),
        sa.Column("credit_limit_minor", sa.BigInteger(), nullable=True),
        sa.Column("bill_close_date", sa.Date(), nullable=True),
        sa.Column("bill_due_date", sa.Date(), nullable=True),
        sa.Column("is_demo", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_bank_account_links_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["connection_id"],
            ["bank_connections.id"],
            name=op.f("fk_bank_account_links_connection_id_bank_connections"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_bank_account_links_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bank_account_links")),
        sa.UniqueConstraint("account_id", name="uq_bank_account_links_account_id"),
        sa.UniqueConstraint(
            "workspace_id",
            "pluggy_account_id",
            name="uq_bank_account_links_workspace_id_pluggy_account_id",
        ),
    )
    op.create_index(
        op.f("ix_bank_account_links_account_id"), "bank_account_links", ["account_id"], unique=False
    )
    op.create_index(
        op.f("ix_bank_account_links_connection_id"),
        "bank_account_links",
        ["connection_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_bank_account_links_workspace_id"),
        "bank_account_links",
        ["workspace_id"],
        unique=False,
    )

    op.create_table(
        "bank_category_mappings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("pluggy_category", sa.Text(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.Column("is_demo", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_bank_category_mappings_category_id_categories"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_bank_category_mappings_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bank_category_mappings")),
        sa.UniqueConstraint(
            "workspace_id",
            "pluggy_category",
            name="uq_bank_category_mappings_workspace_id_pluggy_category",
        ),
    )
    op.create_index(
        op.f("ix_bank_category_mappings_category_id"),
        "bank_category_mappings",
        ["category_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_bank_category_mappings_workspace_id"),
        "bank_category_mappings",
        ["workspace_id"],
        unique=False,
    )

    op.add_column("transactions", sa.Column("external_id", sa.Text(), nullable=True))
    op.create_index(
        "uq_transactions_account_id_external_id",
        "transactions",
        ["account_id", "external_id"],
        unique=True,
        postgresql_where=sa.text("external_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_transactions_account_id_external_id",
        table_name="transactions",
        postgresql_where=sa.text("external_id IS NOT NULL"),
    )
    op.drop_column("transactions", "external_id")

    op.drop_index(op.f("ix_bank_category_mappings_workspace_id"), table_name="bank_category_mappings")
    op.drop_index(op.f("ix_bank_category_mappings_category_id"), table_name="bank_category_mappings")
    op.drop_table("bank_category_mappings")

    op.drop_index(op.f("ix_bank_account_links_workspace_id"), table_name="bank_account_links")
    op.drop_index(op.f("ix_bank_account_links_connection_id"), table_name="bank_account_links")
    op.drop_index(op.f("ix_bank_account_links_account_id"), table_name="bank_account_links")
    op.drop_table("bank_account_links")

    op.drop_index(op.f("ix_bank_connections_workspace_id"), table_name="bank_connections")
    op.drop_table("bank_connections")
