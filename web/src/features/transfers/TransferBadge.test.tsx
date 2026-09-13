import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import TransferBadge from "./TransferBadge";
import type { TransferOut } from "./useTransfers";

const TRANSFER: TransferOut = {
  id: "tr1",
  from_account_id: "a1",
  to_account_id: "a2",
  amount_minor: 5000,
  currency: "USD",
  description: "Move to savings",
  occurred_on: "2026-09-11",
  is_demo: false,
  created_at: "2026-09-11T00:00:00Z",
};

const accountName = (id: string) => ({ a1: "Checking", a2: "Savings" })[id] ?? "Unknown account";

describe("TransferBadge", () => {
  it("labels a negative (outflow) leg as a transfer TO the destination account", () => {
    render(<TransferBadge amountMinor={-5000} transfer={TRANSFER} accountName={accountName} />);
    expect(screen.getByText("Transfer to Savings")).toBeInTheDocument();
  });

  it("labels a positive (inflow) leg as a transfer FROM the source account", () => {
    render(<TransferBadge amountMinor={5000} transfer={TRANSFER} accountName={accountName} />);
    expect(screen.getByText("Transfer from Checking")).toBeInTheDocument();
  });

  it("falls back to a plain label with direction when the transfer isn't resolvable yet", () => {
    render(<TransferBadge amountMinor={-5000} transfer={null} accountName={accountName} />);
    expect(screen.getByText(/transfer/i)).toBeInTheDocument();
  });
});
