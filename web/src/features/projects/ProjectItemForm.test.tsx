import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import ProjectItemForm from "./ProjectItemForm";
import type { ProjectItemFormProps } from "./ProjectItemForm";
import type { ProjectItemOut } from "./useProjects";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function renderForm(props: Partial<ProjectItemFormProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSuccess = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectItemForm projectId="p1" currency="USD" onSuccess={onSuccess} {...props} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

const ITEM: ProjectItemOut = {
  id: "i1",
  project_id: "p1",
  transaction_id: null,
  name: "Shingles",
  amount_minor: 200_000,
  actual_minor: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("ProjectItemForm — add", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts the item name and the amount converted to minor units", async () => {
    mockApiFetch.mockResolvedValue(ITEM);
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Part"), { target: { value: "Shingles" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: /add part/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/items", {
        method: "POST",
        json: { name: "Shingles", amount_minor: 200_000 },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(ITEM));
  });

  it("does not submit without a name and a valid amount", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /add part/i })).toBeDisabled();
  });
});

describe("ProjectItemForm — edit", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("prefills from the given item and patches on save", async () => {
    mockApiFetch.mockResolvedValue({ ...ITEM, amount_minor: 250_000 });
    const { onSuccess } = renderForm({ item: ITEM });

    expect(screen.getByLabelText("Part")).toHaveValue("Shingles");
    expect(screen.getByLabelText("Amount")).toHaveValue("2000.00");

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/items/i1", {
        method: "PATCH",
        json: { name: "Shingles", amount_minor: 250_000 },
      }),
    );
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith({ ...ITEM, amount_minor: 250_000 }),
    );
  });
});
