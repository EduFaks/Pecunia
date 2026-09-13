# Pecunia — Technical & Product Design Proposal (v2)

**Date:** 2026-09-11
**Status:** Draft — awaiting owner review
**Scope:** Full V1 proposal, updated to incorporate the "Additional Hard Requirements" addendum (first-run wizard, dark-first design, JWT authentication, audit logging, Docker first-run experience, decision board).

---

## 1. Product snapshot

Pecunia is a self-hosted personal finance application: accounts, transactions, projects, assets and valuations, budgets — owned entirely by the person running it. The bar it must clear:

> **Unusually polished for a self-hosted open-source application, while retaining an extremely simple deployment model.**

Stack (unchanged from the base proposal, restated for completeness):

| Layer | Choice |
|---|---|
| API | Python 3.12+, FastAPI, SQLAlchemy 2.x, Alembic, Pydantic v2 |
| Database | PostgreSQL 17 |
| Frontend | React + TypeScript + Vite, Tailwind (token-driven) |
| Files | Local volume (attachments, receipts, asset photos) |
| Deployment | Docker Compose — exactly three containers: `pecunia-web`, `pecunia-api`, `pecunia-db` |

Everything below is organized as a **Decision Board** (Section 2, one entry per mandated decision), followed by detailed specs for each subsystem.

---

## 2. Decision Board

### D1 — Authentication architecture

**Requirement:** JWT-based, secure, and cleanly extensible to mobile clients, CLI tools, and personal access tokens.

**Options considered**

| | Option | Verdict |
|---|---|---|
| A | **Stateless JWT pair** — access *and* refresh are both self-validating JWTs, no server-side records | ❌ Rejected. No revocation, no "log out all devices", no sessions UI. Every listed requirement (revocation, session/device management) fights this design. |
| B | **Opaque server-side sessions only** — classic session cookie, no JWT | ❌ Rejected. Would be the simplest secure design in a vacuum, but it fails the explicit JWT requirement, and it makes future API clients no easier (they'd need cookie jars or a parallel token system anyway). |
| C | **Hybrid: short-lived access JWT + server-side opaque rotating refresh token** | ✅ **Recommended.** |

**Decision: Option C.**

- **Access token** — a JWT, **15-minute TTL**, signed **HS256**. Claims: `iss: "pecunia"`, `sub` (user id), `sid` (session id), `jti`, `iat`, `exp`. The header carries a `kid` so the signing key can rotate (config holds a small key ring: current + previous; old key accepted for verification only until outstanding 15-minute tokens die).
- **Refresh token** — deliberately **not** a JWT. A 256-bit opaque random value whose SHA-256 hash lives in an `auth_sessions` row. The database is the single authority on refresh validity; a self-validating refresh token would undermine revocation, which is the whole point of keeping it server-side.
- **Per-request verification** — signature + expiry check (stateless, fast path), plus a session-liveness check of the token's `sid` against a **30-second in-process cache** of session state. Result: revocation takes effect within seconds of `logout`/`revoke` (and *instantly* for actions performed in the same process, which is the normal single-container case), without a database read per request in steady state. Sensitive endpoints (password change, session revocation, data export/erase) bypass the cache and hit the database directly.
- **Why HS256, not RS256/EdDSA** — there is exactly one issuer and one verifier (the same FastAPI process). Asymmetric keys pay a key-management cost to let *third parties* verify tokens; nothing in Pecunia's architecture needs that. The `kid` mechanism keeps the door open to switching algorithms later without a breaking change.

**Browser storage decision** (the addendum asks for this to be explicit):

```text
Access JWT     → JavaScript memory only (never localStorage, never a readable cookie)
Refresh token  → HttpOnly + Secure cookie, SameSite=Strict, Path=/api/v1/auth
```

Reasoning:

- `localStorage` is trivially exfiltrated by any XSS — ruled out per the requirement.
- Putting the *access* token in a cookie would make every data endpoint cookie-authenticated and therefore CSRF-relevant, requiring CSRF tokens across the whole API. Sending it instead as an `Authorization: Bearer` header from memory makes the entire data API **immune to CSRF by construction** (cross-site pages cannot set custom headers).
- The only cookie-authenticated endpoint is `POST /api/v1/auth/refresh`. It is protected by: `SameSite=Strict`, an Origin/Referer check, the narrow cookie `Path`, and rotation-with-reuse-detection (D2). A cross-site attacker who somehow triggered a refresh could not read the response anyway.
- On SPA boot (page load / F5), the app performs a **silent refresh** to obtain a fresh in-memory access token. `SameSite=Strict` is fine for an SPA: the cookie is only needed on same-origin XHR, never on the top-level navigation itself.
- XSS blast radius: an injected script can use the app *while the tab is open* (unavoidable in any browser auth scheme) but can only steal a ≤15-minute token, not the long-lived credential. Mitigated further by a strict CSP (no third-party script origins — Pecunia has no third-party scripts).

**Future clients fit in without changes to the model:**

- **Mobile / CLI:** `POST /auth/login` with `"client": "native"` returns the refresh token **once in the response body** instead of a cookie; the client stores it in the OS keychain and presents it in the body of `/auth/refresh`. Same endpoints, same session records, same sessions UI.
- **Personal access tokens (V1.1+):** separate long-lived opaque tokens (`pecunia_pat_…` prefix, hashed at rest, scoped), verified by the same auth dependency. Never JWTs.
- **TOTP / passkeys / OIDC (future):** all slot in as additional steps *before* session issuance; nothing about token issuance changes. The `auth_sessions` table already models "a device/agent holding credentials," which is the primitive all of these need.

---

### D2 — Refresh-token architecture

**Decision: rotation on every use, reuse detection with family revocation, hashed at rest, absolute + idle expiry.**

`auth_sessions` (one row per issued refresh token; a *session* is the chain/family of rotations):

```text
id             uuid PK
user_id        FK users
family_id      uuid            -- constant across rotations of one login
token_hash     bytea           -- sha256(refresh token); raw token never stored
client         'web' | 'native'
created_at     timestamptz
expires_at     timestamptz     -- absolute cap: 30 days from login (not extended by use)
idle_expires_at timestamptz    -- sliding: last_used + 14 days
last_used_at   timestamptz
superseded_by  uuid NULL       -- set on rotation
revoked_at     timestamptz NULL
revoke_reason  text NULL       -- 'logout' | 'logout_all' | 'user_revoked' | 'reuse_detected' | 'password_changed'
ip             inet NULL       -- display only; never used for security decisions
user_agent     text NULL
device_label   text NULL       -- parsed "Firefox · Linux" style label
```

Mechanics:

- **Rotation:** every successful `/auth/refresh` inserts a new row in the same `family_id`, marks the old row `superseded_by`, and sets a new cookie. The old token is dead.
- **Reuse detection:** if a presented token matches a row that is superseded or revoked, that is evidence the token was stolen (either the attacker or the legitimate user is replaying an old credential). The **entire family is revoked**, the event is audited as `auth.session.reuse_detected`, and the user must log in again. This is the standard OAuth "refresh token rotation" hardening and the main reason cookie-borne refresh tokens are acceptable.
- **Logout** revokes the family; **logout-all** revokes all the user's families. Password change revokes all families except (optionally) the current one. In every case the in-process session cache is invalidated immediately, so outstanding access tokens die within the 30-second cache window at worst.
- **Sessions UI** (Settings → Security → Sessions) reads this table grouped by family: device label, approximate location (display only — the addendum's rule that location is never a security signal is honored), last active, current-session marker, per-session **Revoke** and a **Log out everywhere** action.
- **Hygiene:** a daily in-process sweep deletes rows fully expired for more than 30 days (the audit log retains the history). Hashing means a stolen database backup yields no usable tokens.
- **Brute force:** login attempts tracked per-account and per-IP in a `login_attempts` table (durable across restarts, no Redis). V1 policy: a fixed window — ≥5 failures for the same email or IP within 15 minutes → `429` (exponential backoff is a possible later refinement, not a V1 requirement); failures audited as `auth.login.failed`. Login work is constant-time with respect to account existence (unknown emails verify against a dummy Argon2 hash). Argon2id (memory 64 MiB, time 3, parallelism 4) for password hashing.

---

### D3 — Audit-log architecture

**Requirement:** first-class append-only audit trail; avoid hand-wiring logging into every endpoint; but capture real business context.

**Options considered**

| | Approach | Assessment |
|---|---|---|
| A | **Explicit `audit.record(...)` calls in every service method** | Full context, but repetitive, easy to forget on new endpoints, and couples every service to the audit implementation. |
| B | **SQLAlchemy events (`before_flush` hooks)** | Automatic diffs, but sees *rows*, not *intent*: cannot distinguish `transaction.imported` from `transaction.created`, struggles with bulk operations, and actor context must be smuggled in anyway. Fragile magic. |
| C | **HTTP middleware** | Knows `request_id`/IP/UA/latency but nothing about the domain. The addendum itself notes middleware alone cannot understand the operation. Useful as a *context provider*, useless as the recorder. |
| D | **Lightweight in-process domain events** | Services publish typed events (`TransactionCreated`, `AssetValuationUpdated`, …); subscribers record audit rows, activity entries, and — later — notifications/webhooks. One publish, many consumers. |

**Decision: D, with C as its context provider, and a thin slice of A for auth edge cases.**

- A **synchronous in-process event bus** (~50 lines: typed event dataclasses, a registry, `publish()` iterating subscribers). No queue, no thread pool, no Redis — deliberately boring.
- A **request-context middleware** populates `contextvars` with `request_id` (UUIDv7), actor user id, session id, client IP (trusting `X-Forwarded-For` only from the known `pecunia-web` proxy), and user agent. The audit recorder reads context implicitly; services never pass plumbing arguments.
- **Same-transaction semantics:** subscribers run synchronously inside the operation's database transaction. An audited write and its audit row commit **atomically** — a financial app should not be able to perform an unaudited write, and a crash can't produce one. This also makes an outbox unnecessary in V1 (there are no external consumers yet); if webhooks arrive later, an outbox table slots in as just another subscriber.
- **Auth events that have no domain aggregate** (`auth.login.failed` for an unknown email, rate-limit lockouts) call the `AuditService` directly — pretending these are "domain events" would be ceremony.
- **Enforcement that new features audit correctly:** the event catalog is a closed enum; a CI test asserts every mutating service method publishes at least one domain event (via a decorator/registry check). This is the "don't forget" guarantee option A lacks.

**Append-only enforcement and honesty about limits:**

- A Postgres trigger on `audit_events` raises on any row-level `UPDATE` or `DELETE`, so no application bug or ordinary write path can silently alter or remove an audit row. Bulk operations that only the table owner can run — `TRUNCATE`, `DROP TRIGGER`, `ALTER TABLE` — sit outside a row-level trigger by definition; they fall under the same honest limit as the rest of this section (a self-hosted owner controls the database). The test suite itself uses `TRUNCATE` to reset fixtures, which is exactly why the guarantee is scoped to row mutations rather than claimed as absolute.
- **Stated plainly (as the addendum requires):** on a self-hosted instance the database owner can drop the trigger and edit anything. True tamper-proofing is impossible when the auditor owns the hardware. The trigger's real guarantees are: protection against application bugs, against accidental migrations/scripts, and against *casual* tampering — plus an honest signal of intent. (A hash-chain column is listed as a possible V2 hardening; it raises the tampering effort but still cannot beat a determined DB owner, so it is not V1 scope.)

**Payload hygiene:**

- `before`/`after` are built from **explicit per-resource field allowlists** — never `model.__dict__`. Secrets (password hashes, token hashes, TOTP seeds) are structurally unreachable because they are not in any allowlist.
- A CI test walks every registered allowlist and fails on field names matching `password|secret|token|hash|key`.

---

### D4 — First-run setup state

**Requirement:** backend-enforced uninitialized state; initialization securely and permanently locked after completion.

**Detection.** A singleton `instance_state` table (classic `id integer PRIMARY KEY CHECK (id = 1)`), created by migration with `initialized_at NULL`:

```text
id               1
initialized_at   timestamptz NULL   -- NULL ⇒ wizard mode
owner_user_id    uuid NULL
instance_id      uuid               -- random, generated at first migration
```

(No `schema_version` column: Alembic's own `alembic_version` table is the single source of truth for schema state.)

`GET /api/v1/setup/status` → `{ "initialized": false }` is the only unauthenticated read. The SPA routes to the wizard when false — but this is cosmetic; **every enforcement lives in the API**:

- While uninitialized: every non-setup endpoint returns `409 SETUP_REQUIRED` (a router-level dependency, not per-endpoint discipline).
- Once initialized: every setup endpoint permanently returns `409 SETUP_ALREADY_COMPLETE`.

**Atomic initialization.** The wizard collects everything client-side and commits **one** call:

```text
POST /api/v1/setup/initialize
{
  owner:       { name, email, password },
  preferences: { base_currency, locale, date_format, number_format,
                 timezone, first_day_of_week }
}
```

Inside a single transaction: `SELECT … FOR UPDATE` on the singleton row → if `initialized_at` is set, `409` (two racing browsers cannot both win — the row lock serializes them) → create the owner (Argon2id hash) → create the default workspace and an `owner` membership (D7) → write instance settings → set `initialized_at` → create an auth session and set cookies (**auto-login**, so the wizard flows straight into the optional steps without a redundant login screen) → audit `setup.completed`, `user.created`, `settings.updated`.

**Why one atomic call instead of per-step endpoints:** the server has exactly two states — *uninitialized* and *initialized* — and no half-configured limbo an attacker or a crashed browser can leave behind. It is idempotent from the client's view (retrying after a network error either succeeds or gets a clean 409 because it already succeeded), and "resumable" comes free: pre-submit, the draft lives client-side (non-sensitive fields in `sessionStorage`; the password is never persisted anywhere); post-submit, the remaining steps are ordinary authenticated calls that are all skippable.

**Attack window honesty.** Like Portainer or Grafana's first boot, an uninitialized instance is first-visit-wins. For the normal case (localhost / LAN before exposure) that is the right trade. For users who must expose Pecunia to the internet before initializing, an optional `PECUNIA_SETUP_TOKEN` env var makes `initialize` additionally require `X-Setup-Token`. Default unset — zero friction for the 95% case, documented for the rest. There is deliberately **no API path that can ever de-initialize** an instance; factory reset means dropping the database volume, which requires host access.

---

### D5 — Dark-first design direction

**Decision: dark is the canonical Pecunia experience, built as a token system from day one; light mode is a later token set, not a launch requirement.**

Direction: **private banking × modern terminal precision × luxury editorial × handwritten ledger accents.** Explicitly *not*: pure-black + gray cards + purple gradients.

**Token architecture.** All color, spacing, radius, shadow, and motion values are CSS custom properties (`--pc-*`) with **semantic** names (`--pc-surface-2`, `--pc-text-secondary`, `--pc-positive`), consumed by Tailwind via its theme config. A theme is a token set; dark ships first and defines the identity.

**Draft palette** (starting values — tuned against WCAG contrast during the design-system build; the dataviz palette will additionally pass the chart-color validator):

```text
Canvas          #101214   graphite-ink, never pure black
Surface 1       #16191D   cards
Surface 2       #1C2025   raised cards, popovers
Surface 3       #23272D   overlays, menus
Hairline        rgba(235, 230, 220, 0.07)   -- warm, extremely subtle borders
Text primary    #E9E4DA   warm off-white (ivory-leaning, not blue-white)
Text secondary  #9C978C
Text faint      #6B675F
Accent          #B69160   muted bronze — interactive emphasis, hand-drawn strokes, focus rings
Positive        #7FA98B   restrained sage — reserved for actual value movement
Negative        #C08577   muted clay — likewise reserved
```

Rules that make it a *system* rather than a palette:

- Green/red appear **only** on semantic value movement (deltas, P&L), never as decoration — the accent for everything interactive is bronze. This directly answers "do not overuse green."
- Elevation is expressed by surface steps + hairlines; shadows are restrained (`0 1px 2px rgba(0,0,0,.5)`-class ambient only).
- Typography: **Fraunces** (editorial display serif) for headings and branded moments; **Inter** for UI; all monetary figures use tabular numerals; raw data (IDs, exports, ISO dates) in a mono face. Numbers align in columns like a ledger.
- Charts: 1.5px strokes, ≤8%-alpha area fills, muted categorical colors, no gradients by default.

**Hand-drawn motion** (the addendum's signature accent):

- Implemented as **pre-authored SVG paths** (drawn once, shipped as assets) animated via `stroke-dasharray`/`stroke-dashoffset`, 400–700 ms, ease-out, in the bronze accent. No runtime sketch library, no per-frame JS.
- Usage map — generous in onboarding, scarce in the app:
  - Wizard: logo introduced by stroke animation; a drawn underline beneath *"Your money. Your server. Your data."*; a drawn circle settling around the chosen base currency; a drawn checkmark on completion, dissolving into the dashboard.
  - App: reserved for first-time empty states and milestone moments (a project reaching its target). Never on routine interactions.
- `prefers-reduced-motion`: every stroke animation renders its final frame instantly. The wizard is fully keyboard-navigable regardless.

---

### D6 — Background infrastructure

**Decision: none. Three containers stand.** Every candidate need was audited against "do not add infrastructure unless we need it":

| Need | Solution without new infrastructure |
|---|---|
| Login rate limiting / lockout | `login_attempts` table (durable, queryable, auditable). In-process token bucket for general API abuse. |
| Session sweep, retention jobs | `asyncio` periodic tasks in the FastAPI lifespan. Single process — no coordination problem exists. |
| Scheduled backups | `pg_dump` invoked by host cron or a compose-profile sidecar running busybox cron; V1 documents it, `pecunia doctor` checks backup age. A queue adds nothing to a nightly dump. |
| CSV/OFX import | Synchronous streaming parse; worst realistic file is seconds of work. `BackgroundTasks` if a case ever exceeds a request budget. |
| Caching | The dataset is one household. Postgres is the cache. |
| Events / audit / activity | Synchronous in-process bus (D3). |
| Future webhooks/notifications | An outbox *table* + the existing bus — still no broker. |

Redis/Valkey earns its place only when there are multiple API processes needing shared state, or push-scale fan-out — neither exists in a self-hosted household app. Adding it "for later" would tax every single installation forever to serve a hypothetical.

---

### D7 — Multi-user readiness: workspaces & entity ownership

**Requirement (owner addendum, 2026-09-11):** structure users/organizations/ownership now so that later (a) a user can invite others into a workspace with roles (admin, view, …) and (b) multiple people can hold independent accounts on the same instance — without a schema rewrite.

**Options considered**

| | Option | Verdict |
|---|---|---|
| A | **Single-user schema, retrofit later** | ❌ Rejected. Adding tenancy later means backfilling an owner column across every domain table and rewriting every query — the one migration you never want. |
| B | **Full multi-tenancy in V1** — invitations, role matrix, permission UI | ❌ Rejected. Months of surface for zero V1 users of it; violates YAGNI and the polish budget. |
| C | **Workspace-scaffolded single-user** — the *schema* is multi-tenant from day one; the *product* is single-user | ✅ **Recommended.** |

**Decision: Option C.**

- **`workspaces`** table from day one (`id`, `name`, `created_at`). Setup creates one default workspace (named "Personal", renameable) inside the same atomic `initialize` transaction.
- **`workspace_memberships`** (`workspace_id`, `user_id`, `role`, `joined_at`) with a role enum defined now — `owner | admin | member | viewer` — but only `owner` ever assigned in V1.
- **Every domain entity** (accounts, transactions, projects, project items, assets, valuations, budgets, attachments) carries a **non-null `workspace_id` FK** from its first migration. Nothing is owned by a user directly; users reach data *through membership*. This is the load-bearing choice: multi-user later becomes purely additive (an invitations table, role checks, a workspace switcher) instead of a data migration.
- **Scoping in V1:** every query filters by workspace via a single repository-level helper (`current_workspace()` — the user's only membership). Because the filter exists everywhere from day one, it cannot be forgotten when a second workspace appears; a CI test asserts every domain query path goes through the scoped helper.
- **Users are instance-global** (unique email per instance), so "separate people with their own accounts on one instance" is just: more users, more workspaces — already modeled.
- **Auth stays user-level:** the JWT carries `sub`/`sid` only — no workspace claim, so switching workspaces later never invalidates tokens. Routes stay flat (`/api/v1/accounts`); the server resolves the workspace from membership. A future workspace selector (path prefix or header) is additive.
- **Audit & activity** rows gain a nullable `workspace_id` (auth events have none; domain events always set it), so per-workspace filtering works on day one of multi-user.
- **Roles split cleanly:** `instance_state.owner_user_id` remains the *installation* administrator (settings, backups, audit log); workspace roles govern *data* access. In V1 the same person holds both.

**Deliberately not in V1:** invitation flow, role management UI, permission matrix, workspace switching UI. All additive later.

---

## 3. First-run setup wizard — detailed spec

**Flow** (tightened from the addendum's sketch — personalization is folded into other steps, and assets are deliberately deferred to a post-onboarding empty-state prompt, as the addendum itself suspected):

```text
1 Welcome  →  2 Owner account  →  3 Preferences  →  4 Starting point  →  5 Finish
                                   (atomic initialize                    (auto-logged in)
                                    happens on leaving step 3)
```

**Step 1 — Welcome.** Full-viewport, canvas background, the Pecunia wordmark stroke-animating in, then: *"Your financial life, in one place."* with the hand-drawn underline beneath *"Your money. Your server. Your data."* Actions: **Get Started →** and a quiet secondary link **Restore an existing Pecunia backup** (V1: opens instructions for the documented CLI restore path; wizard-integrated restore is V1.1 — promising an upload UI we haven't built would be worse than honesty).

**Step 2 — Owner account.** Name, email, password + confirmation. Live zxcvbn strength meter (rendered as a drawn ink-line that extends and warms in color, not a traffic-light bar); requirements are sensible (≥10 chars, no forced symbol theater — zxcvbn score ≥3). Copy states plainly: *"This account controls this Pecunia instance."*

**Step 3 — Preferences.** Base currency as the hero control (searchable, common currencies first; the hand-drawn circle settles around the selection). Locale, date format, number format, timezone, first day of week — all **pre-filled from browser hints** (`Intl` APIs) so the common path is "confirm and continue." A footnote notes everything is editable later in Settings. On **Continue**, the client calls `POST /setup/initialize`; a failure keeps the user here with a clear error; success auto-logs-in and proceeds.

**Step 4 — Starting point** (authenticated, entirely optional). One screen, three cards:

- **Add my first accounts** — inline quick-add for bank / card / cash / brokerage / wallet, repeatable.
- **Explore with demo data** — seeds a realistic dataset (accounts, months of transactions, a project, an asset with valuation history, a budget) *in the chosen base currency*. Every seeded row carries `is_demo = true`; a persistent chip in the app header (*"Demo data · Remove"*) deletes it all in one transaction (`data.demo_seeded` / `data.demo_removed` audited). Demo data and real data can coexist; removal never touches real rows.
- **Skip for now** — Pecunia is fully usable with zero accounts; the dashboard's empty states carry the guidance forward (including the deferred "add your first asset" prompt).

**Step 5 — Finish.** *"You're ready."* The hand-drawn checkmark draws, holds a beat, and the wizard cross-fades into the dashboard (no hard redirect flash). **[ Enter Pecunia → ]**.

**Qualities:** responsive from 360 px up; keyboard-first (logical focus order, Enter advances, visible bronze focus rings); resumable client-side pre-initialize (sessionStorage, password excluded); idempotent server-side (one atomic call, D4); reduced-motion respected throughout.

---

## 4. Authentication — API surface

```text
POST   /api/v1/auth/login          email+password (+ future 2FA step) → access JWT
                                   + refresh cookie (web) or body token (native)
POST   /api/v1/auth/refresh        rotate refresh, return new access JWT
POST   /api/v1/auth/logout         revoke current session family, clear cookie
POST   /api/v1/auth/logout-all     revoke all families for the user
GET    /api/v1/auth/me             current user + instance preferences
GET    /api/v1/auth/sessions       session list for the sessions UI
DELETE /api/v1/auth/sessions/{id}  revoke one session
```

Notes: uniform `401 INVALID_CREDENTIALS` on login failure (no user enumeration); `Secure` cookie flag driven by forwarded proto (with a logged warning when serving over plain HTTP on a non-localhost host); all auth mutations audited per the D3 catalog.

---

## 5. Audit log & activity timeline

**Two distinct products from one event stream** (per the addendum's separation):

- **Audit log** — the security/technical record. Machine-readable action identifiers, complete, append-only.
- **Activity timeline** — the human product-history (*"Mercedes valuation decreased · R$ 480,000 → R$ 460,000"*). A projection subscriber maps a *curated subset* of domain events to `activity_entries` rows holding a **template key + params** (`activity.asset.valuation_changed`, `{asset, from, to, currency}`), rendered client-side — i18n-ready and re-skinnable without data migration. Not every audit event becomes activity (nobody's timeline needs `auth.login.failed`), and not identically shaped — which is exactly why they are separate tables fed by the same bus.

**`audit_events` schema:**

```text
id               bigint identity  -- append-only monotonic; see note
occurred_at      timestamptz
actor_user_id    uuid NULL        -- NULL ⇒ system; soft ref (no FK)
actor_session_id uuid NULL
workspace_id     uuid NULL        -- soft ref (no FK)
action           text             -- closed catalog: 'transaction.updated', …
resource_type    text NULL
resource_id      text NULL
request_id       uuid NULL
ip               inet NULL
user_agent       text NULL
metadata         jsonb            -- action-specific context (allowlisted)
before / after   jsonb NULL       -- allowlisted field diffs only
```

**Implemented id type:** `bigint identity`, not UUIDv7. A monotonic identity column orders append-only rows naturally and needs no extra dependency (Postgres 17 has no built-in `uuidv7()`); actor/workspace are deliberately *soft* uuid references with no foreign key, so deleting a referenced user or workspace never blocks or rewrites audit history.

Indexes on `(occurred_at)`, `(action, occurred_at)`, `(actor_user_id, occurred_at)`, `(resource_type, resource_id, occurred_at)`, `(workspace_id, occurred_at)`. Event catalog exactly as enumerated in the requirements (auth, accounts, transactions, projects, assets, configuration), extended with `setup.completed`, `auth.login.throttled`, `auth.session.reuse_detected`, `data.demo_seeded`, `data.demo_removed`.

**Deferred:** cache-invalidation-via-events. V1's revocation endpoints (logout, logout-all, revoke session) invalidate the in-process session cache at the router, which is sufficient for every revocation path that exists in V1. Moving invalidation onto a domain-event subscriber (so a future *service-level* revocation such as password change can't forget it) is deferred to when password change lands — recorded here so the follow-up isn't lost.

**UI:** `Settings → Security → Audit Log` — day-grouped timeline as sketched in the requirements, filters for user / action / resource / event type / date range, cursor pagination, per-event expandable before→after diff. Read endpoint: `GET /api/v1/audit-events` (owner role). Activity timeline surfaces on the dashboard via `GET /api/v1/activity`.

**Retention:** none by default in V1 (a household's audit volume is trivial); growth is surfaced in `pecunia doctor`.

---

## 6. Docker & first-run experience

Target journey, verbatim from the requirements — `clone → cp .env.example .env → docker compose up -d → open browser → wizard`. No manual migrations, SQL, user creation, builds, or secret generation.

**`pecunia-api` entrypoint sequence:**

1. Wait for PostgreSQL (bounded retry loop with clear logging).
2. `alembic upgrade head` (migrations are additive and safe to run on every boot).
3. Idempotently seed reference data (currency table, the `instance_state` singleton).
4. **Secrets:** if `PECUNIA_SECRET_KEY` is empty (the `.env.example` default), generate a 256-bit key and persist it to the config volume (`0600`) — reused on every subsequent boot, so tokens survive restarts. If a key is *set* but weak (< 32 chars) or a known placeholder, **refuse to start** with a message that says exactly what to do. Auto-generation with persistence beats a "change-me" default that half of all installs would keep forever.
5. Start uvicorn (single worker default — matches the in-process cache/bus design; the compose file documents scaling implications honestly).

`pecunia-web` is nginx: serves the built SPA, proxies `/api` → `pecunia-api`, sets `X-Forwarded-*`. `pecunia-db` is `postgres:17-alpine` with a healthcheck the API's entrypoint respects. One published port (`PECUNIA_PORT`, default `8480`). Volumes: `pecunia_db_data`, `pecunia_files`, `pecunia_config`.

**`pecunia doctor`** ships in V1 as a small Typer CLI inside the API image (`docker compose exec api pecunia doctor`): checks DB connectivity, migration head, storage-volume writability, secret entropy/persistence, and last-backup age. It is diagnostic only — never required for setup.

---

## 7. Data model additions (delta for this addendum)

```text
users                 id, name, email (citext unique), password_hash (argon2id),
                      display_name, created_at, updated_at   -- instance-global
workspaces            id, name, created_at                    (per D7)
workspace_memberships workspace_id, user_id, role ('owner'|'admin'|'member'|'viewer'),
                      joined_at — PK (workspace_id, user_id)
auth_sessions         (per D2)
login_attempts        id, email_tried, ip, succeeded, occurred_at
instance_state        (per D4)  + preference columns or a settings jsonb
audit_events          (per D5)  + UPDATE/DELETE-blocking trigger + workspace_id NULL
activity_entries      id, workspace_id, occurred_at, template_key, params jsonb,
                      resource refs
workspace_id FK       non-null on every domain table: accounts, transactions,
                      projects, project_items, assets, valuations, budgets,
                      attachments (per D7)
is_demo flag          on accounts, transactions, projects, assets, budgets
```

---

## 8. Explicitly deferred (so V1 stays honest)

TOTP/2FA, passkeys, OAuth/OIDC, personal access tokens (architecture reserved in D1), wizard-integrated backup restore, webhooks/notifications (outbox slot reserved in D3/D6), light theme (token set exists, values don't), audit hash-chaining, and the multi-user *product surface* — invitations, role management, workspace switching (schema fully reserved in D7).

---

## 9. Threat-model notes

- **XSS** → memory-held short-lived access token, strict CSP, zero third-party scripts. Worst case is a ≤15-min token, not the credential.
- **CSRF** → structurally absent on data endpoints (bearer header); refresh endpoint defended by SameSite=Strict + origin check + rotation.
- **Refresh theft** → rotation + family-revoking reuse detection.
- **Database theft** → Argon2id password hashes; refresh tokens stored only as SHA-256 hashes.
- **Credential stuffing** → durable per-account/per-IP throttling, uniform error responses, full audit trail.
- **Uninitialized-instance takeover** → first-visit-wins by default (documented), optional `PECUNIA_SETUP_TOKEN` for internet-exposed first boots, no de-initialization path in the API, race-proof single-winner initialization.
- **DNS rebinding** → the Origin-vs-Host check cannot detect rebinding (the browser's Host matches the attacker's hostname by construction). Mitigations: a trusted-host allowlist (`PECUNIA_SERVER_NAME`-style, enforced by middleware and reused by the origin check) lands with the Plan 03 request-context work; until then, `PECUNIA_SETUP_TOKEN` is the documented mitigation for uninitialized instances on shared LANs. Browser Private Network Access increasingly blocks this class as well.
- **Audit tampering** → app-level impossibility (trigger); host-level impossibility is explicitly *not claimed* — the self-hosted owner controls the database, and the docs say so.
- **Location data** → cosmetic only, never an input to any security decision.
