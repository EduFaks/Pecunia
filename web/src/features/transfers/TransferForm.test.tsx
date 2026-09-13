import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../../lib/api";
import TransferForm from "./TransferForm";
import type { TransferFormProps } from "./TransferForm";
import type { AccountOut } from "../accounts/useAccounts";
import type { TransferOut } from "./useTransfers";

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

const SAVINGS: AccountOut = { ...CHECKING, id: "a2", name: "Savings", balance_minor: 500000 };
const SAVINGS_EUR: AccountOut = { ...CHECKING, id: "a3", name: "Euro savings", currency: "EUR" };

const ACCOUNTS = [CHECKING, SAVINGS, SAVINGS_EUR];

const TRANSFER: TransferOut = {
  id: "tr1",
  from_account_id: "a1",
  to_account_id: "a2",
  amount_minor: 5000,
  currency: "USD",
  description: "Move to savings",
  occurred_on: "2026-09-11",
  is_demo: false,
  created_at: "2026-09-11T00:00:00Z",
};

function renderForm(props: Partial<TransferFormProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSuccess = vi.fn();
  const onDeleted = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TransferForm accounts={ACCOUNTS} onSuccess={onSuccess} onDeleted={onDeleted} {...props} />
    </QueryClientProvider>,
  );
  return { onSuccess, onDeleted };
}

describe("TransferForm — create", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("submits from/to/amount/date/description and calls create", async () => {
    mockApiFetch.mockResolvedValue(TRANSFER);
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("From account"), { target: { value: "a1" } });
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "a2" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Move to savings" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-11" } });

    fireEvent.click(screen.getByRole("button", { name: /add transfer/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/transfers", {
        method: "POST",
        json: {
          from_account_id: "a1",
          to_account_id: "a2",
          amount_minor: 5000,
          currency: "USD",
          description: "Move to savings",
          occurred_on: "2026-09-11",
        },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(TRANSFER));
  });

  it("cannot pick the same account on both sides — the from-account is excluded from the to list", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("From account"), { target: { value: "a1" } });

    const toSelect = screen.getByLabelText("To account");
    expect(within(toSelect).queryByRole("option", { name: /^Checking/ })).not.toBeInTheDocument();
    // The other accounts are still selectable on the to side.
    expect(within(toSelect).getByRole("option", { name: /^Savings/ })).toBeInTheDocument();
  });

  it("blocks a cross-currency transfer with a guard and a disabled submit", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText("From account"), { target: { value: "a1" } });
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "a3" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-11" } });

    expect(await screen.findByText(/same currency/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add transfer/i })).toBeDisabled();
  });

  it("surfaces the server's cross-currency 422 as a friendly error", async () => {
    mockApiFetch.mockRejectedValue(new ApiError(422, "TRANSFER_CURRENCY_MISMATCH"));
    renderForm();

    fireEvent.change(screen.getByLabelText("From account"), { target: { value: "a1" } });
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "a2" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-11" } });
    fireEvent.click(screen.getByRole("button", { name: /add transfer/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/currency/i);
  });
});

describe("TransferForm — edit", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("prefills from a transfer and patches the changed fields on save", async () => {
    mockApiFetch.mockResolvedValue({ ...TRANSFER, amount_minor: 7000 });
    renderForm({ transfer: TRANSFER });

    expect(screen.getByLabelText("From account")).toHaveValue("a1");
    expect(screen.getByLabelText("To account")).toHaveValue("a2");
    expect(screen.getByLabelText("Amount")).toHaveValue("50.00");
    expect(screen.getByLabelText("Description")).toHaveValue("Move to savings");
    expect(screen.getByLabelText("Date")).toHaveValue("2026-09-11");

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "70" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/transfers/tr1",
        expect.objectContaining({
          method: "PATCH",
          json: expect.objectContaining({ amount_minor: 7000 }),
        }),
      ),
    );
  });

  it("deletes via the transfer's delete mutation after confirming in the dialog", async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { onDeleted } = renderForm({ transfer: TRANSFER });

    fireEvent.click(screen.getByRole("button", { name: /delete transfer/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAccessibleName("Delete this transfer?");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete transfer" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/transfers/tr1", { method: "DELETE" }),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it("cancelling the delete confirmation does not delete the transfer", async () => {
    renderForm({ transfer: TRANSFER });

    fireEvent.click(screen.getByRole("button", { name: /delete transfer/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith("/transfers/tr1", { method: "DELETE" });
  });
});
