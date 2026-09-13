import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import StepFinish from "./StepFinish";

function renderStep() {
  // A real QueryClient (not mocked): StepFinish reads `useQueryClient()` to
  // mark the setup-status cache initialized in the same tick it navigates
  // to "/" (see its own doc comment) — no network query ever actually runs
  // against it in these tests, only direct cache writes/reads.
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={["/setup/finish"]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/setup/finish" element={<StepFinish />} />
          <Route path="/" element={<div>App shell (post-setup landing)</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe("StepFinish", () => {
  it("renders the check glyph, the ready message, and the Enter Pecunia button", () => {
    const { container } = renderStep();

    expect(container.querySelector("svg path")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /you.re ready/i })).toBeInTheDocument();
    expect(screen.getByText(/pecunia is now configured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enter pecunia/i })).toBeInTheDocument();
  });

  it("clicking Enter Pecunia navigates to / (the dashboard)", async () => {
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: /enter pecunia/i }));

    expect(await screen.findByText("App shell (post-setup landing)")).toBeInTheDocument();
  });

  it("marks the setup-status query cache initialized once it navigates, so RequireSetup doesn't bounce the just-onboarded owner back to /setup", async () => {
    const { queryClient } = renderStep();

    expect(queryClient.getQueryData(["setup-status"])).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: /enter pecunia/i }));
    await screen.findByText("App shell (post-setup landing)");

    expect(queryClient.getQueryData(["setup-status"])).toEqual({ initialized: true });
  });

  it("ignores a second click while the cross-fade is already in flight", async () => {
    renderStep();
    const button = screen.getByRole("button", { name: /enter pecunia/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByText("App shell (post-setup landing)")).toBeInTheDocument();
  });
});
