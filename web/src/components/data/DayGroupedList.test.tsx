import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DayGroupedList from "./DayGroupedList";
import type { KeysetPage } from "./DataList";

interface Item {
  id: string;
  occurred_at: string;
  name: string;
}

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const NOW = new Date("2026-09-11T15:00:00.000Z");

const PAGE_1: KeysetPage<Item> = {
  items: [
    { id: "1", occurred_at: "2026-09-11T09:00:00.000Z", name: "Alpha" },
    { id: "2", occurred_at: "2026-09-10T09:00:00.000Z", name: "Bravo" },
  ],
  next_cursor: "cursor-1",
};

const PAGE_2: KeysetPage<Item> = {
  items: [{ id: "3", occurred_at: "2026-09-01T09:00:00.000Z", name: "Charlie" }],
  next_cursor: null,
};

describe("DayGroupedList", () => {
  it("renders each item under its calendar-day group heading", async () => {
    const fetchPage = vi.fn().mockResolvedValue(PAGE_1);

    renderWithQuery(
      <DayGroupedList<Item>
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
        now={NOW}
      />,
    );

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
  });

  it("fetches and appends the next page on 'Load more'", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(PAGE_1).mockResolvedValueOnce(PAGE_2);

    renderWithQuery(
      <DayGroupedList<Item>
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
        now={NOW}
      />,
    );

    const loadMore = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);

    expect(await screen.findByText("Charlie")).toBeInTheDocument();
    expect(fetchPage).toHaveBeenCalledWith("cursor-1");
  });

  it("hides 'Load more' once next_cursor comes back null", async () => {
    const fetchPage = vi.fn().mockResolvedValue(PAGE_2);

    renderWithQuery(
      <DayGroupedList<Item>
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
        now={NOW}
      />,
    );

    expect(await screen.findByText("Charlie")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("renders the empty state when there are no items", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [], next_cursor: null });

    renderWithQuery(
      <DayGroupedList<Item>
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item) => <span>{item.name}</span>}
        empty={<p>No items yet.</p>}
        now={NOW}
      />,
    );

    await waitFor(() => expect(screen.getByText("No items yet.")).toBeInTheDocument());
  });

  it("renders a default error callout when the fetch fails", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new Error("network down"));

    renderWithQuery(
      <DayGroupedList<Item>
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
        now={NOW}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load/i);
  });

  it("lets a caller override error rendering (e.g. a friendly permission message)", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new Error("forbidden"));

    renderWithQuery(
      <DayGroupedList<Item>
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
        now={NOW}
        renderError={() => <p>Only the owner can see this.</p>}
      />,
    );

    expect(await screen.findByText("Only the owner can see this.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
