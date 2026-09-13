import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import PlannedScreen from "./PlannedScreen";
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
  name: "Housing",
  kind: "expense",
  color: "#8a8578",
  icon: null,
  archived_at: null,
  is_demo: false,
};

const LANDLORD: ContactOut = {
  id: "p-landlord",
  name: "Landlord",
  default_category_id: "c-rent",
  type: "person",
  avatar: null,
  archived_at: null,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
};

const SALARY: ScheduledTransactionOut = {
  id: "s-salary",
  account_id: "a1",
  category_id: null,
  contact_id: null,
  amount_minor: 500000,
  currency: "USD",
  description: "Salary",
  frequency: "monthly",
  interval_count: 1,
  next_due: "2026-09-25",
  end_date: null,
  is_active: true,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

const RENT: ScheduledTransactionOut = {
  id: "s-rent",
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

let schedules: ScheduledTransactionOut[];

function installBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";
    if (path.startsWith("/accounts?") && method === "GET") {
      return Promise.resolve({ items: [CHECKING], next_cursor: null });
    }
    if (path.startsWith("/categories?") && method === "GET") {
      return Promise.resolve({ items: [RENT_CATEGORY], next_cursor: null });
    }
    if (path.startsWith("/contacts?") && method === "GET") {
      return Promise.resolve({ items: [LANDLORD], next_cursor: null });
    }
    if (path.startsWith("/planned?") && method === "GET") {
      // Server returns soonest-first (next_due ASC).
      const items = [...schedules].sort((a, b) => a.next_due.localeCompare(b.next_due));
      return Promise.resolve({ items, next_cursor: null });
    }
    const postMatch = /^\/planned\/([^/]+)\/post$/.exec(path);
    if (postMatch && method === "POST") {
      return Promise.resolve({
        schedule: { ...RENT, next_due: "2026-11-01" },
        transaction: {},
      });
    }
    const skipMatch = /^\/planned\/([^/]+)\/skip$/.exec(path);
    if (skipMatch && method === "POST") {
      return Promise.resolve({ ...RENT, next_due: "2026-11-01" });
    }
    const patchMatch = /^\/planned\/([^/]+)$/.exec(path);
    if (patchMatch && method === "PATCH") {
      return Promise.resolve({ ...RENT, is_active: false });
    }
    if (patchMatch && method === "DELETE") {
      schedules = schedules.filter((s) => s.id !== patchMatch[1]);
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <PlannedScreen />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("PlannedScreen", () => {
  beforeEach(() => {
    schedules = [SALARY, RENT].map((s) => ({ ...s }));
    installBackend();
  });

  it("shows a guiding empty state when there are no schedules", async () => {
    schedules = [];
    installBackend();
    renderScreen();
    expect(await screen.findByText(/no planned/i)).toBeInTheDocument();
  });

  it("lists schedules soonest-first with their next-due date and frequency", async () => {
    renderScreen();

    const salary = await screen.findByText("Salary");
    const rent = await screen.findByText("Rent");
    // Salary is due 2026-09-25 (sooner) than Rent 2026-10-01.
    expect(salary.compareDocumentPosition(rent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getAllByText(/monthly/i).length).toBeGreaterThan(0);
    // The next-due date is shown (formatted from 2026-10-01).
    expect(screen.getAllByText(/next/i).length).toBeGreaterThan(0);
  });

  it("colors an expense schedule's amount negative", async () => {
    renderScreen();
    const amount = await screen.findByText("-$1,200.00");
    expect(amount.className).toMatch(/text-negative/);
  });

  it("shows the signed total upcoming across active schedules", async () => {
    renderScreen();
    await screen.findByText("Salary");

    // 500000 (Salary) - 120000 (Rent) = 380000 -> $3,800.00, colored positive
    // since active schedules net positive.
    const summaryBlock = screen.getByText("Total upcoming").parentElement!;
    const total = within(summaryBlock).getByText("$3,800.00");
    expect(total).toBeInTheDocument();
    expect(total.className).toMatch(/text-positive/);
  });

  it("excludes a paused schedule from the total upcoming", async () => {
    schedules = [SALARY, { ...RENT, is_active: false }];
    installBackend();
    renderScreen();
    await screen.findByText("Salary");

    // Only SALARY (active) counts: 500000 -> $5,000.00.
    const summaryBlock = screen.getByText("Total upcoming").parentElement!;
    expect(within(summaryBlock).getByText("$5,000.00")).toBeInTheDocument();
  });

  it("calls the post mutation when Post now is clicked", async () => {
    renderScreen();
    await screen.findByText("Rent");

    const rentRow = screen.getByText("Rent").closest("li")!;
    fireEvent.click(within(rentRow).getByRole("button", { name: /post now/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/planned/s-rent/post",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("calls the skip mutation when Skip is clicked", async () => {
    renderScreen();
    await screen.findByText("Rent");

    const rentRow = screen.getByText("Rent").closest("li")!;
    fireEvent.click(within(rentRow).getByRole("button", { name: /^skip$/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/planned/s-rent/skip",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("PATCHes is_active when the pause toggle is clicked", async () => {
    renderScreen();
    await screen.findByText("Rent");

    const rentRow = screen.getByText("Rent").closest("li")!;
    fireEvent.click(within(rentRow).getByRole("button", { name: /pause/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/planned/s-rent",
        expect.objectContaining({ method: "PATCH", json: { is_active: false } }),
      ),
    );
  });

  it("confirms via a dialog before deleting a schedule, then calls delete", async () => {
    renderScreen();
    await screen.findByText("Rent");

    const rentRow = screen.getByText("Rent").closest("li")!;
    fireEvent.click(within(rentRow).getByRole("button", { name: /delete/i }));

    // A confirmation dialog appears — nothing deleted yet.
    const dialog = await screen.findByRole("alertdialog");
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      "/planned/s-rent",
      expect.objectContaining({ method: "DELETE" }),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: /delete/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/planned/s-rent",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("marks a paused schedule with a paused indicator", async () => {
    schedules = [{ ...RENT, is_active: false }];
    installBackend();
    renderScreen();

    expect(await screen.findByText(/paused/i)).toBeInTheDocument();
    // A paused schedule can be resumed, not paused again.
    const rentRow = screen.getByText("Rent").closest("li")!;
    expect(within(rentRow).getByRole("button", { name: /resume/i })).toBeInTheDocument();
  });
});
