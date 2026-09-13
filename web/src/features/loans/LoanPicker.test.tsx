import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import LoanPicker from "./LoanPicker";
import type { LoanOut } from "./useLoans";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const CAR_LOAN: LoanOut = {
  id: "l1",
  name: "Car loan",
  direction: "borrowed",
  principal_minor: 2_500_000,
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
  paid_total_minor: 135_000,
  remaining_minor: 2_365_000,
};

const STUDENT_LOAN: LoanOut = {
  ...CAR_LOAN,
  id: "l2",
  name: "Student loan",
  remaining_minor: 1_000_000,
};

/** A fully-paid loan (remaining 0) — "not active", so it must not appear. */
const SETTLED_LOAN: LoanOut = {
  ...CAR_LOAN,
  id: "l3",
  name: "Settled loan",
  remaining_minor: 0,
};

function installFakeBackend(loans: LoanOut[]) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path.startsWith("/loans?")) {
      return Promise.resolve({ items: loans, next_cursor: null });
    }
    return Promise.reject(new Error(`unexpected call: ${path}`));
  });
}

function renderPicker(onSelect = vi.fn()) {
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
  render(
    <QueryClientProvider client={queryClient}>
      <LoanPicker onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return { onSelect };
}

describe("LoanPicker", () => {
  beforeEach(() => {
    installFakeBackend([CAR_LOAN, STUDENT_LOAN, SETTLED_LOAN]);
  });

  it("lists active loans (remaining > 0) and fires onSelect with the picked loan", async () => {
    const { onSelect } = renderPicker();

    const option = await screen.findByText("Car loan");
    // A settled loan (remaining 0) is not offered.
    expect(screen.queryByText("Settled loan")).not.toBeInTheDocument();

    fireEvent.click(option);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "l1" })));
  });

  it("filters loans by name as the user types", async () => {
    renderPicker();
    await screen.findByText("Car loan");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "student" } });

    expect(await screen.findByText("Student loan")).toBeInTheDocument();
    expect(screen.queryByText("Car loan")).not.toBeInTheDocument();
  });
});
