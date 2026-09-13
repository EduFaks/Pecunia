import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../../lib/api";
import AccountForm from "./AccountForm";
import type { AccountFormProps } from "./AccountForm";
import type { AccountOut } from "./useAccounts";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function renderForm(props: Partial<AccountFormProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSuccess = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <AccountForm onSuccess={onSuccess} {...props} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

const ACCOUNT: AccountOut = {
  id: "a1",
  name: "Checking",
  type: "checking",
  currency: "USD",
  initial_balance_minor: 0,
  balance_minor: 500,
  is_demo: false,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("AccountForm — create", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts name, type, currency, and the starting balance converted to minor units", async () => {
    mockApiFetch.mockResolvedValue(ACCOUNT);
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Everyday checking" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "savings" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "EUR" } });
    fireEvent.change(screen.getByLabelText(/starting balance/i), { target: { value: "84.99" } });

    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/accounts", {
        method: "POST",
        json: {
          name: "Everyday checking",
          type: "savings",
          currency: "EUR",
          initial_balance_minor: 8499,
        },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(ACCOUNT));
  });

  it("omits initial_balance_minor when the starting balance is left blank", async () => {
    mockApiFetch.mockResolvedValue(ACCOUNT);
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Wallet" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/accounts",
        expect.objectContaining({
          json: expect.not.objectContaining({ initial_balance_minor: expect.anything() }),
        }),
      ),
    );
  });

  it("does not submit with an empty name", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /create account/i })).toBeDisabled();
  });
});

describe("AccountForm — edit", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("prefills from the given account and has no starting-balance field", () => {
    renderForm({ account: ACCOUNT });

    expect(screen.getByLabelText("Name")).toHaveValue("Checking");
    expect(screen.getByLabelText("Type")).toHaveValue("checking");
    expect(screen.getByLabelText("Currency")).toHaveValue("USD");
    expect(screen.queryByLabelText(/starting balance/i)).not.toBeInTheDocument();
  });

  it("patches only name/type/currency on save", async () => {
    mockApiFetch.mockResolvedValue({ ...ACCOUNT, name: "Renamed" });
    const { onSuccess } = renderForm({ account: ACCOUNT });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/accounts/a1", {
        method: "PATCH",
        json: { name: "Renamed", type: "checking", currency: "USD" },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ ...ACCOUNT, name: "Renamed" }));
  });

  it("shows a friendly error when changing currency conflicts with existing transactions (409)", async () => {
    mockApiFetch.mockRejectedValue(new ApiError(409, "ACCOUNT_HAS_TRANSACTIONS"));
    renderForm({ account: ACCOUNT });

    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "EUR" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/currency can't be changed/i);
  });
});
