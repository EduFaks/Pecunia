import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import LoanForm from "./LoanForm";
import type { LoanOut } from "./useLoans";
import type { ContactOut } from "../contacts/useContacts";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const CREATED: LoanOut = {
  id: "l-new",
  name: "Loan to Alice",
  direction: "lent",
  principal_minor: 1_000_000,
  currency: "USD",
  interest_rate_bps: 500,
  planned_payment_minor: 20_000,
  payment_frequency: "monthly",
  next_due: null,
  opened_on: null,
  description: null,
  contact_id: null,
  is_demo: false,
  created_at: "2026-09-12T00:00:00Z",
  paid_total_minor: 0,
  remaining_minor: 1_000_000,
};

const ALICE: ContactOut = {
  id: "c-alice",
  name: "Alice",
  default_category_id: null,
  type: "person",
  avatar: null,
  archived_at: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
};

/** Serves the `ContactPicker`'s own `/contacts` + `/categories` reads and the
 * form's POST/PATCH — for the contact-field tests, which need real options to
 * pick from (the other tests' blanket `mockResolvedValue` suffices there). */
function installContactBackend(result: LoanOut) {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string }) => {
    const method = opts?.method ?? "GET";
    if (path.startsWith("/contacts?")) {
      return Promise.resolve({ items: [ALICE], next_cursor: null });
    }
    if (path.startsWith("/categories?")) {
      return Promise.resolve({ items: [], next_cursor: null });
    }
    if ((path === "/loans" && method === "POST") || (path.startsWith("/loans/") && method === "PATCH")) {
      return Promise.resolve(result);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderForm(props: Partial<React.ComponentProps<typeof LoanForm>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LoanForm onSuccess={props.onSuccess ?? (() => {})} {...props} />
    </QueryClientProvider>,
  );
}

describe("LoanForm", () => {
  beforeEach(() => {
    mockApiFetch.mockReset().mockResolvedValue(CREATED);
  });

  it("creates a loan with direction, principal, planned payment, and %→bps interest", async () => {
    const onSuccess = vi.fn();
    renderForm({ onSuccess, defaultCurrency: "USD" });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Loan to Alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Lent" }));
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Principal"), { target: { value: "10000" } });
    fireEvent.change(screen.getByLabelText("Interest rate"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Planned payment"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "monthly" } });

    fireEvent.click(screen.getByRole("button", { name: /create loan/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans", {
        method: "POST",
        json: {
          name: "Loan to Alice",
          direction: "lent",
          currency: "USD",
          principal_minor: 1_000_000,
          interest_rate_bps: 500, // 5% → 500 bps
          planned_payment_minor: 20_000, // $200.00
          payment_frequency: "monthly",
        },
      }),
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("omits the interest field when left blank (no rate set)", async () => {
    renderForm({ defaultCurrency: "USD" });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Car loan" } });
    fireEvent.change(screen.getByLabelText("Principal"), { target: { value: "25000" } });
    fireEvent.click(screen.getByRole("button", { name: /create loan/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans", {
        method: "POST",
        json: { name: "Car loan", direction: "borrowed", currency: "USD", principal_minor: 2_500_000 },
      }),
    );
  });

  it("submits the picked contact's id on create", async () => {
    installContactBackend(CREATED);
    renderForm({ defaultCurrency: "USD" });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Loan to Alice" } });
    fireEvent.change(screen.getByLabelText("Principal"), { target: { value: "10000" } });

    fireEvent.focus(await screen.findByLabelText("Contact"));
    fireEvent.click(await screen.findByRole("option", { name: /alice/i }));

    fireEvent.click(screen.getByRole("button", { name: /create loan/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/loans", {
        method: "POST",
        json: expect.objectContaining({ contact_id: "c-alice" }),
      }),
    );
  });

  it("clears a linked contact in edit mode (sends an explicit contact_id null)", async () => {
    const loan: LoanOut = { ...CREATED, contact_id: "c-alice" };
    installContactBackend(loan);
    renderForm({ loan });

    // The picker prefills with the linked contact's name once contacts load.
    const contactInput = await screen.findByLabelText("Contact");
    await waitFor(() => expect(contactInput).toHaveValue("Alice"));

    fireEvent.focus(contactInput);
    fireEvent.click(await screen.findByRole("option", { name: /no contact/i }));

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(`/loans/${loan.id}`, {
        method: "PATCH",
        json: expect.objectContaining({ contact_id: null }),
      }),
    );
  });

  it("prefills the interest rate as a percent (bps→%) in edit mode", () => {
    renderForm({
      loan: { ...CREATED, direction: "borrowed", interest_rate_bps: 425 },
    });

    // 425 bps → "4.25"
    expect(screen.getByLabelText("Interest rate")).toHaveValue("4.25");
    // Borrowed toggle is pressed in edit mode.
    expect(screen.getByRole("button", { name: "Borrowed" })).toHaveAttribute("aria-pressed", "true");
  });
});
