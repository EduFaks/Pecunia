import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CurrencySelect from "./CurrencySelect";

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <CurrencySelect value={value} onChange={setValue} />;
}

function openList() {
  fireEvent.focus(screen.getByRole("combobox"));
}

describe("CurrencySelect", () => {
  it("shows the common currencies first (USD, EUR, BRL, GBP, JPY, …) before the rest, with no query", () => {
    render(<CurrencySelect value="" onChange={vi.fn()} />);
    openList();

    const options = screen.getAllByRole("option").map((el) => el.textContent ?? "");
    const codesInOrder = options.map((text) => text.slice(0, 3));
    const commonPrefix = ["USD", "EUR", "BRL", "GBP", "JPY"];
    expect(codesInOrder.slice(0, commonPrefix.length)).toEqual(commonPrefix);
  });

  it("filters currencies by typing a code or a name", () => {
    render(<CurrencySelect value="" onChange={vi.fn()} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "real" } });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("BRL");
  });

  it("selecting an option calls onChange with the 3-letter code", () => {
    const onChange = vi.fn();
    render(<CurrencySelect value="" onChange={onChange} />);
    openList();

    fireEvent.click(screen.getByRole("option", { name: /^EUR/ }));

    expect(onChange).toHaveBeenCalledWith("EUR");
  });

  it("renders no selection ring before a currency is chosen", () => {
    render(<CurrencySelect value="" onChange={vi.fn()} />);
    expect(screen.queryByTestId("currency-select-circle")).not.toBeInTheDocument();
  });

  it("shows a selection ring around the chosen currency once one is selected", () => {
    render(<Harness />);
    openList();
    fireEvent.click(screen.getByRole("option", { name: /^EUR/ }));

    expect(screen.getByTestId("currency-select-circle")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument();
  });

  it("shows the currently selected code in the hero display for a controlled value", () => {
    render(<CurrencySelect value="JPY" onChange={vi.fn()} />);
    expect(screen.getByTestId("currency-select-circle")).toBeInTheDocument();
    expect(screen.getByText("JPY")).toBeInTheDocument();
  });
});
