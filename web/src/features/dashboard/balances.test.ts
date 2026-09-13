import { describe, expect, it } from "vitest";
import {
  assetValuesByCurrency,
  balancesByCurrency,
  loanContributionsByCurrency,
  netWorthByCurrency,
  portfolioValuesByCurrency,
  selectPrimaryAccount,
} from "./balances";
import type { AccountSummary, AssetSummary, LoanSummary, PortfolioSummary } from "./balances";

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "a1",
    name: "Checking",
    type: "checking",
    currency: "USD",
    balance_minor: 100000,
    archived_at: null,
    ...overrides,
  };
}

function asset(overrides: Partial<AssetSummary> = {}): AssetSummary {
  return {
    id: "s1",
    name: "Model 3",
    currency: "USD",
    current_value_minor: 5000000,
    ...overrides,
  };
}

function portfolio(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    currency: "USD",
    value_minor: 2000000,
    ...overrides,
  };
}

function loan(overrides: Partial<LoanSummary> = {}): LoanSummary {
  return {
    currency: "USD",
    direction: "borrowed",
    remaining_minor: 1000000,
    ...overrides,
  };
}

describe("balancesByCurrency", () => {
  it("sums non-archived account balances grouped by currency, in integer minor units", () => {
    const accounts = [
      account({ id: "a1", currency: "USD", balance_minor: 100000 }),
      account({ id: "a2", currency: "USD", balance_minor: 50000 }),
      account({ id: "a3", currency: "EUR", balance_minor: 20000 }),
    ];

    expect(balancesByCurrency(accounts)).toEqual({ USD: 150000, EUR: 20000 });
  });

  it("excludes archived accounts from the sum", () => {
    const accounts = [
      account({ id: "a1", currency: "USD", balance_minor: 100000, archived_at: null }),
      account({ id: "a2", currency: "USD", balance_minor: 999999, archived_at: "2026-01-01T00:00:00Z" }),
    ];

    expect(balancesByCurrency(accounts)).toEqual({ USD: 100000 });
  });

  it("never sums across currencies", () => {
    const accounts = [
      account({ id: "a1", currency: "USD", balance_minor: 100 }),
      account({ id: "a2", currency: "JPY", balance_minor: 100 }),
    ];

    const totals = balancesByCurrency(accounts);
    expect(totals.USD).toBe(100);
    expect(totals.JPY).toBe(100);
    expect(Object.keys(totals)).toHaveLength(2);
  });

  it("returns an empty object for no accounts", () => {
    expect(balancesByCurrency([])).toEqual({});
  });

  it("handles a negative total (overdrawn currency)", () => {
    const accounts = [account({ currency: "USD", balance_minor: -5000 })];
    expect(balancesByCurrency(accounts)).toEqual({ USD: -5000 });
  });
});

describe("assetValuesByCurrency", () => {
  it("sums current_value_minor grouped by currency", () => {
    const assets = [
      asset({ id: "s1", currency: "USD", current_value_minor: 5000000 }),
      asset({ id: "s2", currency: "USD", current_value_minor: 1000000 }),
      asset({ id: "s3", currency: "EUR", current_value_minor: 200000 }),
    ];

    expect(assetValuesByCurrency(assets)).toEqual({ USD: 6000000, EUR: 200000 });
  });

  it("skips an asset with no valuation yet (null current_value_minor)", () => {
    const assets = [asset({ currency: "USD", current_value_minor: null })];
    expect(assetValuesByCurrency(assets)).toEqual({});
  });
});

describe("portfolioValuesByCurrency", () => {
  it("sums portfolio value_minor grouped by currency", () => {
    const portfolios = [
      portfolio({ currency: "USD", value_minor: 2000000 }),
      portfolio({ currency: "USD", value_minor: 500000 }),
      portfolio({ currency: "EUR", value_minor: 100000 }),
    ];

    expect(portfolioValuesByCurrency(portfolios)).toEqual({ USD: 2500000, EUR: 100000 });
  });

  it("returns an empty object for no portfolios", () => {
    expect(portfolioValuesByCurrency([])).toEqual({});
  });

  it("keeps a zero-value (empty) portfolio in its currency bucket", () => {
    // Unlike a null asset valuation (unknown → skipped), an empty portfolio's
    // value is a known 0, so it establishes its currency bucket at 0.
    expect(portfolioValuesByCurrency([portfolio({ currency: "GBP", value_minor: 0 })])).toEqual({
      GBP: 0,
    });
  });
});

describe("loanContributionsByCurrency", () => {
  it("subtracts a borrowed loan's remaining (a liability) and adds a lent loan's (a receivable)", () => {
    const loans = [
      loan({ currency: "USD", direction: "borrowed", remaining_minor: 1000000 }),
      loan({ currency: "USD", direction: "lent", remaining_minor: 300000 }),
    ];

    // -1,000,000 + 300,000 = -700,000
    expect(loanContributionsByCurrency(loans)).toEqual({ USD: -700000 });
  });

  it("keeps each loan in its own currency bucket, never summed across currencies", () => {
    const loans = [
      loan({ currency: "USD", direction: "borrowed", remaining_minor: 1000000 }),
      loan({ currency: "EUR", direction: "lent", remaining_minor: 500000 }),
    ];

    expect(loanContributionsByCurrency(loans)).toEqual({ USD: -1000000, EUR: 500000 });
  });

  it("returns an empty object for no loans", () => {
    expect(loanContributionsByCurrency([])).toEqual({});
  });

  it("skips a fully-paid loan (remaining_minor: 0) so it does not create a currency bucket", () => {
    const loans = [loan({ currency: "USD", direction: "borrowed", remaining_minor: 0 })];
    expect(loanContributionsByCurrency(loans)).toEqual({});
  });

  it("includes a partially-paid loan while skipping a fully-paid one in the same currency", () => {
    const loans = [
      loan({ currency: "USD", direction: "borrowed", remaining_minor: 1000000 }),
      loan({ currency: "USD", direction: "lent", remaining_minor: 0 }),
    ];
    expect(loanContributionsByCurrency(loans)).toEqual({ USD: -1000000 });
  });
});

describe("netWorthByCurrency", () => {
  it("combines account balances and asset values per currency", () => {
    const accounts = [account({ currency: "USD", balance_minor: 100000 })];
    const assets = [asset({ currency: "USD", current_value_minor: 5000000 })];

    expect(netWorthByCurrency(accounts, assets)).toEqual({ USD: 5100000 });
  });

  it("adds portfolio value as a third per-currency term", () => {
    const accounts = [account({ currency: "USD", balance_minor: 100000 })];
    const assets = [asset({ currency: "USD", current_value_minor: 5000000 })];
    const portfolios = [portfolio({ currency: "USD", value_minor: 2000000 })];

    expect(netWorthByCurrency(accounts, assets, portfolios)).toEqual({ USD: 7100000 });
  });

  it("keeps a portfolio in its own currency bucket, never summed across currencies", () => {
    const accounts = [account({ currency: "USD", balance_minor: 100000 })];
    const assets: AssetSummary[] = [];
    const portfolios = [
      portfolio({ currency: "USD", value_minor: 2000000 }),
      portfolio({ currency: "EUR", value_minor: 3000000 }),
    ];

    expect(netWorthByCurrency(accounts, assets, portfolios)).toEqual({
      USD: 2100000,
      EUR: 3000000,
    });
  });

  it("applies a borrowed loan as a NEGATIVE term (reduces net worth by its remaining)", () => {
    const accounts = [account({ currency: "USD", balance_minor: 5000000 })];
    const assets: AssetSummary[] = [];
    const loans = [loan({ currency: "USD", direction: "borrowed", remaining_minor: 1200000 })];

    // 5,000,000 − 1,200,000 = 3,800,000
    expect(netWorthByCurrency(accounts, assets, [], loans)).toEqual({ USD: 3800000 });
  });

  it("applies a lent loan as a POSITIVE term (adds its remaining as a receivable)", () => {
    const accounts = [account({ currency: "USD", balance_minor: 5000000 })];
    const assets: AssetSummary[] = [];
    const loans = [loan({ currency: "USD", direction: "lent", remaining_minor: 800000 })];

    // 5,000,000 + 800,000 = 5,800,000
    expect(netWorthByCurrency(accounts, assets, [], loans)).toEqual({ USD: 5800000 });
  });

  it("keeps a loan in its own currency bucket, never summed across currencies", () => {
    const accounts = [account({ currency: "USD", balance_minor: 5000000 })];
    const loans = [
      loan({ currency: "USD", direction: "borrowed", remaining_minor: 1000000 }),
      loan({ currency: "EUR", direction: "borrowed", remaining_minor: 2000000 }),
    ];

    expect(netWorthByCurrency(accounts, [], [], loans)).toEqual({
      USD: 4000000,
      EUR: -2000000,
    });
  });

  it("treats an omitted loans argument as no loans (unchanged result)", () => {
    const accounts = [account({ currency: "USD", balance_minor: 100000 })];
    const assets = [asset({ currency: "USD", current_value_minor: 5000000 })];
    const portfolios = [portfolio({ currency: "USD", value_minor: 2000000 })];

    // Same result with the loans argument omitted and passed as an empty array.
    expect(netWorthByCurrency(accounts, assets, portfolios)).toEqual(
      netWorthByCurrency(accounts, assets, portfolios, []),
    );
  });

  it("keeps currencies separate even when only one side has that currency", () => {
    const accounts = [account({ currency: "USD", balance_minor: 100000 })];
    const assets = [asset({ currency: "EUR", current_value_minor: 5000000 })];

    expect(netWorthByCurrency(accounts, assets)).toEqual({ USD: 100000, EUR: 5000000 });
  });

  it("excludes archived accounts and null-valuation assets", () => {
    const accounts = [
      account({ currency: "USD", balance_minor: 100000, archived_at: "2026-01-01T00:00:00Z" }),
    ];
    const assets = [asset({ currency: "USD", current_value_minor: null })];

    expect(netWorthByCurrency(accounts, assets)).toEqual({});
  });

  it("returns an empty object when there is no data at all", () => {
    expect(netWorthByCurrency([], [])).toEqual({});
  });

  it("treats an omitted portfolios argument as no portfolios (unchanged result)", () => {
    const accounts = [account({ currency: "USD", balance_minor: 100000 })];
    const assets = [asset({ currency: "USD", current_value_minor: 5000000 })];

    // Same result with the argument omitted and passed as an empty array.
    expect(netWorthByCurrency(accounts, assets)).toEqual(
      netWorthByCurrency(accounts, assets, []),
    );
  });

  it("excludes a fully-paid loan (remaining_minor: 0) so it does not create or change a currency bucket", () => {
    const accounts = [account({ currency: "USD", balance_minor: 100000 })];
    const loans = [loan({ currency: "USD", direction: "borrowed", remaining_minor: 0 })];

    // A fully-paid loan should not create a USD bucket or affect the net worth.
    expect(netWorthByCurrency(accounts, [], [], loans)).toEqual({ USD: 100000 });
  });

  it("includes a partially-paid loan while excluding a fully-paid one", () => {
    const accounts = [account({ currency: "USD", balance_minor: 5000000 })];
    const loans = [
      loan({ currency: "USD", direction: "borrowed", remaining_minor: 1000000 }),
      loan({ currency: "USD", direction: "borrowed", remaining_minor: 0 }),
    ];

    // 5,000,000 − 1,000,000 = 4,000,000; the fully-paid loan is skipped
    expect(netWorthByCurrency(accounts, [], [], loans)).toEqual({ USD: 4000000 });
  });
});

describe("selectPrimaryAccount", () => {
  it("picks the largest-balance non-archived account in the base currency", () => {
    const accounts = [
      account({ id: "a1", currency: "USD", balance_minor: 50000 }),
      account({ id: "a2", currency: "USD", balance_minor: 200000 }),
      account({ id: "a3", currency: "EUR", balance_minor: 900000 }),
    ];

    expect(selectPrimaryAccount(accounts, "USD")?.id).toBe("a2");
  });

  it("falls back to the largest account overall when none match the base currency", () => {
    const accounts = [
      account({ id: "a1", currency: "EUR", balance_minor: 50000 }),
      account({ id: "a2", currency: "GBP", balance_minor: 200000 }),
    ];

    expect(selectPrimaryAccount(accounts, "USD")?.id).toBe("a2");
  });

  it("ignores archived accounts", () => {
    const accounts = [
      account({ id: "a1", currency: "USD", balance_minor: 999999, archived_at: "2026-01-01T00:00:00Z" }),
      account({ id: "a2", currency: "USD", balance_minor: 100 }),
    ];

    expect(selectPrimaryAccount(accounts, "USD")?.id).toBe("a2");
  });

  it("returns null when there are no active accounts", () => {
    expect(selectPrimaryAccount([], "USD")).toBeNull();
    expect(
      selectPrimaryAccount(
        [account({ archived_at: "2026-01-01T00:00:00Z" })],
        "USD",
      ),
    ).toBeNull();
  });
});
