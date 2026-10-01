# Pecunia v1.6.1 — Dashboard Refinements (Design)

**Status:** approved 2026-10-01. A refinement pass on Track U (the daily dashboard), from real-use feedback. Call it **Track U2**.

## Goal

Fix the dashboard figures that read wrong in real use and make the "safe-to-spend" number trustworthy and legible: scope spending to the current month, fold credit-card bills into committed outflow (without double-counting), show signed/colored breakdowns and projected in/out, roll stale card due dates forward, and turn the hero progress bar into a segmented month view with an optional budget marker.

## Global constraints

Follows `docs/CONVENTIONS.md`:
- Money = integer minor units, **never summed across currencies** (per-currency maps); services flush / routers commit; services clock-free (`today` passed in).
- Frontend: Tailwind `--pc-*` tokens only (no raw hex); semantic `--pc-positive`/`--pc-negative` for value movement only; Recharts via the existing wrappers; `MoneyText`/`DateText`; `qk` factory; co-located Vitest.
- Conventional commits, NO trailers. TDD. `cd api && uv run pytest -q` and `cd web && npm run build && lint && test` green, 0 new warnings.
- Base-currency view (BRL) for the dashboard, as in Track U.

## Verified facts behind these changes (investigated 2026-10-01 against live data)

- "Gastei em quê" showed R$103,390 on Oct 1 because `SpendingBreakdownCard` uses the default rolling-12-month analytics window; all 125 imported transactions are dated September (R$103,079 of it uncategorized — no category mappings set yet). October MTD spend = R$0.
- Pluggy returns `creditData.balanceDueDate` as the **last closed** bill's due date (past): BTG `2026-09-11`, Inter `2026-09-10`, C6 `2026-09-10`, XP `2026-09-15`; `balanceCloseDate` is null for all. So due dates must be rolled forward for display and for the safe-to-spend window test.
- Safe-to-spend currently ignores credit-card bills entirely, so a R$13,361 BTG bill due this month does not reduce "livre pra gastar".

## Locked decisions (from brainstorming)

1. Credit-card bills count in safe-to-spend **without double-counting**: per linked card, `max(0, abs(amount_owed) − card_spend_mtd_on_that_card)`, only when the (rolled) due date is in `(today, month_end]`.
2. Roll stale Pluggy due dates to the **next occurrence of that day-of-month ≥ today**; expose as `next_bill_due_date`; use it for both display and the safe-to-spend window test.
3. "Resultado do mês" shows projected in/out derived from the **same** safe-to-spend figures (no second source): projected income = `expected_income`; projected expense = `spent_mtd + committed_remaining`; net projection = `safe_minor`.
4. The hero bar is **segmented over the month total** (`expected_income`): spent (solid) · committed-to-come (hatched) · free (empty); an optional **budget marker line** at `monthly_budget / expected_income`.
5. "Gastei em quê" is scoped to the **current calendar month**.

---

## Track U2 — the work

### U2-1. Safe-to-spend: card bills + due-date roll + richer breakdown (backend)

`api/src/pecunia/services/safe_to_spend.py` — extend `compute`:
- New helper `next_due_date(day_anchor: date, *, today: date) -> date`: returns the next date on `day_anchor`'s day-of-month that is `>= today` (clamp months without that day to the last day, reusing `pecunia.period`). Pure, unit-tested.
- **Card-bill committed:** for each `bank_account_link` whose account `type == "credit_card"` and whose `next_due_date(link.bill_due_date)` ∈ `(today, month_end]`, add `max(0, abs(link.provider_balance_minor) − card_spend_mtd)` to `committed_remaining`, where `card_spend_mtd` = Σ of this month's expense transaction magnitudes on that account (one scoped query, or reuse cashflow per account). Links with no `bill_due_date` or no `provider_balance_minor` are skipped. Per currency (card's account currency).
- **Breakdown fields** added to `SafeToSpendOut`: `committed_cards_minor` (the card portion) and `committed_other_minor` (subscriptions + loans + recurring-planned) so the UI can label them; `committed_remaining_minor` stays the sum. Also add `projected_income_minor` (= `expected_income_minor`) and `projected_expense_minor` (= `spent_mtd_minor + committed_remaining_minor`) so the dashboard has one source for the month projection.
- No double-count: this-month card purchases are already in `spent_mtd`; `committed_cards` subtracts them, leaving only the prior-cycle debt due now.

`api/src/pecunia/api/banksync.py` — `BankLinkOut` gains `next_bill_due_date: date | None` (rolled via the same helper, computed in the router/service from `bill_due_date`), so the frontend shows the upcoming date, never a past one. `bill_due_date` (raw) stays for reference.

**Tests:** `next_due_date` (same-month-future, past-day→next-month, Jan31→Feb clamp); card-bill inclusion (due this month counts, due-next-month excluded, balance−mtd no double-count, paid-down→0); `committed_cards` + `committed_other` split sums to `committed_remaining`; `projected_income`/`projected_expense` identities; per-currency; `next_bill_due_date` on the connections endpoint.

### U2-2. SpendingBreakdownCard current-month fix (frontend)

`web/src/features/dashboard/SpendingBreakdownCard.tsx` — request `useSpendingByCategory` with the **current calendar month** window (from = month start, to = today) instead of the default 12-month window, so the donut + total reflect this month. The "vs mês passado" delta already compares current vs previous `spend_minor` from `useCashflow` and stays. Verify the hook/endpoint accept a range arg (analytics endpoints take `from`/`to`); thread it through. **Test:** card requests the month window; donut/total reflect it; empty current month → "sem gastos neste mês" (not a stale year total).

### U2-3. SafeToSpendCard breakdown + segmented bar (frontend)

`web/src/features/dashboard/SafeToSpendCard.tsx`:
- **Signed/colored breakdown:** `renda +<expected_income>` (positive tone) · `fixos a vir −<committed_remaining>` (negative tone) · `gasto −<spent_mtd>` (negative tone). If `committed_cards_minor > 0`, a sub-note "inclui fatura de cartão <committed_cards>".
- **Segmented bar** over total = `expected_income_minor`: three segments left→right — `spent_mtd` (solid `bg-ink`/neutral), `committed_remaining` (hatched via a CSS `repeating-linear-gradient` using accent at low alpha), `displayed_safe` (empty/track). Clamp so segments never exceed the total; if `expected_income == 0`, render an empty track. **Budget marker:** when `monthly_budget_minor` is set, a 2px vertical line at `budget / expected_income` (clamped 0–100%), with an accessible label; spending past the line reads as over-budget (hero already shows `displayed_safe`). A11y: keep `role="progressbar"` semantics on the spent portion (aria-valuenow = spent, max = expected_income) plus `aria-label`s on the hatched/marker. Hatch pattern must be a token-based gradient, not raw hex.

### U2-4. MonthResultCard projected in/out (frontend)

`web/src/features/dashboard/MonthResultCard.tsx` — reuse `useSafeToSpend()`:
- "Entrou <income_mtd> (previsto <projected_income>)" — actual MTD income from `useSummary().savings.income_minor`, projected from `projected_income_minor`.
- "Saiu <spend_mtd> (previsto <projected_expense>)" — actual from `useSummary().savings.spend_minor`, projected from `projected_expense_minor`.
- "Projeção fim do mês <safe_minor>" (green ≥0 / red <0) — unchanged source. Labels pt-BR, consistent.
**Test:** actual + "(previsto …)" render for both rows from mocked responses; projection sign/color unchanged.

### U2-5. AccountsCardsCard rolled due date (frontend)

`web/src/features/dashboard/AccountsCardsCard.tsx` — display `next_bill_due_date` (from U2-1) instead of the raw `bill_due_date`, so credit cards show the upcoming due date (e.g. "vence 11/10"), never a past one. **Test:** a card with a past raw `bill_due_date` shows the rolled future date.

## Testing strategy

TDD per unit. Backend: pytest + testcontainers, no network (fixtures). Frontend: Vitest + Testing Library, `apiFetch` mocked, Recharts stubbed. Everything green, 0 new warnings, before merge.

## Out of scope / deferred

Importing credit-card bills via Pluggy `/bills` (we approximate the amount due from balance − this-month card spend); minimum-payment vs full-statement modeling (assumes pay-in-full); multi-currency budgets; the category-mapping setup itself (user configures mappings to make the donut categorized — the dashboard just reflects what's mapped).
