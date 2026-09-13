import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import EmptyState from "./EmptyState";

describe("EmptyState", () => {
  it("renders the title and body", () => {
    render(<EmptyState title="No accounts yet" body="Add one to get started." />);

    expect(screen.getByRole("heading", { name: "No accounts yet" })).toBeInTheDocument();
    expect(screen.getByText("Add one to get started.")).toBeInTheDocument();
  });

  it("renders an optional action", () => {
    render(
      <EmptyState
        title="No accounts yet"
        body="Add one to get started."
        action={<button type="button">Add account</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "Add account" })).toBeInTheDocument();
  });

  it("omits the action block when none is given", () => {
    render(<EmptyState title="No accounts yet" body="Add one to get started." />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
