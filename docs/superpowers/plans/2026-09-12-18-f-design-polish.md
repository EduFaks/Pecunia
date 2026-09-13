# Plan F (v1.1) — Design & Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The final polish pass over the whole v1.1 app: wire the **Plume** logo (sidebar + favicon), swap the stored icon strings and ad-hoc SVGs for **lucide-react** icons, clear the small correctness/consistency items deferred from A–E, and do a **mobile responsiveness + restrained motion** pass — then verify the whole app visually (desktop + mobile) as the end-of-work deliverable. Polishes every screen including the new domains (Planned, Portfolio, Loans, Insights).

**Architecture:** Frontend-only except one tiny backend freshness tweak (analytics net-worth lazy-capture). Everything stays on the `--pc-*` token system (§9); motion uses the existing `--pc-ease`/`--pc-ease-out` tokens and is `prefers-reduced-motion`-safe and RESTRAINED (per the design guidance: over-animation reads as generated). Adds one dep: `lucide-react`.

## Global Constraints
- Follow `docs/CONVENTIONS.md` §9 (tokens only, no raw hex; the §9.1 accent rules). Keep both suites green (backend 561, web 771 at branch start). Conventional commits, **no trailers**. Node via nvm.
- The **Plume** geometry (owner-approved), viewBox `0 0 48 48`, round caps, `stroke="currentColor"` (inherits ink): spine `M15 40 C21 30 28 20 36 10`; vane `M36 10 C40 18 38 27 31 32 C26 35 20 35 16 33`; barbs `M25 25 L32 21` and `M21 31 L28 28`. **Small-size variant** (favicon / ≤20px): thicker stroke, DROP the two barbs (they muddy at 16px).

---

### Task 1: Plume logo — `PlumeMark`, favicon, sidebar lockup

**Files:** Create `web/src/components/brand/PlumeMark.tsx` (+ test); modify `web/src/components/brand/Wordmark.tsx` (mark + text lockup), `web/public/favicon.svg` (or wherever `index.html`'s `/favicon.svg` resolves), the sidebar header in `web/src/components/layout/AppShell.tsx` and the wizard/login `Wordmark` usages; tests.

**Interfaces:** `PlumeMark({ size?, strokeWidth?, showBarbs?=true, className? })` — an inline SVG feather using the geometry above, `stroke="currentColor"` + `fill="none"`, round line caps/joins, `aria-hidden` (decorative; the wordmark carries the name). A `detailed` (barbs) and a `compact` (no barbs, thicker stroke) rendering. `Wordmark` gains an optional `withMark` (default true in the sidebar) placing `PlumeMark` before the "PECUNIA" text in a horizontal lockup, mark sized to the text. Rewrite `favicon.svg` as the compact Plume (thick stroke, no barbs) — near-white stroke on transparent so it reads on both light and dark browser chrome (check the tab).

- [ ] **Step 1: Failing tests (vitest):** `PlumeMark` renders an SVG with the spine path and, in the default variant, the barb paths; the compact variant omits the barbs; it's `aria-hidden`. `Wordmark withMark` renders the mark + the "PECUNIA" text.
- [ ] **Step 2–4:** implement; wire the sidebar/login/wizard wordmarks; update `favicon.svg`; `npm run build && npm run lint && npm run test` green. **Step 5:** commit `feat(web): wire the Plume logo — mark component, favicon, sidebar lockup`.

---

### Task 2: lucide-react icons

**Files:** `web/package.json` (+lock: add `lucide-react`); create `web/src/components/icons/categoryIcon.tsx` (map a stored icon-string → a lucide component, with a sensible fallback) + maybe `navIcon`; modify `web/src/features/categories/CategoryBadge.tsx` + `CategoryPicker.tsx` (render the lucide icon instead of the icon string), `web/src/components/layout/AppShell.tsx` (a lucide icon per nav item), and swap obviously-ad-hoc inline action SVGs (e.g. the mobile menu toggle, chevrons) for lucide where it improves consistency; tests.

**Interfaces:** `CategoryIcon({ name, className })` — looks up the stored lucide name (the DEFAULT_CATEGORIES icon strings: `wallet`, `car`, `shopping-bag`, `home`, `zap`, `utensils`, `heart-pulse`, `clapperboard`, `circle-dashed`, …) in a map to the corresponding lucide-react component; unknown/empty → a neutral fallback (`Circle`/`Tag`). Import icons individually (tree-shakeable: `import { Car } from "lucide-react"`) — do NOT dynamic-import the whole set. Nav gets a small icon per item (Dashboard→LayoutDashboard, Insights→ChartLine/PieChart, Accounts→Wallet, Transactions→ArrowLeftRight, Planned→CalendarClock, Projects→FolderKanban, Assets→Gem, Portfolio→LineChart/TrendingUp, Budgets→Target, Loans→Landmark, Activity→Activity, Settings→Settings). Icons sized to the text, `aria-hidden`, colored by `currentColor` (tokens). Keep the CategoryBadge's color swatch; the icon sits with it.

- [ ] **Step 1: Failing tests (vitest):** `CategoryIcon` renders the mapped lucide icon for a known name and the fallback for an unknown; a `CategoryBadge` shows an icon (not the raw string); nav items render an icon + label. Update any test that asserted the old icon-string text.
- [ ] **Step 2–4:** implement; build/lint/test green (lint must stay at 0 warnings — watch unused imports). **Step 5:** commit `feat(web): lucide-react icons for categories, nav, and actions`.

---

### Task 3: Deferred correctness/consistency nits (from A–E)

**Files:** `web/src/features/transactions/useTransactions.ts` (analytics invalidation), `web/src/features/dashboard/Dashboard.tsx` (+ tests) (demote the per-account line), `web/src/components/charts/IncomeSpendChart.tsx` (aspect ratio), `api/src/pecunia/services/analytics.py` + `api/src/pecunia/api/analytics.py` (net-worth same-day freshness), `web/src/features/portfolio/usePortfolios.ts` + `web/src/features/loans/useLoans.ts` (trim over-broad invalidation); tests.

- [ ] **Step 1:** (a) `useTransactions` create/update/delete mutations must also invalidate `["analytics"]` (a transaction changes cashflow/spending/net-worth) — mirror how Planned's post/skip do it. (b) **Demote the standalone per-account "recent balance" line** on the dashboard: remove that second full-width line chart so the snapshot-backed **net worth over time** is the sole headline line (the per-account series already lives as the sparkline in `AccountsSnapshot` — keep that). (c) `IncomeSpendChart` — drop `preserveAspectRatio="none"` (or set a real aspect) so bars aren't horizontally stretched. (d) net-worth freshness: make `analytics.net_worth_series` capture today's snapshot **per currency present** (not just guard on "any snapshot for today exists"), so adding a new-currency account or same-day activity reflects on the latest point — keep it clock-free (router passes `today`). (e) trim the `qk.accounts` invalidation from portfolio/loan mutations that don't change account balances (keep `qk.portfolios`/`qk.loans` + `["analytics"]`).
- [ ] **Step 2–4:** update/adjust tests for each; both suites green. **Step 5:** commit `fix: deferred polish — analytics invalidation, single dashboard net-worth line, chart aspect, net-worth freshness`.

---

### Task 4: Mobile responsiveness + restrained motion, then visual verification

**Files:** the new-domain screens (`features/planned/*`, `features/portfolio/*`, `features/loans/*`, `features/analytics/InsightsScreen.tsx`) + the dashboard graphs; a shared motion utility (e.g. a small `motion.css`/token-based class or a `Reveal` wrapper); `web/e2e/*` for capture; no product-logic changes.

- [ ] **Step 1 — mobile pass:** audit every screen at a phone width (~375px). Wide content (the holdings/payments/transactions tables, the charts) must scroll inside `overflow-x:auto` containers — the page body must never scroll sideways. Forms stack to one column; row action clusters wrap; the sidebar nav collapses/toggles (verify the existing mobile toggle works with the new nav items + icons). Fix with tokens/utilities only.
- [ ] **Step 2 — restrained motion:** a single, quiet entrance vocabulary — cards/list rows fade + a few px translate-in on mount using `--pc-ease-out`, staggered subtly at most; hovers already exist. Keep it minimal (no bouncing, no parallax). Everything gated by `prefers-reduced-motion: reduce` (the global rule already zeroes durations — make sure new motion is plain CSS transitions/animations it covers). Do NOT over-animate.
- [ ] **Step 3 — verify:** `npm run build && npm run lint && npm run test` green. Then bring up the 3-container stack, seed demo, and capture Playwright screenshots at **desktop (1280)** and **mobile (390)** for: Dashboard, Insights, Transactions, Planned, Projects, Assets, Portfolio, Loans, Budgets, Settings/Categories — into `web/e2e/screenshots/f-*.png`. Review them: no horizontal body scroll on mobile, icons/logo render, charts legible, nav usable. Fix any issue found.
- [ ] **Step 4:** commit `feat(web): mobile responsiveness pass + restrained entrance motion` (+ a follow-up commit `test(web): v1.1 visual verification` if screenshots are tracked; they're gitignored — just keep them for the review).

---

## Self-review notes
- **Coverage:** logo wired (T1), lucide across categories/nav/actions (T2), the five deferred A–E nits cleared (T3), mobile + restrained motion + a full visual sweep (T4). Every new-domain screen is polished and verified on desktop + mobile.
- **Consistency:** tokens-only; lucide imported per-icon (tree-shaken); motion via existing ease tokens + reduced-motion-safe; the Plume uses `currentColor` so it inherits ink and needs no new color.
- **Restraint:** motion is deliberately minimal (the design guidance flags over-animation as a tell). The logo/icons are the visible upgrade; motion is a light touch.
- **End deliverable:** the T4 desktop+mobile screenshots are the consolidated review set to hand the owner.
