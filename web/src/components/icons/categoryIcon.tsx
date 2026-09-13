import {
  Car,
  CircleDashed,
  Clapperboard,
  HeartPulse,
  Home,
  ShoppingBag,
  Tag,
  Utensils,
  Wallet,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * The stored category `icon` strings (`DEFAULT_CATEGORIES` in
 * `api/src/pecunia/models/category.py`, plus whatever a user typed into
 * `CategoryForm`'s icon field) mapped to their lucide-react glyphs. Icons are
 * imported individually so the bundler tree-shakes the rest of the set —
 * never `import * as icons` / a dynamic name lookup over the whole package.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  wallet: Wallet,
  "circle-dashed": CircleDashed,
  "shopping-bag": ShoppingBag,
  utensils: Utensils,
  car: Car,
  home: Home,
  zap: Zap,
  "heart-pulse": HeartPulse,
  clapperboard: Clapperboard,
};

export interface CategoryIconProps {
  /** A stored icon string; unknown/empty/`null` renders the neutral `Tag`
   * fallback so a row always has a glyph. */
  name?: string | null;
  className?: string;
  /** Any lucide size (px number or CSS length). Defaults to `1em` so the glyph
   * tracks the surrounding text size. */
  size?: number | string;
}

/**
 * Renders a category's stored icon as a lucide glyph, `aria-hidden` (the
 * category name carries the meaning) and stroked with `currentColor` so it
 * inherits the ink token of whatever it sits in — no per-icon color. Used by
 * `CategoryBadge`, `CategoryPicker`, and `CategoriesPanel` in place of showing
 * the raw icon string as text.
 */
function CategoryIcon({ name, className, size = "1em" }: CategoryIconProps) {
  const Icon = (name && ICON_MAP[name]) || Tag;
  return <Icon aria-hidden="true" size={size} className={cn("shrink-0", className)} />;
}

export default CategoryIcon;
