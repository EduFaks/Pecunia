import { NavLink } from "react-router-dom";
import { ArrowLeftRight, LayoutDashboard, PieChart, Settings, TrendingUp, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { focusRingClass } from "../ui/a11y";

interface TabItem {
  label: string;
  to: string;
  end: boolean;
  icon: LucideIcon;
}

/**
 * Six tabs, same icons `AppShell`'s sidebar uses for the matching routes
 * (Previsão's `TrendingUp` is its own icon, distinct from the sidebar's
 * Portfolio `LineChart`, so no two sidebar items share a glyph).
 * Transactions/Accounts carry the dashboard cards' Portuguese copy
 * ("Transações"/"Contas", see `SafeToSpendCard`'s "definir orçamento") since
 * this bar is the app's primary nav on a phone, not an echo of the sidebar's
 * English chrome; Dashboard/Insights/Settings stay the same label either way.
 * "Previsão" (Track V) is the forecast tab added alongside Insights — both
 * are the bar's two analytical, non-CRUD screens.
 */
const TABS: TabItem[] = [
  { label: "Dashboard", to: "/", end: true, icon: LayoutDashboard },
  { label: "Transações", to: "/transactions", end: false, icon: ArrowLeftRight },
  { label: "Insights", to: "/insights", end: false, icon: PieChart },
  { label: "Previsão", to: "/forecast", end: false, icon: TrendingUp },
  { label: "Contas", to: "/accounts", end: false, icon: Wallet },
  { label: "Settings", to: "/settings", end: false, icon: Settings },
];

/**
 * Fixed bottom tab bar — the phone-native replacement for digging into the
 * off-canvas drawer for the five routes someone actually jumps between
 * one-handed. `md:hidden` so it never appears alongside the always-visible
 * `md:+` sidebar (`AppShell` renders both; the breakpoint picks one). A
 * named landmark (`aria-label="Tab bar"`) distinct from the sidebar's own
 * `<nav>` so the two don't collide as indistinguishable "navigation"
 * landmarks for assistive tech or `getByRole("navigation")` queries.
 *
 * `pb-[env(safe-area-inset-bottom)]` pads the bar's own bottom edge rather
 * than relying on fixed height, so it grows to clear the iPhone home
 * indicator without the icons/labels themselves sitting inside the inset —
 * `index.html`'s `viewport-fit=cover` is what makes `env()` resolve to a
 * real value instead of `0` in Safari.
 */
function TabBar() {
  return (
    <nav
      aria-label="Tab bar"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-hairline bg-surface-1 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            cn(
              "flex flex-1 flex-col items-center justify-center gap-1 py-2 font-sans text-[11px] transition-colors duration-150 ease-pc",
              isActive ? "text-ink" : "text-ink-2",
              focusRingClass,
            )
          }
        >
          <tab.icon aria-hidden="true" className="h-5 w-5 shrink-0" />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

export default TabBar;
