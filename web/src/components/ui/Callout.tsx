import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { semanticVariantClasses } from "./semanticVariants";
import type { SemanticVariant } from "./semanticVariants";
import VariantIcon from "./VariantIcon";

export interface CalloutProps {
  variant?: SemanticVariant;
  title?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Inline status banner — semantic colors only, never the white accent
 * (the accent means "act on this", not "here's a status"). `negative` is an
 * assertive `role="alert"` (interrupts, e.g. a failed login); `info`/
 * `positive` are a polite `role="status"`.
 */
function Callout({ variant = "info", title, children, className }: CalloutProps) {
  const styles = semanticVariantClasses[variant];
  const isAlert = variant === "negative";

  return (
    <div
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? "assertive" : "polite"}
      className={cn("flex items-start gap-3 rounded-pc border px-4 py-3", styles.wrap, className)}
    >
      <span className={cn("mt-0.5 shrink-0", styles.icon)}>
        <VariantIcon variant={variant} />
      </span>
      <div className="text-sm text-ink">
        {title ? <p className="font-medium">{title}</p> : null}
        <div className={title ? "mt-0.5 text-ink-2" : undefined}>{children}</div>
      </div>
    </div>
  );
}

export default Callout;
