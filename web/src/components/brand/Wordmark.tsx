import { cn } from "../../lib/cn";
import PlumeMark from "./PlumeMark";

export type WordmarkSize = "sm" | "md" | "lg";

export interface WordmarkProps {
  size?: WordmarkSize;
  /**
   * Render the Plume mark before the "PECUNIA" text in a horizontal lockup.
   * Defaults to `false` so existing text-only callers are unchanged; the
   * sidebar (and the login/setup screens) opt in.
   */
  withMark?: boolean;
  className?: string;
}

const TEXT_SIZE: Record<WordmarkSize, string> = {
  sm: "text-sm tracking-[0.3em]",
  md: "text-2xl tracking-[0.25em]",
  lg: "text-4xl tracking-[0.2em]",
};

/**
 * The "PECUNIA" wordmark: set in the system sans, wide-tracked. Plain text by
 * default; with `withMark`, the Plume feather sits before it in a horizontal
 * lockup, sized to the text (`1em`) and inheriting the same ink.
 */
function Wordmark({ size = "md", withMark = false, className }: WordmarkProps) {
  const text = (
    <span className={cn("font-display font-medium text-ink", TEXT_SIZE[size])}>PECUNIA</span>
  );

  if (withMark) {
    return (
      <span className={cn("inline-flex items-center gap-2 text-ink", className)}>
        <PlumeMark className={TEXT_SIZE[size]} />
        {text}
      </span>
    );
  }

  return <span className={cn("inline-flex flex-col items-start", className)}>{text}</span>;
}

export default Wordmark;
