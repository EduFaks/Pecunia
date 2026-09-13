import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DataList from "./DataList";
import type { KeysetPage } from "./DataList";

interface Item {
  id: string;
  name: string;
}

function renderWithQuery(ui: ReactElement) {
  // `retry: false` so the "renders an error callout" test below fails fast
  // instead of working through TanStack Query's default 3-retry backoff.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const PAGE_1: KeysetPage<Item> = {
  items: [
    { id: "1", name: "Alpha" },
    { id: "2", name: "Bravo" },
  ],
  next_cursor: "cursor-1",
};

const PAGE_2: KeysetPage<Item> = {
  items: [{ id: "3", name: "Charlie" }],
  next_cursor: null,
};

describe("DataList", () => {
  it("renders the rows from the first page", async () => {
    const fetchPage = vi.fn().mockResolvedValue(PAGE_1);

    renderWithQuery(
      <DataList
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item: Item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
      />,
    );

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(fetchPage).toHaveBeenCalledWith(null);
  });

  it("shows a 'Load more' button while next_cursor is non-null, and fetches/appends the next page without duplicating rows", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(PAGE_1).mockResolvedValueOnce(PAGE_2);

    renderWithQuery(
      <DataList
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item: Item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
      />,
    );

    const loadMore = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);

    expect(await screen.findByText("Charlie")).toBeInTheDocument();
    expect(fetchPage).toHaveBeenCalledWith("cursor-1");

    // Original page's rows still present exactly once each.
    expect(screen.getAllByText("Alpha")).toHaveLength(1);
    expect(screen.getAllByText("Bravo")).toHaveLength(1);
    expect(screen.getAllByText("Charlie")).toHaveLength(1);
  });

  it("hides 'Load more' once next_cursor comes back null", async () => {
    const fetchPage = vi.fn().mockResolvedValue(PAGE_2);

    renderWithQuery(
      <DataList
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item: Item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
      />,
    );

    expect(await screen.findByText("Charlie")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("renders the empty state when the list has no items", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [], next_cursor: null });

    renderWithQuery(
      <DataList
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item: Item) => <span>{item.name}</span>}
        empty={<p>No items yet.</p>}
      />,
    );

    await waitFor(() => expect(screen.getByText("No items yet.")).toBeInTheDocument());
  });

  it("renders an error callout when the fetch fails", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new Error("network down"));

    renderWithQuery(
      <DataList
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item: Item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load/i);
  });

  it("calls onItemsChange with the loaded items and hasNextPage once the first page resolves", async () => {
    const fetchPage = vi.fn().mockResolvedValue(PAGE_1);
    const onItemsChange = vi.fn();

    renderWithQuery(
      <DataList
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item: Item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
        onItemsChange={onItemsChange}
      />,
    );

    await screen.findByText("Alpha");

    await waitFor(() => expect(onItemsChange).toHaveBeenCalledWith(PAGE_1.items, true));
  });

  it("calls onItemsChange again with the appended items and hasNextPage false after 'Load more'", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(PAGE_1).mockResolvedValueOnce(PAGE_2);
    const onItemsChange = vi.fn();

    renderWithQuery(
      <DataList
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item: Item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
        onItemsChange={onItemsChange}
      />,
    );

    const loadMore = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);

    await screen.findByText("Charlie");

    await waitFor(() =>
      expect(onItemsChange).toHaveBeenCalledWith([...PAGE_1.items, ...PAGE_2.items], false),
    );
  });

  it("does not call onItemsChange while the first page is still loading", () => {
    const fetchPage = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const onItemsChange = vi.fn();

    renderWithQuery(
      <DataList
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item: Item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
        onItemsChange={onItemsChange}
      />,
    );

    expect(onItemsChange).not.toHaveBeenCalled();
  });

  it("scrolls wide content in its own container rather than the page", async () => {
    const fetchPage = vi.fn().mockResolvedValue(PAGE_2);

    const { container } = renderWithQuery(
      <DataList
        queryKey={["items"]}
        fetchPage={fetchPage}
        renderRow={(item: Item) => <span>{item.name}</span>}
        empty={<p>No items.</p>}
      />,
    );

    await screen.findByText("Charlie");
    expect(container.querySelector(".overflow-x-auto")).toBeInTheDocument();
  });
});
