import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * End-to-end walk of the entire setup wizard (Plan 06) against a real,
 * uninitialized Pecunia stack — see `playwright.config.ts`'s `webServer`
 * (the Vite dev server, proxying `/api` to `localhost:8480`) and the
 * Task 5 brief's runbook for bringing the full stack up first (`docker
 * compose down -v && docker compose up -d --build`, reset to
 * uninitialized). Screenshots every step full-page to
 * `e2e/screenshots/step-N-*.png` (git-ignored) for design-fidelity review;
 * the assertions check the flow actually *completes* end to end — the
 * owner account is created, the instance initializes, the owner is
 * auto-logged-in, and the dashboard shell renders at `/` — not just that
 * each screen renders in isolation (the unit suite already covers that).
 *
 * Deliberately one long `test(...)` rather than five independent ones:
 * each step depends on state built by the previous one (the resumable
 * draft, the in-memory password, the just-created owner session), so
 * splitting this into per-step tests would mean re-walking the wizard from
 * scratch for every step — slower, and it would hide exactly the kind of
 * cross-step regression (e.g. the atomic `initialize` call losing the
 * owner's name between Step 2 and Step 3) this test exists to catch.
 */

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

// Long, mixed-class, non-dictionary passphrase — comfortably clears the
// wizard's own 10–128 length floor and StepOwner's UI-only zxcvbn "Fair"
// (score >= 2) floor (see StepOwner.tsx).
const STRONG_PASSWORD = "Qu4rtz-Falcon-99!Harbor-Ridge";

function screenshotPath(name: string): string {
  return path.join(SCREENSHOT_DIR, name);
}

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("walks the entire setup wizard end to end and lands on the dashboard", async ({ page }) => {
  await page.goto("/");

  // Step 1 — Welcome: the wizard's identity showcase.
  await expect(
    page.getByRole("heading", { name: "Your financial life, in one place." }),
  ).toBeVisible();
  await page.screenshot({ path: screenshotPath("step-1-welcome.png"), fullPage: true });

  await page.getByRole("button", { name: /get started/i }).click();

  // Step 2 — Owner account: name/email/password+confirm, a strong password.
  await expect(page.getByRole("heading", { name: "Create the owner account" })).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  await page.getByLabel("Email", { exact: true }).fill("ada@example.com");
  await page.getByLabel("Password", { exact: true }).fill(STRONG_PASSWORD);
  await page.getByLabel("Confirm password", { exact: true }).fill(STRONG_PASSWORD);

  const ownerContinue = page.getByRole("button", { name: /^continue/i });
  await expect(ownerContinue).toBeEnabled();
  await page.screenshot({ path: screenshotPath("step-2-owner.png"), fullPage: true });

  await ownerContinue.click();

  // Step 3 — Preferences: confirm the Intl-derived defaults, pick a base
  // currency (the one field the wizard deliberately leaves to a choice).
  await expect(page.getByRole("heading", { name: "Set your preferences" })).toBeVisible();

  await page.getByRole("combobox", { name: "Base currency" }).click();
  await page.getByRole("option", { name: /USD/ }).click();

  const preferencesContinue = page.getByRole("button", { name: /^continue/i });
  await expect(preferencesContinue).toBeEnabled();
  await page.screenshot({ path: screenshotPath("step-3-preferences.png"), fullPage: true });

  // Fires the wizard's one pivotal write — POST /setup/initialize — which
  // creates the owner, initializes the instance, and auto-logs the owner
  // in (adoptSession). A real network round trip through password
  // hashing, so give it a generous timeout on the step-4 heading below.
  await preferencesContinue.click();

  // Step 4 — Starting point: optional accounts/demo; skip it.
  await expect(page.getByRole("heading", { name: "Choose your starting point" })).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: screenshotPath("step-4-starting.png"), fullPage: true });

  await page.getByRole("button", { name: "Skip for now" }).click();

  // Step 5 — Finish. The checkmark draws in immediately, but "You're
  // ready."/Enter Pecunia is a delayed opacity/translate reveal on their
  // shared wrapper `<div>` (StepFinish.tsx: `delay-700 duration-300`) —
  // `toBeVisible()` only checks layout presence, not opacity, so it passes
  // well before the fade visually completes. There's no element-level
  // signal of "the transition finished" to assert on (checking the
  // *button's own* computed opacity doesn't reflect its ancestor's fade —
  // opacity isn't reflected in a descendant's own computed style), so wait
  // out the transition's own 700ms delay + 300ms duration (plus a margin)
  // before screenshotting, or the capture catches an empty-looking
  // transitional frame.
  const enterButton = page.getByRole("button", { name: /enter pecunia/i });
  await expect(enterButton).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: screenshotPath("step-5-finish.png"), fullPage: true });

  await enterButton.click();

  // The wizard cross-fades out and navigates to "/" — the real app shell,
  // since initialize already auto-logged the owner in (RequireAuth lets
  // "/" render instead of bouncing to /login).
  await page.waitForURL((url) => url.pathname === "/");
  expect(new URL(page.url()).pathname).toBe("/");

  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  await page.screenshot({ path: screenshotPath("step-6-dashboard.png"), fullPage: true });
});
