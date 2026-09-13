import { Building2, User } from "lucide-react";
import { cn } from "../../lib/cn";

export type AvatarSize = "sm" | "md" | "lg";
/** A contact's kind — kept as a local union rather than importing the feature
 * type, so this shared kit component has no dependency on `features/`. */
export type AvatarType = "person" | "company";

export interface AvatarProps {
  /** A `data:image/…;base64,…` URI (see `ImageUpload`). When null/absent the
   * monogram fallback is rendered instead. */
  src?: string | null;
  /** Drives the monogram initials and the deterministic tint — always
   * required so the fallback is stable and legible. */
  name: string;
  /** Adds a small person/company affordance in the corner when set. */
  type?: AvatarType;
  size?: AvatarSize;
  className?: string;
}

/** Eight literal class pairs (not built dynamically — Tailwind v4's scanner
 * only emits classes it can see as whole strings) cycling the sanctioned
 * `--chart-*` palette as a subtle tint + matching ink for the monogram
 * fallback. A contact has no palette of its own, so the tint is derived
 * deterministically from the name — the same name always lands the same
 * color. */
const TINTS = [
  "bg-chart-1/15 text-chart-1",
  "bg-chart-2/15 text-chart-2",
  "bg-chart-3/15 text-chart-3",
  "bg-chart-4/15 text-chart-4",
  "bg-chart-5/15 text-chart-5",
  "bg-chart-6/15 text-chart-6",
  "bg-chart-7/15 text-chart-7",
  "bg-chart-8/15 text-chart-8",
];

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-12 w-12 text-sm",
};

const AFFORDANCE_ICON_SIZE: Record<AvatarSize, string> = {
  sm: "h-2.5 w-2.5",
  md: "h-3 w-3",
  lg: "h-3.5 w-3.5",
};

/** Up to two initials: the first letter of the first two words, or the first
 * two letters of a single-word name. Uppercased; falls back to "?" for an
 * empty/whitespace name so the circle is never blank. */
function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic 0–7 index from the name so a contact's tint is stable across
 * renders and sessions without storing anything. */
function tintIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % TINTS.length;
}

/**
 * A contact's avatar: the uploaded `data:` image when one is set, otherwise a
 * monogram (1–2 initials) on a deterministic token-tinted circle. Tokens only
 * (CONVENTIONS §9) — the tint cycles the `--chart-*` palette, never a raw hex.
 * The image is decorative (`alt=""`): a contact's name always sits beside its
 * avatar in every surface that renders one, so the name is never carried by
 * the image alone. An optional `type` adds a small person/company affordance
 * in the corner. Reused by Subscriptions for vendor logos.
 */
function Avatar({ src, name, type, size = "md", className }: AvatarProps) {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-visible rounded-full",
        SIZE_CLASSES[size],
        className,
      )}
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full rounded-full object-cover" />
      ) : (
        <span
          className={cn(
            "flex h-full w-full items-center justify-center rounded-full font-medium",
            TINTS[tintIndex(name)],
          )}
        >
          {monogram(name)}
        </span>
      )}
      {type ? (
        <span
          aria-hidden="true"
          className="absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full border border-surface-1 bg-surface-2 p-0.5 text-ink-2"
        >
          {type === "person" ? (
            <User className={AFFORDANCE_ICON_SIZE[size]} />
          ) : (
            <Building2 className={AFFORDANCE_ICON_SIZE[size]} />
          )}
        </span>
      ) : null}
    </span>
  );
}

export default Avatar;
