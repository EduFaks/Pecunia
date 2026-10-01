import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import { qk } from "../../lib/queries";
import ConnectionsPanel from "./ConnectionsPanel";
import type { BankConnectionOut, BankLinkOut } from "./useBankSync";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const BANK_LINK_1: BankLinkOut = {
  id: "link1",
  account_id: "acct1",
  account_name: "Checking",
  account_currency: "USD",
  pluggy_account_id: "pluggy-1",
  sync_from: "2026-01-01",
  provider_balance_minor: 500_000, // $5,000.00
  provider_balance_as_of: "2026-09-30",
  derived_balance_minor: 500_000,
  credit_limit_minor: null,
  bill_close_date: null,
  bill_due_date: null,
};

const BANK_LINK_2: BankLinkOut = {
  id: "link2",
  account_id: "acct2",
  account_name: "Savings",
  account_currency: "USD",
  pluggy_account_id: "pluggy-2",
  sync_from: "2026-02-01",
  provider_balance_minor: 1_000_000, // $10,000.00
  provider_balance_as_of: "2026-09-30",
  derived_balance_minor: 900_000, // $9,000.00 — divergence
  credit_limit_minor: null,
  bill_close_date: null,
  bill_due_date: null,
};

const CONNECTION: BankConnectionOut = {
  id: "conn1",
  institution_name: "Banco do Brasil",
  status: "ok",
  last_error: null,
  last_synced_at: "2026-09-30T10:00:00Z",
  links: [BANK_LINK_1, BANK_LINK_2],
};

function installFakeBackend() {
  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      const method = opts?.method ?? "GET";

      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: null });
      }
      if (path.startsWith("/bank-sync/connections") && method === "GET") {
        return Promise.resolve([CONNECTION]);
      }
      if (path.startsWith("/bank-sync/sync") && method === "POST") {
        return Promise.resolve({
          connections: 1,
          created: 2,
          skipped: 0,
          errors: [],
        });
      }
      if (path.startsWith("/bank-sync/links/link2/reconcile") && method === "POST") {
        return Promise.resolve({
          id: "tx1",
          account_id: "acct2",
          description: "Reconcile transaction",
          amount_minor: 100_000,
          currency: "USD",
          date: "2026-09-30",
          type: "transfer",
          category_id: null,
          contact_id: null,
          is_demo: false,
          created_at: "2026-09-30T10:00:00Z",
        });
      }
      if (path.startsWith("/bank-sync/links/link2") && method === "DELETE") {
        return Promise.resolve(undefined);
      }
      if (path.startsWith("/bank-sync/connections/conn1") && method === "DELETE") {
        return Promise.resolve(undefined);
      }
      // CategoryMappingEditor now renders unconditionally beneath the
      // connections list, so every render needs these two endpoints too.
      if (path.startsWith("/bank-sync/category-mappings") && method === "GET") {
        return Promise.resolve([]);
      }
      if (path.startsWith("/categories") && method === "GET") {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      // LinkDialog is always mounted (controlled by its `open` prop), so its
      // queries need a backend too — gated by `enabled: open`, they must not
      // actually fire until the dialog is opened (see the dedicated test below).
      if (path.startsWith("/bank-sync/discovery") && method === "GET") {
        return Promise.resolve({ item_id: "item1", institution_name: "Mock Bank", status: "UPDATED", accounts: [] });
      }
      if (path.startsWith("/accounts") && method === "GET") {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
}

function renderPanel() {
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
        <ConnectionsPanel />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ConnectionsPanel", () => {
  beforeEach(() => {
    installFakeBackend();
  });

  it("renders a list of bank connections with their links", async () => {
    renderPanel();

    expect(await screen.findByText("Checking")).toBeInTheDocument();
    expect(screen.getByText("Savings")).toBeInTheDocument();
  });

  it("renders each connection's institution name so multiple banks are distinguishable", async () => {
    // Finding 12: `institution_name` was missing from `BankConnectionOut`
    // on the frontend, so with 2+ linked banks the cards were
    // indistinguishable (just "Connected" / "Error" repeated). Two
    // connections here, each with its own institution_name, must both be
    // visible on the page.
    const secondConnection: BankConnectionOut = {
      ...CONNECTION,
      id: "conn2",
      institution_name: "Nubank",
      links: [],
    };
    mockApiFetch.mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      const method = opts?.method ?? "GET";
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: null });
      }
      if (path.startsWith("/bank-sync/connections") && method === "GET") {
        return Promise.resolve([CONNECTION, secondConnection]);
      }
      if (path.startsWith("/bank-sync/category-mappings") && method === "GET") {
        return Promise.resolve([]);
      }
      if (path.startsWith("/categories") && method === "GET") {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      if (path.startsWith("/bank-sync/discovery") && method === "GET") {
        return Promise.resolve({ item_id: "item1", institution_name: "Mock Bank", status: "UPDATED", accounts: [] });
      }
      if (path.startsWith("/accounts") && method === "GET") {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });

    renderPanel();

    expect(await screen.findByText("Banco do Brasil")).toBeInTheDocument();
    expect(await screen.findByText("Nubank")).toBeInTheDocument();
  });

  it("uses the project's real semantic color tokens for connection status", async () => {
    // Finding 11: `text-emerald-12`/`text-coral-12` aren't tokens this
    // project defines (grep shows `text-positive`/`text-negative` used
    // everywhere else for this exact "good/bad" semantic) — a class that
    // doesn't exist renders as literally no color, so the "Connected"/
    // "Error" text is indistinguishable from any other muted label.
    renderPanel();

    const statusText = await screen.findByText("Connected");
    expect(statusText).toHaveClass("text-positive");
    expect(statusText.className).not.toMatch(/emerald|coral/);
  });

  it("shows a divergence badge only when provider and derived balances differ", async () => {
    renderPanel();

    const checkingRow = (await screen.findByText("Checking")).closest("li");
    expect(within(checkingRow!).queryByText(/divergence|mismatch/i)).not.toBeInTheDocument();

    const savingsRow = screen.getByText("Savings").closest("li");
    expect(within(savingsRow!).getByText(/divergence|mismatch/i)).toBeInTheDocument();
  });

  it("posts sync-now and toasts a summary", async () => {
    renderPanel();

    const syncButton = await screen.findByRole("button", { name: /sync now|sync/i });
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/bank-sync/sync", { method: "POST" });
    });

    // Toast should display the summary: 1 connection, 2 created, 0 skipped
    expect(await screen.findByText(/1.*connection|2.*created/i)).toBeInTheDocument();
  });

  it("confirms before reconciling a link", async () => {
    renderPanel();

    // Find reconcile button in the Savings row (which has divergence)
    const savingsRow = (await screen.findByText("Savings")).closest("li");
    const reconcileButton = within(savingsRow!).getByRole("button", { name: /reconcile/i });
    fireEvent.click(reconcileButton);

    // Confirm dialog should appear - find the confirm button in the dialog
    const confirmDialog = await screen.findByRole("alertdialog");
    const confirmButton = within(confirmDialog).getByRole("button", { name: /reconcile/i });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/bank-sync/links/link2/reconcile", {
        method: "POST",
      });
    });

    expect(await screen.findByText(/reconciled|success/i)).toBeInTheDocument();
  });

  it("unlinks a connection", async () => {
    renderPanel();

    // Find the unlink button for Checking link (using within to scope)
    const checkingRow = (await screen.findByText("Checking")).closest("li");
    const unlinkButton = within(checkingRow!).getByRole("button", { name: /unlink/i });
    fireEvent.click(unlinkButton);

    // Confirm dialog - find within the dialog
    const confirmDialog = await screen.findByRole("alertdialog");
    const confirmButton = within(confirmDialog).getByRole("button", { name: /unlink/i });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/bank-sync/links/link1", { method: "DELETE" });
    });
  });

  it("deletes an entire connection", async () => {
    renderPanel();

    // Find the delete connection button
    const deleteConnButton = await screen.findByRole("button", { name: /delete connection/i });
    fireEvent.click(deleteConnButton);

    // Confirm dialog - find within the dialog
    const confirmDialog = await screen.findByRole("alertdialog");
    const confirmButton = within(confirmDialog).getByRole("button", { name: /delete connection/i });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/bank-sync/connections/conn1", { method: "DELETE" });
    });
  });

  it("does not fetch discovery merely by opening the dialog — only once an item id is searched", async () => {
    renderPanel();

    await screen.findByText("Checking");
    expect(
      mockApiFetch.mock.calls.some(([path]) => String(path).startsWith("/bank-sync/discovery")),
    ).toBe(false);

    const linkButtons = await screen.findAllByRole("button", { name: /link an account/i });
    fireEvent.click(linkButtons[0]);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Opening the dialog alone must not fetch discovery (Meu Pluggy's free
    // tier has no client-wide item listing — discovery needs a submitted
    // item id first).
    expect(
      mockApiFetch.mock.calls.some(([path]) => String(path).startsWith("/bank-sync/discovery")),
    ).toBe(false);

    const itemIdInput = within(dialog).getByLabelText(/item id/i);
    fireEvent.change(itemIdInput, { target: { value: "item1" } });
    const searchButton = within(dialog).getByRole("button", { name: /buscar contas/i });
    fireEvent.click(searchButton);

    await waitFor(() => {
      expect(
        mockApiFetch.mock.calls.some(([path]) => String(path).startsWith("/bank-sync/discovery")),
      ).toBe(true);
    });
  });

  it("renders the category mapping editor beneath the connections list", async () => {
    renderPanel();

    expect(await screen.findByText("Checking")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /category mappings/i })).toBeInTheDocument();
  });
});
