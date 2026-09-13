import { defineConfig, devices } from "@playwright/test";

/**
 * Ship-verification config for `ship.spec.ts` (Plan 08 Task 5) — proves the
 * SHIPPED artifact (the nginx-served production build in the `pecunia-web`
 * container, proxying `/api` to `pecunia-api`) delivers the whole first-run
 * journey, not the Vite dev server `playwright.config.ts` boots for
 * `wizard.spec.ts`/`app.spec.ts`.
 *
 * Deliberately declares **no `webServer`**: the point of this config is to
 * point Playwright at a server it did not start and does not manage. The
 * controller brings the real three-container stack up first (`docker
 * compose down -v && docker compose up -d --build` from the repo root,
 * per `ship.spec.ts`'s own docstring and the Task 5 brief's runbook) and
 * this config just aims `baseURL` at whatever host port that stack
 * published — `PECUNIA_PORT` (the same env var `docker-compose.yml` itself
 * reads for `pecunia-web`'s port mapping), defaulting to `8480` to match
 * the compose file's own default. If the stack isn't up yet, or is up on a
 * different port than this run passes, every test simply fails to connect
 * — never silently falls back to a dev server.
 *
 * Run via `npm run e2e:ship` (`package.json`), or directly:
 *   PECUNIA_PORT=8480 npx playwright test -c playwright.ship.config.ts ship.spec.ts
 */
const PORT = process.env.PECUNIA_PORT ?? "8480";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "ship.spec.ts",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report-ship", open: "never" }],
  ],
  outputDir: "test-results-ship",
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
  // No `webServer` — see module docstring above.
});
