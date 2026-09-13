import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Full three-container, end-to-end verification of the SHIPPED artifact
 * (Plan 08 Task 5) — the nginx-served production build in the `pecunia-web`
 * container, proxying `/api` to `pecunia-api` and `pecunia-api` talking to
 * `pecunia-db`, not the Vite dev server `wizard.spec.ts`/`app.spec.ts` run
 * against (see `playwright.config.ts`'s `webServer`). This is the
 * authoritative proof that what a real user downloads and runs
 * (`docker compose up -d --build`) actually works end to end: the built JS
 * bundle, the SPA history fallback, and — most load-bearing — that the
 * browser's `Origin`/cookie behavior survives the real nginx proxy hop
 * (Task 1's `$http_host` fix and `X-Forwarded-For` trust wiring), not just
 * the dev proxy's direct pass-through.
 *
 * Run via `playwright.ship.config.ts` (no `webServer` — see its own
 * docstring), which is why this file has none of its own: the caller
 * ("npm run e2e:ship", or the Task 5 runbook's
 * `PECUNIA_PORT=8480 npx playwright test -c playwright.ship.config.ts
 * ship.spec.ts`) is responsible for having the real stack up first
 * (`docker compose down -v && docker compose up -d --build` from the repo
 * root, then polling `curl localhost:${PECUNIA_PORT:-8480}/api/v1/setup/status`
 * until it answers `{"initialized":false}`) and tearing it down after
 * (`docker compose down -v`). Running this against the plain
 * `playwright.config.ts` dev-server setup would defeat its entire purpose —
 * `playwright.config.ts` explicitly `testIgnore`s this file for exactly
 * that reason.
 *
 * Walks the identical uninitialized → owner → preferences → starting-point →
 * finish journey `wizard.spec.ts` walks, but diverges at the starting-point
 * step: instead of "Skip for now", this run clicks through "Explore with
 * demo data" so the rest of the walk (dashboard, Accounts, an asset detail)
 * has real seeded figures to assert against — proving the shipped build
 * renders real data, not just an empty shell. One long `test(...)`, same
 * rationale as `wizard.spec.ts`/`app.spec.ts`: each step depends on state
 * (the resumable draft, the in-memory password, the just-created owner
 * session, the seeded demo data) built by the previous one.
 *
 * Deliberately visits an asset detail screen rather than Activity: demo
 * seeding alone never populates the Activity feed (`seed_demo_data`
 * publishes exactly one `data.demo_seeded` event, not one per row — see
 * `app.spec.ts`'s module docstring for the full rationale), so an
 * Activity-feed screenshot here would show nothing but its empty state, not
 * the "real demo data" this task is proving renders through the served
 * build. The asset detail screen's valuation chart is real seeded data with
 * no extra write required.
 */

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

// Long, mixed-class, non-dictionary passphrase — comfortably clears the
// wizard's own 10–128 length floor and StepOwner's UI-only zxcvbn "Fair"
// (score >= 2) floor (see StepOwner.tsx), same shape as wizard.spec.ts's.
const STRONG_PASSWORD = "Cobalt-Ferry-77!Meridian-Vault";

function screenshotPath(name: string): string {
  return path.join(SCREENSHOT_DIR, name);
}

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("walks the full first-run journey against the shipped nginx build, seeding and rendering real demo data", async ({
  page,
}) => {
  // Real container-to-container network hops (nginx -> api -> postgres) for
  // every step, plus the demo seed's bulk insert, comfortably exceed the
  // config's default 30s single-test budget.
  test.setTimeout(120_000);

  await page.goto("/");

  // Step 1 — Welcome: the wizard's identity showcase, served as a static
  // asset out of nginx's `root`, not Vite.
  await expect(
    page.getByRole("heading", { name: "Your financial life, in one place." }),
  ).toBeVisible();
  await page.screenshot({ path: screenshotPath("ship-1-welcome.png"), fullPage: true });

  await page.getByRole("button", { name: /get started/i }).click();

  // Step 2 — Owner account: name/email/password+confirm, a strong password.
  await expect(page.getByRole("heading", { name: "Create the owner account" })).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill("Nora Chen");
  await page.getByLabel("Email", { exact: true }).fill("nora@pecunia.ship");
  await page.getByLabel("Password", { exact: true }).fill(STRONG_PASSWORD);
  await page.getByLabel("Confirm password", { exact: true }).fill(STRONG_PASSWORD);

  const ownerContinue = page.getByRole("button", { name: /^continue/i });
  await expect(ownerContinue).toBeEnabled();
  await page.screenshot({ path: screenshotPath("ship-2-owner.png"), fullPage: true });

  await ownerContinue.click();

  // Step 3 — Preferences: confirm the Intl-derived defaults, pick a base
  // currency.
  await expect(page.getByRole("heading", { name: "Set your preferences" })).toBeVisible();

  await page.getByRole("combobox", { name: "Base currency" }).click();
  await page.getByRole("option", { name: /USD/ }).click();

  const preferencesContinue = page.getByRole("button", { name: /^continue/i });
  await expect(preferencesContinue).toBeEnabled();
  await page.screenshot({ path: screenshotPath("ship-3-preferences.png"), fullPage: true });

  // Fires the wizard's one pivotal write — POST /setup/initialize, through
  // nginx's /api/ proxy — which creates the owner, initializes the
  // instance, and auto-logs the owner in (adoptSession). This is the first
  // credentialed request through the real proxy: if nginx's `Host`/XFF
  // forwarding ever regressed (Task 1's `$http_host` fix), the API's
  // Origin/Host CSRF guard would reject this with 403 ORIGIN_MISMATCH and
  // the step-4 heading below would never appear.
  await preferencesContinue.click();

  // Step 4 — Starting point: seed demo data (rather than skip, as
  // `wizard.spec.ts` does) so the rest of this walk has real figures.
  await expect(page.getByRole("heading", { name: "Choose your starting point" })).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: screenshotPath("ship-4-starting.png"), fullPage: true });

  await page.getByRole("button", { name: "Add demo data" }).click();
  await expect(page.getByText("Demo data added", { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: screenshotPath("ship-4b-demo-seeded.png"), fullPage: true });

  await page.getByRole("button", { name: "Continue →" }).click();

  // Step 5 — Finish. Same fixed-delay rationale as `wizard.spec.ts`: the
  // "You're ready."/Enter Pecunia reveal is a delayed opacity transition
  // (`StepFinish.tsx`: `delay-700 duration-300`) with no element-level
  // "transition finished" signal to assert on.
  const enterButton = page.getByRole("button", { name: /enter pecunia/i });
  await expect(enterButton).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: screenshotPath("ship-5-finish.png"), fullPage: true });

  await enterButton.click();

  // The wizard cross-fades out and navigates to "/" — the real app shell,
  // since initialize already auto-logged the owner in.
  await page.waitForURL((url) => url.pathname === "/");
  expect(new URL(page.url()).pathname).toBe("/");

  // --- Dashboard: real demo balances, not an empty/zero placeholder -----
  // Note: Dashboard's own "Welcome to Pecunia" heading is the *empty-state*
  // (zero accounts) rendering (`Dashboard.tsx`) — irrelevant here since demo
  // seeding means the populated view (net worth, balance tiles, accounts
  // snapshot) renders instead. Assert on that populated content directly.
  await expect(page.getByText("Demo data")).toBeVisible();
  await expect(page.getByText("Net worth")).toBeVisible();
  await expect(page.getByText("Everyday Checking")).toBeVisible();
  await expect(page.locator("main")).toContainText(/\$[1-9][\d,]*\.\d{2}/);
  await page.screenshot({ path: screenshotPath("ship-6-dashboard.png"), fullPage: true });

  // --- Accounts: every seeded demo account renders ----------------------
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.waitForURL((url) => url.pathname === "/accounts");
  // Forces the wait past the one atomic tree swap before asserting further
  // (see app.spec.ts's comment on the same pattern — avoids a transient
  // strict-mode double-match against the outgoing screen).
  await expect(page.getByRole("heading", { name: "Accounts", level: 1 })).toBeVisible();
  await expect(page.getByText("Everyday Checking")).toBeVisible();
  await expect(page.getByText("Emergency Fund")).toBeVisible();
  await expect(page.getByText("Rewards Credit Card")).toBeVisible();
  await page.screenshot({ path: screenshotPath("ship-7-accounts.png"), fullPage: true });

  // --- Asset detail: real seeded valuation history renders a chart -------
  await page.getByRole("link", { name: "Assets" }).click();
  await page.waitForURL((url) => url.pathname === "/assets");
  await page.getByRole("link", { name: "Mercedes CLA 45 S" }).click();
  await page.waitForURL((url) => /\/assets\/.+/.test(url.pathname));
  await expect(page.getByRole("heading", { name: "Mercedes CLA 45 S", level: 1 })).toBeVisible();
  await expect(page.locator('svg[role="img"]')).toBeVisible();
  await expect(page.getByText("Market estimate").first()).toBeVisible();
  await page.screenshot({ path: screenshotPath("ship-8-asset-detail.png"), fullPage: true });
});
