import { describe, expect, it } from "vitest";
import { CATEGORY_PALETTE } from "./categoryTypes";

// The vibrant categorical palette (Track G): the single sanctioned place the
// otherwise-monochrome UI uses saturated color. This list MUST stay byte-
// identical to the backend `PALETTE` tuple in
// `api/src/pecunia/models/category.py` (the two are hand-synced; see the
// cross-reference comments in both files). If you change one, change the other
// and update this expectation.
const VIBRANT_PALETTE = [
  "#22d3ee", // cyan
  "#a78bfa", // violet
  "#fbbf24", // amber
  "#fb7185", // rose
  "#38bdf8", // sky
  "#a3e635", // lime
  "#fb923c", // orange
  "#e879f9", // fuchsia
];

describe("CATEGORY_PALETTE", () => {
  it("is exactly the 8 vibrant hexes, in order, mirroring the api PALETTE", () => {
    expect(CATEGORY_PALETTE.map((swatch) => swatch.value)).toEqual(VIBRANT_PALETTE);
  });

  it("pairs every hex with a human label", () => {
    expect(CATEGORY_PALETTE).toHaveLength(8);
    for (const swatch of CATEGORY_PALETTE) {
      expect(swatch.label).toBeTruthy();
    }
  });
});
