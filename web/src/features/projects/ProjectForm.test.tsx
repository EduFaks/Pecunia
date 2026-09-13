import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../../lib/api";
import ProjectForm from "./ProjectForm";
import type { ProjectFormProps } from "./ProjectForm";
import type { ProjectOut } from "./useProjects";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function renderForm(props: Partial<ProjectFormProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSuccess = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectForm onSuccess={onSuccess} {...props} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

const PROJECT: ProjectOut = {
  id: "p1",
  name: "New roof",
  description: null,
  target_amount_minor: 1_000_000,
  currency: "USD",
  status: "active",
  type: "spending",
  planned_minor: 250_000,
  actual_minor: 100_000,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("ProjectForm — create", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts name, currency, status, the spending type, and the budget amount in minor units", async () => {
    mockApiFetch.mockResolvedValue(PROJECT);
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New roof" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "active" } });
    // Spending is the default type — its target field reads "Budget amount".
    fireEvent.change(screen.getByLabelText(/budget amount/i), { target: { value: "10000" } });

    fireEvent.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects", {
        method: "POST",
        json: {
          name: "New roof",
          currency: "USD",
          status: "active",
          type: "spending",
          target_amount_minor: 1_000_000,
        },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(PROJECT));
  });

  it("submits the saving type and shows saving-flavoured labels once the toggle is switched", async () => {
    mockApiFetch.mockResolvedValue({ ...PROJECT, type: "saving" });
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rainy day" } });
    fireEvent.click(screen.getByRole("button", { name: /^saving$/i }));

    // The target field relabels to the saving vocabulary.
    expect(screen.getByLabelText(/goal amount/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/budget amount/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/projects",
        expect.objectContaining({ json: expect.objectContaining({ type: "saving" }) }),
      ),
    );
  });

  it("omits target_amount_minor when left blank", async () => {
    mockApiFetch.mockResolvedValue(PROJECT);
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Vacation" } });
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/projects",
        expect.objectContaining({
          json: expect.not.objectContaining({ target_amount_minor: expect.anything() }),
        }),
      ),
    );
  });

  it("does not submit with an empty name", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /create project/i })).toBeDisabled();
  });
});

describe("ProjectForm — edit", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("prefills from the given project, including its type toggle", () => {
    renderForm({ project: PROJECT });

    expect(screen.getByLabelText("Name")).toHaveValue("New roof");
    expect(screen.getByLabelText("Currency")).toHaveValue("USD");
    expect(screen.getByLabelText("Status")).toHaveValue("active");
    expect(screen.getByLabelText(/budget amount/i)).toHaveValue("10000.00");
    expect(screen.getByRole("button", { name: /^spending$/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("patches the changed fields on save", async () => {
    mockApiFetch.mockResolvedValue({ ...PROJECT, status: "completed" });
    const { onSuccess } = renderForm({ project: PROJECT });

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "completed" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1", {
        method: "PATCH",
        json: {
          name: "New roof",
          currency: "USD",
          status: "completed",
          type: "spending",
          target_amount_minor: 1_000_000,
        },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ ...PROJECT, status: "completed" }));
  });

  it("shows a generic error message on failure", async () => {
    mockApiFetch.mockRejectedValue(new ApiError(500, "UNKNOWN_ERROR"));
    renderForm({ project: PROJECT });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't save/i);
  });
});
