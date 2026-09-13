import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import AuditLogPanel from "./AuditLogPanel";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const PREFERENCES = {
  base_currency: "USD",
  locale: "en-US",
  date_format: "MM/DD/YYYY",
  number_format: "1,234.56",
  timezone: "UTC",
  first_day_of_week: "monday",
};

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(qk.me, { user: null, preferences: PREFERENCES });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const EVENT_1 = {
  id: 1,
  occurred_at: new Date().toISOString(),
  actor_user_id: "u1",
  action: "account.created",
  resource_type: "account",
  resource_id: "a1",
  ip: "127.0.0.1",
  user_agent: "test-agent",
  metadata: { note: "seeded" },
  before: null,
  after: { name: "Checking" },
};

const EVENT_2 = {
  id: 2,
  occurred_at: new Date().toISOString(),
  actor_user_id: "u1",
  action: "transaction.updated",
  resource_type: "transaction",
  resource_id: "t1",
  ip: "127.0.0.1",
  user_agent: "test-agent",
  metadata: null,
  before: { amount_minor: -100 },
  after: { amount_minor: -200 },
};

/** Routes `apiFetch` by path/query so `/auth/me` (from `usePreferences`) and
 * `/audit-events` (under test, with varying filters/cursor) can both
 * resolve within the same test — see `ActivityScreen.test.tsx` for the same
 * pattern and why a `mockResolvedValueOnce` chain doesn't work here. */
function installFakeBackend(handler: (path: string) => unknown) {
  mockApiFetch.mockReset().mockImplementation((path: unknown) => {
    const p = String(path);
    if (p.startsWith("/auth/me")) {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    const result = handler(p);
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve(result);
  });
}

describe("AuditLogPanel", () => {
  it("lists audit events grouped by day", async () => {
    installFakeBackend((p) => (p.startsWith("/audit-events") ? { items: [EVENT_1, EVENT_2], next_cursor: null } : new Error(p)));

    renderWithProviders(<AuditLogPanel />);

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Account created · Account")).toBeInTheDocument();
    expect(screen.getByText("Transaction updated · Transaction")).toBeInTheDocument();
  });

  it("applies the action/resource-type/date filters to the query", async () => {
    installFakeBackend((p) => (p.startsWith("/audit-events") ? { items: [EVENT_1], next_cursor: null } : new Error(p)));

    renderWithProviders(<AuditLogPanel />);
    await screen.findByText("Account created · Account");

    fireEvent.change(screen.getByLabelText(/action/i), { target: { value: "account.created" } });
    fireEvent.change(screen.getByLabelText(/resource type/i), { target: { value: "account" } });
    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: "2026-09-11" } });

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\/audit-events\?.*action=account\.created.*resource_type=account.*since=2026-09-01.*until=2026-09-11|^\/audit-events\?.*resource_type=account.*action=account\.created.*since=2026-09-01.*until=2026-09-11/,
        ),
      ),
    );
  });

  it("expands a row to show its before/after and metadata detail", async () => {
    installFakeBackend((p) => (p.startsWith("/audit-events") ? { items: [EVENT_2], next_cursor: null } : new Error(p)));

    renderWithProviders(<AuditLogPanel />);
    const row = await screen.findByRole("button", { name: /Transaction updated/i });

    expect(screen.queryByText(/"amount_minor"/)).not.toBeInTheDocument();
    fireEvent.click(row);

    expect(screen.getByText(/"amount_minor": -100/)).toBeInTheDocument();
    expect(screen.getByText(/"amount_minor": -200/)).toBeInTheDocument();
  });

  it("paginates via the keyset cursor on 'Load more'", async () => {
    installFakeBackend((p) => {
      if (!p.startsWith("/audit-events")) return new Error(p);
      if (p.includes("cursor=")) return { items: [EVENT_2], next_cursor: null };
      return { items: [EVENT_1], next_cursor: "5" };
    });

    renderWithProviders(<AuditLogPanel />);
    const loadMore = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);

    expect(await screen.findByText("Transaction updated · Transaction")).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringMatching(/cursor=5/));
  });

  it("shows a friendly message instead of an error when a non-owner is refused (403 NOT_OWNER)", async () => {
    const { ApiError } = await import("../../lib/api");
    installFakeBackend((p) => (p.startsWith("/audit-events") ? new ApiError(403, "NOT_OWNER") : new Error(p)));

    renderWithProviders(<AuditLogPanel />);

    expect(await screen.findByText(/only the instance owner can view the audit log/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
