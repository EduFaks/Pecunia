import { describe, expect, it } from "vitest";
import { groupByDay } from "./dayGroups";

interface Item {
  id: number;
  occurred_at: string;
}

const NOW = new Date("2026-09-11T15:00:00.000Z");

describe("groupByDay", () => {
  it("labels an item that occurred today as 'Today'", () => {
    const groups = groupByDay<Item>([{ id: 1, occurred_at: "2026-09-11T09:00:00.000Z" }], { now: NOW });
    expect(groups).toEqual([{ label: "Today", items: [{ id: 1, occurred_at: "2026-09-11T09:00:00.000Z" }] }]);
  });

  it("labels an item from the previous calendar day as 'Yesterday'", () => {
    const groups = groupByDay<Item>([{ id: 1, occurred_at: "2026-09-10T23:59:00.000Z" }], { now: NOW });
    expect(groups[0].label).toBe("Yesterday");
  });

  it("labels an older item with its explicit formatted date", () => {
    const groups = groupByDay<Item>([{ id: 1, occurred_at: "2026-09-01T12:00:00.000Z" }], {
      now: NOW,
      dateFormat: "YYYY-MM-DD",
    });
    expect(groups[0].label).toBe("2026-09-01");
  });

  it("groups multiple items sharing a calendar day under one label, preserving item order", () => {
    const groups = groupByDay<Item>(
      [
        { id: 1, occurred_at: "2026-09-11T09:00:00.000Z" },
        { id: 2, occurred_at: "2026-09-11T08:00:00.000Z" },
        { id: 3, occurred_at: "2026-09-10T20:00:00.000Z" },
      ],
      { now: NOW },
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      label: "Today",
      items: [
        { id: 1, occurred_at: "2026-09-11T09:00:00.000Z" },
        { id: 2, occurred_at: "2026-09-11T08:00:00.000Z" },
      ],
    });
    expect(groups[1].label).toBe("Yesterday");
  });

  it("returns an empty array for an empty input", () => {
    expect(groupByDay<Item>([], { now: NOW })).toEqual([]);
  });
});
