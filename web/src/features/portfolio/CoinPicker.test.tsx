import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import CoinPicker from "./CoinPicker";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const COINS = [
  { id: "bitcoin", symbol: "btc", name: "Bitcoin" },
  { id: "bitcoin-cash", symbol: "bch", name: "Bitcoin Cash" },
];

function renderPicker(onChange = vi.fn(), value = "") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CoinPicker value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe("CoinPicker", () => {
  beforeEach(() => {
    mockApiFetch.mockReset().mockResolvedValue(COINS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queries the coin-search proxy only after the debounce elapses, and lists the matches", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { onChange } = renderPicker();

    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "bit" } });

    expect(mockApiFetch).not.toHaveBeenCalledWith(expect.stringContaining("q=bit"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("q=bit")),
    );
    expect(await screen.findByRole("option", { name: /Bitcoin Cash/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /^Bitcoin btc$/i }));
    expect(onChange).toHaveBeenCalledWith("bitcoin", COINS[0]);
  });

  it("clears the selection via the 'No automatic pricing' option", async () => {
    const { onChange } = renderPicker(vi.fn(), "bitcoin");

    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: /no automatic pricing/i }));

    expect(onChange).toHaveBeenCalledWith("", null);
  });

  it("shows the raw coingecko id as the initial text for an already-set value", () => {
    renderPicker(vi.fn(), "bitcoin");
    expect(screen.getByRole("combobox")).toHaveValue("bitcoin");
  });
});
