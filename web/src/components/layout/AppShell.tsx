import { useEffect, useId, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  ArrowLeftRight,
  CalendarClock,
  FolderKanban,
  Gem,
  Landmark,
  LayoutDashboard,
  LineChart,
  Menu,
  PieChart,
  RefreshCw,
  Settings,
  Target,
  Users,
  Wallet,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { useAuth } from "../../lib/auth";
import { focusRingClass } from "../ui/a11y";
import Button from "../ui/Button";
import Wordmark from "../brand/Wordmark";
import DemoChip from "./DemoChip";

interface NavItem {
  label: string;
  to: string;
  end: boolean;
  icon: LucideIcon;
}

/** Sidebar nav, wired to the real routes `App.tsx` mounts under `AppShell`,
 * grouped under small non-clickable section headers (the Settings sub-nav's
 * uppercase tracked muted label idiom) so 14 items scan without extra
 * clicks. A `null` section renders no header — the final Activity/Settings
 * group, pinned to the sidebar's bottom via `mt-auto`. `end: true` on
 * Dashboard keeps it from matching every nested path the way an unqualified
 * `/` prefix match would. Each item carries a lucide `icon` rendered
 * (decorative, `aria-hidden`, `currentColor`) before its label. */
const NAV_GROUPS: { section: string | null; items: NavItem[] }[] = [
  {
    section: "Overview",
    items: [
      { label: "Dashboard", to: "/", end: true, icon: LayoutDashboard },
      { label: "Insights", to: "/insights", end: false, icon: PieChart },
    ],
  },
  {
    section: "Money",
    items: [
      { label: "Transactions", to: "/transactions", end: false, icon: ArrowLeftRight },
      { label: "Planned", to: "/planned", end: false, icon: CalendarClock },
      { label: "Subscriptions", to: "/subscriptions", end: false, icon: RefreshCw },
      { label: "Budgets", to: "/budgets", end: false, icon: Target },
    ],
  },
  {
    section: "Net worth",
    items: [
      { label: "Accounts", to: "/accounts", end: false, icon: Wallet },
      { label: "Portfolio", to: "/portfolio", end: false, icon: LineChart },
      { label: "Assets", to: "/assets", end: false, icon: Gem },
      { label: "Loans", to: "/loans", end: false, icon: Landmark },
    ],
  },
  {
    section: "Plan",
    items: [
      { label: "Contacts", to: "/contacts", end: false, icon: Users },
      { label: "Projects", to: "/projects", end: false, icon: FolderKanban },
    ],
  },
  {
    section: null,
    items: [
      { label: "Activity", to: "/activity", end: false, icon: Activity },
      { label: "Settings", to: "/settings", end: false, icon: Settings },
    ],
  },
];

/**
 * Dark sidebar + topbar frame for the authed app: near-black surfaces,
 * hairline borders, the white accent reserved for the active nav item, and
 * a system-sans wordmark. `DemoChip` mounts once here (topbar), so it's
 * visible from every screen.
 *
 * The sidebar (`<aside>`) is a single shared landmark, not two copies for
 * desktop/mobile — it's `fixed` and off-canvas (`-translate-x-full`) below
 * the `md` breakpoint, sliding in as a drawer when `navOpen`, and reverts to
 * its original static, always-visible `w-56` column at `md:` and up via
 * responsive overrides layered on the same classes (the desktop rendering
 * is unchanged). The topbar's menu button (`md:hidden`) is the only new
 * chrome; it's wired with `aria-expanded`/`aria-controls` per the nav's
 * `useId`, closes on Escape (restoring focus to itself, `ConfirmDialog`'s
 * pattern) and on a backdrop click, and closes automatically when a nav
 * link is activated so navigating on a phone doesn't leave the drawer open
 * over the new screen.
 */
function AppShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const navId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!navOpen) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setNavOpen(false);
        toggleRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [navOpen]);

  return (
    <div className="flex min-h-screen bg-canvas text-ink">
      {navOpen ? (
        <div
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-canvas/70 md:hidden"
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-hairline bg-surface-1 shadow-pc-2 transition-transform duration-200 ease-pc",
          "md:sticky md:top-0 md:h-screen md:self-start md:overflow-y-auto md:z-auto md:w-56 md:translate-x-0 md:shadow-none",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="border-b border-hairline px-6 py-5">
          <Wordmark size="sm" withMark />
        </div>
        <nav
          id={navId}
          className="flex flex-1 flex-col gap-5 px-3 py-4"
          onClick={() => setNavOpen(false)}
        >
          {NAV_GROUPS.map((group) => (
            <div key={group.section ?? "pinned"} className={group.section ? undefined : "mt-auto"}>
              {group.section ? (
                <p className="mb-1 px-3 font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">
                  {group.section}
                </p>
              ) : null}
              <ul className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        cn(
                          "flex items-center gap-2.5 rounded-pc px-3 py-2 font-sans text-sm transition-colors duration-150 ease-pc",
                          isActive
                            ? "bg-accent-soft text-ink"
                            : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                          focusRingClass,
                        )
                      }
                    >
                      <item.icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-hairline bg-surface-1 px-4 py-3 md:px-6 md:py-4">
          <div className="flex items-center gap-3">
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={navOpen}
              aria-controls={navId}
              onClick={() => setNavOpen((open) => !open)}
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-pc text-ink-2 transition-colors duration-150 ease-pc hover:bg-surface-2 hover:text-ink md:hidden",
                focusRingClass,
              )}
            >
              <span className="sr-only">{navOpen ? "Close navigation" : "Open navigation"}</span>
              {navOpen ? (
                <X aria-hidden="true" className="h-4 w-4" />
              ) : (
                <Menu aria-hidden="true" className="h-4 w-4" />
              )}
            </button>
            <span className="hidden font-mono text-xs uppercase tracking-[0.2em] text-ink-faint md:inline">
              Workspace
            </span>
            <DemoChip />
          </div>
          <div className="flex items-center gap-4">
            {user ? (
              <span className="hidden font-mono text-xs text-ink-2 md:inline">{user.email}</span>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              Log out
            </Button>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
          {/* One restrained entrance for the whole app: keying this wrapper on
              the pathname remounts it each navigation, replaying the quiet
              `.pc-reveal` fade (reduced-motion-safe, pure CSS) once per screen —
              so the motion lives in a single place instead of every screen. */}
          <div key={location.pathname} className="pc-reveal">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

export default AppShell;
