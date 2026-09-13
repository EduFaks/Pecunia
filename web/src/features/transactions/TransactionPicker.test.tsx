import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import TransactionPicker from "./TransactionPicker";
import type { TransactionOut } from "./useTransactions";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const HARDWARE: TransactionOut = {
  id: "tx1",
  account_id: "a1",
  category_id: null,
  contact_id: null,
  project_id: null,
  transfer_id: null,
  amount_minor: -240_000,
  currency: "USD",
  description: "Hardware store",
  occurred_on: "2026-02-01",
  is_demo: false,
  deleted_at: null,
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
};

const PAINT: TransactionOut = {
  ...HARDWARE,
  id: "tx2",
  amount_minor: -5_000,
  description: "Paint supplier",
};

function installBackend(transactions: TransactionOut[]) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path.startsWith("/transactions?")) {
      return Promise.resolve({ items: transactions, next_cursor: null });
    }
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: null });
    }
    return Promise.reject(new Error(`unexpected call: ${path}`));
  });
}

function renderPicker(transactions: TransactionOut[], onSelect = vi.fn()) {
  installBackend(transactions);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransactionPicker onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return { onSelect };
}

describe("TransactionPicker", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("lists the workspace's transactions", async () => {
    renderPicker([HARDWARE, PAINT]);

    expect(await screen.findByRole("option", { name: /hardware store/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /paint supplier/i })).toBeInTheDocument();
  });

  it("filters by description", async () => {
    renderPicker([HARDWARE, PAINT]);

    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "paint" } });

    expect(await screen.findByRole("option", { name: /paint supplier/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /hardware store/i })).not.toBeInTheDocument();
  });

  it("filters by amount", async () => {
    renderPicker([HARDWARE, PAINT]);

    // 50.00 (the paint) but not 2,400.00 (the hardware).
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "50" } });

    expect(await screen.findByRole("option", { name: /paint supplier/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /hardware store/i })).not.toBeInTheDocument();
  });

  it("calls onSelect with the picked transaction", async () => {
    const { onSelect } = renderPicker([HARDWARE, PAINT]);

    fireEvent.click(await screen.findByRole("option", { name: /hardware store/i }));

    expect(onSelect).toHaveBeenCalledWith(HARDWARE);
  });
});
