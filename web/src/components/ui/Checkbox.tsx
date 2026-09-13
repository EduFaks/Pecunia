import { forwardRef, useId } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { focusRingClass } from "./a11y";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Visible label, rendered as a sibling of the input inside a `<label>`
   * wrapping both — the whole row (box + text) is one click/tap target,
   * and the label's plain text stays exactly what `getByLabelText` matches
   * against (no icon/markup mixed into the accessible name). */
  label: string;
}

/**
 * Shared checkbox primitive — a native `<input type="checkbox">` (full
 * keyboard/screen-reader behavior for free, same rationale as `Select`
 * choosing a native `<select>` over a custom listbox) styled with the same
 * token set as every other control: `surface-2` fill, a hairline border,
 * and the white accent via the CSS `accent-color` property for the
 * checked mark — no custom SVG check icon to keep in sync with the design
 * tokens. `focusRingClass` is applied explicitly per §9.3's convention.
 *
 * `AccountsScreen`'s "Show archived accounts" toggle is the first adopter,
 * replacing a raw `<input type="checkbox">` that predated this primitive.
 */
const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const checkboxId = id ?? `checkbox-${autoId}`;

  return (
    <label
      htmlFor={checkboxId}
      className="inline-flex w-fit cursor-pointer items-center gap-2 text-sm text-ink-2"
    >
      <input
        ref={ref}
        type="checkbox"
        id={checkboxId}
        className={cn(
          "h-4 w-4 rounded-sm border-hairline-strong bg-surface-2 accent-accent",
          focusRingClass,
          className,
        )}
        {...rest}
      />
      {label}
    </label>
  );
});

export default Checkbox;
