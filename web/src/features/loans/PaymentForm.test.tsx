import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import PaymentForm from "./PaymentForm";
import type { TransactionOut } from "../transactions/useTransactions";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const GROCERIES: TransactionOut = {
  id: "t1",
  account_id: "a1",
  category_id: null,
  contact_id: null,
  project_id: null,
  transfer_id: null,
  amount_minor: -8499,
  currency: "USD",
  description: "Card payment",
  occurred_on: "2026-09-10",
  is_demo: false,
  deleted_at: null,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

function installFakeBackend() {
  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      const method = opts?.method ?? "GET";
      if (path.startsWith("/transactions?") && method === "GET") {
        return Promise.resolve({ items: [GROCERIES], next_cursor: null });
      }
      if (path === "/loans/l1/payments" && method === "POST") {
        const body = opts?.json as Record<string, unknown>;
        return Promise.resolve({
          id: "lp-new",
          loan_id: "l1",
          transaction_id: body.transaction_id ?? null,
          amount_minor: body.amount_minor,
          paid_on: body.paid_on,
          note: body.note,
          is_demo: false,
          created_at: "2026-09-15T00:00:00Z",
        });
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
}

function renderForm() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(qk.me, {
    user: null,
    preferences: {
      base_currency: "USD",
      locale: "en-US",
      date_format: "MM/DD/YYYY",
      number_format: "1,234.56",
      timezone: "UTC",
      first_day_of_week: "monday",
    },
  });
  const onSuccess = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <PaymentForm loanId="l1" currency="USD" onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

describe("PaymentForm — link a transaction", () => {
  beforeEach(() => {
    installFakeBackend();
  });

  it("records a plain payment without a transaction_id in the payload", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-15" } });
    fireEvent.click(screen.getByRole("button", { name: /record payment/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments", {
        method: "POST",
        json: { amount_minor: 50_000, paid_on: "2026-09-15", note: null },
      }),
    );
  });

  it("sends the picked transaction's id when a transaction is linked", async () => {
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-15" } });

    // Reveal the transaction picker and pick the existing transaction.
    fireEvent.click(screen.getByRole("button", { name: /link a transaction/i }));
    const option = await screen.findByText("Card payment");
    fireEvent.click(option);

    fireEvent.click(screen.getByRole("button", { name: /record payment/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments", {
        method: "POST",
        json: { amount_minor: 50_000, paid_on: "2026-09-15", note: null, transaction_id: "t1" },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it("can remove a linked transaction before recording (back to no transaction_id)", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-15" } });

    fireEvent.click(screen.getByRole("button", { name: /link a transaction/i }));
    fireEvent.click(await screen.findByText("Card payment"));
    // The linked-transaction summary now offers a Remove affordance.
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    fireEvent.click(screen.getByRole("button", { name: /record payment/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments", {
        method: "POST",
        json: { amount_minor: 50_000, paid_on: "2026-09-15", note: null },
      }),
    );
  });
});
