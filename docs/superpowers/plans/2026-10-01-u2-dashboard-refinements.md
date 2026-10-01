# Track U2 (v1.6.1) — Dashboard Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the dashboard figures from real-use feedback — scope "gastei em quê" to the current month, fold credit-card bills into safe-to-spend without double-counting, roll stale card due dates forward, show signed/colored breakdowns + projected in/out, and make the hero bar a segmented month view with a budget marker.

**Architecture:** A reusable date-roll helper in `pecunia.period`; `SafeToSpendService` gains a card-bill term (`abs(owed) − card_spend_mtd`, due-this-month only) plus a richer breakdown; the bank-sync connections endpoint exposes a rolled `next_bill_due_date`; five dashboard card components get the month-scope fix, the signed breakdown + segmented bar, projected in/out, and the rolled due date.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest+testcontainers; Vite/React/TS, TanStack Query, Recharts, Vitest, Tailwind v4.

## Global Constraints

- `docs/CONVENTIONS.md`: money = integer minor units, **never summed across currencies** (per-currency maps); services flush / routers commit; services clock-free (`today: date` passed in); workspace scoping via `scoped_select`/`get_scoped`. Conventional commits, **NO trailers**.
- Frontend: Tailwind `--pc-*`/`--color-*` tokens only (no raw hex); `--pc-positive`/`--pc-negative` for value movement only; `MoneyText`/`DateText`; `qk` factory; co-located Vitest; `min-w-0`/`flex-wrap`.
- Base-currency (BRL) dashboard view.
- **Branch `feat/plan-u2-refinements` off `main`.** Baseline first: `cd api && uv run pytest -q` (currently 851) and `cd web && npm run build && npm run lint && npm run test` (currently 1037) — record, stay green, 0 new warnings. Docker running for the API suite.
- **No DB migration** (card-bill data already on `bank_account_links`; budget already in settings).

---

### Task 1: `next_due_on_or_after` helper + `next_bill_due_date` on connections (backend)

**Files:**
- Modify: `api/src/pecunia/period.py` (add helper), `api/src/pecunia/api/banksync.py` (`BankLinkOut` + mapping), `api/src/pecunia/services/banksync/sync.py` (`list_connections` link dict)
- Test: `api/tests/test_period.py` (helper), `api/tests/test_banksync_api.py` (endpoint field)

**Interfaces — Produces:**
```python
# pecunia/period.py
def next_due_on_or_after(anchor: date, ref: date) -> date:
    """The next date on `anchor`'s day-of-month that is >= `ref`. Months
    without that day clamp to the month's last day (calendar.monthrange),
    matching the clamping `advance` already uses. Pure, clock-free."""
```
`BankLinkOut` (api/banksync.py) gains `next_bill_due_date: date | None` — for a link with a `bill_due_date`, `next_due_on_or_after(bill_due_date, today)`; `None` when `bill_due_date` is None. `list_connections` (sync.py) adds `"next_bill_due_date"` to each link dict (router passes `today=date.today()` into `list_connections`, OR the router computes the roll from the returned `bill_due_date` — pick the router-computes option to keep `list_connections` clock-free: the `GET /bank-sync/connections` handler maps each link dict, adding `next_bill_due_date = next_due_on_or_after(d["bill_due_date"], date.today()) if d["bill_due_date"] else None`).

- [ ] **Step 1:** Failing tests. `test_period.py`: `next_due_on_or_after(date(2026,9,11), date(2026,10,1)) == date(2026,10,11)`; same-month-future stays this month (`anchor day 20, ref day 5 → this month 20`); ref past the day → next month (`anchor day 5, ref day 10 → next month 5`); Jan-31 anchor into February clamps to Feb-28/29; anchor exactly == ref returns ref. `test_banksync_api.py`: a linked credit card with `bill_due_date` in the past returns a `next_bill_due_date` that is `>= today` on `GET /bank-sync/connections`.
- [ ] **Step 2:** Run focused → FAIL.
- [ ] **Step 3:** Implement the helper + wire `next_bill_due_date` (router-level roll, `BankLinkOut` field).
- [ ] **Step 4:** `cd api && uv run pytest tests/test_period.py tests/test_banksync_api.py -q` → PASS; full suite green.
- [ ] **Step 5:** Commit `feat: roll bank bill due dates forward (next_bill_due_date)`.

---

### Task 2: Safe-to-spend — card bills + breakdown split + projected fields (backend)

**Files:**
- Modify: `api/src/pecunia/services/safe_to_spend.py`, `api/src/pecunia/api/analytics.py` (`SafeToSpendOut` new fields)
- Test: `api/tests/test_safe_to_spend.py`, `api/tests/test_analytics.py` (endpoint shape)

**Interfaces — Consumes:** `next_due_on_or_after` (Task 1); `BankAccountLink` (`account_id`, `provider_balance_minor`, `bill_due_date`), `Account` (`type`, `currency`); `AnalyticsService.cashflow`; existing `current_window`.

**Interfaces — Produces:** `SafeToSpendService.compute` result dict gains `committed_cards_minor`, `committed_other_minor` (sum == `committed_remaining_minor`), `projected_income_minor` (== `expected_income_minor`), `projected_expense_minor` (== `spent_mtd_minor + committed_remaining_minor`). `SafeToSpendOut` mirrors these.

Card-bill term, per linked credit card (inside `compute`, before the per-currency assembly):
- Load `BankAccountLink`s joined to their `Account` (scoped). For each where `account.type == "credit_card"`, `link.provider_balance_minor is not None`, `link.bill_due_date is not None`, and `next_due_on_or_after(link.bill_due_date, today)` ∈ `(today, month_end]`:
  - `owed = abs(link.provider_balance_minor)` (credit balance is stored negative).
  - `card_spend_mtd` = Σ magnitude of this-month expense transactions on that account: `-SUM(amount_minor)` where `account_id == link.account_id`, `amount_minor < 0`, `occurred_on` in `[month_start, today]`, `deleted_at IS NULL` (one scoped aggregate query per card, small N).
  - `card_bill = max(0, owed - card_spend_mtd)`.
  - Add `card_bill` to `committed_cards[account.currency]`.
- `committed_remaining[currency] += committed_cards[currency]`; keep `committed_other` = the pre-card committed (subscriptions+loans+scheduled-expense) so the split is reported. The budget cap / `displayed`/`limited_by` / `daily_allowance` math is unchanged but now sees the larger `committed_remaining`.
- No double-count: this-month card purchases are in `spent_mtd` AND subtracted via `card_spend_mtd`, so only prior-cycle debt due now is added.

- [ ] **Step 1:** Failing tests in `test_safe_to_spend.py`:
  - Card due this month counts: a linked credit card, `provider_balance_minor = -1300000`, `bill_due_date` a past date whose rolled next-due is in `(today, month_end]`, zero card spend this month → `committed_cards_minor == 1300000`, `committed_remaining_minor` increases by it, `safe_minor` drops by it.
  - No double-count: same card but with a −R$200,00 expense transaction this month on that account → `committed_cards_minor == 1300000 − 20000 == 1280000`.
  - Due next month excluded: rolled next-due falls after `month_end` → `committed_cards_minor == 0`.
  - Paid down (card_spend_mtd > owed) → `max(0, …) == 0`.
  - `committed_cards_minor + committed_other_minor == committed_remaining_minor`.
  - `projected_income_minor == expected_income_minor`; `projected_expense_minor == spent_mtd_minor + committed_remaining_minor`.
  - Per-currency: a card in a non-base currency contributes to its own currency only.
  - Endpoint test in `test_analytics.py`: `GET /analytics/safe-to-spend` returns the new fields.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd api && uv run pytest tests/test_safe_to_spend.py tests/test_analytics.py -q` → PASS; full suite green.
- [ ] **Step 5:** Commit `feat: fold credit-card bills into safe-to-spend without double-counting`.

---

### Task 3: SpendingBreakdownCard — current-month scope (frontend)

**Files:** Modify `web/src/features/dashboard/SpendingBreakdownCard.tsx`; Test `web/src/features/dashboard/SpendingBreakdownCard.test.tsx`

**Interfaces — Consumes:** `useSpendingByCategory({ range })` where `range: { from: string, to: string }` (ISO dates) → donut for the window; `useCashflow()` (unranged, for vs-last-month) stays.

The donut + month total must reflect the **current calendar month**: compute `range = { from: <first of this month, ISO>, to: <today, ISO> }` and pass it to `useSpendingByCategory({ range })`. Keep `useCashflow()` unranged (it drives the "vs mês passado" delta from the last two dense months — do NOT range-scope it). Build the month boundaries with local date math (first-of-month = `new Date(y, m, 1)`, today) formatted as `YYYY-MM-DD`. Empty current month → "sem gastos neste mês".

- [ ] **Step 1:** Failing Vitest: the card calls `apiFetch` for spending-by-category with `?from=<month start>&to=<today>` (assert the URL/range), NOT the bare 12-month path; donut/total reflect the mocked month response; empty month shows "sem gastos neste mês"; the vs-last-month delta still renders from the (unranged) cashflow mock.
- [ ] **Step 2–4:** implement; `cd web && npm run build && npm run lint && npm run test` green, 0 new warnings.
- [ ] **Step 5:** Commit `fix(web): scope spending-by-category to the current month`.

---

### Task 4: SafeToSpendCard — signed breakdown + segmented bar + budget marker (frontend)

**Files:** Modify `web/src/features/dashboard/SafeToSpendCard.tsx`; Test `.test.tsx`; may add `web/src/features/dashboard/safeToSpendBar.ts` (pure segment math + its test), mirroring the `creditCardUsage.ts` convention.

**Interfaces — Consumes:** `useSafeToSpend()` now returns `committed_cards_minor`, `committed_other_minor`, `projected_income_minor`, `projected_expense_minor` (Task 2) in addition to the existing fields. Extend the `SafeToSpend` TS interface in `useDashboard.ts` with those four fields.

- **Signed/colored breakdown** (replaces the current plain line): `renda +<expected_income>` (positive tone) · `fixos a vir −<committed_remaining>` (negative tone) · `gasto −<spent_mtd>` (negative tone). When `committed_cards_minor > 0`, a sub-note "inclui fatura de cartão <committed_cards_minor>". Use `MoneyText` with explicit sign prefixes; positive/negative tones via the semantic tokens.
- **Segmented bar** — a pure helper `safeToSpendSegments({ expected_income_minor, spent_mtd_minor, committed_remaining_minor, displayed_safe_minor, monthly_budget_minor })` → `{ spentPct, committedPct, freePct, budgetMarkerPct|null }`, all clamped so the three segments never exceed 100% of `expected_income_minor` (the month total); `budgetMarkerPct = monthly_budget_minor/expected_income_minor` clamped 0–100, or `null` when no budget or `expected_income_minor == 0`. Render three stacked inline segments left→right: spent (solid neutral `bg-ink`), committed-to-come (hatched — a token-based `repeating-linear-gradient` of the accent at low alpha), free (empty track `bg-surface-2`). When `expected_income_minor == 0`, render an empty track. Budget marker = a 2px vertical line (token color) at `budgetMarkerPct`, with an `aria-label`. Keep a `role="progressbar"` on the spent portion (`aria-valuenow = spent`, `aria-valuemax = expected_income`) + `aria-label`s on committed and marker. No raw hex — the hatch is a gradient over token colors.
- The hero figure (`displayed_safe_minor`, "livre pra gastar") and the budget editor stay as they are.

- [ ] **Step 1:** Failing Vitest: breakdown shows the three signed/colored figures and the "inclui fatura de cartão" sub-note when `committed_cards_minor > 0` (and not when 0); `safeToSpendSegments` unit tests (normal split sums to 100%; clamp when spent+committed exceed income; budget marker position; `null` marker with no budget / zero income; no NaN); the bar renders three segments and a marker when a budget is set (assert the marker present/absent).
- [ ] **Step 2–4:** implement; web gate green, 0 new warnings.
- [ ] **Step 5:** Commit `feat(web): signed breakdown + segmented safe-to-spend bar with budget marker`.

---

### Task 5: MonthResultCard — projected in/out (frontend)

**Files:** Modify `web/src/features/dashboard/MonthResultCard.tsx`; Test `.test.tsx`

**Interfaces — Consumes:** `useSummary()` (`savings.income_minor`/`savings.spend_minor` actual MTD) + `useSafeToSpend()` (`projected_income_minor`, `projected_expense_minor`, `safe_minor`).

Rows: "Entrou <income_mtd> (previsto <projected_income_minor>)"; "Saiu <spend_mtd> (previsto <projected_expense_minor>)"; "Projeção fim do mês <safe_minor>" (green ≥0 / red <0, unchanged source). The "(previsto …)" figure in a muted/secondary tone; actuals in the primary tone. pt-BR, consistent.

- [ ] **Step 1:** Failing Vitest: both rows render actual + "(previsto …)" from mocked `useSummary` + `useSafeToSpend`; projection row keeps its sign/color; when projected == actual (nothing scheduled) the "(previsto …)" still renders (not hidden).
- [ ] **Step 2–4:** implement; web gate green.
- [ ] **Step 5:** Commit `feat(web): show projected income/expense on the month-result card`.

---

### Task 6: AccountsCardsCard — rolled due date (frontend)

**Files:** Modify `web/src/features/dashboard/AccountsCardsCard.tsx`; Test `.test.tsx`; extend the `BankLink` TS type in `web/src/features/banksync/useBankSync.ts` with `next_bill_due_date: string | null`.

**Interfaces — Consumes:** `useBankConnections()` links now include `next_bill_due_date` (Task 1). Display "vence <DateText next_bill_due_date>" for linked credit cards instead of the raw `bill_due_date`. If `next_bill_due_date` is null, show no due line.

- [ ] **Step 1:** Failing Vitest: a linked credit card whose `bill_due_date` is in the past but `next_bill_due_date` is in the future shows the **future** date (assert the rolled date text, and that the past raw date is not shown).
- [ ] **Step 2–4:** implement; web gate green.
- [ ] **Step 5:** Commit `fix(web): show the rolled next bill due date on cards`.

---

## Self-review notes
- **Spec coverage:** U2-1 → Tasks 1 (roll + endpoint field) + 2 (card bills + breakdown + projected); U2-2 → Task 3; U2-3 → Task 4; U2-4 → Task 5; U2-5 → Task 6.
- **Consistency:** `next_due_on_or_after` defined in Task 1, consumed in Tasks 2 (service) and surfaced via Task 1's `next_bill_due_date` used in Task 6; the four new `SafeToSpend` fields (`committed_cards_minor`, `committed_other_minor`, `projected_income_minor`, `projected_expense_minor`) defined in Task 2 and consumed in Tasks 4 (bar/breakdown) + 5 (projection); `committed_cards + committed_other == committed_remaining` asserted in Task 2.
- **No double-count:** Task 2 subtracts `card_spend_mtd` from the card bill; this-month card purchases stay only in `spent_mtd`.
- **No migration;** no backend change in Tasks 3–6; `useCashflow` deliberately left unranged in Task 3 so the vs-last-month delta keeps working.
- **Deferred (per spec):** Pluggy `/bills` import, minimum-vs-full statement modeling, multi-currency budgets, category-mapping setup.
