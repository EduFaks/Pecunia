import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import Wordmark from "./brand/Wordmark";
import Button from "./ui/Button";
import Callout from "./ui/Callout";

export interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Top-level crash guard, wrapping `<AppRoutes />` in `App.tsx`. Before this,
 * a thrown render error anywhere in the tree (the cache-key collision this
 * same review pass fixed, or any future one) unmounted the whole app with no
 * feedback — a blank page, not a screen. `getDerivedStateFromError` swaps in
 * the fallback synchronously on the next render; `componentDidCatch` logs
 * the real error for whoever is watching the console/error-reporting
 * pipeline, but the fallback itself never surfaces raw error text — same
 * "never an unmapped error string on screen" rule §9.6 sets for API errors.
 *
 * The fallback mirrors `routes/guards.tsx`'s `SetupError` shape (`Wordmark`
 * + `Callout` + a `Button`) so a crash reads as "another calm Pecunia
 * screen," not a foreign error page — every color still traces back to a
 * `--pc-*` token via these same primitives. "Reload" is a full page
 * reload (not a state reset) since a render throw can leave module-level or
 * query-cache state in whatever shape caused the crash; a fresh load is the
 * only recovery guaranteed to be clean.
 *
 * A class component because this is the one thing hooks genuinely cannot
 * do: `getDerivedStateFromError`/`componentDidCatch` are lifecycle methods
 * with no hook equivalent.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Pecunia crashed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
          <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
            <Wordmark size="md" />
            <Callout variant="negative">Something went wrong.</Callout>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
