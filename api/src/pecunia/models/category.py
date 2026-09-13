import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, ForeignKey, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, DateTime, Text, Uuid

from pecunia.models.base import Base


class CategoryKind(StrEnum):
    INCOME = "income"
    EXPENSE = "expense"


_KINDS = "','".join(k.value for k in CategoryKind)


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (
        CheckConstraint(f"kind IN ('{_KINDS}')", name="kind_valid"),
        UniqueConstraint(
            "workspace_id", "name", "kind", name="uq_categories_workspace_id_name_kind"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    color: Mapped[str] = mapped_column(Text, nullable=False)
    icon: Mapped[str | None] = mapped_column(Text)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)


# 8 vibrant categorical hexes, tuned to read clearly on the near-black #0a0a0b
# canvas and to stay distinct from the emerald/coral value-movement pair. This
# is the ONE sanctioned place vibrant color is used (charts + category chips —
# see docs/CONVENTIONS.md §9.1); the same 8 hexes are the `--chart-1…8` design
# tokens (web/src/styles/tokens.css). Kept as an allowlist of values
# DEFAULT_CATEGORIES draws from and CategoryIn/CategoryUpdate validate against,
# not free-form input. MUST stay byte-identical (same order) to the mirrored
# `CATEGORY_PALETTE` in web/src/features/categories/categoryTypes.ts — the two
# are hand-synced; change one, change the other.
PALETTE: tuple[str, ...] = (
    "#22d3ee",  # cyan
    "#a78bfa",  # violet
    "#fbbf24",  # amber
    "#fb7185",  # rose
    "#38bdf8",  # sky
    "#a3e635",  # lime
    "#fb923c",  # orange
    "#e879f9",  # fuchsia
)

# The default category set seeded for every new workspace (real, at setup)
# and for the demo dataset (flagged is_demo=True) — see
# pecunia.services.categories.seed_default_categories.
DEFAULT_CATEGORIES: list[dict[str, str]] = [
    {"name": "Salary", "kind": CategoryKind.INCOME.value, "color": PALETTE[1], "icon": "wallet"},
    {"name": "Other Income", "kind": CategoryKind.INCOME.value, "color": PALETTE[2], "icon": "circle-dashed"},
    {"name": "Groceries", "kind": CategoryKind.EXPENSE.value, "color": PALETTE[0], "icon": "shopping-bag"},
    {"name": "Dining", "kind": CategoryKind.EXPENSE.value, "color": PALETTE[3], "icon": "utensils"},
    {"name": "Transport", "kind": CategoryKind.EXPENSE.value, "color": PALETTE[4], "icon": "car"},
    {"name": "Housing", "kind": CategoryKind.EXPENSE.value, "color": PALETTE[5], "icon": "home"},
    {"name": "Utilities", "kind": CategoryKind.EXPENSE.value, "color": PALETTE[6], "icon": "zap"},
    {"name": "Health", "kind": CategoryKind.EXPENSE.value, "color": PALETTE[7], "icon": "heart-pulse"},
    {"name": "Entertainment", "kind": CategoryKind.EXPENSE.value, "color": PALETTE[1], "icon": "clapperboard"},
    {"name": "Shopping", "kind": CategoryKind.EXPENSE.value, "color": PALETTE[2], "icon": "shopping-bag"},
    {"name": "Other", "kind": CategoryKind.EXPENSE.value, "color": PALETTE[0], "icon": "circle-dashed"},
]
