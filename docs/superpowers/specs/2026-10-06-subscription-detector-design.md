# Pecunia v1.8 — Subscription Detector (Design)

**Status:** approved 2026-10-06. Call it **Track W**.

## Goal

Stop making the user hand-enter every subscription: scan the automatically-imported bank/card transactions for recurring charges, suggest them as candidate subscriptions the user confirms (pre-filled, editable), and surface subscription spend broken down by category — on top of the monthly/annual rollup that already exists. Capturing Pluggy's merchant name (currently dropped at import) is the prerequisite that makes detection accurate.

## Global constraints

Follows `docs/CONVENTIONS.md`:
- Money = integer minor units, **never summed across currencies** (per-currency maps); services flush / routers commit; services **clock-free** (`today: date` passed in).
- StrEnum/CHECK conventions; migration hand-written (`0006`, `down_revision="0005"`), naming-convention parity (`compare_metadata`); new nullable column is additive. New column joins NO housekeeping lists (it's a column, not a table).
- Frontend: Tailwind `--pc-*` tokens only; `MoneyText`/`DateText`; `qk` factory; co-located Vitest; reuse the existing `SubscriptionForm`/`useCreateSubscription` to confirm a candidate (no new write path).
- Conventional commits, NO trailers. TDD. `pytest` + `npm run build && lint && test` green, 0 new warnings.
- Suggestions are **suggest-and-confirm** — nothing becomes a `Subscription` without the user's explicit confirm.

## What exists (build on, don't rebuild)

- **Subscription domain is complete**: model (`billing_frequency` ∈ weekly|monthly|quarterly|yearly, CHECK), `SubscriptionService` (CRUD + `renew` + `set_status`), module-level `annual_minor`/`monthly_minor` normalization (`_ANNUAL_FACTOR = {weekly:52,monthly:12,quarterly:4,yearly:1}`), `totals(status) -> {currency:{monthly_minor,annual_minor,count}}`, `POST /subscriptions` + `SubscriptionForm` + `useCreateSubscription`, `SubscriptionsScreen` with a `SummaryHeader` (monthly + annual). No by-category grouping yet.
- **No merchant anywhere**: `ProviderTransaction` + `_map_transaction` (`services/banksync/provider.py`) drop Pluggy's `merchant` object; `Transaction` has no merchant column; the only persisted recurrence signal today is the raw `description` (noisy — embeds dates/ids).
- **No detector** of any kind (open space). `recurrence.expand_occurrences` is forward-only.
- **Confirm-flow precedent**: bank-sync discover→select→confirm (`LinkDialog` + `discover_item` returns candidates without writing, `POST /bank-sync/links` confirms) — the shape the suggestion scan + confirm mirrors.
- Imported transactions: `external_id` marks them; POSTED-only at import; expenses are `amount_minor < 0`; `transfer_id` set on transfer legs; `category_id` set only when a Pluggy→Pecunia category mapping exists (mostly unset today).

## Locked decisions (from brainstorming)

1. **Capture the merchant** (new nullable `transactions.merchant`, migration 0006) + backfill the ~380 already-imported rows; key recurrence on merchant.
2. **Suggest-and-confirm** — a read-only scan endpoint returns candidates; confirming reuses `POST /subscriptions`.
3. Suggestions surface as a section on `SubscriptionsScreen`.
4. Add a **by-category** breakdown to subscription totals.
5. Deferred: persistent "ignored" suggestions (v1 ignore is session-only; confirmed ones drop out because a matching active subscription exists); revolving-card recurrence.

---

## Track W — the work

### W-1. Capture merchant (backend, migration 0006)

- Migration `0006_transaction_merchant` (`down_revision="0005"`): `op.add_column` nullable `Text` `transactions.merchant`; real `downgrade` drops it. Model `Transaction.merchant: Mapped[str | None]`. `compare_metadata` parity. Migration test `test_migration_0006.py` (ORM round-trip, downgrade→upgrade cycle, parity stays green).
- Provider (`services/banksync/provider.py`): `ProviderTransaction` gains `merchant: str | None`; `_map_transaction` reads it from the Pluggy row — prefer `row["merchant"]["name"]`, fall back to `["merchant"]["businessName"]`, else `None` (tolerate missing/partial `merchant` object, like the partial-creditData handling). MockTransport tests for merchant present / businessName-only / absent.
- `TransactionService.create` gains keyword-only `merchant: str | None = None`, set on the row (does not change the emitted event/allowlist unless trivially adding `merchant` to the `"transaction"` allowlist — add it). `BankSyncService._sync_link` passes `row.merchant`. `TransactionOut` gains `merchant: str | None`.
- Tests: import stores merchant; create with/without merchant; Out exposes it.

### W-2. Merchant backfill (one-time data op, not shipped code)

The ~380 already-imported rows have `merchant = NULL` (captured only going forward). A one-time backfill script (run by the assistant on the VM after deploy, mirroring the 3-month backfill): per linked account, `provider.fetch_transactions` and `UPDATE transactions SET merchant=... WHERE external_id=... AND merchant IS NULL` (match by external_id; only fill nulls; never touch manual rows). This is an operational step recorded in the plan's final notes, not a code deliverable — but the plan documents the exact script so it's reproducible.

### W-3. Detection engine + scan endpoint (backend)

New `SubscriptionDetector` (`api/src/pecunia/services/subscription_detect.py`), clock-free: `suggest(workspace_id, *, today) -> list[dict]`.
- Candidate set: the workspace's `Transaction`s that are imported (`external_id IS NOT NULL`), expense (`amount_minor < 0`), not a transfer leg (`transfer_id IS NULL`), not soft-deleted, with a non-null `merchant`.
- Group by `(merchant, currency)`. Within a group: the representative amount = the **modal** `abs(amount_minor)` (ties → median); keep occurrences whose amount is within **±10%** of it (absorbs fx/price bumps); drop the rest.
- Require **≥ 2** kept occurrences. Infer cadence from the **median gap** between consecutive `occurred_on` (sorted): weekly (gap ≈ 7 ± 2d), monthly (≈ 30 ± 7d), quarterly (≈ 91 ± 15d), yearly (≈ 365 ± 30d). If no bucket matches the median gap, skip the group (irregular, not a subscription).
- Exclude a group that already matches an **active** `Subscription` (same currency + merchant≈name + amount within ±10% + same inferred frequency) so confirmed ones never re-suggest.
- Emit per surviving group a candidate dict: `{ merchant, suggested_name (=merchant), amount_minor (representative), currency, billing_frequency, occurrences (count), first_seen, last_seen, suggested_next_renewal (= advance(last_seen, frequency)), suggested_category_id (most common non-null category_id in the group, else None) }`. Sorted by `amount_minor` desc (biggest first).
- Endpoint `GET /api/v1/subscriptions/suggestions` → `list[SubscriptionSuggestionOut]`, `require_workspace`+`require_initialized`, router passes `today=date.today()`, declared BEFORE `/{id}` (route-order, like `/totals`).
- Tests: a monthly merchant with 3 same-amount charges → one monthly candidate with the right amount/next_renewal/count; amount within ±10% kept, outside dropped; irregular gaps → no candidate; a merchant already an active subscription → excluded; income/transfer/manual/null-merchant rows ignored; suggested_category_id = the group's modal category; per-currency isolation; <2 occurrences → none.

### W-4. By-category subscription totals (backend)

Extend `SubscriptionService.totals` (or add `totals_by_category`) + the `GET /subscriptions/totals` response: alongside `{currency:{monthly_minor,annual_minor,count}}`, add a per-currency, per-category breakdown — `by_category: [{category_id: uuid|None, name: str|None, monthly_minor, annual_minor, count}]` (uncategorized bucket = `category_id null`, name null). Normalized via the existing `monthly_minor`/`annual_minor`. Tests: grouping by category incl. the uncategorized bucket, per-currency, normalization across frequencies.

### W-5. Suggestions UI + by-category header (frontend)

- `web/src/features/subscriptions/useSubscriptions.ts`: `useSubscriptionSuggestions()` (GET `/subscriptions/suggestions`, key `qk.subscriptions` child e.g. `[...,"suggestions"]`). Type `SubscriptionSuggestion` mirroring the Out.
- `SubscriptionSuggestions.tsx` (new, on `SubscriptionsScreen` above the list): "Encontramos N possíveis assinaturas"; each candidate row shows merchant, `MoneyText(amount_minor)`, frequency, "visto N× · desde <DateText first_seen>", and **Adicionar** (opens the existing `SubscriptionForm` pre-filled from the candidate — name/amount/currency/frequency/next_renewal/category — user edits + confirms via `useCreateSubscription`, which already invalidates `qk.subscriptions` so the candidate drops out on re-scan) and **Ignorar** (session-dismiss via local state; not persisted — deferred). Hidden entirely when no candidates. Loading/empty states calm.
- `SummaryHeader` on `SubscriptionsScreen`: add the by-category breakdown (small per-category list/mini-bars under the monthly/annual stats), from the extended totals. Tokens only.

## Testing strategy

TDD per unit. Backend: pytest + testcontainers, no network (detector from fixtures; provider merchant via MockTransport). Frontend: Vitest + Testing Library, `apiFetch` mocked. Everything green, 0 new warnings, before merge. Migration 0006 behavioral + parity tests.

## Out of scope / deferred

Persistent "ignored"/dismissed suggestions (v1 session-only); detecting recurrence on a revolving credit-card balance; merchant-based auto-contact-linking; learning/adjusting the ±10% and cadence tolerances; a standalone category-mapping onboarding (the existing `CategoryMappingEditor` already covers mapping; the detector pre-fills category when a mapping made the transaction categorized).
