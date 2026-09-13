/**
 * Shared semantic-color mapping for `Callout` and `Toast` — one source of
 * truth so both consume the exact same token mapping instead of redefining
 * "what does negative look like" twice. Per docs/CONVENTIONS.md §9: `info`
 * is neutral (surface + ink tokens only — the accent is reserved for
 * interactive elements, never decoration or status), `positive`/`negative`
 * are the emerald/coral tokens, applied at low opacity via Tailwind's `/alpha`
 * modifier rather than new hex tokens. Icons live in `./VariantIcon` (a
 * separate, component-only module, so this one stays Fast-Refresh-friendly
 * plain data).
 */

export type SemanticVariant = "info" | "positive" | "negative";

export const semanticVariantClasses: Record<
  SemanticVariant,
  { wrap: string; icon: string }
> = {
  info: { wrap: "border-hairline-strong bg-surface-2", icon: "text-ink-2" },
  positive: { wrap: "border-positive/30 bg-positive/10", icon: "text-positive" },
  negative: { wrap: "border-negative/30 bg-negative/10", icon: "text-negative" },
};
