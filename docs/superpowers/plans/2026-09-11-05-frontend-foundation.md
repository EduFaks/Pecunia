# Plan 05 — Frontend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A Vite + React + TypeScript SPA foundation embodying Pecunia's **dark-first** visual identity — the `--pc-*` design-token system, typography (Fraunces / Inter / JetBrains Mono), a secure auth client (in-memory access token + silent refresh, refresh token in the HttpOnly cookie, **never `localStorage`**), an API client, a router with setup/auth guards, and a base component kit — so Plans 06 (wizard) and 07 (app UI) build screens, not infrastructure.

**Architecture:** `web/` holds the SPA. Design tokens are CSS custom properties (dark values on `:root`, canonical; a `[data-theme="light"]` stub reserved) surfaced to Tailwind v4 via `@theme`. Auth state lives in a small React context/store; the access token is held in memory only; a fetch wrapper attaches it and transparently refreshes on 401. Routing gates on `GET /api/v1/setup/status` (uninitialized → wizard) and auth (`/auth/me`). Everything follows `docs/CONVENTIONS.md` §9 (which THIS plan fills in).

**Tech Stack:** Vite 5, React 18, TypeScript 5, Tailwind CSS v4 (`@tailwindcss/vite`), React Router 6, TanStack Query (server state) — no other heavy deps; Vitest + Testing Library + jsdom for tests; `@fontsource-variable/*` for self-hosted fonts (a self-hosted app must not depend on a font CDN).

## Global Constraints

- **Follow `docs/CONVENTIONS.md`; this plan writes its §9 (frontend conventions).** Backend API contract is fixed by Plans 01–04 (`/api/v1/...`, error bodies `{"detail":"SCREAMING_SNAKE"}`, cookie-based refresh at `/api/v1/auth/refresh`, bearer access token).
- **Security (spec D1):** the access token lives in JavaScript memory ONLY — never `localStorage`/`sessionStorage`/a readable cookie. The refresh token is the backend's HttpOnly `pecunia_refresh` cookie; the client never reads it. All API calls are same-origin (`/api/...`) so the cookie is sent automatically; `credentials: "include"`. On boot and on 401, the client silently calls `/auth/refresh`.
- **Dark-first:** dark is the canonical, default theme (no toggle needed to look right). Tokens are semantic (`--pc-surface-1`, `--pc-text-secondary`, `--pc-positive`), never raw hex in components. A light theme is a later token set — reserve `[data-theme="light"]` but do not build it.
- **No secrets in the bundle**, no analytics, no third-party network calls (self-hosted ethos). Fonts self-hosted via `@fontsource`.
- **Money:** amounts arrive as integer minor units + currency; a shared `formatMoney(minor, currency, locale)` using `Intl.NumberFormat` renders them. Never do float math on money.
- Dev server proxies `/api` → `http://localhost:8480` (the running `pecunia-api`). Production serving is Plan 08 (`pecunia-web` nginx).
- **Verification gates each task:** `npm run build` (tsc + vite build) passes, `npm run lint` (eslint) clean, `npm run test` (vitest) green. TDD applies to logic (auth store, api client, formatters, guards); components get smoke/render tests, not pixel tests.
- Node 20 (nvm: `~/.nvm/versions/node/v20.20.2/bin` — if `node`/`npm` aren't on PATH, `source ~/.nvm/nvm.sh` first). npm (not pnpm). Conventional commits, **no trailers**, one task per commit.

---

## File Structure (end state)

```
web/
├── package.json  tsconfig.json  vite.config.ts  eslint config  index.html
├── vitest.config.ts  vitest.setup.ts
├── src/
│   ├── main.tsx                 app entry (providers, router)
│   ├── App.tsx                  router + route tree
│   ├── styles/
│   │   ├── tokens.css           the --pc-* system (dark :root, light stub)
│   │   └── global.css           base element styles, font faces, resets
│   ├── lib/
│   │   ├── api.ts               fetch wrapper (base, credentials, error model)
│   │   ├── auth.tsx             AuthProvider + useAuth (in-memory token, silent refresh)
│   │   ├── query.ts             TanStack Query client
│   │   ├── money.ts             formatMoney + parseMoney helpers
│   │   └── format.ts            date/number formatting from preferences
│   ├── routes/
│   │   ├── guards.tsx           RequireSetup / RequireAuth / RedirectIfAuthed
│   │   ├── Login.tsx            (minimal; full styling reuses the kit)
│   │   └── NotFound.tsx
│   ├── components/
│   │   ├── ui/                  Button, TextField, PasswordField, Card, Surface,
│   │   │                        Callout, Spinner, Toast, Field primitives
│   │   ├── layout/              AppShell (sidebar/topbar) stub
│   │   └── brand/               Wordmark (SVG), HandStroke (reusable stroke-anim)
│   └── test/                    test utils (renderWithProviders)
└── (Dockerfile + nginx come in Plan 08)
```

---

### Task 1: Scaffold + design-token system + typography

**Files:** create the whole `web/` scaffold: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, eslint config, `src/main.tsx`, `src/App.tsx` (placeholder rendering the showcase), `src/styles/tokens.css`, `src/styles/global.css`, a `src/routes/Showcase.tsx` (temporary token/type/color showcase for visual verification), Vitest config + one smoke test.

**Interfaces:** produces the `--pc-*` token set and Tailwind utility mappings every later component uses; `npm run dev/build/lint/test` scripts.

- [ ] **Step 1: Scaffold** — from repo root: create `web/` and initialize. `package.json`:

```json
{
  "name": "pecunia-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "lint": "eslint . --max-warnings 0",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0",
    "@tanstack/react-query": "^5.51.0",
    "@fontsource-variable/fraunces": "^5.0.0",
    "@fontsource-variable/inter": "^5.0.0",
    "@fontsource/jetbrains-mono": "^5.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "jsdom": "^25.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.4.0",
    "eslint": "^9.9.0",
    "@eslint/js": "^9.9.0",
    "typescript-eslint": "^8.0.0",
    "eslint-plugin-react-hooks": "^5.1.0",
    "eslint-plugin-react-refresh": "^0.4.0"
  }
}
```

Run `cd web && npm install` (if `npm` missing, `source ~/.nvm/nvm.sh` first). Configure `vite.config.ts` with `@vitejs/plugin-react` + `@tailwindcss/vite`, a dev proxy (`server.proxy` `"/api" -> {target: "http://localhost:8480", changeOrigin: true}`), and Vitest (`test: { environment: "jsdom", setupFiles: "./vitest.setup.ts", globals: true }`). `tsconfig.json` strict. eslint flat config (js + typescript-eslint + react-hooks + react-refresh).

- [ ] **Step 2: The token system** — `src/styles/tokens.css` (the identity — use these values):

```css
:root {
  /* Grounds — deep graphite, never pure black */
  --pc-canvas:        #0f1113;
  --pc-surface-1:     #16191d;   /* cards */
  --pc-surface-2:     #1c2025;   /* raised cards, popovers */
  --pc-surface-3:     #23272d;   /* overlays, menus */
  /* Hairlines — warm, extremely subtle */
  --pc-hairline:        rgba(235, 230, 220, 0.07);
  --pc-hairline-strong: rgba(235, 230, 220, 0.13);
  /* Ink — warm off-white, ivory-leaning */
  --pc-text:          #e9e4da;
  --pc-text-secondary:#9c978c;
  --pc-text-faint:    #6b675f;
  /* Bronze — the sole interactive accent */
  --pc-accent:        #b69160;
  --pc-accent-hover:  #c6a574;
  --pc-accent-soft:   rgba(182, 145, 96, 0.14);
  /* Semantic value movement — reserved for real deltas, never decoration */
  --pc-positive:      #7fa98b;   /* muted sage */
  --pc-negative:      #c08577;   /* muted clay */
  /* Focus */
  --pc-focus:         #b69160;
  /* Radii, shadow, motion */
  --pc-radius:        6px;
  --pc-radius-lg:     10px;
  --pc-shadow-1:      0 1px 2px rgba(0, 0, 0, 0.5);
  --pc-shadow-2:      0 8px 30px rgba(0, 0, 0, 0.45);
  --pc-ease:          cubic-bezier(0.4, 0, 0.2, 1);
}

/* Light theme reserved for a later plan — do NOT rely on it in V1. */
:root[data-theme="light"] {
  /* intentionally empty stub; light palette is future work */
}
```

`src/styles/global.css`: `@import "tailwindcss";`, the `@fontsource` imports, an `@theme` block mapping Tailwind tokens to the vars (e.g. `--color-canvas: var(--pc-canvas); --color-surface-1: var(--pc-surface-1); --color-ink: var(--pc-text); --color-ink-2: var(--pc-text-secondary); --color-accent: var(--pc-accent); --color-positive: var(--pc-positive); --color-negative: var(--pc-negative); --font-display: "Fraunces Variable", Georgia, serif; --font-sans: "Inter Variable", system-ui, sans-serif; --font-mono: "JetBrains Mono", ui-monospace, monospace;`). Base layer: `html` sets `color-scheme: dark`; `body` `background: var(--pc-canvas); color: var(--pc-text); font-family: var(--font-sans);`; monetary/tabular figures use `font-variant-numeric: tabular-nums`; a visible bronze focus ring on `:focus-visible`; respect `prefers-reduced-motion`.

- [ ] **Step 3: Showcase + smoke test** — `src/routes/Showcase.tsx` renders swatches of every token, the type scale (Fraunces display sizes, Inter body, mono), and sample positive/negative figures — for visual verification. `App.tsx` renders it at `/`. A Vitest smoke test asserts `App` renders without crashing and the wordmark text appears.

- [ ] **Step 4: Verify** — `cd web && npm run build && npm run lint && npm run test` all pass. (Controller will additionally screenshot the showcase.)

- [ ] **Step 5: Commit** — `.gitignore` already ignores `node_modules`; verify `web/node_modules` and `web/dist` are ignored (add `web/node_modules/`, `web/dist/`, `web/*.tsbuildinfo` to `.gitignore` if needed). `git add web .gitignore && git commit -m "feat(web): scaffold with dark-first design token system and typography"`

---

### Task 2: API client + money/format helpers

**Files:** `src/lib/api.ts`, `src/lib/money.ts`, `src/lib/format.ts`; tests `src/lib/api.test.ts`, `src/lib/money.test.ts`.

**Interfaces:** `apiFetch(path, opts?) -> Promise<T>` (prepends `/api/v1`, `credentials: "include"`, JSON by default; on non-2xx throws `ApiError{status, detail}` parsed from `{detail}`; a `401` bubbles a typed `UnauthorizedError` the auth layer catches). `ApiError`, `UnauthorizedError`. `formatMoney(minor: number, currency: string, locale?: string) -> string` (via `Intl.NumberFormat` with `minimumFractionDigits` from the currency; divides minor by the currency's minor-unit factor — default 100). `formatDate`/`formatNumber` from preferences.

- [ ] **Step 1: Failing tests** (Vitest, mock `fetch`): `apiFetch` prepends `/api/v1`, includes credentials, parses JSON, throws `ApiError` with `detail` on 400/404/409, throws `UnauthorizedError` on 401; `formatMoney(100000,"BRL","pt-BR")` → `"R$ 1.000,00"`, `formatMoney(-849900,"BRL","pt-BR")` negative, a zero-decimal currency (`JPY`) formats without decimals.
- [ ] **Step 2–5:** implement, verify (`npm run test/build/lint`), commit `feat(web): api client and money/date formatters`.

---

### Task 3: Auth — in-memory token, silent refresh, provider

**Files:** `src/lib/auth.tsx` (AuthProvider, `useAuth`), integrate with `api.ts` (token injection + refresh-on-401); tests `src/lib/auth.test.tsx`.

**Interfaces:** `AuthProvider` holds `accessToken` in a React ref/state (memory only). `useAuth()` → `{ user, status: "loading"|"authed"|"anon", login(email,password), logout(), logoutAll() }`. On mount, calls `POST /auth/refresh` (silent, uses the HttpOnly cookie) → on success stores the access token in memory + fetches `/auth/me`; on failure → `anon`. `api.ts` gets the current token via a registered getter and, on a `401`, performs a single `/auth/refresh` retry then replays the request once; if refresh fails, clears state → `anon`. A refresh timer refreshes ~1 min before the 15-min expiry (optional; the 401-retry path is the required floor). Access token NEVER touches storage (a test asserts `localStorage`/`sessionStorage` remain empty after login).

- [ ] **Step 1: Failing tests** (mock fetch): boot with a valid refresh cookie → status `authed`, user loaded, `localStorage` empty; boot with refresh failure → `anon`; a 401 on a data call triggers one refresh + replay; refresh-failure on retry → `anon` + state cleared; `login` stores token in memory and sets `authed`; `logout` calls `/auth/logout` and clears. Assert the token is never written to `localStorage`/`sessionStorage`.
- [ ] **Step 2–5:** implement, verify, commit `feat(web): in-memory access token with silent refresh`.

---

### Task 4: Router + setup/auth guards + app shell stub

**Files:** `src/routes/guards.tsx`, `src/App.tsx` (route tree), `src/routes/Login.tsx`, `src/routes/NotFound.tsx`, `src/components/layout/AppShell.tsx` (stub), `src/lib/setup.ts` (setup-status query); tests `src/routes/guards.test.tsx`.

**Interfaces:** route tree: `/setup/*` (wizard — Plan 06 mounts here), `/login`, and the authed app under an `AppShell` (`/`, and Plan 07's screens). Guards: `useSetupStatus()` queries `GET /setup/status`; `RequireSetup` redirects to `/setup` when `initialized === false` (and away from `/setup` when already initialized); `RequireAuth` redirects unauthenticated users to `/login`; `RedirectIfAuthed` bounces authed users off `/login`. A loading state shows a branded splash (Wordmark + subtle stroke) while setup-status/auth resolve. `AppShell` is a minimal dark sidebar+topbar frame with nav placeholders (Plan 07 fills it).

- [ ] **Step 1: Failing tests** (render with a mocked setup-status + auth): uninitialized instance → lands on `/setup`; initialized + anon → `/login`; initialized + authed → app shell renders; visiting `/setup` when initialized → redirected to app.
- [ ] **Step 2–5:** implement, verify, commit `feat(web): router with setup and auth guards`.

---

### Task 5: Base component kit + brand marks

**Files:** `src/components/ui/*` (Button, TextField, PasswordField, Card, Surface, Callout, Spinner, Toast, form Field label/error primitives), `src/components/brand/Wordmark.tsx` + `HandStroke.tsx`, style the `Login.tsx` using the kit; tests `src/components/ui/*.test.tsx` (render/interaction smoke).

**Interfaces:** accessible, token-driven components (keyboard focus rings, `aria-*`, `prefers-reduced-motion`). `Button` (variants: primary=bronze, ghost, quiet; sizes; loading state). `TextField`/`PasswordField` (label, error, description; PasswordField has a show/hide toggle). `Card`/`Surface` (surface-1/2/3 elevation via tokens + hairline borders, restrained shadow). `Callout` (info/positive/negative). `Toast` (transient, via a small context). `Wordmark` (the "PECUNIA" SVG with optional stroke-in animation). `HandStroke` (a reusable SVG stroke-draw component animating `stroke-dashoffset`, respecting reduced-motion — the hand-drawn accent Plan 06's wizard leans on). The Login screen becomes a real, polished dark screen using these (email + PasswordField + primary Button + error Callout on `INVALID_CREDENTIALS`/`TOO_MANY_ATTEMPTS`), wired to `useAuth().login`.

- [ ] **Step 1: Failing tests:** Button fires onClick / shows loading / is disabled; PasswordField toggles visibility; Login shows an error Callout when `login` rejects with `INVALID_CREDENTIALS`; focus-visible ring present (class/attr assertion).
- [ ] **Step 2–5:** implement, verify (build/lint/test), commit `feat(web): base component kit, brand marks, and login screen`.

- [ ] **Step 6: Fill CONVENTIONS §9.** Replace the §9 placeholder in `docs/CONVENTIONS.md` with the real frontend conventions as built: the `--pc-*` token system + Tailwind `@theme` mapping (no raw hex in components), component structure (`components/ui|layout|brand`), the auth model (in-memory token + silent refresh, never `localStorage`), the api client + error model, routing/guards, `formatMoney`/`format` helpers, TanStack Query for server state, self-hosted fonts, and the hand-drawn-motion accent system (pre-authored SVG stroke-draw, reduced-motion-safe, generous in onboarding / scarce in-app). Commit `docs: fill CONVENTIONS §9 with frontend conventions`.

---

## Self-review notes

- **Spec coverage:** D1 browser architecture (in-memory access token + silent refresh + HttpOnly cookie, no localStorage — Task 3, with a storage-emptiness test); D5 dark-first token system + Fraunces/Inter/mono + bronze accent + restrained sage/clay + hand-drawn stroke component (Tasks 1, 5); setup/auth routing gates (Task 4). Money as integer minor units rendered via Intl (Task 2).
- **Design fidelity:** tokens are the exact D5 palette; components consume tokens only (no raw hex); the showcase + Login give the controller two real screens to screenshot-verify the identity before Plan 06.
- **Deferred:** the light theme (token stub only), the wizard screens (Plan 06), the app screens/dashboard (Plan 07), production serving (Plan 08). WebAuthn/2FA/passkey UI (post-V1).
- **Verification:** each task gated by `npm run build && npm run lint && npm run test`; controller screenshots the showcase (Task 1) and Login (Task 5) via the browser tooling to confirm the dark identity renders as intended.
