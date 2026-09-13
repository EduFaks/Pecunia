import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import TransactionsScreen from "../transactions/TransactionsScreen";
import AccountsScreen from "./AccountsScreen";
import type { AccountOut } from "./useAccounts";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const ACTIVE: AccountOut = {
  id: "a1",
  name: "Everyday checking",
  type: "checking",
  currency: "USD",
  initial_balance_minor: 0,
  balance_minor: 150000,
  is_demo: false,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const ARCHIVED: AccountOut = {
  id: "a2",
  name: "Old savings",
  type: "savings",
  currency: "USD",
  initial_balance_minor: 0,
  balance_minor: 42000,
  is_demo: false,
  archived_at: "2026-06-01T00:00:00Z",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
};

function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string }) => {
    const method = opts?.method ?? "GET";
    if (path.startsWith("/accounts?") && method === "GET") {
      const includeArchived = path.includes("include_archived=true");
      const items = includeArchived ? [ACTIVE, ARCHIVED] : [ACTIVE];
      return Promise.resolve({ items, next_cursor: null });
    }
    if (path.startsWith("/transactions?") && method === "GET") {
      return Promise.resolve({ items: [], next_cursor: null });
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderWithClient(ui: ReactElement, queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/**
 * Regression test for the cache-key collision that crashed `AccountsScreen`
 * after visiting `/transactions`: `TransactionsScreen` calls the FLAT
 * `useAccounts(true)` (a plain `useQuery`) to populate its account filter,
 * and `AccountsScreen`'s `DataList` reads the exact same `includeArchived`
 * filter through `useInfiniteQuery` — before the fix, both lived under the
 * identical `[...qk.accounts, {includeArchived}]` key. Once the flat query
 * populated that cache slot with a plain `{items, next_cursor}` payload,
 * `DataList`'s `useInfiniteQuery` read it as if it were an already-paginated
 * `{pages, pageParams}` result and its render (`query.data?.pages.flatMap`)
 * threw on the missing `.pages`, crashing the whole tree (no error boundary
 * caught it).
 *
 * Every other test in this codebase mints a fresh `QueryClient` per test
 * (see `AccountsScreen.test.tsx`/`TransactionsScreen.test.tsx`), so none of
 * them could ever observe this — their queries never shared a cache. This
 * test deliberately shares ONE `QueryClient` across both screens, mounted in
 * the same sequence that broke in the app: transactions first (seeding the
 * flat, `includeArchived: true` cache entry), accounts second, then toggling
 * "Show archived" to select that exact same filter variant.
 */
describe("accounts/transactions cache-key isolation", () => {
  it("does not crash AccountsScreen after TransactionsScreen has populated the flat account list under the same includeArchived filter", async () => {
    installFakeBackend();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // Visit /transactions first — `useAccounts(true)` fetches and caches the
    // full (active + archived) flat account list for the filter Select.
    const { unmount } = renderWithClient(<TransactionsScreen />, queryClient);
    await screen.findByRole("option", { name: "Everyday checking" });
    await screen.findByRole("option", { name: "Old savings" });
    unmount();

    // Now visit /accounts with the SAME QueryClient and toggle "Show
    // archived" — this flips AccountsScreen's DataList to the exact same
    // includeArchived: true variant already cached above.
    renderWithClient(<AccountsScreen />, queryClient);
    expect(await screen.findByText("Everyday checking")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/show archived/i));

    // Before the fix, DataList's useInfiniteQuery reads the flat payload
    // cached above under the identical key and throws while rendering it —
    // these assertions are never reached without the key-suffix fix.
    expect(await screen.findByText("Old savings")).toBeInTheDocument();
    expect(screen.getByText("Everyday checking")).toBeInTheDocument();
  });
});
