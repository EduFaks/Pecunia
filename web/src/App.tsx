import { lazy, Suspense } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import AppShell from "./components/layout/AppShell";
import { ToastProvider } from "./components/ui/Toast";
import AccountDetail from "./features/accounts/AccountDetail";
import AccountsScreen from "./features/accounts/AccountsScreen";
import ActivityScreen from "./features/activity/ActivityScreen";
import InsightsScreen from "./features/analytics/InsightsScreen";
import AssetDetail from "./features/assets/AssetDetail";
import AssetsScreen from "./features/assets/AssetsScreen";
import BudgetsScreen from "./features/budgets/BudgetsScreen";
import ContactDetail from "./features/contacts/ContactDetail";
import ContactsScreen from "./features/contacts/ContactsScreen";
import Dashboard from "./features/dashboard/Dashboard";
import LoanDetail from "./features/loans/LoanDetail";
import LoansScreen from "./features/loans/LoansScreen";
import PlannedScreen from "./features/planned/PlannedScreen";
import PortfolioDetail from "./features/portfolio/PortfolioDetail";
import PortfolioScreen from "./features/portfolio/PortfolioScreen";
import ProjectDetail from "./features/projects/ProjectDetail";
import ProjectsScreen from "./features/projects/ProjectsScreen";
import SettingsScreen from "./features/settings/SettingsScreen";
import SubscriptionsScreen from "./features/subscriptions/SubscriptionsScreen";
import TransactionsScreen from "./features/transactions/TransactionsScreen";
import { AuthProvider } from "./lib/auth";
import { queryClient } from "./lib/query";
import { RedirectIfAuthed, RequireAuth, RequireSetup, Splash } from "./routes/guards";
import Login from "./routes/Login";
import NotFound from "./routes/NotFound";

/** Lazy: `WizardShell` (and everything under `features/setup/`) pulls in
 * `zxcvbn`'s ~2MB language dictionary (`PasswordStrength`'s strength meter)
 * plus the whole multi-step wizard — none of which an already-initialized
 * instance (the common case after first run) ever needs. A dynamic
 * `import()` splits it into its own chunk, fetched only when `/setup/*` is
 * actually visited, keeping it out of the main bundle everyone downloads on
 * every load. */
const WizardShell = lazy(() => import("./features/setup/WizardShell"));

/** Lazy AND dev-gated: a plain static `import` still pulls `Showcase`'s
 * module (and its content strings) into the main production bundle even
 * behind an `import.meta.env.DEV` conditional — Rollup keeps any module
 * whose export is referenced anywhere in the source, dead branch or not,
 * and only a minifier-level fold removes the *call site*, not the
 * already-bundled module. A dynamic `import()`, by contrast, is always its
 * own chunk; gating the `import()` call itself behind `DEV` (not just the
 * `<Route>` around it) keeps that chunk out of a production build entirely,
 * not merely unreachable at runtime. */
const Showcase = import.meta.env.DEV ? lazy(() => import("./routes/Showcase")) : null;

/**
 * The route tree. `RequireSetup` is the outermost guard — an uninitialized
 * instance is redirected to `/setup` from anywhere, including the
 * catch-all, before any other guard or route ever renders. Inside it:
 * `/setup/*` (the first-run wizard, `WizardShell` — Plan 06), `/login`
 * behind `RedirectIfAuthed`, and the authed app (`AppShell` + nested
 * screens) at `/` behind `RequireAuth`.
 *
 * `/showcase` (the token/typography reference sheet, Plan 05) sits outside
 * `RequireSetup` entirely and only exists at all in dev (see the `Showcase`
 * lazy import above) — a living design reference for whoever is styling a
 * new screen, reachable regardless of setup/auth state, never shipped to a
 * real deployment.
 */
function AppRoutes() {
  return (
    <Routes>
      {Showcase ? (
        <Route
          path="/showcase"
          element={
            <Suspense fallback={null}>
              <Showcase />
            </Suspense>
          }
        />
      ) : null}
      <Route element={<RequireSetup />}>
        <Route
          path="/setup/*"
          element={
            <Suspense fallback={<Splash />}>
              <WizardShell />
            </Suspense>
          }
        />
        <Route element={<RedirectIfAuthed />}>
          <Route path="/login" element={<Login />} />
        </Route>
        <Route element={<RequireAuth />}>
          <Route path="/" element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="insights" element={<InsightsScreen />} />
            <Route path="accounts" element={<AccountsScreen />} />
            <Route path="accounts/:id" element={<AccountDetail />} />
            <Route path="transactions" element={<TransactionsScreen />} />
            <Route path="contacts" element={<ContactsScreen />} />
            <Route path="contacts/:id" element={<ContactDetail />} />
            <Route path="planned" element={<PlannedScreen />} />
            <Route path="projects" element={<ProjectsScreen />} />
            <Route path="projects/:id" element={<ProjectDetail />} />
            <Route path="assets" element={<AssetsScreen />} />
            <Route path="assets/:id" element={<AssetDetail />} />
            <Route path="portfolio" element={<PortfolioScreen />} />
            <Route path="portfolio/:id" element={<PortfolioDetail />} />
            <Route path="loans" element={<LoansScreen />} />
            <Route path="loans/:id" element={<LoanDetail />} />
            <Route path="subscriptions" element={<SubscriptionsScreen />} />
            <Route path="budgets" element={<BudgetsScreen />} />
            <Route path="activity" element={<ActivityScreen />} />
            <Route path="settings" element={<SettingsScreen />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/**
 * Root component: wires the QueryClient, auth provider, toast host, and
 * router around the guarded route tree. This is the single composition
 * point — `main.tsx` stays a plain bootstrap. `ToastProvider` wraps the
 * router (not the reverse) so a toast fired just before navigation still
 * renders across the transition, and any route can call `useToast()`.
 * `ErrorBoundary` wraps `AppRoutes` specifically (inside the router, not
 * around it) so a crash anywhere in a screen falls back to a calm branded
 * page instead of React's silent unmount-to-blank-page, while `useToast`/
 * `useAuth`/the router itself stay outside the boundary and keep working
 * underneath the fallback.
 */
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          >
            <ErrorBoundary>
              <AppRoutes />
            </ErrorBoundary>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
