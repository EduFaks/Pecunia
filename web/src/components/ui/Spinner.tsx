import { cn } from "../../lib/cn";

export type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
  /** Accessible label. Omit for a purely decorative spinner paired with
   * visible adjacent text (e.g. inside `Button`'s loading state); pass one
   * for a standalone spinner so screen readers announce the busy state. */
  label?: string;
}

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

/**
 * Circular loading indicator. Color is `currentColor`, so it inherits
 * whatever text color the parent sets (`text-on-accent` inside a primary
 * `Button`'s white fill, `text-accent` standalone, etc.) — no color prop
 * needed.
 * `animate-spin` is neutralized under `prefers-reduced-motion` by the
 * global base rule in `styles/global.css`.
 */
function Spinner({ size = "md", className, label }: SpinnerProps) {
  const svg = (
    <svg
      className={cn("animate-spin", SIZE_CLASSES[size], className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden={label ? undefined : "true"}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );

  if (!label) {
    return svg;
  }

  return (
    <span role="status" className="inline-flex items-center gap-2">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}

export default Spinner;
