import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import { qk } from "../../lib/queries";
import LoanDetail from "./LoanDetail";
import type { LoanOut, LoanPaymentOut } from "./useLoans";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const LOAN: LoanOut = {
  id: "l1",
  name: "Car loan",
  direction: "borrowed",
  principal_minor: 2_500_000, // $25,000.00
  currency: "USD",
  interest_rate_bps: 425, // 4.25%
  planned_payment_minor: 45_000, // $450.00
  payment_frequency: "monthly",
  next_due: "2026-10-01",
  opened_on: "2025-01-01",
  description: "5-year auto loan",
  contact_id: null,
  // Distinct from every payment figure below so the hero remaining is
  // unambiguous under getByText.
  remaining_minor: 2_365_000, // $23,650.00
  paid_total_minor: 135_000,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
};

const LENDER_CONTACT = {
  id: "c-lender",
  name: "First National",
  default_category_id: null,
  type: "company",
  avatar: null,
  archived_at: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
};

const PAYMENT: LoanPaymentOut = {
  id: "lp1",
  loan_id: "l1",
  transaction_id: null,
  amount_minor: 45_000, // $450.00
  paid_on: "2026-09-01",
  note: "September payment",
  is_demo: false,
  created_at: "2026-09-01T00:00:00Z",
};

const LINKED_PAYMENT: LoanPaymentOut = {
  ...PAYMENT,
  id: "lp1",
  transaction_id: "tx1",
  note: "September payment",
};

const LINKED_TX = {
  id: "tx1",
  account_id: "a1",
  category_id: null,
  contact_id: null,
  project_id: null,
  transfer_id: null,
  amount_minor: -45_000,
  currency: "USD",
  description: "Auto-pay to lender",
  occurred_on: "2026-09-01",
  is_demo: false,
  deleted_at: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

function installFakeBackend(
  options: {
    loan?: LoanOut;
    payments?: LoanPaymentOut[];
    transactions?: unknown[];
    contacts?: unknown[];
  } = {},
) {
  const loan = { ...(options.loan ?? LOAN) };
  const payments = [...(options.payments ?? [])];
  const transactions = [...(options.transactions ?? [])];
  const contacts = [...(options.contacts ?? [])];

  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      const method = opts?.method ?? "GET";

      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: null });
      }
      if (path.startsWith("/contacts?") && method === "GET") {
        return Promise.resolve({ items: contacts, next_cursor: null });
      }
      if (path.startsWith("/transactions?") && method === "GET") {
        return Promise.resolve({ items: transactions, next_cursor: null });
      }
      if (path === "/loans/l1" && method === "GET") {
        return Promise.resolve({ ...loan });
      }
      if (path.startsWith("/loans/l1/payments?") && method === "GET") {
        return Promise.resolve({ items: payments, next_cursor: null });
      }
      if (path === "/loans/l1/payments" && method === "POST") {
        const body = opts?.json as { amount_minor: number; paid_on: string; note: string | null };
        const created: LoanPaymentOut = {
          id: "lp-new",
          loan_id: "l1",
          transaction_id: null,
          amount_minor: body.amount_minor,
          paid_on: body.paid_on,
          note: body.note,
          is_demo: false,
          created_at: "2026-09-15T00:00:00Z",
        };
        payments.push(created);
        return Promise.resolve(created);
      }
      const patchMatch = /^\/loans\/l1\/payments\/([^/]+)$/.exec(path);
      if (patchMatch && method === "PATCH") {
        const body = opts?.json as { transaction_id?: string | null };
        const payment = payments.find((p) => p.id === patchMatch[1]);
        if (payment && "transaction_id" in body) {
          payment.transaction_id = body.transaction_id ?? null;
        }
        return Promise.resolve({ ...payment });
      }
      if (path === "/loans/l1/payments/lp1" && method === "DELETE") {
        return Promise.resolve(undefined);
      }
      if (path === "/loans/l1" && method === "DELETE") {
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
}

function renderDetail() {
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
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={["/loans/l1"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/loans" element={<div>Loans list screen</div>} />
            <Route path="/loans/:id" element={<LoanDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("LoanDetail", () => {
  beforeEach(() => {
    installFakeBackend({ payments: [PAYMENT] });
  });

  it("shows the loan header (name, direction, hero remaining) and terms", async () => {
    renderDetail();

    const heading = await screen.findByRole("heading", { name: "Car loan" });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText("Borrowed")).toBeInTheDocument();
    // Hero remaining 2_365_000 → $23,650.00 (shown in the header hero and
    // echoed in the payoff bar's "remaining" caption).
    expect(screen.getAllByText(/23,650\.00/).length).toBeGreaterThan(0);
    // Interest rate 425 bps → 4.25%
    expect(screen.getByText(/4\.25%/)).toBeInTheDocument();
  });

  it("shows the linked contact as a badge in the terms grid", async () => {
    installFakeBackend({
      loan: { ...LOAN, contact_id: "c-lender" },
      payments: [],
      contacts: [LENDER_CONTACT],
    });
    renderDetail();

    await screen.findByRole("heading", { name: "Car loan" });
    expect(await screen.findByText("First National")).toBeInTheDocument();
  });

  it("lists payments with date, amount, and note", async () => {
    renderDetail();

    const row = (await screen.findByText("September payment")).closest("tr")!;
    // amount $450.00
    expect(within(row).getByText(/450\.00/)).toBeInTheDocument();
    expect(within(row).getByText(/09\/01\/2026/)).toBeInTheDocument();
  });

  it("shows a guiding empty state when the loan has no payments", async () => {
    installFakeBackend({ payments: [] });
    renderDetail();

    expect(await screen.findByText(/no payments yet/i)).toBeInTheDocument();
  });

  it("records a payment via the Record payment panel", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "Car loan" });

    fireEvent.click(screen.getByRole("button", { name: /record payment/i }));

    const paymentForm = screen.getByLabelText("Amount").closest("form")!;
    fireEvent.change(within(paymentForm).getByLabelText("Amount"), { target: { value: "500" } });
    fireEvent.change(within(paymentForm).getByLabelText("Date"), { target: { value: "2026-09-15" } });
    fireEvent.click(within(paymentForm).getByRole("button", { name: /record payment/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments", {
        method: "POST",
        json: { amount_minor: 50_000, paid_on: "2026-09-15", note: null },
      }),
    );
  });

  it("confirms before deleting a payment, then deletes on confirm", async () => {
    renderDetail();
    const row = (await screen.findByText("September payment")).closest("tr")!;

    fireEvent.click(within(row).getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName(/delete this payment\?/i);
    fireEvent.click(screen.getByRole("button", { name: "Delete payment" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments/lp1", { method: "DELETE" }),
    );
  });

  it("shows a payment's linked transaction with its description and an Unlink action", async () => {
    installFakeBackend({ payments: [LINKED_PAYMENT], transactions: [LINKED_TX] });
    renderDetail();

    const row = (await screen.findByText("September payment")).closest("tr")!;
    // The linked transaction's description surfaces in the payment row.
    expect(await within(row).findByText(/auto-pay to lender/i)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /unlink/i })).toBeInTheDocument();
  });

  it("unlinks a payment's transaction via a PATCH with transaction_id null", async () => {
    installFakeBackend({ payments: [LINKED_PAYMENT], transactions: [LINKED_TX] });
    renderDetail();

    const row = (await screen.findByText("September payment")).closest("tr")!;
    fireEvent.click(await within(row).findByRole("button", { name: /unlink/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments/lp1", {
        method: "PATCH",
        json: { transaction_id: null },
      }),
    );
  });

  it("confirms before deleting the loan, then deletes and navigates back", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "Car loan" });

    // The header's loan-level Delete (distinct from a payment row's Delete).
    // The heading sits in the header's text column; its parent is the flex row
    // that also holds the Edit/Delete button column.
    const header = screen.getByRole("heading", { name: "Car loan" }).closest("div")!.parentElement!;
    fireEvent.click(within(header).getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName('Delete "Car loan"?');
    fireEvent.click(screen.getByRole("button", { name: "Delete loan" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1", { method: "DELETE" }),
    );
    expect(await screen.findByText("Loans list screen")).toBeInTheDocument();
  });
});
