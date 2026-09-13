import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Callout from "./Callout";

describe("Callout", () => {
  it("renders the negative variant with an alert role (assertive)", () => {
    render(<Callout variant="negative">Something broke</Callout>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something broke");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("renders the info variant (default) with a status role, not alert", () => {
    render(<Callout>Heads up</Callout>);
    expect(screen.getByRole("status")).toHaveTextContent("Heads up");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the positive variant with a status role", () => {
    render(<Callout variant="positive">All set</Callout>);
    expect(screen.getByRole("status")).toHaveTextContent("All set");
  });

  it("renders an optional title", () => {
    render(
      <Callout variant="negative" title="Sign-in failed">
        Try again
      </Callout>,
    );
    expect(screen.getByText("Sign-in failed")).toBeInTheDocument();
  });
});
