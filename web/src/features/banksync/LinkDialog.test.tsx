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
      if (path === "/bank-sync/discovery" && method === "GET") {
        return Promise.resolve([
          {
            pluggy_item_id: "item1",
            pluggy_account_id: "acct-bank-1",
            type: "BANK",
            balance: 5000_00,
            linked_account_id: null,
          },
          {
            pluggy_item_id: "item1",
            pluggy_account_id: "acct-cc-1",
            type: "CREDIT",
            balance: 2000_00,
            linked_account_id: "acct2", // already linked
          },
          {
            pluggy_item_id: "item2",
            pluggy_account_id: "acct-bank-2",
            type: "BANK",
            balance: 10000_00,
            linked_account_id: null,
          },
        ]);
      }
      if (path === "/accounts" && method === "GET") {
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
          ],
          next_cursor: null,
        });
      }
      if (path === "/bank-sync/links" && method === "POST") {
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
                account_currency: "USD",
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

  it("filters out already-linked discovered accounts", async () => {
    renderDialog();

    // Should show unlinked accounts (acct-bank-1, acct-bank-2)
    // Should NOT show the already-linked acct-cc-1
    const discoverSelect = await screen.findByRole("combobox", { name: /discovered account/i });
    const options = discoverSelect.querySelectorAll("option");
    const linkedOption = Array.from(options).find((opt) => opt.textContent?.includes("acct-cc-1"));
    expect(linkedOption).not.toBeInTheDocument();

    const unlinkedOptions = Array.from(options).filter((opt) =>
      ["acct-bank-1", "acct-bank-2"].some((id) => opt.textContent?.includes(id)),
    );
    expect(unlinkedOptions.length).toBeGreaterThan(0);
  });

  it("filters existing account options by currency matching discovered account", async () => {
    renderDialog();

    // Select a discovered account
    const discoverSelect = await screen.findByRole("combobox", { name: /discovered account/i });
    fireEvent.change(discoverSelect, { target: { value: "item1:acct-bank-1" } });

    // Should show only USD accounts (Checking, Credit Card) in the Pecunia Account select
    // Should NOT show EUR account (Savings EUR)
    const pecuniaSelect = await screen.findByRole("combobox", { name: /pecunia account/i });
    const accountOptions = pecuniaSelect.querySelectorAll("option");
    const eurOption = Array.from(accountOptions).find((opt) => opt.textContent?.includes("Savings EUR"));
    expect(eurOption).not.toBeInTheDocument();

    const usdOptions = Array.from(accountOptions).filter((opt) =>
      ["Checking", "Credit Card"].some((name) => opt.textContent?.includes(name)),
    );
    expect(usdOptions.length).toBeGreaterThan(0);
  });

  it("posts with account_id when linking to existing account", async () => {
    renderDialog();

    // Select discovered account
    const discoverSelect = await screen.findByRole("combobox", { name: /discovered account/i });
    fireEvent.change(discoverSelect, { target: { value: "item1:acct-bank-1" } });

    // Select existing account - this appears after selecting discovered account
    const pecuniaSelect = await screen.findByRole("combobox", { name: /pecunia account/i });
    fireEvent.change(pecuniaSelect, { target: { value: "acct1" } });

    // Submit - now the button should be enabled
    const submitButton = await screen.findByRole("button", { name: /link account/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/bank-sync/links",
        expect.objectContaining({
          method: "POST",
          json: expect.objectContaining({
            pluggy_account_id: "acct-bank-1",
            account_id: "acct1",
          }),
        }),
      );
    });
  });

  it("posts with new_account when creating linked account", async () => {
    renderDialog();

    // Select discovered account
    const discoverSelect = await screen.findByRole("combobox", { name: /discovered account/i });
    fireEvent.change(discoverSelect, { target: { value: "item1:acct-bank-1" } });

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
            pluggy_account_id: "acct-bank-1",
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
