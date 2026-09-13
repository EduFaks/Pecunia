# Track P (v1.4) — Refined Screens: Per-Currency Summary Totals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give every list screen a summary header with per-currency totals (Accounts total, Portfolio grand total, Loans borrowed/lent/remaining, Assets total, Subscriptions rollup, Planned due, Transactions in/out/net), computed from the already-fetched lists.

**Architecture:** One shared presentational `<SummaryHeader>` (tokens, responsive, `flex-wrap`, per-currency rows) plus tiny pure per-screen aggregation helpers over the bounded (`limit=200`) lists each screen already loads. No new endpoints (no screen truncates today); the one honest caveat — Transactions is keyset-paginated, so its totals are labelled "this page" when a `next_cursor` is present.

**Tech Stack:** Vite/React/TS, Tailwind v4 tokens, TanStack Query, Vitest.

## Global Constraints
- `docs/CONVENTIONS.md` §4 (money integer minor units, **never sum across currencies** — group by currency) + §9 tokens only; respect the mobile work (`flex-wrap`, no overflow at 360px). Conventional commits, **NO trailers**.
- **Baseline first:** `cd web && source ~/.nvm/nvm.sh && npm run test` — record the count; stay green (0 new warnings).
- Reuse existing formatters (`MoneyText`, `lib/format`); do NOT refetch — aggregate the data the screen already has.

---

### Task 1: Shared `<SummaryHeader>` + per-currency aggregation helper

**Files:** Create `web/src/components/ui/SummaryHeader.tsx` and `web/src/features/_shared/totals.ts` (pure `sumByCurrency(items, pick)` → `{currency: total_minor}[]`); Tests `SummaryHeader.test.tsx`, `totals.test.ts`.

**Interfaces — Produces:** `sumByCurrency<T>(items: T[], amount: (t:T)=>number, currency:(t:T)=>string): {currency:string; total_minor:number}[]` (stable currency order); `<SummaryHeader stats={{label:string; entries:{currency:string; value_minor:number; tone?:"pos"|"neg"|"muted"}[]}[]} note?={string} />`.

- [ ] **Step 1:** Failing tests: `sumByCurrency` groups + sums per currency incl. negatives, omits empty; `<SummaryHeader>` renders each stat's per-currency figures with the right tone, shows `note` when given, and an empty state.
- [ ] **Step 2–4:** implement; green.
- [ ] **Step 5:** Commit `feat(web): shared per-currency SummaryHeader + totals helper`.

---

### Task 2: Wire summaries into Accounts / Portfolio / Loans / Assets

**Files:** Modify `web/src/features/accounts/AccountsScreen.tsx`, `web/src/features/portfolio/PortfolioScreen.tsx`, `web/src/features/loans/LoansScreen.tsx`, `web/src/features/assets/AssetsScreen.tsx`; Tests alongside each.

**Interfaces — Consumes:** Task 1. Accounts: total balance per currency. Portfolio: Σ `value_minor` per currency. Loans: three stats — borrowed (direction=borrowed principal-remaining), lent, total remaining — per currency. Assets: Σ current value per currency.

- [ ] **Step 1:** Failing tests per screen: header shows the correct per-currency totals from a mocked list (incl. a negative account, a mixed-currency set kept separate).
- [ ] **Step 2–4:** implement; green.
- [ ] **Step 5:** Commit `feat(web): summary totals on accounts/portfolio/loans/assets`.

---

### Task 3: Wire summaries into Subscriptions / Planned / Transactions

**Files:** Modify `web/src/features/subscriptions/SubscriptionsScreen.tsx` (fold the existing monthly+annual rollup into `<SummaryHeader>`), `web/src/features/planned/PlannedScreen.tsx` (total upcoming, signed), `web/src/features/transactions/TransactionsScreen.tsx` (in / out / net of the loaded rows, `note="this page"` when `next_cursor` is present); Tests alongside.

- [ ] **Step 1:** Failing tests: subscriptions header keeps the monthly+annual figures via the shared component; planned sums the signed upcoming per currency; transactions shows in/out/net and the "this page" note only when a cursor exists.
- [ ] **Step 2–4:** implement; `npm run build && lint && test` green (0 warnings).
- [ ] **Step 5:** Commit `feat(web): summary totals on subscriptions/planned/transactions`.

## Self-review notes
- **Coverage:** shared header+helper (T1); 4 value screens (T2); the 3 rollup/paged screens (T3).
- **Consistency:** per-currency grouping everywhere; no refetch; honest "this page" on the only keyset screen.
- **Deferred:** server-side totals (unnecessary — every screen already loads its full bounded list).
