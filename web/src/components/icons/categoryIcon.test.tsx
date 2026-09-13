import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import CategoryIcon from "./categoryIcon";

describe("CategoryIcon", () => {
  it("renders the mapped lucide glyph for a known icon name", () => {
    const { container } = render(<CategoryIcon name="car" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveClass("lucide-car");
  });

  it("maps a kebab-case name to its lucide glyph", () => {
    const { container } = render(<CategoryIcon name="shopping-bag" />);
    expect(container.querySelector("svg")).toHaveClass("lucide-shopping-bag");
    const heart = render(<CategoryIcon name="heart-pulse" />).container;
    expect(heart.querySelector("svg")).toHaveClass("lucide-heart-pulse");
  });

  it("falls back to a neutral Tag glyph for an unknown name", () => {
    const { container } = render(<CategoryIcon name="not-a-real-icon" />);
    expect(container.querySelector("svg")).toHaveClass("lucide-tag");
  });

  it("falls back to the neutral glyph for an empty or missing name", () => {
    const empty = render(<CategoryIcon name="" />).container;
    expect(empty.querySelector("svg")).toHaveClass("lucide-tag");
    const missing = render(<CategoryIcon />).container;
    expect(missing.querySelector("svg")).toHaveClass("lucide-tag");
    const nulled = render(<CategoryIcon name={null} />).container;
    expect(nulled.querySelector("svg")).toHaveClass("lucide-tag");
  });

  it("is aria-hidden (decorative — the category name carries the meaning)", () => {
    const { container } = render(<CategoryIcon name="wallet" />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("colors via currentColor so it inherits the ink tokens", () => {
    const { container } = render(<CategoryIcon name="wallet" />);
    expect(container.querySelector("svg")).toHaveAttribute("stroke", "currentColor");
  });
});
