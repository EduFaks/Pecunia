# Plan 06 — First-Run Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The five-step first-run wizard (spec §3) — Pecunia's identity showcase — with sophisticated hand-drawn motion: Welcome → Owner account → Preferences (the atomic `POST /setup/initialize` + auto-login) → Starting point → Finish, cross-fading into the dashboard. Responsive, keyboard-accessible, reduced-motion-safe, resumable pre-submit.

**Architecture:** A `web/src/features/setup/` feature: a `WizardShell` owning step state + progress + client-side draft (non-sensitive fields in `sessionStorage`, password NEVER persisted), five step components, and the initialize call wired through the api + auth store. Hand-drawn accents use the `HandStroke`/`Wordmark` primitives from Plan 05. Everything is token-driven per CONVENTIONS §9.

**Tech Stack:** adds `@zxcvbn-ts/core` + `@zxcvbn-ts/language-common` (password strength) and dev-only `playwright` (visual verification, Task 5). No other deps.

## Global Constraints

- **Follow `docs/CONVENTIONS.md` (§9 frontend).** Tokens only (no raw hex); bronze reserved for interactive emphasis / strokes / focus (not static labels); stroke motion 400–700ms ease-out; `prefers-reduced-motion` renders final frames instantly.
- **Backend contract (fixed, Plans 02):** `GET /api/v1/setup/status`; `POST /api/v1/setup/initialize {owner:{name,email,password}, preferences:{base_currency,locale,date_format,number_format,timezone,first_day_of_week}, client:"web"}` → 201 with `TokenResponse` + sets the refresh cookie (auto-login); `409 SETUP_ALREADY_COMPLETE`; `403 INVALID_SETUP_TOKEN`; `422` validation. After init, the optional steps use the authed finance endpoints (`POST /accounts`, `POST /demo`).
- **Security:** the owner password lives only in component state; NEVER in sessionStorage/localStorage. The draft persisted for resumability excludes the password. Initialize is ONE atomic call (the wizard collects everything for steps 1–3 client-side, submits on leaving step 3); auto-login stores the returned access token in memory via the auth store.
- **Accessibility:** keyboard-first (logical focus order, Enter advances where sensible, visible bronze focus rings), labeled inputs, `aria` on the strength meter and progress, focus moves to each new step's heading. Responsive from 360px up.
- Verification gates: `npm run build && npm run lint && npm run test` green each task. TDD for logic (draft/validation/initialize wiring/strength mapping); render/interaction tests for steps. Task 5 adds a Playwright screenshot capture the controller reviews for design fidelity.
- Node 20 via nvm (`source ~/.nvm/nvm.sh` if needed), npm, conventional commits **no trailers**, one task per commit.

---

## File Structure (end state)

```
web/src/features/setup/
├── WizardShell.tsx          step state machine, progress, draft (sessionStorage, no password), transitions
├── useSetupDraft.ts         draft persistence hook (non-sensitive only)
├── steps/
│   ├── StepWelcome.tsx      wordmark stroke-in, tagline, drawn underline, Get Started / Restore
│   ├── StepOwner.tsx        name/email/password+confirm, zxcvbn strength meter
│   ├── StepPreferences.tsx  base-currency hero (drawn circle), locale/formats/tz/first-day (Intl prefills)
│   ├── StepStartingPoint.tsx  add-first-accounts / explore-demo / skip
│   └── StepFinish.tsx       drawn checkmark, "You're ready.", Enter Pecunia → dashboard
├── PasswordStrength.tsx     zxcvbn-driven ink-line meter (shared)
├── CurrencySelect.tsx       searchable currency picker (common first)
├── setupApi.ts              initialize() + restore-info; typed request/response
└── (tests alongside)
web/e2e/
├── wizard.spec.ts           Playwright: walk the flow, screenshot each step
└── playwright.config.ts
```

---

### Task 1: Wizard shell, step framework, draft, routing, Step 1 (Welcome)

**Files:** `web/src/features/setup/WizardShell.tsx`, `useSetupDraft.ts`, `steps/StepWelcome.tsx`, wire `/setup/*` in `App.tsx` to render `WizardShell` (behind the existing `RequireSetup` uninitialized gate); tests.

**Interfaces:** `WizardShell` manages `step` (1–5) and a `draft` object; renders a progress indicator (5 steps, current highlighted in bronze), the active step, and handles forward/back. `useSetupDraft()` persists the non-sensitive draft (owner name/email + all preferences) to `sessionStorage` under `pecunia.setup.draft`, restoring on mount; it NEVER stores password/confirm. Step 1 (Welcome): full-viewport canvas; `Wordmark animate`; the tagline "Your financial life, in one place." (Fraunces); beneath "Your money. Your server. Your data." a `HandStroke` underline draws in; primary "Get Started →" advances to step 2; a quiet "Restore an existing Pecunia backup" secondary link opens an informational modal/callout (V1: explains the documented CLI restore path — no upload UI). Reduced-motion: strokes render final frame.

- [ ] **Step 1: Failing tests:** WizardShell starts at step 1; "Get Started" advances to step 2; the draft hook round-trips non-sensitive fields through sessionStorage and NEVER writes a password key (assert sessionStorage has no key containing the password value); Welcome renders the wordmark + tagline + restore link.
- [ ] **Step 2–5:** implement, verify build/lint/test, commit `feat(web): setup wizard shell, draft persistence, and welcome step`.

---

### Task 2: Step 2 — Owner account + password strength

**Files:** `steps/StepOwner.tsx`, `PasswordStrength.tsx`, add `@zxcvbn-ts/core` + `@zxcvbn-ts/language-common`; tests.

**Interfaces:** `StepOwner` collects name, email, password, confirm. Validation (client-side, mirrors backend): name non-empty; email format; password 10–128 chars; confirm matches. `PasswordStrength` uses `@zxcvbn-ts/core` (configured with the common language package) to score 0–4, rendered as a hand-drawn ink line that extends and warms in color with strength (not a traffic-light bar), with an `aria-live` textual label ("Weak"/"Fair"/"Good"/"Strong"). Copy states plainly: "This account controls this Pecunia instance." Continue is disabled until valid (password score ≥ 2 recommended, ≥ the 10-char floor required); Back returns to Welcome. On Continue, owner fields are held in the wizard state (name/email into the resumable draft; password in memory only) and step advances to Preferences.

- [ ] **Step 1: Failing tests:** invalid email / short password / mismatched confirm block Continue; a valid set enables it; PasswordStrength maps a weak vs strong password to different score labels; the password is never written to sessionStorage (assert).
- [ ] **Step 2–5:** implement, verify, commit `feat(web): wizard owner-account step with password strength meter`.

---

### Task 3: Step 3 — Preferences + atomic initialize + auto-login

**Files:** `steps/StepPreferences.tsx`, `CurrencySelect.tsx`, `setupApi.ts`; tests.

**Interfaces:** `StepPreferences`: base currency as the hero control via `CurrencySelect` (searchable; common currencies — USD/EUR/BRL/GBP/JPY/… — first; a `HandStroke` circle settles around the chosen currency); locale, date_format, number_format, timezone, first_day_of_week — all PRE-FILLED from browser hints (`Intl.DateTimeFormat().resolvedOptions()` for timezone/locale; sensible date/number format defaults per locale) so the common path is "confirm and continue"; a footnote: "You can change all of this later in Settings." `setupApi.initialize(payload)` POSTs `/setup/initialize` (client:"web"); on 201 it stores the returned access token + user in the auth store (auto-login) and advances to step 4; on 409 SETUP_ALREADY_COMPLETE → route to the app (someone else initialized); on 422 → show which field errored and stay; network error → a retry Callout, staying on the step (idempotent: the user can retry). Continue triggers the submit (this is the pivotal atomic call combining steps 1–3's data).

- [ ] **Step 1: Failing tests (mock api + auth):** Continue POSTs the assembled payload (owner from state + preferences) once; on 201 the auth store becomes authed and step advances to 4; on 409 it routes to the app; on 422 it surfaces the error and stays; timezone/locale prefilled from Intl on mount; the currency picker selects and shows the drawn circle.
- [ ] **Step 2–5:** implement, verify, commit `feat(web): wizard preferences step with atomic initialize and auto-login`.

---

### Task 4: Step 4 (Starting point) + Step 5 (Finish) + transition

**Files:** `steps/StepStartingPoint.tsx`, `steps/StepFinish.tsx`, wire the completion transition into the dashboard; tests.

**Interfaces:** `StepStartingPoint` (authenticated — runs after auto-login): three cards —
  1. **Add my first accounts** — inline repeatable quick-add (name + type + currency, defaulting to the base currency) POSTing `/accounts`; added accounts list under the card;
  2. **Explore with demo data** — a toggle/button POSTing `/demo` (seeds the demo dataset); shows a confirmation and that it can be removed later;
  3. **Skip for now** — advances with nothing.
All optional; a primary "Continue" advances to Finish. `StepFinish`: a `HandStroke` checkmark draws, holds a beat, then "You're ready." (Fraunces) + "Pecunia is now configured." and a primary "Enter Pecunia →" that cross-fades (a brief opacity/transform transition, reduced-motion-safe) by navigating to `/` (the dashboard — Plan 07; for now `/` renders the AppShell). Because the instance is now initialized + the user authed, `RequireSetup`/`RequireAuth` let them into the app.

- [ ] **Step 1: Failing tests:** quick-add posts an account and lists it; demo button posts `/demo`; skip advances; Finish renders the checkmark + Enter button; Enter navigates to `/`.
- [ ] **Step 2–5:** implement, verify, commit `feat(web): wizard starting-point and finish steps with dashboard transition`.

---

### Task 5: End-to-end flow test + Playwright visual capture

**Files:** `web/e2e/wizard.spec.ts`, `web/e2e/playwright.config.ts`, add dev-only `@playwright/test`; a `screenshots/` output dir (git-ignored). Also fold in the small Plan 05 ride-along: wire `Showcase` behind a `import.meta.env.DEV` route (or delete it), and add the concurrent-401/`logoutAll` auth tests.

**Interfaces:** A Playwright test that, against a running full stack (uninitialized backend + web dev server), walks the entire wizard: Welcome → fills Owner → confirms Preferences → (skips accounts/demo) → Finish → lands on the dashboard shell; asserts each step renders and the final URL is `/`; and **captures a full-page screenshot of every step** to `web/e2e/screenshots/step-N-*.png`. The config starts the web dev server (webServer) and assumes the api is reachable (the controller brings up `docker compose` + resets the instance before running).

**Runbook (the implementer documents; the controller executes the capture):**
1. `docker compose down -v && docker compose up -d --build` (fresh uninitialized instance).
2. `cd web && npx playwright install chromium` (if the browser download is blocked in this environment, report it — the flow test can still assert logic against a mocked api, but the screenshots need a real browser).
3. `npm run e2e` (runs `playwright test`), producing the step screenshots.
4. `docker compose down -v`.

- [ ] **Step 1:** add the flow spec + config + `e2e` script; wire Showcase dev-only; add the auth tests. `npm run build && npm run lint && npm run test` green.
- [ ] **Step 2:** run the capture per the runbook (implementer attempts; if the browser can't be installed, report BLOCKED-on-browser with everything else done, and the controller does the visual pass separately).
- [ ] **Step 3:** commit `test(web): setup wizard end-to-end flow and screenshot capture` (screenshots git-ignored). Report the screenshot paths so the controller can review them for design fidelity.

---

## Self-review notes

- **Spec coverage (§3):** five-step flow with the exact hand-drawn moments (wordmark stroke-in, drawn underline under "Your money. Your server. Your data.", drawn circle around the base currency, drawn checkmark at Finish) — Tasks 1–4; atomic single-call initialize + auto-login (Task 3); optional accounts/demo/skip with the app fully usable if skipped (Task 4); resumable pre-submit draft excluding the password (Task 1); keyboard + reduced-motion throughout.
- **Security:** password in memory only, never persisted (asserted); initialize is the one atomic call; 409/422/network handled idempotently.
- **Design fidelity:** the wizard is the identity showcase — strokes 400–700ms ease-out, bronze accent used for interactive/stroke emphasis only, Fraunces for the branded lines. Task 5's screenshots are the authoritative visual check (controller reviews).
- **Deferred:** wizard-integrated backup RESTORE upload (Step 1 links to CLI docs only), the optional first-asset step (spec defers it to a post-onboarding empty state), OAuth/2FA setup (post-V1).
