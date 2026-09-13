import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Avatar from "./Avatar";

describe("Avatar", () => {
  it("renders the image when a src is provided", () => {
    const { container } = render(<Avatar src="data:image/webp;base64,AAAA" name="Grocery Store" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "data:image/webp;base64,AAAA");
  });

  it("renders a monogram fallback when src is null", () => {
    const { container } = render(<Avatar src={null} name="Grocery Store" />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("GS")).toBeInTheDocument();
  });

  it("renders a monogram fallback when no src is given at all", () => {
    render(<Avatar name="Alex Rent" />);
    expect(screen.getByText("AR")).toBeInTheDocument();
  });

  it("uses the first two letters for a single-word name", () => {
    render(<Avatar src={null} name="Netflix" />);
    expect(screen.getByText("NE")).toBeInTheDocument();
  });

  it("shows a placeholder monogram for an empty name", () => {
    render(<Avatar src={null} name="   " />);
    expect(screen.getByText("?")).toBeInTheDocument();
  });
});
