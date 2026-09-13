import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PlumeMark from "./PlumeMark";

function pathData(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("path")).map((p) => p.getAttribute("d") ?? "");
}

describe("PlumeMark", () => {
  it("renders an svg containing the spine path", () => {
    const { container } = render(<PlumeMark />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(pathData(container).some((d) => d.startsWith("M15 40"))).toBe(true);
  });

  it("includes the barb paths in the default (detailed) variant", () => {
    const { container } = render(<PlumeMark />);
    const paths = pathData(container);
    expect(paths.some((d) => d.startsWith("M25 25"))).toBe(true);
    expect(paths.some((d) => d.startsWith("M21 31"))).toBe(true);
  });

  it("omits the barb paths when showBarbs is false (compact variant)", () => {
    const { container } = render(<PlumeMark showBarbs={false} />);
    const paths = pathData(container);
    expect(paths.some((d) => d.startsWith("M25 25"))).toBe(false);
    expect(paths.some((d) => d.startsWith("M21 31"))).toBe(false);
    // spine + vane still present
    expect(paths.some((d) => d.startsWith("M15 40"))).toBe(true);
  });

  it("is aria-hidden by default (decorative — the wordmark carries the name)", () => {
    const { container } = render(<PlumeMark />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("role");
  });

  it("becomes role=img with a <title> when a title is passed", () => {
    const { container } = render(<PlumeMark title="Pecunia" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).not.toHaveAttribute("aria-hidden");
    expect(screen.getByRole("img")).toBe(svg);
    expect(container.querySelector("title")?.textContent).toBe("Pecunia");
  });
});
