import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../../lib/api";
import ScheduleForm from "./ScheduleForm";
import type { ScheduleFormProps } from "./ScheduleForm";
import type { AccountOut } from "../accounts/useAccounts";
import type { CategoryOut } from "../categories/useCategories";
import type { ContactOut } from "../contacts/useContacts";
import type { ScheduledTransactionOut } from "./usePlanned";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const CHECKING: AccountOut = {
  id: "a1",
  name: "Checking",
  type: "checking",
  currency: "USD",
  initial_balance_minor: 0,
  balance_minor: 150000,
  is_demo: false,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const RENT_CATEGORY: CategoryOut = {
  id: "c-rent",
  name: "Rent",
  kind: "expense",
  color: "#8a8578",
  icon: null,
  archived_at: null,
  is_demo: false,
};

const SCHEDULE: ScheduledTransactionOut = {
  id: "s1",
  account_id: "a1",
  category_id: "c-rent",
  contact_id: "p-landlord",
  amount_minor: -120000,
  currency: "USD",
  description: "Rent",
  frequency: "monthly",
  interval_count: 1,
  next_due: "2026-10-01",
  end_date: null,
  is_active: true,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

/** Routes the pickers' own reads to fixed lists and everything else to
 * `handler` — ScheduleForm always mounts a `CategoryPicker` and `ContactPicker`
 * that each fetch their own data. */
function installBackend(
  handler: (path: string, opts?: { method?: string; json?: unknown }) => Promise<unknown>,
  categories: CategoryOut[] = [RENT_CATEGORY],
  contacts: ContactOut[] = [],
) {
  mockApiFetch.mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    if (path.startsWith("/categories?")) {
      return Promise.resolve({ items: categories, next_cursor: null });
    }
    if (path.startsWith("/contacts?")) {
      return Promise.resolve({ items: contacts, next_cursor: null });
    }
    return handler(path, opts);
  });
}

function renderForm(props: Partial<ScheduleFormProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSuccess = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleForm accounts={[CHECKING]} onSuccess={onSuccess} {...props} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

describe("ScheduleForm — create", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts a new schedule with account, amount, frequency, and next_due (expense → negative)", async () => {
    installBackend(() => Promise.resolve(SCHEDULE));
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "a1" } });
    // Expense is the default direction.
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1200" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Rent" } });
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "monthly" } });
    fireEvent.change(screen.getByLabelText("Next due"), { target: { value: "2026-10-01" } });

    fireEvent.click(screen.getByRole("button", { name: /create schedule/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/planned", {
        method: "POST",
        json: {
          account_id: "a1",
          category_id: null,
          contact_id: null,
          amount_minor: -120000,
          currency: "USD",
          description: "Rent",
          frequency: "monthly",
          interval_count: 1,
          next_due: "2026-10-01",
          end_date: null,
        },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(SCHEDULE));
  });

  it("posts a positive amount_minor when the income direction is selected", async () => {
    installBackend(() => Promise.resolve(SCHEDULE));
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: /^income$/i }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Salary" } });
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "monthly" } });
    fireEvent.change(screen.getByLabelText("Next due"), { target: { value: "2026-10-01" } });

    fireEvent.click(screen.getByRole("button", { name: /create schedule/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/planned",
        expect.objectContaining({ json: expect.objectContaining({ amount_minor: 500000 }) }),
      ),
    );
  });

  it("sends interval_count > 1 when a repeat interval is entered", async () => {
    installBackend(() => Promise.resolve(SCHEDULE));
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Fortnightly" } });
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "weekly" } });
    fireEvent.change(screen.getByLabelText(/repeat every/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Next due"), { target: { value: "2026-10-01" } });

    fireEvent.click(screen.getByRole("button", { name: /create schedule/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/planned",
        expect.objectContaining({
          json: expect.objectContaining({ frequency: "weekly", interval_count: 2 }),
        }),
      ),
    );
  });

  it("surfaces a friendly message on a zero-amount rejection (422)", async () => {
    installBackend(() => Promise.reject(new ApiError(422, "SCHEDULE_ZERO_AMOUNT")));
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Nothing" } });
    fireEvent.change(screen.getByLabelText("Next due"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: /create schedule/i }));

    expect(await screen.findByText(/can't be zero|amount/i)).toBeInTheDocument();
  });

  it("shows a friendly error when the account can't be found (404)", async () => {
    installBackend(() => Promise.reject(new ApiError(404, "ACCOUNT_NOT_FOUND")));
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText("Next due"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: /create schedule/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/account/i);
  });
});

describe("ScheduleForm — edit", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("prefills the expense direction, absolute amount, frequency, and dates from an existing schedule", async () => {
    installBackend(() => Promise.reject(new Error("unexpected call")));
    renderForm({ schedule: SCHEDULE });

    expect(screen.getByLabelText("Amount")).toHaveValue("1200.00");
    expect(screen.getByRole("button", { name: /^expense$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Description")).toHaveValue("Rent");
    expect(screen.getByLabelText("Frequency")).toHaveValue("monthly");
    expect(screen.getByLabelText("Next due")).toHaveValue("2026-10-01");
  });

  it("patches only via PATCH on save", async () => {
    installBackend(() => Promise.resolve({ ...SCHEDULE, amount_minor: -130000 }));
    renderForm({ schedule: SCHEDULE });

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1300" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/planned/s1",
        expect.objectContaining({
          method: "PATCH",
          json: expect.objectContaining({ amount_minor: -130000 }),
        }),
      ),
    );
  });
});
