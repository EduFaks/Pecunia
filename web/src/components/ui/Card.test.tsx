import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Card from "./Card";

describe("Card", () => {
  it("renders children inside an elevated, padded surface", () => {
    render(<Card>Hello</Card>);
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("carries the elevation shadow token by default", () => {
    const { container } = render(<Card>Hello</Card>);
    expect(container.firstChild).toHaveClass("shadow-pc-2");
  });
});
