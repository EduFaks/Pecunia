# Pecunia v1.5 — Bank Sync via Open Finance / Pluggy (Design)

**Status:** approved 2026-09-30. Single-track epic, naming continues the series (v1.1 = A–F, v1.2 = G–N, v1.4 = O–S) → **v1.5 = T**.

## Goal

Stop typing bank data by hand: automatically sync account balances, transactions, and credit-card activity from the owner's real banks into Pecunia via **Meu Pluggy** (Pluggy's free-for-personal-use Open Finance Brasil gateway). The user connects banks once at meu.pluggy.ai; Pecunia pulls from the Pluggy API daily (plus on demand), dedupes, categorizes through a user-editable mapping, and keeps derived balances reconciled against what the bank reports — with the user always in control of what gets linked and imported.

## Pluggy API facts this design relies on

- Auth: `POST https://api.pluggy.ai/auth` with `{clientId, clientSecret}` (from the Pluggy dashboard tied to the Meu Pluggy account) → `apiKey` valid ~2h, sent as `X-API-KEY` on every call.
- Each connected bank = an **Item**; Open Finance items auto-refresh daily on Pluggy's side. We only *read* what Pluggy already fetched (no `PATCH /items` in v1).
- Resources: `GET /v2/items` (cursor), `GET /accounts?itemId=` (type `BANK`|`CREDIT`, `balance`, `currencyCode`, `creditData` with limits/close/due dates), `GET /v2/transactions` (cursor; v1 `/transactions` is deprecated 2026-12-31) with `accountId`/`from` filters. Transactions carry `id`, `description`, signed `amount` (float), `date`, `category`, `status` (`POSTED`/`PENDING`), `type` (`CREDIT`/`DEBIT`), `merchant`, `creditCardMetadata`.
- Rate limiting is per-minute per-IP (429). Personal scale (a handful of accounts, one sync/day) sits far below it; the client must still reuse the apiKey between calls and treat 429 as a provider error, never retry-loop.
- Webhooks exist but require a public HTTPS endpoint — rejected for a locally-hosted app (see Locked decisions).

## Global constraints

All work follows `docs/CONVENTIONS.md`:
- **§4 money** = integer minor units (`Decimal(str(x))` conversion from Pluggy floats via `money.py` exponents, never binary-float arithmetic), never summed across currencies.
- Services **flush**, routers **commit**; services are **clock-free** (`today: date` passed in).
- Every new table is workspace-scoped with the standard columns; mutations emit events → audit/activity with explicit field allowlists; StrEnum + CHECK; naming-convention parity via `compare_metadata`.
- New tables join `api/tests/conftest.py::_pg_clean` and `services/demo.py::_TABLES` (children before parents).
- No new infrastructure (§10): the sync runs in-process on the existing asyncio scheduler pattern.
- Frontend: Tailwind v4 `--pc-*` tokens, TanStack Query with `qk` factory, Vitest + Testing Library, co-located tests, mobile-responsive rules.
- **Conventional commits, NO trailers.**

## Locked decisions (from brainstorming)

1. **Scope v1:** bank accounts + balances, transactions, and credit cards (limits, close/due dates, card spend incl. installment lines as posted). **Investments via Pluggy: out** (portfolio stays manual + CoinGecko).
2. **Linking is explicit:** a Connections screen lists discovered Pluggy accounts; for each the user either links it to an existing Pecunia account or creates a new one. Nothing auto-links.
3. **History starts at a user-chosen `sync_from` date** picked at link time (default = today; a fresh account may reach back the full ~12 months Open Finance provides).
4. **Balance = anchor at link + divergence alert:** after the first import, `initial_balance_minor` is adjusted once so the derived balance equals the bank's balance; afterwards sync only *stores* the bank balance and the UI flags divergence, offering an explicit re-reconcile action (adjustment transaction). Never silently self-corrects.
5. **Categories via an editable mapping** (Pluggy category → Pecunia category); unmapped → transaction imported uncategorized.
6. **Polling, not webhooks:** daily in-process job + "Sync now" button, following the Track Q scheduler mold. Gated by `PECUNIA_ENABLE_BANK_SYNC` and credential presence.
7. Imported transactions stay **editable**; soft delete (`deleted_at`) acts as a tombstone so a deleted import never comes back.
8. **`POSTED` only** in v1; `PENDING` transactions are skipped (unstable ids).
9. Transfers between two of the user's own synced accounts import as two independent transactions (no automatic `Transfer` matching in v1).

---

## Track T — Bank sync (Pluggy)

**Model — migration `0005_bank_sync`, `down_revision = "0004"`.**

Three new tables (standard UUID PK / `workspace_id` / `is_demo` / `created_at` / `updated_at`):

- `bank_connections` — one per Pluggy Item: `pluggy_item_id` Text (unique per workspace), `institution_name` Text, `status` Text CHECK (`ok`|`error`), `last_error` Text nullable, `last_synced_at` DateTime(tz) nullable.
- `bank_account_links` — one per linked account: `connection_id` FK CASCADE, `account_id` FK CASCADE **unique** (an account has at most one link), `pluggy_account_id` Text (unique per workspace), `sync_from` Date, `provider_balance_minor` BigInteger nullable, `provider_balance_as_of` DateTime(tz) nullable, and card fields `credit_limit_minor` BigInteger nullable, `bill_close_date` Date nullable, `bill_due_date` Date nullable.
- `bank_category_mappings` — `pluggy_category` Text (unique per workspace) → `category_id` FK CASCADE (category deleted ⇒ mapping row goes with it).

`transactions` gains nullable `external_id` Text (the Pluggy transaction id) + partial unique index on `(account_id, external_id)` where not null — the provenance marker (precedent: `holdings.coingecko_id`) and the dedupe key. `external_id IS NOT NULL` ⇒ imported; no separate `source` column. `Account` itself is unchanged.

Audit: new actions `bank_connection.created`/`.deleted`, `bank_account.linked`/`.unlinked`, `bank_sync.completed`/`.failed`, plus finally emitting the reserved `transaction.imported` and `account.balance_reconciled`. Allowlist entries for the three new aggregates (never `pluggy_*` secrets — ids only).

**Provider — `services/banksync/provider.py`, Track Q mold.**

- `BankProvider` (typing Protocol): `fetch_connections() -> list[ProviderConnection]`, `fetch_accounts(item_id) -> list[ProviderAccount]`, `fetch_transactions(account_id, *, from_date) -> list[ProviderTransaction]` — frozen dataclasses already normalized to Pecunia conventions: minor units via `Decimal(str(amount))` + `currency_minor_unit_exponent`, sign = `type == "DEBIT"` ⇒ negative, `"CREDIT"` ⇒ positive, `abs(amount)` applied first (this also fixes Pluggy's credit-card quirk where purchases arrive positive). Carries `pluggy_category`, `status`, `date`, `description` (prefer `description`; `descriptionRaw` ignored in v1).
- `PluggyProvider`: optional injected `httpx.AsyncClient` (short-lived per call otherwise, exactly like `CoinGeckoPriceProvider`); manages the apiKey lifecycle — lazy `POST /auth`, cached in memory with its expiry, re-auth once on 401; pages `GET /v2/items`, `GET /accounts?itemId=`, `GET /v2/transactions?accountId=&from=` until the cursor is exhausted. Every `httpx.HTTPError`/`ValueError`/429 → typed `BankProviderError`; callers never see httpx. Client id/secret arrive via constructor, read from `Settings` at wiring time; never logged.
- `FakeBankProvider`: hand-rolled double recording `.calls`, seeded with connections/accounts/transactions, failure injection (`raise_for_accounts`, `raise_all`) — the double for every service/API/scheduler test.

**Service — `services/banksync/sync.py` (`BankSyncService(db, provider)`), flushes, never commits, clock-free.**

- `discover(workspace_id)` — live provider view of connections + accounts, each annotated with existing link/connection state (drives the link wizard). Provider failure raises `BankProviderError` (router → 503).
- `link_account(workspace_id, *, pluggy_item_id, pluggy_account_id, sync_from, today, account_id=None, new_account=None)` — upserts the `bank_connections` row, validates currency match (Pluggy `currencyCode` vs Pecunia account currency, else `CurrencyMismatchError`), creates the link (for `new_account`: name/type/currency derived from provider data — `BANK/CHECKING_ACCOUNT`→`checking`, `SAVINGS_ACCOUNT`→`savings`, `CREDIT/CREDIT_CARD`→`credit_card`), runs the **first sync** from `sync_from`, then **anchors once**: `initial_balance_minor += provider_balance − derived_balance` (order matters — anchoring before importing would double-count). Emits `bank_account.linked`.
- `sync_workspace(workspace_id, *, today) -> {connections, accounts_synced, created, skipped, errors}` — per connection (failure isolated per connection, captured into `errors[]`, others proceed): per link, fetch transactions from `max(sync_from, last_synced_at − 7 days)` (overlap window for late-posting), skip `PENDING`, dedupe against existing `external_id`s on the account **including soft-deleted rows** (tombstone), create the rest through `TransactionService.create` extended with an optional `external_id` kwarg that swaps the emitted event to `transaction.imported`; category resolved from `bank_category_mappings` (miss ⇒ None; the contact default-category auto-fill does not apply). Updates `provider_balance_minor`/`as_of` + card fields on the link, `status`/`last_error`/`last_synced_at` on the connection (Pluggy item status `UPDATED` ⇒ `ok`; anything else — `LOGIN_ERROR`, `WAITING_USER_INPUT`, `OUTDATED`, … ⇒ `error` with the raw status in `last_error`, pointing the user back to meu.pluggy.ai). Emits `bank_sync.completed` (summary in the payload) or `bank_sync.failed` per run.
- `reconcile(link_id, *, today)` — creates the adjustment transaction (`external_id=None`, description "Ajuste de reconciliação") closing the gap between derived and stored provider balance; emits `account.balance_reconciled`. Only ever user-triggered.
- `unlink(link_id)` / `delete_connection(id)` — remove link/connection rows; transactions (and their `external_id`s) stay.

**Endpoints — `api/banksync.py`, all under `/api/v1/bank-sync`, `require_initialized` + `require_workspace`.**

- `GET /bank-sync/discovery` → live Pluggy view; 503 `BANK_PROVIDER_UNAVAILABLE` when the provider errors or credentials are absent.
- `GET /bank-sync/connections` → stored connections + links incl. `derived_balance_minor` vs `provider_balance_minor`, card fields, `last_synced_at`, `last_error`.
- `POST /bank-sync/links` (link, first sync inside; 409 on already-linked account or pluggy id, 422 `CURRENCY_MISMATCH`), `DELETE /bank-sync/links/{id}`, `POST /bank-sync/links/{id}/reconcile`.
- `POST /bank-sync/sync` → on-demand `sync_workspace`, returns the summary (works regardless of the daily-job flag, like `refresh-prices`).
- `GET /bank-sync/category-mappings` / `PUT /bank-sync/category-mappings` (full replace, list of `{pluggy_category, category_id}`).
- `DELETE /bank-sync/connections/{id}`.
- Provider via `get_bank_provider(request)` dependency lazily cached on `app.state.bank_provider` (Track Q mold), overridable in tests; returns 503 when credentials are missing.
- `TransactionOut` gains `is_imported: bool` (derived from `external_id`).

**Daily job — `scheduler.py`, same file as the price sync.**

`run_daily_bank_sync(sessionmaker, provider, *, today)` — directly testable: all workspace ids in one session, then one session + try/except + commit per workspace, `logger.exception` on failure, per-workspace summary dict. `_bank_sync_loop` (initial 120s sleep, then every 24h) + `start_bank_sync_task(settings, sessionmaker, *, provider=None) -> asyncio.Task | None` gated by `settings.enable_bank_sync` **and** both credentials non-empty. Wired in `main.py` lifespan next to the price-sync task; cancelled on shutdown.

**Config & egress.**

`Settings` gains `pluggy_client_id: str = ""`, `pluggy_client_secret: str = ""`, `enable_bank_sync: bool = True` (inert without credentials). `.env.example` entries + `docker-compose.yml` passthrough. The secret joins the never-logged set (`test_no_secret_leak` guards). README "Network egress" gains `api.pluggy.ai` as the second documented exception (precedent: commit `86dfc96` for CoinGecko), noting it is optional and off without credentials. `conftest.py` forces `PECUNIA_ENABLE_BANK_SYNC=false` so app-booting tests never start the loop.

**Frontend.**

New **Connections** screen (settings area, sidebar entry): per-bank cards (institution, status, `last_synced_at`, errors, "Sync now" button with summary toast), linked accounts showing bank balance vs Pecunia balance with a divergence badge + "Reconcile" action (confirm dialog → adjustment), a link wizard (pick a discovered Pluggy account → link to existing / create new → pick `sync_from`, defaulting today), and the category-mapping editor (rows of Pluggy category → Pecunia category select). Existing screens: an "Open Finance" chip on linked accounts (card fields shown for credit cards: limit, close/due dates) and a subtle imported marker on transactions via `is_imported`. `features/banksync/` with `useBankSync.ts` hooks + `qk.bankSync.*` keys; all components with co-located Vitest tests mocking `apiFetch`.

**Tests.**

- Provider (`httpx.MockTransport` into the real `PluggyProvider`): auth + apiKey reuse + single re-auth on 401, cursor pagination, float→minor conversion incl. JPY-style exponents, DEBIT/CREDIT sign normalization incl. the credit-card quirk, PENDING passthrough of status, 429/network/malformed-JSON → `BankProviderError`.
- Service (`FakeBankProvider`): link to existing vs new account, currency-mismatch guard, anchor math (import-then-anchor ordering), dedupe on re-sync, tombstone (soft-deleted import not recreated), overlap-window bounds, category mapping hit/miss, per-connection error isolation, reconcile adjustment, unlink keeps transactions, card fields stored.
- Scheduler: `run_daily_bank_sync` directly (multi-workspace, one failing workspace doesn't block others); `start_bank_sync_task` gating (flag off / credentials missing / both present).
- API: every endpoint incl. 503 paths and 409/422 guards, provider override via `app.state`.
- Migration: `test_migration_0005.py` — CHECK/unique constraints, partial index behavior, ORM round-trip, `downgrade → upgrade head` cycle; schema parity stays green.
- Web: wizard flow, divergence badge + reconcile, mapping editor, sync-now toast, imported marker, empty/degraded (503) states.

---

## Build & review

Single track: one branch `feat/plan-t-bank-sync`, TDD task sequence mirroring Track Q's plan shape (migration+models → provider → service → endpoints → scheduler+config → frontend), whole-branch review at the end, merge `--no-ff` to `develop`. Owner pushes.

## Out of scope / deferred

Pluggy investments (portfolio stays manual + CoinGecko); webhooks / public endpoint; `PATCH /items` forced refresh; `PENDING` transactions; automatic transfer matching between synced accounts; credit-card bill entities (`/bills` — card fields on the link suffice for v1); merchant → Contact auto-linking; multi-workspace credential storage (credentials are instance-level env vars); automatic category *rule learning* (the mapping is manual).
