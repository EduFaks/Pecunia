import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ImageUpload from "./ImageUpload";
import { ImageTooLargeError, fitWithin } from "./imageTransform";

describe("fitWithin", () => {
  it("downscales the longest edge to the max, preserving aspect ratio", () => {
    expect(fitWithin(512, 256, 128)).toEqual({ width: 128, height: 64 });
  });

  it("never upscales a source smaller than the max", () => {
    expect(fitWithin(64, 48, 128)).toEqual({ width: 64, height: 48 });
  });

  it("returns zero for a degenerate size", () => {
    expect(fitWithin(0, 0, 128)).toEqual({ width: 0, height: 0 });
  });
});

const DATA_URI = "data:image/webp;base64,AAAABBBBCCCC";

function file() {
  return new File(["x"], "logo.png", { type: "image/png" });
}

describe("ImageUpload", () => {
  it("produces a data-URI on file select via the transform", async () => {
    const onChange = vi.fn();
    const transformFile = vi.fn().mockResolvedValue(DATA_URI);
    render(<ImageUpload label="Avatar" value={null} onChange={onChange} transformFile={transformFile} />);

    const input = screen.getByLabelText("Avatar");
    fireEvent.change(input, { target: { files: [file()] } });

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(DATA_URI));
    expect(transformFile).toHaveBeenCalledOnce();
  });

  it("clears the value when Clear is pressed", () => {
    const onChange = vi.fn();
    render(<ImageUpload label="Avatar" value={DATA_URI} onChange={onChange} transformFile={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows a friendly message and does not call onChange when the image is too large", async () => {
    const onChange = vi.fn();
    const transformFile = vi.fn().mockRejectedValue(new ImageTooLargeError());
    render(<ImageUpload label="Avatar" value={null} onChange={onChange} transformFile={transformFile} />);

    fireEvent.change(screen.getByLabelText("Avatar"), { target: { files: [file()] } });

    expect(await screen.findByText(/couldn't use that image/i)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the current image in the preview", () => {
    const { container } = render(
      <ImageUpload label="Avatar" value={DATA_URI} onChange={vi.fn()} transformFile={vi.fn()} />,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", DATA_URI);
  });
});
