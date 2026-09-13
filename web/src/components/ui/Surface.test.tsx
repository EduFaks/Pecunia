import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import Surface from "./Surface";

describe("Surface", () => {
  it("applies the surface-level background token class (default level 1)", () => {
    const { container } = render(<Surface>content</Surface>);
    expect(container.firstChild).toHaveClass("bg-surface-1");
  });

  it("switches surface levels via the level prop", () => {
    const { container } = render(<Surface level={3}>content</Surface>);
    expect(container.firstChild).toHaveClass("bg-surface-3");
  });

  it("always carries a hairline border", () => {
    const { container } = render(<Surface>content</Surface>);
    expect(container.firstChild).toHaveClass("border-hairline");
  });
});
