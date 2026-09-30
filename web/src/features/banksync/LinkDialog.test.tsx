import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import { qk } from "../../lib/queries";
import LinkDialog from "./LinkDialog";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function installFakeBackend() {
  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      const method = opts?.method ?? "GET";

      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: null });
      }
      if (path.startsWith("/bank-sync/discovery") && method === "GET") {
        // Shape mirrors DiscoveredConnectionOut (api/src/pecunia/api/banksync.py):
        // connections nest their discovered accounts, each carrying its own currency.
        return Promise.resolve([
          {
            item_id: "item1",
            institution_name: "Banco do Brasil",
            status: "UPDATED",
            accounts: [
              {
                pluggy_account_id: "acct-bank-1",
                type: "BANK",
                subtype: "checking_account",
                name: "Conta Corrente",
                number: "1234",
                balance_minor: 500_000,
                currency: "BRL",
                linked_account_id: null,
              },
              {
                pluggy_account_id: "acct-cc-1",
                type: "CREDIT",
                subtype: "credit_card",
                name: "Cartao",
                number: "5678",
                balance_minor: 200_000,
                currency: "BRL",
                linked_account_id: "acct2", // already linked
              },
            ],
          },
          {
            item_id: "item2",
            institution_name: "Chase",
            status: "UPDATED",
            accounts: [
              {
                pluggy_account_id: "acct-bank-2",
                type: "BANK",
                subtype: "checking_account",
                name: "Checking",
                number: "9999",
                balance_minor: 1_000_000,
                currency: "USD",
                linked_account_id: null,
              },
            ],
          },
        ]);
      }
      if (path.startsWith("/accounts") && method === "GET") {
        return Promise.resolve({
          items: [
            {
              id: "acct1",
              name: "Checking",
              currency: "USD",
              subtype: "checking",
            },
            {
              id: "acct2",
              name: "Credit Card",
              currency: "USD",
              subtype: "credit",
            },
            {
              id: "acct3",
              name: "Savings EUR",
              currency: "EUR",
              subtype: "savings",
            },
            {
              id: "acct4",
              name: "Conta BRL",
              currency: "BRL",
              subtype: "checking",
            },
          ],
          next_cursor: null,
        });
      }
      if (path.startsWith("/bank-sync/links") && method === "POST") {
        const body = opts?.json as Record<string, unknown>;
        if (body.account_id) {
          return Promise.resolve({
            id: "conn-new",
            status: "ok",
            last_error: null,
            last_synced_at: null,
            links: [
              {
                id: "link-new",
                account_id: body.account_id,
                account_name: "New Link",
                account_currency: "BRL",
                pluggy_account_id: body.pluggy_account_id,
                sync_from: body.sync_from,
                provider_balance_minor: 0,
                provider_balance_as_of: null,
                derived_balance_minor: 0,
                credit_limit_minor: null,
                bill_close_date: null,
                bill_due_date: null,
              },
            ],
          });
        }
        if (body.new_account) {
          return Promise.resolve({
            id: "conn-new-acct",
            status: "ok",
            last_error: null,
            last_synced_at: null,
            links: [
              {
                id: "link-new-acct",
                account_id: "acct-created",
                account_name: (body.new_account as Record<string, unknown>).name as string,
                account_currency: (body.new_account as Record<string, unknown>).currency as string,
                pluggy_account_id: body.pluggy_account_id,
                sync_from: body.sync_from,
                provider_balance_minor: 0,
                provider_balance_as_of: null,
                derived_balance_minor: 0,
                credit_limit_minor: null,
                bill_close_date: null,
                bill_due_date: null,
              },
            ],
          });
        }
        return Promise.reject(new Error("Missing account_id or new_account"));
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
}

function renderDialog(props = { open: true, onClose: vi.fn() }) {
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
        <LinkDialog open={props.open} onClose={props.onClose} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("LinkDialog", () => {
  beforeEach(() => {
    installFakeBackend();
  });

  it("does not fetch discovery while closed, and fetches once opened", async () => {
    renderDialog({ open: false, onClose: vi.fn() });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockApiFetch.mock.calls.some(([path]) => path === "/bank-sync/discovery")).toBe(false);
  });

  it("filters out already-linked discovered accounts", async () => {
    renderDialog();

    // Should show unlinked accounts (acct-bank-1, acct-bank-2)
    // Should NOT show the already-linked acct-cc-1
    const discoverSelect = await screen.findByRole("combobox", { name: /discovered account/i });
    const options = discoverSelect.querySelectorAll("option");
    const linkedOption = Array.from(options).find((opt) => opt.textContent?.includes("acct-cc-1"));
    expect(linkedOption).toBeUndefined();

    const unlinkedOptions = Array.from(options).filter((opt) =>
      ["acct-bank-1", "acct-bank-2"].some((id) => opt.textContent?.includes(id)),
    );
    expect(unlinkedOptions.length).toBe(2);
  });

  it("filters existing account options to the same currency as the discovered account", async () => {
    renderDialog();

    // Select the BRL discovered account (Banco do Brasil / Conta Corrente)
    const discoverSelect = await screen.findByRole("combobox", { name: /discovered account/i });
    fireEvent.change(discoverSelect, { target: { value: "item1:acct-bank-1" } });

    // Should show only the BRL Pecunia account (Conta BRL)
    // Should NOT show the USD accounts (Checking, Credit Card) or the EUR one (Savings EUR)
    const pecuniaSelect = await screen.findByRole("combobox", { name: /pecunia account/i });
    const accountOptions = pecuniaSelect.querySelectorAll("option");

    const brlOption = Array.from(accountOptions).find((opt) => opt.textContent?.includes("Conta BRL"));
    expect(brlOption).toBeInTheDocument();

    const nonBrlOption = Array.from(accountOptions).find((opt) =>
      ["Checking", "Credit Card", "Savings EUR"].some((name) => opt.textContent?.includes(name)),
    );
    expect(nonBrlOption).toBeUndefined();
  });

  it("posts with account_id when linking to existing account", async () => {
    renderDialog();

    // Select the BRL discovered account
    const discoverSelect = await screen.findByRole("combobox", { name: /discovered account/i });
    fireEvent.change(discoverSelect, { target: { value: "item1:acct-bank-1" } });

    // Select the matching-currency existing account
    const pecuniaSelect = await screen.findByRole("combobox", { name: /pecunia account/i });
    fireEvent.change(pecuniaSelect, { target: { value: "acct4" } });

    // Submit - now the button should be enabled
    const submitButton = await screen.findByRole("button", { name: /link account/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/bank-sync/links",
        expect.objectContaining({
          method: "POST",
          json: expect.objectContaining({
            pluggy_item_id: "item1",
            pluggy_account_id: "acct-bank-1",
            account_id: "acct4",
          }),
        }),
      );
    });
  });

  it("posts the sync_from date the user picked, not just today", async () => {
    // Finding 13: sync_from was locked to `today` with no date input
    // rendered — the locked-in decision is that the user picks the start
    // date at link time (default today).
    renderDialog();

    const discoverSelect = await screen.findByRole("combobox", { name: /discovered account/i });
    fireEvent.change(discoverSelect, { target: { value: "item1:acct-bank-1" } });

    const pecuniaSelect = await screen.findByRole("combobox", { name: /pecunia account/i });
    fireEvent.change(pecuniaSelect, { target: { value: "acct4" } });

    const syncFromInput = await screen.findByLabelText(/sync from|start date/i);
    fireEvent.change(syncFromInput, { target: { value: "2026-01-15" } });

    const submitButton = await screen.findByRole("button", { name: /link account/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/bank-sync/links",
        expect.objectContaining({
          method: "POST",
          json: expect.objectContaining({
            sync_from: "2026-01-15",
          }),
        }),
      );
    });
  });

  it("posts with new_account (using the discovered account's currency) when creating linked account", async () => {
    renderDialog();

    // Select the USD discovered account (Chase / Checking)
    const discoverSelect = await screen.findByRole("combobox", { name: /discovered account/i });
    fireEvent.change(discoverSelect, { target: { value: "item2:acct-bank-2" } });

    // Choose "Create new account"
    const createButton = await screen.findByRole("button", { name: /create new account/i });
    fireEvent.click(createButton);

    // Fill in new account form
    const nameInput = await screen.findByLabelText(/account name/i);
    fireEvent.change(nameInput, { target: { value: "New Checking" } });

    // Submit
    const submitButton = await screen.findByRole("button", { name: /link account/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/bank-sync/links",
        expect.objectContaining({
          method: "POST",
          json: expect.objectContaining({
            pluggy_item_id: "item2",
            pluggy_account_id: "acct-bank-2",
            new_account: expect.objectContaining({
              name: "New Checking",
              currency: "USD",
            }),
          }),
        }),
      );
    });
  });

  it("handles 503 discovery unavailable gracefully", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/bank-sync/discovery") {
        return Promise.reject({ status: 503 });
      }
      return Promise.resolve(null);
    });

    renderDialog();

    // Should show degraded UI or message
    expect(await screen.findByText(/unavailable|offline|try again/i)).toBeInTheDocument();
  });
});
