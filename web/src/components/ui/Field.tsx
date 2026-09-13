import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Low-level label/description/error primitives shared by every form
 * control (`TextField`, `PasswordField`, and anything Plan 06/07 adds —
 * selects, checkboxes). A control composes these itself rather than being
 * wrapped by one generic `<Field>`, since each control's markup (an
 * `<input>`, an `<input>` plus a toggle button, eventually a `<select>`)
 * differs enough that a one-size wrapper would just get prop-drilled
 * through.
 */

export function FieldLabel({
  htmlFor,
  children,
  required,
}: {
  htmlFor: string;
  children: ReactNode;
  required?: boolean;
}) {
  // The required marker is a sibling of `<label>`, not a child of it: it's
  // decorative punctuation, not part of the field's name, and keeping it
  // out of the label element means the label's accessible name — and its
  // plain textContent, which `getByLabelText` matches against — stays
  // exactly the field name (`"Email"`, not `"Email*"`).
  return (
    <span className="inline-flex items-baseline gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink-2">
        {children}
      </label>
      {required ? (
        <span className="text-ink-faint" aria-hidden="true">
          *
        </span>
      ) : null}
    </span>
  );
}

export function FieldDescription({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p id={id} className={cn("text-xs text-ink-faint", className)}>
      {children}
    </p>
  );
}

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-xs text-negative">
      {children}
    </p>
  );
}
