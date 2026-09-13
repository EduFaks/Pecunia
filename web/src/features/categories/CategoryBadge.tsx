import CategoryIcon from "../../components/icons/categoryIcon";
import { cn } from "../../lib/cn";
import type { CategoryOut } from "./useCategories";

export interface CategoryBadgeProps {
  /** `null`/`undefined` renders "Uncategorized" — a transaction/budget with
   * no `category_id`, or one whose category couldn't be resolved (e.g. the
   * caller's category list hasn't loaded yet). Only `name`/`color` are
   * required; `icon` is optional so a caller can still pass a plain
   * `{name, color}` object (the glyph falls back to a neutral `Tag`). */
  category?: (Pick<CategoryOut, "name" | "color"> & { icon?: string | null }) | null;
  className?: string;
}

/**
 * Small colored chip for a list row — `TransactionsScreen`, `AccountDetail`,
 * and `BudgetsScreen` all render one per row. A color dot (`category.color`,
 * a backend-validated palette hex — data, not chrome, see
 * `categoryTypes.ts`'s `CATEGORY_PALETTE` doc comment), the category's lucide
 * icon glyph (`CategoryIcon`, `currentColor`), and the name; the glyph and
 * text stay token-driven (`text-ink-2`/`text-ink-faint`), never colored by
 * the category's own hue — CONVENTIONS §9.1 reserves emerald/coral for value
 * movement/status, and a category is neither.
 */
function CategoryBadge({ category, className }: CategoryBadgeProps) {
  if (!category) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 font-mono text-xs text-ink-faint", className)}>
        <span aria-hidden="true" className="h-2 w-2 rounded-full border border-hairline-strong bg-surface-2" />
        Uncategorized
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-xs text-ink-2", className)}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: category.color }} />
      <CategoryIcon name={category.icon} className="text-ink-faint" />
      {category.name}
    </span>
  );
}

export default CategoryBadge;
