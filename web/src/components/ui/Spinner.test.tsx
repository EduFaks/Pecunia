import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Spinner from "./Spinner";

describe("Spinner", () => {
  it("renders as a decorative element by default (aria-hidden)", () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("exposes an accessible status when a label is given", () => {
    render(<Spinner label="Loading accounts" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading accounts");
  });
});
