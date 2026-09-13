import { cn } from "../../lib/cn";

export interface PlumeMarkProps {
  /** Rendered size — any CSS length. Defaults to `1em` so the mark scales with the surrounding text. */
  size?: number | string;
  /**
   * Stroke width in the 48×48 user space. Defaults to `2.5` for the detailed
   * variant, or `3.5` for the compact one (`showBarbs={false}`) so the mark
   * stays legible at small sizes.
   */
  strokeWidth?: number;
  /** Draw the two short barbs across the vane. Dropped at small sizes where they muddy. */
  showBarbs?: boolean;
  className?: string;
  /** Accessible name. When set, the mark becomes `role="img"` with a `<title>`; otherwise it's decorative (`aria-hidden`). */
  title?: string;
}

/**
 * The Plume — Pecunia's feather mark, drawn inline from the owner-approved
 * geometry (spine + vane, with optional barbs). Strokes in `currentColor`
 * with no fill, so it inherits the surrounding ink and needs no color of its
 * own. Decorative by default (`aria-hidden`) since the wordmark carries the
 * name; pass a `title` to give it an accessible label (`role="img"`). The
 * `showBarbs={false}` compact rendering (thicker default stroke) is for small
 * sizes such as the favicon.
 */
function PlumeMark({ size = "1em", strokeWidth, showBarbs = true, className, title }: PlumeMarkProps) {
  const resolvedStroke = strokeWidth ?? (showBarbs ? 2.5 : 3.5);
  const labelled = title != null && title.length > 0;
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={resolvedStroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
      {...(labelled ? { role: "img" } : { "aria-hidden": true })}
    >
      {labelled ? <title>{title}</title> : null}
      {/* spine */}
      <path d="M15 40 C21 30 28 20 36 10" />
      {/* vane */}
      <path d="M36 10 C40 18 38 27 31 32 C26 35 20 35 16 33" />
      {showBarbs ? (
        <>
          <path d="M25 25 L32 21" />
          <path d="M21 31 L28 28" />
        </>
      ) : null}
    </svg>
  );
}

export default PlumeMark;
