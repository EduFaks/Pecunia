import { describe, expect, it } from "vitest";
import { financeQueryKeys, qk } from "./queries";

describe("qk", () => {
  it("gives each list its own top-level key", () => {
    expect(qk.accounts).toEqual(["accounts"]);
    expect(qk.assets).toEqual(["assets"]);
    expect(qk.projects).toEqual(["projects"]);
    expect(qk.portfolios).toEqual(["portfolios"]);
    expect(qk.loans).toEqual(["loans"]);
    expect(qk.subscriptions).toEqual(["subscriptions"]);
    expect(qk.budgets).toEqual(["budgets"]);
    expect(qk.categories).toEqual(["categories"]);
    expect(qk.contacts).toEqual(["contacts"]);
    expect(qk.transfers).toEqual(["transfers"]);
    expect(qk.activity).toEqual(["activity"]);
    expect(qk.sessions).toEqual(["sessions"]);
    expect(qk.demo).toEqual(["demo"]);
    expect(qk.me).toEqual(["me"]);
  });

  it("nests a detail key under its list's key", () => {
    expect(qk.account("a1")).toEqual(["accounts", "a1"]);
    expect(qk.asset("as1")).toEqual(["assets", "as1"]);
    expect(qk.project("p1")).toEqual(["projects", "p1"]);
  });

  it("nests a resource's sub-collection key under its detail key", () => {
    expect(qk.assetValuations("as1")).toEqual(["assets", "as1", "valuations"]);
    expect(qk.projectItems("p1")).toEqual(["projects", "p1", "items"]);
    expect(qk.portfolio("pf1")).toEqual(["portfolios", "pf1"]);
    expect(qk.holdings("pf1")).toEqual(["portfolios", "pf1", "holdings"]);
    expect(qk.loan("l1")).toEqual(["loans", "l1"]);
    expect(qk.loanPayments("l1")).toEqual(["loans", "l1", "payments"]);
  });

  it("scopes transactions by account when given, and stays a shared unscoped prefix otherwise", () => {
    expect(qk.transactions()).toEqual(["transactions"]);
    expect(qk.transactions("acc-1")).toEqual(["transactions", { accountId: "acc-1" }]);
  });

  it("keys audit events by their filter set, defaulting to no filters", () => {
    expect(qk.auditEvents()).toEqual(["audit-events", {}]);
    expect(qk.auditEvents({ action: "transaction.created" })).toEqual([
      "audit-events",
      { action: "transaction.created" },
    ]);
  });
});

describe("financeQueryKeys", () => {
  it("covers every finance-domain listing, and nothing else", () => {
    expect(financeQueryKeys).toEqual([
      ["accounts"],
      ["transactions"],
      ["assets"],
      ["projects"],
      ["budgets"],
      ["categories"],
      ["contacts"],
      ["transfers"],
      ["portfolios"],
      ["loans"],
      ["subscriptions"],
    ]);
  });
});
