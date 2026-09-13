import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { focusRingClass } from "./a11y";
import Spinner from "./Spinner";
import type { SpinnerSize } from "./Spinner";

export type ButtonVariant = "primary" | "ghost" | "quiet" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` (white fill) is the sole call-to-action per page/section —
   * never more than one competing for attention at once. Its fill is the
   * white `--pc-accent`, so its label/icon must render in `text-on-accent`
   * (near-black), never `text-canvas`/`text-ink` — see CONVENTIONS §9.1's
   * accent-contrast rule. `ghost` is a bordered secondary action; `quiet` is
   * a borderless tertiary one. `destructive` (solid `--pc-negative`/coral
   * fill) is reserved for the confirm action of an irreversible operation —
   * today, only `ConfirmDialog`'s confirm button — never a plain "delete"
   * action taken directly, which stays `ghost` like any other row action. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows an inline spinner, sets `aria-busy`, and forces `disabled`. */
  loading?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  ghost: "border border-hairline text-ink hover:border-hairline-strong hover:bg-surface-2",
  quiet: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  destructive: "bg-negative text-canvas hover:bg-negative/90",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  // `py-2.5` (not the desktop `py-1.5`) below `sm:` brings `sm`'s total
  // height to ~36px — a comfortable touch target — on a phone, where `sm`
  // is the size every dense row's actions (transactions, subscriptions,
  // loans, planned) use; `sm:py-1.5` reverts to the original compact
  // desktop sizing unchanged.
  sm: "px-3 py-2.5 sm:py-1.5 text-xs gap-1.5",
  md: "px-4 py-2 text-sm gap-2",
  lg: "px-5 py-2.5 text-sm gap-2",
};

const SPINNER_SIZE: Record<ButtonSize, SpinnerSize> = { sm: "sm", md: "sm", lg: "md" };

/**
 * The base action primitive. Every color and shadow comes from a `--pc-*`
 * token via Tailwind's `@theme` mapping — never a raw hex value.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, disabled, className, children, type = "button", ...rest },
  ref,
) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center rounded-pc font-sans font-medium transition-colors duration-150 ease-pc disabled:cursor-not-allowed disabled:opacity-60",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        focusRingClass,
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={SPINNER_SIZE[size]} /> : null}
      <span className={loading ? "opacity-90" : undefined}>{children}</span>
    </button>
  );
});

export default Button;
