import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type PillTone = "neutral" | "positive" | "negative";

/** Neutral by default — a small mono/uppercase label for a closed-set value
 * (a status, a period, a type) that isn't itself interactive. Never the
 * white accent (CONVENTIONS §9.1: the accent means "act on this", not
 * "here's a status") —
 * `positive`/`negative` are for a genuine semantic state (e.g. a project
 * that has reached its funding target), reusing the same emerald/coral tokens
 * `Callout`/`Toast` do via `semanticVariants.ts`. */
const TONE_CLASSES: Record<PillTone, string> = {
  neutral: "border-hairline bg-surface-2 text-ink-2",
  positive: "border-positive/30 bg-positive/10 text-positive",
  negative: "border-negative/30 bg-negative/10 text-negative",
};

export interface PillProps {
  children: ReactNode;
  tone?: PillTone;
  className?: string;
}

/**
 * Small chip for a closed-set value rendered inline in a list row or detail
 * header — `ProjectsScreen`'s status, `BudgetsScreen`'s period, and
 * `ProjectDetail`'s "Target reached" badge. Shares `DemoChip`'s visual
 * vocabulary (mono, uppercase, hairline border, `surface-2` fill) without
 * duplicating its markup, since `DemoChip` is a specific interactive widget
 * (a dismiss button inside it) rather than this generic display-only shape.
 */
function Pill({ children, tone = "neutral", className }: PillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pc border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export default Pill;
