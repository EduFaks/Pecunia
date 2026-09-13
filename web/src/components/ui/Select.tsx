import { forwardRef, useId } from "react";
import type { SelectHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { focusRingClass } from "./a11y";
import { FieldDescription, FieldError, FieldLabel } from "./Field";
import { textFieldInputClasses } from "./TextField";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  label: string;
  description?: string;
  error?: string;
  options: SelectOption[];
}

/** `TextField`'s sibling for a closed set of choices — a native `<select>`
 * (full keyboard/screen-reader support for free, no combobox to reinvent)
 * sharing `TextField`'s input chrome (`textFieldInputClasses`) so a form
 * mixing both reads as one control family. Plan 06's Preferences step
 * (locale, date/number format, timezone, first day of week) is the first
 * consumer. */
const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, description, error, id, className, required, options, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? `field-${autoId}`;
  const descriptionId = description ? `${selectId}-description` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={selectId} required={required}>
        {label}
      </FieldLabel>
      <select
        ref={ref}
        id={selectId}
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
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {description ? <FieldDescription id={descriptionId!}>{description}</FieldDescription> : null}
      {error ? <FieldError id={errorId!}>{error}</FieldError> : null}
    </div>
  );
});

export default Select;
