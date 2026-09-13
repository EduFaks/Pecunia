import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ContactBadge from "./ContactBadge";

describe("ContactBadge", () => {
  it("renders the contact's name", () => {
    render(<ContactBadge contact={{ name: "Grocery Store" }} />);
    expect(screen.getByText("Grocery Store")).toBeInTheDocument();
  });

  it("renders the uploaded avatar image when one is set", () => {
    const { container } = render(
      <ContactBadge contact={{ name: "Grocery Store", avatar: "data:image/webp;base64,AAAA", type: "company" }} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "data:image/webp;base64,AAAA");
  });

  it("renders a monogram fallback (no image) when the avatar is null", () => {
    const { container } = render(<ContactBadge contact={{ name: "Grocery Store", avatar: null }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("GS")).toBeInTheDocument();
  });

  it("renders nothing when given no contact", () => {
    const { container } = render(<ContactBadge contact={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the contact is omitted entirely", () => {
    const { container } = render(<ContactBadge />);
    expect(container).toBeEmptyDOMElement();
  });
});
