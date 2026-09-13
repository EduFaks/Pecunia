import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DemoChip from "./DemoChip";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../ui/Toast";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function renderChip() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <DemoChip />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function mockDemoRoutes(overrides: Partial<{ present: boolean }> = {}) {
  mockApiFetch.mockImplementation(((path: string, opts?: { method?: string }): unknown => {
    if (path === "/demo" && opts?.method === "DELETE") {
      return Promise.resolve(undefined);
    }
    if (path === "/demo") {
      return Promise.resolve({ present: overrides.present ?? true, counts: { accounts: 1 } });
    }
    return Promise.reject(new Error(`unexpected apiFetch(${path})`));
  }) as typeof mockApiFetch);
}

describe("DemoChip", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("renders nothing while GET /demo is loading", () => {
    mockApiFetch.mockImplementation(() => new Promise(() => {}));

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <DemoChip />
        </ToastProvider>
      </QueryClientProvider>,
    );

    expect(screen.queryByText("Demo data")).not.toBeInTheDocument();
  });

  it("renders nothing when /demo reports no demo data present", async () => {
    mockDemoRoutes({ present: false });

    renderChip();

    // Wait for the query to resolve, then assert the chip stays absent.
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith("/demo"));
    expect(screen.queryByText("Demo data")).not.toBeInTheDocument();
  });

  it("shows a 'Demo data · Remove' chip when /demo reports data present", async () => {
    mockDemoRoutes({ present: true });

    renderChip();

    expect(await screen.findByText("Demo data")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("clicking Remove opens a confirmation instead of deleting immediately", async () => {
    mockDemoRoutes({ present: true });

    renderChip();
    const removeButton = await screen.findByRole("button", { name: "Remove" });
    fireEvent.click(removeButton);

    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName("Remove demo data?");
    expect(mockApiFetch).not.toHaveBeenCalledWith("/demo", { method: "DELETE" });
  });

  it("cancelling the confirmation leaves the demo data in place", async () => {
    mockDemoRoutes({ present: true });

    renderChip();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith("/demo", { method: "DELETE" });
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("confirming calls DELETE /demo, invalidates finance queries, and shows a success toast", async () => {
    mockDemoRoutes({ present: true });

    const queryClient = renderChip();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove demo data" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/demo", { method: "DELETE" }),
    );

    await screen.findByText("Demo data removed.");
    // The mutation's onSuccess awaits `invalidateQueries`, which itself
    // awaits DemoChip's own `/demo` refetch — let that trailing update (the
    // button leaving its busy state) settle inside this same act-wrapped
    // poll rather than letting it land after the test returns.
    await screen.findByRole("button", { name: "Remove" });

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toEqual(
      expect.arrayContaining([
        ["accounts"],
        ["transactions"],
        ["assets"],
        ["projects"],
        ["budgets"],
        ["demo"],
      ]),
    );
  });
});
