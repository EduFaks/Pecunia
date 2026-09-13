import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import AccountsScreen from "./AccountsScreen";
import type { AccountOut } from "./useAccounts";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

let accounts: AccountOut[];
let nextId: number;

function seedAccounts(seed: AccountOut[]) {
  // Clone each fixture rather than aliasing it: the fake archive handler
  // below mutates `archived_at` in place, and without cloning that would
  // permanently mutate the shared `CHECKING` const across later tests.
  accounts = seed.map((account) => ({ ...account }));
  nextId = seed.length + 1;
}

/** A tiny stateful fake of the `/accounts` API — real enough that create
 * (POST) then list (GET, refetched after `useCreateAccount`'s invalidation)
 * demonstrates the round trip end to end, same for archive. */
function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path.startsWith("/accounts?") && method === "GET") {
      const includeArchived = path.includes("include_archived=true");
      const items = accounts.filter((a) => includeArchived || a.archived_at === null);
      return Promise.resolve({ items, next_cursor: null });
    }
    if (path === "/accounts" && method === "POST") {
      const body = opts?.json as { name: string; type: string; currency: string; initial_balance_minor?: number };
      const created: AccountOut = {
        id: `a${nextId++}`,
        name: body.name,
        type: body.type as AccountOut["type"],
        currency: body.currency,
        initial_balance_minor: body.initial_balance_minor ?? 0,
        balance_minor: body.initial_balance_minor ?? 0,
        is_demo: false,
        archived_at: null,
        created_at: "2026-09-11T00:00:00Z",
        updated_at: "2026-09-11T00:00:00Z",
      };
      accounts.push(created);
      return Promise.resolve(created);
    }
    const archiveMatch = /^\/accounts\/([^/]+)\/archive$/.exec(path);
    if (archiveMatch && method === "POST") {
      const account = accounts.find((a) => a.id === archiveMatch[1]);
      if (account) {
        account.archived_at = "2026-09-11T00:00:00Z";
      }
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
        <MemoryRouter
          initialEntries={["/accounts"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/accounts" element={<AccountsScreen />} />
            <Route path="/accounts/:id" element={<div>Account detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// Name deliberately distinct from its humanized type label ("Checking") so
// queries for one don't accidentally match the other.
const CHECKING: AccountOut = {
  id: "a1",
  name: "Everyday",
  type: "checking",
  currency: "USD",
  initial_balance_minor: 0,
  balance_minor: 150000,
  is_demo: false,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("AccountsScreen", () => {
  beforeEach(() => {
    seedAccounts([]);
    installFakeBackend();
  });

  it("shows a guiding empty state on a fresh workspace", async () => {
    renderScreen();
    expect(await screen.findByText(/no accounts yet/i)).toBeInTheDocument();
  });

  it("lists accounts with name, type, and balance", async () => {
    seedAccounts([CHECKING]);
    renderScreen();

    expect(await screen.findByText("Everyday")).toBeInTheDocument();
    expect(screen.getByText("Checking")).toBeInTheDocument(); // humanized type label
    expect(screen.getByText(/1,500\.00/)).toBeInTheDocument();
  });

  it("creates an account with the posted fields and shows it in the list", async () => {
    renderScreen();
    await screen.findByText(/no accounts yet/i);

    fireEvent.click(screen.getAllByRole("button", { name: /new account|add your first account/i })[0]);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Everyday checking" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "checking" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });

    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/accounts", {
        method: "POST",
        json: { name: "Everyday checking", type: "checking", currency: "USD" },
      }),
    );

    expect(await screen.findByText("Everyday checking")).toBeInTheDocument();
  });

  it("archiving an account removes it from the default (non-archived) list", async () => {
    seedAccounts([CHECKING]);
    renderScreen();

    const row = (await screen.findByText("Everyday")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /archive/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/accounts/a1/archive", { method: "POST" }),
    );
    await waitFor(() => expect(screen.queryByText("Everyday")).not.toBeInTheDocument());
  });

  it("shows archived accounts again once the toggle is checked", async () => {
    seedAccounts([{ ...CHECKING, archived_at: "2026-09-01T00:00:00Z" }]);
    renderScreen();

    expect(await screen.findByText(/no accounts yet/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/show archived/i));

    expect(await screen.findByText("Everyday")).toBeInTheDocument();
  });

  it("navigates to the account detail screen when a row is clicked", async () => {
    seedAccounts([CHECKING]);
    renderScreen();

    fireEvent.click(await screen.findByText("Everyday"));

    expect(await screen.findByText("Account detail screen")).toBeInTheDocument();
  });
});
