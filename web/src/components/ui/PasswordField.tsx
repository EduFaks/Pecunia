import { forwardRef, useId, useState } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { focusRingClass } from "./a11y";
import { textFieldInputClasses } from "./TextField";
import { FieldDescription, FieldError, FieldLabel } from "./Field";

export interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  description?: string;
  error?: string;
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
      <path
        d="M1.5 10 C4 5.5 7 3.5 10 3.5 C13 3.5 16 5.5 18.5 10 C16 14.5 13 16.5 10 16.5 C7 16.5 4 14.5 1.5 10 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
      <path
        d="M1.5 10 C4 5.5 7 3.5 10 3.5 C13 3.5 16 5.5 18.5 10 C16 14.5 13 16.5 10 16.5 C7 16.5 4 14.5 1.5 10 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="2.5" y1="17" x2="17.5" y2="3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** `TextField`'s sibling for secrets: an accessible show/hide toggle flips
 * the input between `type="password"` and `type="text"` — the value itself
 * never leaves React state, and nothing here reaches storage (per the
 * in-memory-only auth model, spec D1). */
const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField(
  { label = "Password", description, error, id, className, required, ...rest },
  ref,
) {
  const [visible, setVisible] = useState(false);
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
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          type={visible ? "text" : "password"}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            textFieldInputClasses,
            "pr-10",
            error ? "border-negative/50" : "border-hairline focus:border-hairline-strong",
            focusRingClass,
            className,
          )}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className={cn(
            "absolute inset-y-0 right-0 flex items-center rounded-pc px-3 text-ink-faint transition-colors duration-150 ease-pc hover:text-ink-2",
            focusRingClass,
          )}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      {description ? <FieldDescription id={descriptionId!}>{description}</FieldDescription> : null}
      {error ? <FieldError id={errorId!}>{error}</FieldError> : null}
    </div>
  );
});

export default PasswordField;
