import { forwardRef, useId } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { focusRingClass } from "./a11y";
import { FieldDescription, FieldError, FieldLabel } from "./Field";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  description?: string;
  error?: string;
}

export const textFieldInputClasses =
  "w-full rounded-pc border bg-surface-2 px-3 py-2 text-base sm:text-sm text-ink placeholder:text-ink-faint transition-colors duration-150 ease-pc";

/** Labeled single-line text input with description/error slots, wired for
 * `aria-invalid`/`aria-describedby`. `PasswordField` shares this input
 * styling but composes its own markup to fit the show/hide toggle. */
const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, description, error, id, className, required, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? `field-${autoId}`;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={inputId} required={required}>
        {label}
      </FieldLabel>
      <input
        ref={ref}
        id={inputId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          textFieldInputClasses,
          error ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
          focusRingClass,
          className,
        )}
        {...rest}
      />
      {description ? <FieldDescription id={descriptionId!}>{description}</FieldDescription> : null}
      {error ? <FieldError id={errorId!}>{error}</FieldError> : null}
    </div>
  );
});

export default TextField;
