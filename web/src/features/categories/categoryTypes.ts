import type { SelectOption } from "../../components/ui/Select";

/** Mirrors backend `CategoryKind` (`api/src/pecunia/models/category.py`). */
export type CategoryKind = "income" | "expense";

export const CATEGORY_KIND_OPTIONS: SelectOption[] = [
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
];

export const CATEGORY_KIND_LABELS: Record<string, string> = Object.fromEntries(
  CATEGORY_KIND_OPTIONS.map((option) => [option.value, option.label]),
);

export interface CategorySwatch {
  value: string;
  label: string;
}

/**
 * Mirrors the backend's fixed color palette (`PALETTE` in
 * `api/src/pecunia/models/category.py`) — the only hex values `CategoryIn`/
 * `CategoryUpdate` accept (`_validate_color` 422s on anything else), so the
 * picker offers exactly this closed set as swatches rather than a free
 * color input. These are category *data* values the backend validates
 * against, not app chrome — the one place a literal hex string is correct
 * in this codebase; CONVENTIONS §9.1's token-only rule governs UI chrome
 * color, not domain data a component merely displays (same rationale as
 * `CategoryPicker`'s/`CategoryBadge`'s swatch dot reading `category.color`
 * straight off the API response).
 */
export const CATEGORY_PALETTE: CategorySwatch[] = [
  { value: "#22d3ee", label: "Cyan" },
  { value: "#a78bfa", label: "Violet" },
  { value: "#fbbf24", label: "Amber" },
  { value: "#fb7185", label: "Rose" },
  { value: "#38bdf8", label: "Sky" },
  { value: "#a3e635", label: "Lime" },
  { value: "#fb923c", label: "Orange" },
  { value: "#e879f9", label: "Fuchsia" },
];
