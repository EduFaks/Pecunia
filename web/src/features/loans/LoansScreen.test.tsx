import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import { qk } from "../../lib/queries";
import LoansScreen from "./LoansScreen";
import type { LoanOut } from "./useLoans";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

let loans: LoanOut[];
let nextId: number;

function seedLoans(seed: LoanOut[]) {
  loans = seed.map((l) => ({ ...l }));
  nextId = seed.length + 1;
}

function installFakeBackend() {
  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      const method = opts?.method ?? "GET";

      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: null });
      }
      // The form's `ContactPicker` fetches both of these on its own.
      if (path.startsWith("/contacts?") || path.startsWith("/categories?")) {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      if (path.startsWith("/loans?") && method === "GET") {
        return Promise.resolve({ items: loans, next_cursor: null });
      }
      if (path === "/loans" && method === "POST") {
        const body = opts?.json as { name: string; direction: string; principal_minor: number; currency: string };
        const created: LoanOut = {
          id: `l${nextId++}`,
          name: body.name,
          direction: body.direction as LoanOut["direction"],
          principal_minor: body.principal_minor,
          currency: body.currency,
          interest_rate_bps: null,
          planned_payment_minor: null,
          payment_frequency: null,
          next_due: null,
          opened_on: null,
          description: null,
          contact_id: null,
          is_demo: false,
          created_at: "2026-09-12T00:00:00Z",
          paid_total_minor: 0,
          remaining_minor: body.principal_minor,
        };
        loans.push(created);
        return Promise.resolve(created);
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
}

function renderScreen() {
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
          initialEntries={["/loans"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/loans" element={<LoansScreen />} />
            <Route path="/loans/:id" element={<div>Loan detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const CAR_LOAN: LoanOut = {
  id: "l1",
  name: "Car loan",
  direction: "borrowed",
  principal_minor: 2_500_000, // $25,000.00
  currency: "USD",
  interest_rate_bps: 425,
  planned_payment_minor: 45_000,
  payment_frequency: "monthly",
  next_due: "2026-10-01",
  opened_on: "2025-01-01",
  description: null,
  contact_id: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  paid_total_minor: 500_000, // $5,000.00 → 20%
  remaining_minor: 2_000_000, // $20,000.00
};

describe("LoansScreen", () => {
  beforeEach(() => {
    seedLoans([]);
    installFakeBackend();
  });

  it("shows a guiding empty state on a fresh workspace", async () => {
    renderScreen();
    expect(await screen.findByText(/no loans yet/i)).toBeInTheDocument();
  });

  it("lists loans with direction, remaining, and a payoff progress bar", async () => {
    seedLoans([CAR_LOAN]);
    renderScreen();

    const row = (await screen.findByText("Car loan")).closest("li")!;
    expect(within(row).getByText("Borrowed")).toBeInTheDocument();
    // remaining_minor 2_000_000 → $20,000.00
    expect(within(row).getByText(/20,000\.00/)).toBeInTheDocument();
    // payoff bar at 500,000 / 2,500,000 = 20%
    const bar = screen.getByRole("progressbar", { name: /payoff progress/i });
    expect(bar).toHaveAttribute("aria-valuenow", "20");
  });

  it("shows Owed and To collect, split by direction and currency (never combined)", async () => {
    const RECEIVABLE: LoanOut = {
      id: "l2",
      name: "Loaned to a friend",
      direction: "lent",
      principal_minor: 500_000, // $5,000.00
      currency: "USD",
      interest_rate_bps: null,
      planned_payment_minor: null,
      payment_frequency: null,
      next_due: null,
      opened_on: null,
      description: null,
      contact_id: null,
      is_demo: false,
      created_at: "2026-01-01T00:00:00Z",
      paid_total_minor: 100_000,
      remaining_minor: 400_000, // $4,000.00
    };
    seedLoans([CAR_LOAN, RECEIVABLE]);
    renderScreen();

    await screen.findByText("Car loan");

    const owedBlock = screen.getByText("Owed").parentElement!;
    // Only CAR_LOAN is borrowed: remaining_minor 2_000_000 -> $20,000.00
    expect(within(owedBlock).getByText(/20,000\.00/)).toBeInTheDocument();

    const toCollectBlock = screen.getByText("To collect").parentElement!;
    // Only RECEIVABLE is lent: remaining_minor 400_000 -> $4,000.00
    expect(within(toCollectBlock).getByText(/4,000\.00/)).toBeInTheDocument();

    // No combined-across-direction total — summing "owed" and "to collect"
    // together would be meaningless (they're opposite obligations).
    expect(screen.queryByText(/total remaining/i)).not.toBeInTheDocument();
  });

  it("creates a loan with the posted fields and shows it in the list", async () => {
    renderScreen();
    await screen.findByText(/no loans yet/i);

    fireEvent.click(screen.getAllByRole("button", { name: /new loan|add your first loan/i })[0]);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Student loan" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Principal"), { target: { value: "10000" } });

    fireEvent.click(screen.getByRole("button", { name: /create loan/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans", {
        method: "POST",
        json: { name: "Student loan", direction: "borrowed", currency: "USD", principal_minor: 1_000_000 },
      }),
    );
    expect(await screen.findByText("Student loan")).toBeInTheDocument();
  });

  it("navigates to the loan detail screen when a row is clicked", async () => {
    seedLoans([CAR_LOAN]);
    renderScreen();

    fireEvent.click(await screen.findByText("Car loan"));

    expect(await screen.findByText("Loan detail screen")).toBeInTheDocument();
  });
});
