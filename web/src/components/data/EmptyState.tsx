import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface EmptyStateProps {
  /** Decorative only — rendered `aria-hidden` via its own markup, never the
   * sole carrier of information. */
  icon?: ReactNode;
  title: string;
  body: string;
  /** Typically a `Button` — rendered as-is, this component doesn't dictate
   * its variant. */
  action?: ReactNode;
  className?: string;
}

/**
 * Branded "nothing here yet" placeholder for an empty `DataList` (or any
 * other empty collection): a calm, centered block — display-weight title,
 * ink-2 body, an optional action — never an error tone (that's `Callout
 * variant="negative"`'s job).
 */
function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-pc-lg border border-hairline bg-surface-1 px-6 py-16 text-center",
        className,
      )}
    >
      {icon ? (
        <div aria-hidden="true" className="text-ink-faint">
          {icon}
        </div>
      ) : null}
      <h2 className="font-display text-xl text-ink">{title}</h2>
      <p className="max-w-sm text-sm text-ink-2">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
