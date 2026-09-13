# Pecunia Engineering Conventions

This is the canonical reference for how Pecunia is built. Every implementation plan
points here; every code review checks against it. The goal: Pecunia reads as **one
coherent codebase**, not a patchwork of per-task styles. When a rule here and a plan
disagree, the plan wins for that task — but flag it so this guide can be updated.

This is a living document. When a plan introduces a new layer (events, frontend,
CLI), it extends the relevant section here in the same change.

---

## 1. Repository layout

```
pecunia/
├── docs/
│   ├── CONVENTIONS.md                  ← this file
│   └── superpowers/{specs,plans}/      design spec + per-plan implementation plans
├── docker-compose.yml                  pecunia-db, pecunia-api (+ pecunia-web in Plan 08)
├── .env.example                        every value optional with a working default
├── api/                                the FastAPI backend
│   ├── pyproject.toml  uv.lock  alembic.ini  .python-version (3.12)
│   ├── Dockerfile  docker/entrypoint.sh
│   ├── alembic/versions/NNNN_slug.py   hand-written, zero-padded, sequential
│   ├── src/pecunia/
│   │   ├── main.py         create_app() + lifespan (secret, engine, caches, tasks)
│   │   ├── config.py       Settings (pydantic-settings, PECUNIA_ prefix)
│   │   ├── db.py           async engine, get_db dependency
│   │   ├── events/         in-process domain-event bus (Plan 03)
│   │   ├── models/         one module per aggregate; Base in base.py
│   │   ├── security/       passwords, tokens, session_cache — no DB, no HTTP
│   │   ├── services/       business logic over AsyncSession (flush, never commit)
│   │   └── api/            routers (HTTP ↔ services), deps.py, schemas
│   └── tests/              pytest, mirrors src layout; conftest.py holds fixtures
└── web/                                the React frontend (Plan 05+)
```

**One responsibility per file.** A module that has grown to cover two aggregates or
two concerns gets split. Files that change together live together (a router, its
schemas, and its tests form a unit), split by responsibility, never by technical layer
alone.

---

## 2. Layering and the transaction contract

Strict one-directional dependency: **`api` → `services` → `models`**, with `security`
as a leaf used by services and deps. Routers never touch models directly for business
logic; services never import from `api`.

**One sanctioned exception — read-only list endpoints.** A GET endpoint that only
reads and paginates a table (audit log, activity feed, and the finance listings to
come) may build its `select(Model)` directly in the router rather than through a
service. These have no business logic to protect — the query *is* the endpoint — and a
pass-through service would be ceremony. Anything that writes, or that carries a domain
rule, still goes through a service. When a third such listing appears, factor the
shared cursor-pagination block (`limit+1` / `id < cursor` / `next_cursor`) into one
helper rather than copying it a third time.

| Layer | May import | Owns | Never does |
|-------|-----------|------|-----------|
| `models/` | `models.base`, sqlalchemy | table shape, constraints | business logic, I/O |
| `security/` | stdlib, jwt, argon2 | hashing, tokens, caches | DB, HTTP, request state |
| `services/` | models, security, events | business logic, validation | commit, HTTP status, cookies |
| `api/` | services, deps, schemas | HTTP, commits, cookies, status | business rules, raw SQL |

**The transaction contract (load-bearing — memorize it):**

- **Services flush, never commit.** A service method calls `await db.flush()` to get
  server defaults / satisfy FKs, and returns ORM objects or plain data. The caller owns
  the transaction boundary.
- **Routers commit.** Exactly one `await db.commit()` per successful request, in the
  router, after the service work.
- **Failure paths flush their evidence before raising.** A login failure records the
  `login_attempt` and flushes; the router's `except` branch commits it, then raises the
  HTTP error. Reuse-detection revocations follow the same shape. This is why audit rows
  (Plan 03) can commit atomically with the operation that produced them.
- **`get_db` rolls back on close.** Any request that raises without committing leaves no
  partial write.
- Concurrency-sensitive reads use `.with_for_update().execution_options(populate_existing=True)`
  — the lock serializes, and `populate_existing` discards any stale identity-mapped
  snapshot a dependency already loaded. (This is why `setup.initialize` and
  `auth.refresh` are race-safe.)

Class docstrings on services state this contract explicitly.

---

## 3. Naming

| Thing | Rule | Example |
|-------|------|---------|
| Python modules / files | `snake_case`, singular for an aggregate module | `auth_session.py`, `passwords.py` |
| Classes | `PascalCase` | `AuthService`, `WorkspaceMembership` |
| Functions / methods / vars | `snake_case` | `create_session`, `is_family_active` |
| Module-level constants | `UPPER_SNAKE` | `ACCESS_TTL`, `REFRESH_ABSOLUTE`, `DUMMY_HASH` |
| DB tables | `snake_case`, **plural** | `auth_sessions`, `workspace_memberships` |
| DB columns | `snake_case`, singular | `owner_user_id`, `initialized_at` |
| Constraints / indexes | via `Base.metadata` naming convention — never hand-name inconsistently | `ck_workspace_memberships_role_valid`, `fk_auth_sessions_user_id_users`, `ix_login_attempts_email_time`, `uq_users_email`, `pk_users` |
| Env vars | `PECUNIA_` prefix, `UPPER_SNAKE` | `PECUNIA_SECRET_KEY`, `PECUNIA_SETUP_TOKEN` |
| Pydantic request/response schemas | resource + `In`/`Out` (or `Request`/`Response` for whole bodies) | `OwnerIn`, `PreferencesIn`, `UserOut`, `TokenResponse` |
| HTTP error `detail` strings | `SCREAMING_SNAKE`, stable, machine-readable — they are API contract | `INVALID_CREDENTIALS`, `SETUP_REQUIRED`, `SESSION_NOT_FOUND` |
| Domain event / audit action ids | dot-separated `resource.action[.qualifier]`, lowercase | `transaction.created`, `auth.login.failed`, `asset.valuation.updated` |
| Enumerated string values (roles, clients, revoke reasons) | lowercase; enforced by a DB `CHECK` **and** a Python `StrEnum` | `owner`/`admin`/`member`/`viewer`; `web`/`native` |

The naming convention lives in `models/base.py` and is verified by
`test_migration_*::test_models_and_migrations_describe_the_same_schema` — every
migration must round-trip against `Base.metadata` with no diff.

---

## 4. Money, time, identity — value rules

- **Money is never a float.** Store amounts as integer **minor units** (cents) in a
  `BigInteger` column plus a 3-letter ISO currency code, or as `Numeric`; never
  `Float`/`double`. Do arithmetic in integers or `Decimal`. (Plan 04 fixes the exact
  representation and this guide records it.)
- **Timestamps are `DateTime(timezone=True)`**, stored UTC. In Python use
  `datetime.now(UTC)`; in SQL defaults use `server_default=text("now()")`. Compare
  app-side times to app-side, DB-side to DB-side — don't mix within one predicate.
- **Primary keys are UUID** (`Uuid` column, `uuid.uuid4()` app-side) for every
  domain/identity aggregate. Append-only log tables (`audit_events`, `login_attempts`)
  may use `BigInteger Identity()` — order matters more than opacity there. Time-ordered
  ids that are also public use UUIDv7 where noted in the spec.
- **Every domain entity carries a non-null `workspace_id` FK** (spec D7). Nothing is
  owned by a user directly; access is through workspace membership. Every domain query
  is workspace-scoped through the shared repository helper — never an unscoped
  `select(Model)` on tenant data.

---

## 5. Migrations

- Hand-written (not autogenerated), filename `NNNN_slug.py` with zero-padded sequential
  `revision` = `"NNNN"`, `down_revision` = the prior number.
- Constraint/index names are passed explicitly and **must match** what the naming
  convention computes for the ORM model (the parity test enforces this).
- Reference/seed data that must exist on a fresh boot is inserted **inside the
  migration** (e.g. the `instance_state` singleton), so a migrated DB is immediately
  usable, never half-populated.
- `upgrade()` and `downgrade()` are both real; `downgrade` reverses in FK-safe order.
- Migrations run automatically at container start (`alembic upgrade head`) and on every
  boot idempotently. Editing an unreleased revision in place is fine pre-release; once a
  revision has shipped to a real deployment, changes come as a new revision.

---

## 6. API conventions

- All routes under `/api/v1`. One `APIRouter` per resource in `api/<resource>.py`, with
  `prefix="/<resource>"` and a matching `tags=[...]`.
- Routers that operate on tenant data depend on `require_initialized` and
  `get_current_user`; setup endpoints depend on `require_uninitialized`. Sensitive
  actions (revocation, password change, export) use `get_current_user_fresh`
  (cache-bypassing).
- Status codes: `200` read/action-with-body, `201` creation, `204` action-no-body,
  `409` state conflict, `422` validation (Pydantic), `401`/`403` auth, `404` missing.
  Error bodies are `{"detail": "SCREAMING_SNAKE"}`.
- Request validation is Pydantic v2 at the schema; services assume validated input but
  still enforce invariants that need the DB (uniqueness, state).
- Pagination is cursor-based for anything append-only or unbounded, in one of two
  modes (both in `pecunia.pagination`), always accepting `?cursor=&limit=` and
  returning `{items, next_cursor}`:
  - **`cursor_page`** — for log tables with a monotonic `BigInteger` id (`audit_events`,
    `activity_entries`): orders by `id.desc()`, the opaque cursor is that id.
  - **`keyset_page`** — the standard for finance/domain listings (accounts, and
    transactions/projects/assets/budgets as they land): UUID primary keys carry no
    order, so these order by a time column plus the id as a tiebreaker
    (`sort_col.desc(), id_col.desc()`) and use an opaque `"{sort_value}|{id}"`
    string cursor. The id tiebreaker keeps a walk deterministic — no skipped or
    duplicated row — even when rows share the same timestamp (e.g. a seed script
    inserting many rows in one transaction).
- Workspace resolution: the JWT carries no workspace claim; the server resolves the
  caller's current workspace from membership via a dependency. Routes stay flat
  (`/api/v1/accounts`), never `/workspaces/{id}/accounts` in V1.

---

## 7. Events, audit, activity (Plan 03 — filled in when it lands)

- A synchronous in-process event bus; services `publish(Event)` inside the request
  transaction; subscribers (audit recorder, activity projector) write in the **same
  transaction**, so an operation and its audit row commit atomically.
- Event/action ids follow §3. `before`/`after` and `metadata` payloads are built from
  **explicit per-resource field allowlists** — never `model.__dict__`; secrets are
  structurally unreachable and a CI test fails on any allowlisted field matching
  `password|secret|token|hash|key`.
- `audit_events` is append-only (Postgres trigger blocks UPDATE/DELETE); the honest
  limit (a DB owner can drop the trigger) is documented, not hidden.
- Request context (request id, actor, session, IP, user agent) flows via `contextvars`
  set by middleware; services read it implicitly, never as plumbing arguments. Client IP
  trusts `X-Forwarded-For` **only** from the known `pecunia-web` proxy.
- **Demo-removal scope** (Plan 04 Task 7): `remove_demo_data` deletes only the demo
  *domain* rows (`is_demo=true` accounts…budgets) — never `audit_events` (append-only
  regardless) or `activity_entries` (a historical record, same as any other
  create-then-delete resource's activity trail). "Demo data can be cleanly removed"
  means the financial data that would otherwise pollute balances/lists; audit/activity
  keep the honest history that a demo was seeded and later removed.

---

## 8. Testing

- **TDD**: write the failing test, watch it fail for the right reason, implement, watch
  it pass. Every task ends with a green full suite and a commit.
- Tests run on a **real Postgres testcontainer** (spec relies on CHECK/locks/triggers/
  citext); no SQLite substitution. `cd api && uv run pytest`.
- **Isolation**: every test touching the DB inherits the `_pg_clean` fixture chain (via
  `db`/`app`), which resets `instance_state` and truncates tenant/identity tables after
  each test. No test leaves rows behind; the suite passes run twice back-to-back.
- Shared fixtures live in `conftest.py`: `pg_url`, `engine`, `db`, `app`, `client`,
  `user_factory`, `initialized_instance`, `TEST_SECRET_KEY`. Reuse them; add new shared
  fixtures here, not inline per file.
- Tests verify **real behavior**, not mocks — hit the DB, assert on constraint
  violations, exercise the actual code path (forge tokens with raw PyJWT to reach
  guard clauses, etc.).
- Test output is **pristine**: the only tolerated warning is the known upstream
  testcontainers deprecation. New warnings are findings.
- Prefer focused runs while iterating; one full-suite run before committing.

---

## 9. Frontend conventions

React + TypeScript + Tailwind v4, in `web/`. The identity: minimal-tech — a near-black
canvas, a handful of dark greys, white text, and exactly one white accent, in the system
font. No serif, no self-hosted webfonts, no hand-drawn flourishes: hierarchy comes from
weight, size, and spacing, not decoration. One rule underlies everything below — **no raw
hex/rgba in component code.** Every color traces back to a `--pc-*` token; if a new color
is ever needed, it's added to `styles/tokens.css` first, never inlined.

### 9.1 Design tokens & Tailwind mapping

`src/styles/tokens.css` is the single source of truth: CSS custom properties on `:root`
(`--pc-canvas`, `--pc-surface-1/2/3`, `--pc-hairline[-strong]`, `--pc-text[-secondary/
-faint]`, `--pc-accent[-hover/-soft]`, `--pc-on-accent`, `--pc-positive`/`--pc-negative`,
`--pc-focus`, radii/shadow/ease[-out]). `--pc-accent` (white, `#fafafa`) is the **sole
interactive color** — never used for status/decoration. Because the accent is white,
**any text or icon rendered on top of a filled accent surface must use `--pc-on-accent`**
(near-black, mapped to the `text-on-accent`/`bg-on-accent` utilities), never `text-ink`/
`text-canvas` — a white-on-white or (via `--pc-canvas` drifting) black-on-black label is
the one contrast bug this identity can silently produce, so every new `bg-accent` site
gets checked against this rule (`Button`'s `primary` variant is the reference: `bg-accent
text-on-accent hover:bg-accent-hover`). Fills using `accent-soft` (a faint white tint, not
a solid fill) keep ordinary `text-ink` — the contrast rule only applies to a *solid*
accent surface. `--pc-positive`/`--pc-negative` (muted emerald/coral) are reserved for real
value movement and semantic status, never decoration. A `:root[data-theme="light"]` stub
exists but is intentionally empty — do not rely on a light theme in V1. Eyebrows, index
labels, and required-field markers (`*`) use ink (`text-ink-2`/`text-ink-faint`), never
the accent — the accent is reserved for interactive emphasis and focus, not static labels.
**Five named exceptions carry the accent as a progress/emphasis fill** (not decoration,
not status): the onboarding wizard's step-progress indicator, the owner step's
password-strength meter (`PasswordStrength`), a project's funding-progress bar
(`FundingBar`), a budget's spend-progress bar (`BudgetVsActualBar`), and a loan's payoff-progress bar (`LoanPayoffBar`) — all five express
"progress toward/against a bound," the place a static accent fill is sanctioned (none of
the five render text on top of the fill, so none need the `text-on-accent` treatment). A static ratio is never emerald/coral (that
would falsely imply gain/loss) — **except** `BudgetVsActualBar`, which is the one progress
fill allowed to switch from the accent to coral (`--pc-negative`): going over a budget
isn't just "more progress" the way exceeding a funding target is (which stays the accent,
with a separate `Pill tone="positive"` marking the goal reached) — it's a real overspend,
the same semantic bad state coral marks everywhere else. Reach for another progress fill,
or another accent→coral switch, only with a new named exception here.

**Data-viz is the one sanctioned home for vibrant color.** Charts are built with
shadcn/Recharts via the `components/ui/chart` primitive (`ChartContainer`/`ChartConfig` +
`ChartTooltip[Content]`/`ChartLegend[Content]`), and a categorical series is painted from
the vibrant `--chart-1…8` tokens (`tokens.css`, mapped to `--color-chart-*` so
`fill-chart-1`/`stroke-chart-1` exist). This is the ONLY place saturated categorical color
appears — the rest of the UI stays monochrome minimal-tech. The category `PALETTE` is now
exactly this vibrant set (mirrored byte-identically in `api/src/pecunia/models/category.py`
and `web/src/features/categories/categoryTypes.ts`), so category chips and the spending-by-
category chart share it. Value-movement charts are the exception to the exception: income vs
spend stays the semantic emerald/coral (`--pc-positive`/`--pc-negative`) and a net-worth/
balance series stays neutral (`--pc-text`) — those encode meaning (§9.1's semantic rule),
not category identity, so they never take a `--chart-*` color.

`src/styles/global.css` maps every `--pc-*` token into a Tailwind `@theme` block
(`--color-canvas`, `--color-accent`, `--color-on-accent`, `--font-display`, `--radius-pc`,
`--shadow-pc-1`, etc.), which is what makes `bg-canvas`, `text-ink-2`, `border-hairline`,
`font-display`, `text-on-accent`, `rounded-pc-lg`, `shadow-pc-2` exist as ordinary
Tailwind utilities. Components author exclusively in these utilities. Two consequences
worth knowing:

- Any `--color-*` token is automatically usable across **every** color-consuming utility
  group Tailwind v4 generates from it — `bg-accent`, `text-accent`, `border-accent`,
  `outline-accent`, `ring-accent`, etc. — with no extra config.
- Opacity variants (`bg-positive/10`, `border-negative/30`) resolve via `color-mix()`
  against the token — the way to get a "soft" tint of a semantic color without minting a
  new hex token for it (see `components/ui/semanticVariants.ts`).

A global `:focus-visible { outline: 2px solid var(--pc-focus); ... }` base rule (in
`global.css`, `@layer base`) is the universal safety net; see §9.3 for why interactive
components also carry an explicit focus class. `prefers-reduced-motion: reduce` forces
every CSS animation/transition to ~0 duration globally — every entrance/reveal transition
in the app (the wizard's `StepFinish` check/text reveal, a progress bar's width
transition, the password-strength meter's fill) is plain CSS gated by this one rule; no component needs bespoke
`matchMedia`-driven reduced-motion handling (see §9.4).

### 9.2 Fonts

System stacks only — no self-hosted webfonts, no Google Fonts CDN, no render-blocking
third-party request. `--font-display`/`--font-sans` are both the platform UI sans
(`-apple-system, BlinkMacSystemFont, "SF Pro Text"/"SF Pro Display", "Segoe UI",
system-ui, sans-serif`); `--font-mono` is the platform monospace (`ui-monospace, "SF
Mono", Menlo, Consolas, monospace`). There is deliberately no second (serif/display)
typeface: `font-display` headings differentiate from `font-sans` body text by weight and
size alone (see `routes/Showcase.tsx`'s §04 for the scale). `font-mono` is for anything
numeric or meant to be scanned — money, ids, timestamps — always paired with
`.tabular-figures`/`font-mono`'s `font-variant-numeric: tabular-nums` (set globally in
`@layer base`) so columns of figures align.

### 9.3 Component structure

```
src/components/
├── ui/       Design-system primitives — Button, TextField, PasswordField, Surface,
│             Card, Callout, Spinner, Toast, Field (label/description/error), plus
│             small shared plumbing (a11y.ts, semanticVariants.ts, VariantIcon.tsx).
├── brand/    Wordmark — the identity mark, not generic UI.
└── layout/   App-level chrome — AppShell (sidebar + topbar) today; more as Plan 07 lands.
```

`src/routes/` holds screens (`Login`, `NotFound`, guard components in `guards.tsx`);
`src/lib/` holds framework-agnostic logic (`api.ts`, `auth.tsx`, `format.ts`, `money.ts`,
`query.ts`, `setup.ts`, `cn.ts`). A component's test is co-located as `Name.test.tsx`
next to `Name.tsx` — never a separate `__tests__/` tree.

**Primitive conventions**, established in `components/ui/` and expected of anything
added later:

- **Token-driven only.** No raw hex/rgba — grep for `#[0-9a-fA-F]{3,8}` across
  `components/`, `routes/`, `lib/` before every commit; the only legitimate hits are
  inside `styles/tokens.css` itself (or documentation text that *displays* a hex value
  as a string, as `routes/Showcase.tsx`'s token reference sheet does).
- **`focusRingClass`** (`components/ui/a11y.ts`) — `outline-none
  focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus` —
  is applied explicitly on every focusable primitive (buttons, inputs, icon-buttons).
  This duplicates the global `:focus-visible` base rule by design: the global rule is
  the safety net for anything the kit doesn't cover, but each primitive's own class
  makes its focus treatment part of its own source (self-documenting) and independently
  assertable in its own test (`expect(el.className).toMatch(/focus-visible:outline-focus/)`)
  rather than depending on computed styles jsdom won't evaluate.
- **`forwardRef` on anything that wraps a native focusable element** (`Button`,
  `TextField`, `PasswordField`, `Surface`/`Card`) — callers may need the DOM node
  (autofocus, measuring, imperative focus management).
- **Variant/size maps, not conditional class strings.** Each variant dimension (e.g.
  `Button`'s `variant`/`size`, `Callout`/`Toast`'s semantic `variant`) is a
  `Record<Variant, string>` lookup, composed with the local `cn()` helper
  (`lib/cn.ts` — a minimal dependency-free `clsx` substitute). `Callout` and `Toast`
  import the *same* `semanticVariantClasses` map (`components/ui/semanticVariants.ts`)
  so "what does negative look like" is defined once.
- **`aria-*` wired, not bolted on.** Labeled fields use `useId()` to generate
  `id`/`aria-describedby` pairs for description/error text; errors render through
  `FieldError` (`role="alert"`); a required-field marker (`*`) is a *sibling* of the
  `<label>` element, not a text child of it — keeping the label's accessible name (and
  its plain-text content, which `@testing-library`'s `getByLabelText` matches against)
  exactly the field name. `Callout`/`Toast`'s `negative` variant is `role="alert"`/
  `aria-live="assertive"` (interrupts); everything else is `role="status"`/
  `aria-live="polite"`.

### 9.4 Motion

No hand-drawn or SVG-stroke flourishes — every transition in the app is an ordinary CSS
`transition`/`animate-*` on opacity, transform, width, or color, which means
`prefers-reduced-motion: reduce`'s global rule (§9.1) is always sufficient on its own; no
component reads `matchMedia` or does its own reduced-motion branching. `--pc-ease` (an
in-out curve) is for ordinary UI transitions (hover, color changes, a progress bar's
width); `--pc-ease-out` (starts fast, settles) is for a one-time entrance/reveal (a step
fading and translating into place, an underline widening in) — a settling motion reads
differently than a button changing state, even though both are plain CSS.

The wizard's `StepFinish` is the reference: a static check glyph that scales/fades in,
then the "You're ready" copy revealing on a `delay-700` — plain transitions, staged with
CSS delay classes, no JS animation driver. `Wordmark` (`components/brand/Wordmark.tsx`) is
now plain system-sans "PECUNIA" text with no underline or entrance motion; the minimal
identity dropped the animated accent stroke the old editorial identity carried.

**Budget the motion deliberately**: generous during onboarding/entrance moments (the wizard's `StepFinish` reveal, the owner
step's password-strength fill) where a first impression is being made and the motion has
room to complete; scarce to absent in
steady-state app chrome (`Splash`, `AppShell`) where the same motion would either get cut
off by fast navigation or read as noise on every repeat visit.

### 9.5 Auth model

**SECURITY-CRITICAL, never revisit casually:** the access token lives only in a React
`ref` inside `AuthProvider` (`lib/auth.tsx`) — in memory, for the tab's lifetime. It is
never written to `localStorage`, `sessionStorage`, or `document.cookie`. The refresh
token never reaches JS at all; the API sets it as an HttpOnly cookie, and every
`apiFetch` call sends `credentials: "include"` so it rides along automatically.

Boot sequence: `AuthProvider` always attempts a silent `POST /auth/refresh` on mount.
Success mints a fresh access token and loads `/auth/me` (`status: "authed"`); failure
(no cookie, expired session) is the ordinary logged-out boot, not an error
(`status: "anon"`) — routes never flash the wrong screen while this resolves (`Splash`,
via `RequireAuth`/`RequireSetup`, §9.7). A proactive `setTimeout` re-refreshes ~60s
before expiry so an idle-but-open tab never has to fall back to the reactive path; the
reactive path (`api.ts`'s `onUnauthorized` hook, invoked on any 401) is the required
floor and works with or without the timer. Concurrent refresh attempts share one
in-flight promise rather than each firing their own. `login`/`logout`/`logoutAll` are
the only mutation surface `useAuth()` exposes; `login` intentionally lets `ApiError`
propagate to the caller (the screen decides how to render it — see §9.6).

### 9.6 API client & error model

`lib/api.ts` owns the single `fetch` call in the app (`apiFetch<T>(path, opts)`) —
prefixes `/api/v1`, JSON-encodes `opts.json`, always sends credentials, and attaches the
bearer token from whatever getter `AuthProvider` registered. Non-2xx responses are
parsed as `{"detail": "SCREAMING_SNAKE"}` (per §6) and thrown as `ApiError` (`.status`,
`.detail`); a 401 specifically throws `UnauthorizedError` (an `ApiError` subclass) and,
unless `opts.skipAuthRetry` is set, triggers exactly one silent-refresh-and-replay via
the `onUnauthorized` hook the auth layer registers — never a retry loop.

**Error → copy is always a detail → message map at the call site, not inside `api.ts`.**
`api.ts` stays a dumb transport; a screen owns turning `error.detail` into words a user
reads. `Login`'s mapping is the pattern to copy:

```ts
const LOGIN_ERROR_COPY: Record<string, string> = {
  INVALID_CREDENTIALS: "Incorrect email or password.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Please wait a few minutes.",
};
// unrecognized detail -> a generic fallback message, never the raw SCREAMING_SNAKE code
```

Rendered through `Callout variant="negative"` for a blocking form error, or
`useToast().showToast(...)` (`components/ui/Toast.tsx`) for a transient, non-blocking
one — never a raw `alert()` or an unmapped error string on screen.

### 9.7 Routing & guards

`react-router-dom`, one `<Routes>` tree in `App.tsx`. Guards (`routes/guards.tsx`) are
route-tree wrappers, not per-component checks: `RequireSetup` is outermost (an
uninitialized instance is redirected to `/setup` from anywhere); inside it,
`RedirectIfAuthed` guards `/login` and `RequireAuth` guards the authed app (`AppShell` +
nested screens). Each guard renders `<Splash />` — a subtle, non-animated `Wordmark` —
while its underlying query/state is still resolving, so the app never flashes wizard,
login, or app-shell content before the real answer is known, and never renders
`<Outlet />` speculatively.

### 9.8 Money, dates, numbers

Money is **never** formatted with a hardcoded `/100`. `lib/money.ts`'s `formatMoney(minor,
currency, locale)`/`parseMoney(str, currency, locale)` derive the minor-unit factor from
`Intl.NumberFormat`'s own `resolvedOptions().minimumFractionDigits` for the given ISO
4217 currency — correct for JPY (0 digits), BHD (3 digits), and everything else,
matching backend storage (§4: integer minor units, never a float). `lib/format.ts`'s
`formatDate(iso, { dateFormat, locale })` renders a user's preferred pattern (a small
explicit map) or falls back to `Intl.DateTimeFormat`'s locale-driven medium style, always
reading UTC getters (an ISO instant, not a local wall-clock time) so display doesn't
drift with the viewing machine's timezone; `formatNumber` wraps `Intl.NumberFormat`
directly. Any UI displaying a monetary or otherwise tabular figure pairs it with
`.tabular-figures`/`font-mono` (§9.2).

### 9.9 Server state — TanStack Query

One shared `QueryClient` (`lib/query.ts`), provided once at the `App.tsx` root. Defaults
are deliberately conservative for a same-origin, local-first app: `retry: 1` (not
TanStack's default 3, so a guard's loading state resolves quickly instead of stalling
through several backoff rounds), `refetchOnWindowFocus: false` (route guards already
refetch naturally on navigation/remount), `staleTime: 30_000`. `lib/setup.ts`'s
`useSetupStatus()` is the reference pattern for a query-backed hook: wrap `useQuery` in a
named hook returning a small, purpose-built interface (`{ initialized, isLoading }`),
never leak the raw `UseQueryResult` into a component.

### 9.10 Frontend testing

Vitest + `@testing-library/react`, `npm run test` (`vitest run`). `vitest.setup.ts` wires
`@testing-library/jest-dom` globally. Conventions specific to this layer, beyond the TDD
loop in §8:

- Components with dependencies on context (`useAuth`, `useSetupStatus`) are tested with
  `vi.mock("../lib/auth", () => ({ useAuth: vi.fn() }))` and a small state-builder helper
  (`authState({...overrides})`) — never a real `AuthProvider`/network round trip in a
  component test (that belongs to `lib/auth.test.tsx`/`lib/api.test.ts` themselves).
- Prefer `fireEvent` over adding `@testing-library/user-event` as a new dependency;
  `screen.findByRole`/`waitFor` around any state update that resolves after a promise
  (a submitted form, a rejected `login`) — a `console.error`/`act()` warning is a signal
  the assertion needs to await, not noise to suppress. Test output is pristine, same bar
  as §8; when a test deliberately triggers a thrown render error (e.g. a hook-outside-
  its-provider guard clause), silence the resulting `console.error` with a scoped
  `vi.spyOn(console, "error").mockImplementation(() => {})` for that `it` only.
- A focus-visible ring is asserted as a class match
  (`el.className).toMatch(/focus-visible:outline-focus/)`), not a computed style — jsdom
  doesn't evaluate `:focus-visible` as a live pseudo-class.
- Since §9.4's motion is plain CSS gated by the one global `prefers-reduced-motion` rule,
  no component reads `window.matchMedia` and no test needs to stub it — a transition's
  reduced-motion behavior is the browser's job, not something a component branches on.

---

## 10. Tooling, config, secrets

- Python **3.12** pinned via `api/.python-version`; dependency management with **uv**
  (`uv sync`, `uv run …`); lint with **ruff** (don't introduce new findings).
- Config is `Settings` (pydantic-settings, `env_prefix="PECUNIA_"`, `extra="ignore"`);
  every field has a working default so `docker compose up` needs no `.env` edits.
- Secrets: empty `PECUNIA_SECRET_KEY` → generated once and persisted `0600`; weak/
  placeholder configured key → refuse to start. Never log a secret.
- No new infrastructure without a written justification in the spec (no Redis, Celery,
  brokers) — the three-container model holds (`pecunia-web`, `pecunia-api`,
  `pecunia-db`).

---

## 11. Commits & branches

- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `chore:`, `style:`, `test:`,
  `refactor:`. One logical change per commit; the message says what and why, not how.
- **No trailers.** Commit messages carry no `Co-Authored-By` and no session links —
  just the conventional message.
- One branch per plan (`feat/plan-NN-slug`), executed task-by-task with review between
  tasks, merged `--no-ff` to `main` once the whole-branch review passes.
- The working tree is clean after every task; `.env` and generated data are never
  committed (`.gitignore` covers them).
