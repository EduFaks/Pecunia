import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * End-to-end walk of the *already-initialized* app (Plan 07) — distinct
 * from `wizard.spec.ts` (Plan 06), which walks the first-run setup flow on
 * an uninitialized instance and never re-runs here. This spec assumes a
 * real Pecunia stack is up, initialized, and seeded with demo data (see the
 * Task 6 brief's runbook: `docker compose down -v && docker compose up -d
 * --build`, then `POST /setup/initialize` with the owner below followed by
 * `POST /demo`, before `npm run e2e -- app.spec.ts`). It signs in through
 * the login screen — never the wizard — then visits every major screen,
 * asserting each renders real demo data (not an empty/placeholder state),
 * and captures a full-page screenshot of each to `e2e/screenshots/app-*.png`
 * (git-ignored) for the controller's design review.
 *
 * One write, deliberately: `seed_demo_data` (`api/src/pecunia/services/
 * demo.py`) inserts its ~22 transactions/accounts/asset/project/budget rows
 * directly (bulk fixture load), publishing exactly one `data.demo_seeded`
 * event rather than one per row — so no `activity.*` entries exist for any
 * of it (`project_activity` only projects events that carry an
 * `activity_template`, which the bulk seed's single event doesn't). A
 * demo-only instance's Activity feed is therefore genuinely empty even
 * though the audit log and every finance screen are full. Rather than
 * screenshot that empty state (nothing to review, and not what "populated
 * with demo data" means for this screen), this test performs one real
 * write — adding a small transaction via `AccountDetail`'s own inline
 * form, a screen already on the walk — which produces a real
 * `activity.transaction.created` entry (and a matching `transaction.created`
 * audit row) to show on both the Activity and Audit Log screenshots. This
 * also happens to exercise the balance-reactivity contract end to end
 * against a real API, not just the mocked unit suite.
 *
 * One long `test(...)` rather than one per screen, same rationale as
 * `wizard.spec.ts`: signing in and walking screen-to-screen via real nav
 * clicks (never `page.goto` mid-flow, which would drop the in-memory access
 * token and re-run the boot sequence) builds up state — the added
 * transaction in particular — that later screens depend on.
 */

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

// Matches the runbook's owner (`POST /setup/initialize`'s `owner` body) —
// the controller creates and seeds this instance before running this spec.
const OWNER_EMAIL = "ada@example.com";
const OWNER_PASSWORD = "correct horse battery";

function screenshotPath(name: string): string {
  return path.join(SCREENSHOT_DIR, name);
}

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("walks the demo-seeded app end to end, capturing every major screen", async ({ page }) => {
  // Real network round trips against every screen (accounts, transactions,
  // an asset's valuation history, a live mutation, activity, audit) add up
  // to comfortably more than the config's default 30s single-test budget.
  test.setTimeout(90_000);

  // An uninitialized visit to "/" would land on the wizard (RequireSetup);
  // an initialized-but-anonymous one lands on "/login" (RequireAuth) — the
  // runbook's seeded instance is the latter, so this is the login screen,
  // never the wizard.
  await page.goto("/");
  await page.waitForURL((url) => url.pathname === "/login");

  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");

  // --- Dashboard -----------------------------------------------------
  // The demo chip confirms this instance really is demo-seeded; a named
  // demo account plus a non-zero dollar figure confirm the balance summary
  // is reading real data, not an empty/zero placeholder.
  await expect(page.getByText("Demo data")).toBeVisible();
  await expect(page.getByText("Everyday Checking")).toBeVisible();
  await expect(page.locator("main")).toContainText(/\$[1-9][\d,]*\.\d{2}/);
  await page.screenshot({ path: screenshotPath("app-dashboard.png"), fullPage: true });

  // --- Accounts --------------------------------------------------------
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.waitForURL((url) => url.pathname === "/accounts");
  // `App.tsx`'s `BrowserRouter` opts into `v7_startTransition`, so React can
  // keep the outgoing screen mounted for a beat after the URL/history has
  // already changed — a same-named account can legitimately be the
  // Dashboard's chart subject too (the highest-balance account in the base
  // currency, per `selectPrimaryAccount`), so a broad `getByText` run right
  // after `waitForURL` can transiently strict-mode-violate against both
  // screens at once. Asserting the new screen's own unique `h1` first
  // forces the wait past that one atomic commit — React swaps the whole
  // tree in one go, it doesn't interleave — so every assertion after it is
  // guaranteed to see only the new screen.
  await expect(page.getByRole("heading", { name: "Accounts", level: 1 })).toBeVisible();
  await expect(page.getByText("Everyday Checking")).toBeVisible();
  await expect(page.getByText("Emergency Fund")).toBeVisible();
  await expect(page.getByText("Rewards Credit Card")).toBeVisible();
  await page.screenshot({ path: screenshotPath("app-accounts.png"), fullPage: true });

  // --- Account detail ----------------------------------------------------
  await page.getByRole("link", { name: "Everyday Checking" }).click();
  await page.waitForURL((url) => /\/accounts\/.+/.test(url.pathname));
  await expect(page.getByRole("heading", { name: "Everyday Checking", level: 1 })).toBeVisible();
  await expect(page.getByText("Salary", { exact: true })).toBeVisible();
  await page.screenshot({ path: screenshotPath("app-account-detail.png"), fullPage: true });

  // A real write via the screen's own inline form — see the module
  // docstring for why (populates the otherwise-empty Activity feed).
  await page.getByLabel("Description", { exact: true }).fill("Bookshop");
  await page.getByLabel("Amount", { exact: true }).fill("18.50");
  await page.getByRole("button", { name: "Add transaction" }).click();
  await expect(page.getByText("Bookshop", { exact: true })).toBeVisible();

  // --- Transactions --------------------------------------------------
  // `AccountDetail`'s own transactions section carries an `h2` reading
  // "Transactions" too, so this is exactly the same transient-overlap risk
  // the Accounts step's comment above describes — `level: 1` distinguishes
  // this screen's `h1` from that leftover `h2` during the swap.
  await page.getByRole("link", { name: "Transactions" }).click();
  await page.waitForURL((url) => url.pathname === "/transactions");
  await expect(page.getByRole("heading", { name: "Transactions", level: 1 })).toBeVisible();
  await expect(page.getByText("Rent contribution", { exact: true })).toBeVisible();
  await page.screenshot({ path: screenshotPath("app-transactions.png"), fullPage: true });

  // --- Asset detail (valuation chart) -------------------------------------
  await page.getByRole("link", { name: "Assets" }).click();
  await page.waitForURL((url) => url.pathname === "/assets");
  await page.getByRole("link", { name: "Mercedes CLA 45 S" }).click();
  await page.waitForURL((url) => /\/assets\/.+/.test(url.pathname));
  await expect(page.getByRole("heading", { name: "Mercedes CLA 45 S", level: 1 })).toBeVisible();
  // Three seeded valuations are enough for TimeSeriesChart to render (it
  // needs >= 2 points) rather than fall back to its empty state.
  await expect(page.locator('svg[role="img"]')).toBeVisible();
  await expect(page.getByText("Market estimate").first()).toBeVisible();
  await page.screenshot({ path: screenshotPath("app-asset-detail.png"), fullPage: true });

  // --- Projects --------------------------------------------------------
  await page.getByRole("link", { name: "Projects" }).click();
  await page.waitForURL((url) => url.pathname === "/projects");
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(page.getByText("Sim Rig Build", { exact: true })).toBeVisible();
  // The seeded project items sum exactly to its target (70k + 45k + 65k =
  // 180k), so FundingBar's "Target reached" badge is real, not staged.
  await expect(page.getByText("Target reached", { exact: true })).toBeVisible();
  await page.screenshot({ path: screenshotPath("app-projects.png"), fullPage: true });

  // --- Activity --------------------------------------------------------
  await page.getByRole("link", { name: "Activity" }).click();
  await page.waitForURL((url) => url.pathname === "/activity");
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  // The one real write above is what makes this feed non-empty — see the
  // module docstring.
  await expect(page.getByText(/Bookshop/)).toBeVisible();
  await page.screenshot({ path: screenshotPath("app-activity.png"), fullPage: true });

  // --- Settings -> Security -> Sessions --------------------------------
  await page.getByRole("link", { name: "Settings" }).click();
  await page.waitForURL((url) => url.pathname === "/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sessions", level: 2 })).toBeVisible();
  await expect(page.getByText("Current session", { exact: true })).toBeVisible();
  await page.screenshot({ path: screenshotPath("app-sessions.png"), fullPage: true });

  // --- Settings -> Security -> Audit Log -------------------------------
  await page.getByRole("button", { name: "Audit Log" }).click();
  await expect(page.getByRole("heading", { name: "Audit Log", level: 2 })).toBeVisible();
  // Both the bulk demo seed and the transaction added above show up here —
  // the audit log records everything (CONVENTIONS §7), unlike Activity's
  // curated subset. Scoped to each row's own expand/collapse `button` (not
  // a plain `getByText`) since the same words also appear as `<option>`
  // labels in the Action filter `Select` just above.
  await expect(page.getByRole("button", { name: "Data demo seeded" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Transaction created" })).toBeVisible();
  await page.screenshot({ path: screenshotPath("app-audit.png"), fullPage: true });
});
