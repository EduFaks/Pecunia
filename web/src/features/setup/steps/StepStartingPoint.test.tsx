import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import StepStartingPoint from "./StepStartingPoint";
import { apiFetch, ApiError } from "../../../lib/api";

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockApiFetch = vi.mocked(apiFetch);

function renderStep(onNext = vi.fn(), baseCurrency = "EUR") {
  render(<StepStartingPoint onNext={onNext} baseCurrency={baseCurrency} />);
  return { onNext };
}

function createdAccount(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "acc-1",
    name: "Everyday checking",
    type: "checking",
    currency: "EUR",
    initial_balance_minor: 0,
    balance_minor: 0,
    is_demo: false,
    archived_at: null,
    created_at: "2026-09-11T00:00:00Z",
    updated_at: "2026-09-11T00:00:00Z",
    ...overrides,
  };
}

describe("StepStartingPoint", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("renders the eyebrow and heading for step 4 of 5", () => {
    renderStep();
    expect(screen.getByText(/step 4 of 5/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /choose your starting point/i })).toBeInTheDocument();
  });

  it("defaults the quick-add currency field to the base currency passed in", () => {
    renderStep(vi.fn(), "BRL");
    expect(screen.getByLabelText(/^currency$/i)).toHaveValue("BRL");
  });

  it("quick-add POSTs /accounts with name, type, and currency, then lists the created account", async () => {
    mockApiFetch.mockResolvedValueOnce(createdAccount({ name: "Everyday checking", type: "checking" }));
    renderStep();

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Everyday checking" } });
    fireEvent.click(screen.getByRole("button", { name: /add account/i }));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/accounts");
    expect((opts as { method?: string }).method).toBe("POST");
    expect((opts as { json?: unknown }).json).toEqual({
      name: "Everyday checking",
      type: "checking",
      currency: "EUR",
    });

    const list = await screen.findByRole("list", { name: /accounts added/i });
    expect(list).toHaveTextContent("Everyday checking");
    expect(list).toHaveTextContent(/checking/i);
  });

  it("clears the name field after a successful add so a second, different add can be made (repeatable)", async () => {
    mockApiFetch
      .mockResolvedValueOnce(createdAccount({ id: "acc-1", name: "Everyday checking" }))
      .mockResolvedValueOnce(createdAccount({ id: "acc-2", name: "Travel savings", type: "savings" }));
    renderStep();

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Everyday checking" } });
    fireEvent.click(screen.getByRole("button", { name: /add account/i }));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    await screen.findByText("Everyday checking");

    expect(screen.getByLabelText(/^name$/i)).toHaveValue("");

    fireEvent.change(screen.getByLabelText(/^type$/i), { target: { value: "savings" } });
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Travel savings" } });
    fireEvent.click(screen.getByRole("button", { name: /add account/i }));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    const list = await screen.findByRole("list", { name: /accounts added/i });
    expect(list).toHaveTextContent("Everyday checking");
    expect(list).toHaveTextContent("Travel savings");
    expect((mockApiFetch.mock.calls[1][1] as { json?: unknown }).json).toEqual({
      name: "Travel savings",
      type: "savings",
      currency: "EUR",
    });
  });

  it("shows a Callout when the account POST fails, and leaves the form usable", async () => {
    mockApiFetch.mockRejectedValueOnce(new ApiError(422, "VALIDATION_ERROR", []));
    renderStep();

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Bad account" } });
    fireEvent.click(screen.getByRole("button", { name: /add account/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add account/i })).toBeEnabled();
  });

  it("demo button POSTs /demo; on 201 shows a confirmation and disables the button", async () => {
    mockApiFetch.mockResolvedValueOnce({ present: true, counts: { accounts: 3 } });
    renderStep();

    const button = screen.getByRole("button", { name: /add demo data/i });
    fireEvent.click(button);

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/demo");
    expect((opts as { method?: string }).method).toBe("POST");

    expect(
      await screen.findByText(/demo data added.*remove it anytime from the header/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add demo data/i })).toBeDisabled();
  });

  it("demo button on 409 DEMO_ALREADY_PRESENT shows 'Demo data is already present.'", async () => {
    mockApiFetch.mockRejectedValueOnce(new ApiError(409, "DEMO_ALREADY_PRESENT"));
    renderStep();

    fireEvent.click(screen.getByRole("button", { name: /add demo data/i }));

    expect(await screen.findByText("Demo data is already present.")).toBeInTheDocument();
  });

  it("Skip for now calls onNext directly, with no API call", () => {
    const { onNext } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: /^skip for now$/i }));

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("Continue advances to Finish regardless of whether anything else was done", () => {
    const { onNext } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: /^continue/i }));

    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
