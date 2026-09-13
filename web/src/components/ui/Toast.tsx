import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { focusRingClass } from "./a11y";
import { semanticVariantClasses } from "./semanticVariants";
import type { SemanticVariant } from "./semanticVariants";
import VariantIcon from "./VariantIcon";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title?: string;
  variant?: SemanticVariant;
  /** Auto-dismiss delay in milliseconds. */
  duration?: number;
  /** An optional inline action (e.g. `{ label: "Undo", onClick: restore }`
   * on a "Transaction deleted" toast) — clicking it fires `onClick` and
   * dismisses the toast in one action, so the caller never needs to call
   * `dismissToast` itself. */
  action?: ToastAction;
}

interface ToastItem extends Required<Pick<ToastOptions, "variant" | "duration">> {
  id: string;
  title?: string;
  description: string;
  action?: ToastAction;
}

export interface ToastContextValue {
  showToast: (description: string, options?: ToastOptions) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const DEFAULT_DURATION_MS = 5000;

function createToastId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
      <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Transient notification stack, rendered fixed to the viewport corner and
 * announced via `role="status"`/`aria-live="polite"` (a toast is, by
 * nature, never the thing that needs an interrupting `alert`). Mount once
 * near the app root; any descendant calls `useToast()`.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (description: string, options: ToastOptions = {}) => {
      const id = createToastId();
      const toast: ToastItem = {
        id,
        description,
        title: options.title,
        variant: options.variant ?? "info",
        duration: options.duration ?? DEFAULT_DURATION_MS,
        action: options.action,
      };
      setToasts((current) => [...current, toast]);
      timers.current.set(
        id,
        setTimeout(() => dismissToast(id), toast.duration),
      );
    },
    [dismissToast],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ showToast, dismissToast }), [showToast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-stretch gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
      >
        {toasts.map((toast) => {
          const styles = semanticVariantClasses[toast.variant];
          return (
            <div
              key={toast.id}
              className={cn(
                "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-pc border px-4 py-3 shadow-pc-2",
                styles.wrap,
              )}
            >
              <span className={cn("mt-0.5 shrink-0", styles.icon)}>
                <VariantIcon variant={toast.variant} />
              </span>
              <div className="flex-1 text-sm text-ink">
                {toast.title ? <p className="font-medium">{toast.title}</p> : null}
                <p className={toast.title ? "mt-0.5 text-ink-2" : undefined}>{toast.description}</p>
                {toast.action ? (
                  <button
                    type="button"
                    onClick={() => {
                      toast.action!.onClick();
                      dismissToast(toast.id);
                    }}
                    className={cn(
                      "mt-1.5 font-sans text-sm font-medium text-accent transition-colors duration-150 ease-pc hover:text-accent-hover",
                      focusRingClass,
                    )}
                  >
                    {toast.action.label}
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                aria-label="Dismiss notification"
                className={cn(
                  "shrink-0 rounded-pc p-0.5 text-ink-faint transition-colors duration-150 ease-pc hover:text-ink-2",
                  focusRingClass,
                )}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
