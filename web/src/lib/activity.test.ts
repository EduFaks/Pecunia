import { describe, expect, it } from "vitest";
import { renderActivity } from "./activity";

describe("renderActivity", () => {
  it("renders activity.account.created", () => {
    expect(renderActivity("activity.account.created", { name: "Checking", type: "checking" })).toBe(
      'Account "Checking" created (checking).',
    );
  });

  it("renders activity.transaction.created with the amount formatted per currency", () => {
    const text = renderActivity(
      "activity.transaction.created",
      { description: "Coffee", amount_minor: -450, currency: "USD" },
      "en-US",
    );
    expect(text.startsWith('Transaction "Coffee" recorded — ')).toBe(true);
    expect(text).toContain("4.50");
    expect(text).toMatch(/-/);
    expect(text.endsWith(".")).toBe(true);
  });

  it("renders activity.asset.created", () => {
    expect(renderActivity("activity.asset.created", { name: "Model 3", type: "vehicle" })).toBe(
      'Asset "Model 3" added (vehicle).',
    );
  });

  it("renders activity.asset.valuation_changed with both the old and new value", () => {
    const text = renderActivity(
      "activity.asset.valuation_changed",
      { asset: "Model 3", from: 4000000, to: 3800000, currency: "USD" },
      "en-US",
    );
    expect(text.startsWith("Model 3 valuation changed · ")).toBe(true);
    expect(text).toContain("40,000.00");
    expect(text).toContain("38,000.00");
    expect(text).toMatch(/40,000\.00.*→.*38,000\.00/);
  });

  it("renders activity.project.created with its target", () => {
    const text = renderActivity(
      "activity.project.created",
      { name: "New roof", target_amount_minor: 500000, currency: "USD" },
      "en-US",
    );
    expect(text.startsWith('Project "New roof" created — target ')).toBe(true);
    expect(text).toContain("5,000.00");
  });

  it("renders activity.project.target_reached", () => {
    const text = renderActivity(
      "activity.project.target_reached",
      { project: "New roof", funded: 500000, target: 500000, currency: "USD" },
      "en-US",
    );
    expect(text.startsWith('Project "New roof" reached its target of ')).toBe(true);
    expect(text).toContain("5,000.00");
  });

  it("renders activity.budget.created", () => {
    const text = renderActivity(
      "activity.budget.created",
      { name: "Groceries", amount_minor: 40000, currency: "USD" },
      "en-US",
    );
    expect(text.startsWith('Budget "Groceries" created — ')).toBe(true);
    expect(text).toContain("400.00");
  });

  it("falls back to a humanized sentence for an unrecognized template key", () => {
    expect(renderActivity("activity.workspace.renamed", {})).toBe("Workspace renamed.");
  });

  it("falls back gracefully when expected params are missing", () => {
    expect(renderActivity("activity.account.created", {})).toBe('Account "—" created.');
  });
});
