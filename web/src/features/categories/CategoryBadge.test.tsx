import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import CategoryBadge from "./CategoryBadge";

describe("CategoryBadge", () => {
  it("renders the category's name with a dot in its color", () => {
    const { container } = render(<CategoryBadge category={{ name: "Groceries", color: "#8a8578" }} />);

    expect(screen.getByText("Groceries")).toBeInTheDocument();
    const dot = container.querySelector("span[aria-hidden]") as HTMLElement;
    expect(dot.style.backgroundColor).toBe("rgb(138, 133, 120)");
  });

  it("renders the category's lucide icon glyph beside the swatch", () => {
    const { container } = render(
      <CategoryBadge category={{ name: "Transport", color: "#38bdf8", icon: "car" }} />,
    );

    expect(container.querySelector("svg.lucide-car")).toBeInTheDocument();
    expect(screen.getByText("Transport")).toBeInTheDocument();
  });

  it("falls back to a neutral glyph when the category has no icon", () => {
    const { container } = render(
      <CategoryBadge category={{ name: "Misc", color: "#e879f9", icon: null }} />,
    );

    expect(container.querySelector("svg.lucide-tag")).toBeInTheDocument();
  });

  it("renders Uncategorized when given no category", () => {
    render(<CategoryBadge category={null} />);
    expect(screen.getByText("Uncategorized")).toBeInTheDocument();
  });

  it("renders Uncategorized when category is omitted entirely", () => {
    render(<CategoryBadge />);
    expect(screen.getByText("Uncategorized")).toBeInTheDocument();
  });
});
