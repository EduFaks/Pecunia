import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../../lib/api";
import AssetForm from "./AssetForm";
import type { AssetFormProps } from "./AssetForm";
import type { AssetOut } from "./useAssets";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function renderForm(props: Partial<AssetFormProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSuccess = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <AssetForm onSuccess={onSuccess} {...props} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

const ASSET: AssetOut = {
  id: "as1",
  name: "1967 Mustang",
  type: "vehicle",
  currency: "USD",
  acquired_on: "2020-01-01",
  current_value_minor: 4_500_000,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("AssetForm — create", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts name, type, currency, and acquired_on", async () => {
    mockApiFetch.mockResolvedValue(ASSET);
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "1967 Mustang" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "vehicle" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText(/acquired/i), { target: { value: "2020-01-01" } });

    fireEvent.click(screen.getByRole("button", { name: /create asset/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/assets", {
        method: "POST",
        json: { name: "1967 Mustang", type: "vehicle", currency: "USD", acquired_on: "2020-01-01" },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(ASSET));
  });

  it("omits acquired_on when left blank", async () => {
    mockApiFetch.mockResolvedValue(ASSET);
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Watch" } });
    fireEvent.click(screen.getByRole("button", { name: /create asset/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/assets",
        expect.objectContaining({
          json: expect.not.objectContaining({ acquired_on: expect.anything() }),
        }),
      ),
    );
  });

  it("does not submit with an empty name", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /create asset/i })).toBeDisabled();
  });

  it("includes value_minor and as_of when a current value is entered", async () => {
    mockApiFetch.mockResolvedValue(ASSET);
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "1967 Mustang" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText(/current value/i), { target: { value: "45000.00" } });
    fireEvent.change(screen.getByLabelText(/as of/i), { target: { value: "2020-01-01" } });

    fireEvent.click(screen.getByRole("button", { name: /create asset/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/assets",
        expect.objectContaining({
          json: expect.objectContaining({ value_minor: 4_500_000, as_of: "2020-01-01" }),
        }),
      ),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(ASSET));
  });

  it("omits value_minor and as_of when the current value is left blank", async () => {
    mockApiFetch.mockResolvedValue(ASSET);
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Watch" } });
    fireEvent.click(screen.getByRole("button", { name: /create asset/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/assets",
        expect.objectContaining({
          json: expect.not.objectContaining({ value_minor: expect.anything() }),
        }),
      ),
    );
    const [, options] = mockApiFetch.mock.calls[0]!;
    expect((options as { json: Record<string, unknown> }).json).not.toHaveProperty("as_of");
  });

  it("defaults the as-of date to today", () => {
    renderForm();
    const today = new Date().toISOString().slice(0, 10);
    expect(screen.getByLabelText(/as of/i)).toHaveValue(today);
  });
});

describe("AssetForm — edit", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("prefills from the given asset", () => {
    renderForm({ asset: ASSET });

    expect(screen.getByLabelText("Name")).toHaveValue("1967 Mustang");
    expect(screen.getByLabelText("Type")).toHaveValue("vehicle");
    expect(screen.getByLabelText("Currency")).toHaveValue("USD");
    expect(screen.getByLabelText(/acquired/i)).toHaveValue("2020-01-01");
  });

  it("does not show a current-value field — value history lives on the detail page", () => {
    renderForm({ asset: ASSET });

    expect(screen.queryByLabelText(/current value/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/as of/i)).not.toBeInTheDocument();
  });

  it("patches the changed fields on save", async () => {
    mockApiFetch.mockResolvedValue({ ...ASSET, name: "Renamed" });
    const { onSuccess } = renderForm({ asset: ASSET });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/assets/as1", {
        method: "PATCH",
        json: {
          name: "Renamed",
          type: "vehicle",
          currency: "USD",
          acquired_on: "2020-01-01",
        },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ ...ASSET, name: "Renamed" }));
  });

  it("shows a generic error message on failure", async () => {
    mockApiFetch.mockRejectedValue(new ApiError(500, "UNKNOWN_ERROR"));
    renderForm({ asset: ASSET });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't save/i);
  });
});
