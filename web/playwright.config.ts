import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end config, shared by `wizard.spec.ts` (Plan 06 Task 5 — the
 * first-run setup flow on an uninitialized instance) and `app.spec.ts`
 * (Plan 07 Task 6 — the signed-in app on an initialized, demo-seeded
 * instance). Boots the Vite dev server itself (`webServer`) on a fixed port
 * — rather than whatever port happens to be free — so `use.baseURL` and the
 * dev server always agree and a human re-running `npm run e2e` locally gets
 * a stable, predictable URL. The dev server proxies `/api` to
 * `localhost:8480` (`vite.config.ts`), so this config assumes a real
 * Pecunia API + Postgres stack is already up and reachable in whichever
 * state the spec being run expects (uninitialized for the wizard walk,
 * initialized-with-demo-data for the app walk) — it does not start or reset
 * that stack itself. See each spec's own docstring and its task brief's
 * runbook: `docker compose down -v && docker compose up -d --build` from
 * the repo root before `npm run e2e`.
 *
 * `testDir` is `./e2e` (this file lives at the `web/` root precisely so
 * that default — no `-c`/`--config` flag needed — resolution of `playwright
 * test` finds it there, matching the plain `"e2e": "playwright test"` npm
 * script), and each spec writes its own full-page screenshots under
 * `e2e/screenshots/` (git-ignored) rather than relying on Playwright's
 * built-in failure-screenshot mechanism, since these are a deliberate
 * design-review artifact captured at chosen moments, not a debugging aid.
 *
 * `ship.spec.ts` (Plan 08 Task 5) is deliberately excluded via `testIgnore`
 * below: it proves the SHIPPED artifact — the nginx-served production build
 * behind the real three-container proxy — not the Vite dev server this
 * config boots, so it has its own `playwright.ship.config.ts` (no
 * `webServer`, `baseURL` pointed at the running `pecunia-web` container) and
 * its own `npm run e2e:ship`. Running `npm run e2e` bare must never silently
 * spin up a dev server and run the ship spec against *that* — it would pass
 * for the wrong reason.
 */
const PORT = 4300;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "ship.spec.ts",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
