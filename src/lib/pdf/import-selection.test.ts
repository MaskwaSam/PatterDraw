import { describe, expect, it } from "vitest";
import {
  buildPdfPageOrderAfterInsertion,
  estimatePdfImportCapacity,
  parsePdfPageRange,
  type PdfImportSelection,
} from "./import-selection";

function selection(sourcePageIndices: readonly number[]): Pick<PdfImportSelection, "sourcePageIndices"> {
  return { sourcePageIndices };
}

describe("PDF import page ranges", () => {
  it.each(["", "   ", "all", " ALL "])("selects every page for %j", (value) => {
    expect(parsePdfPageRange(value, 4)).toEqual([0, 1, 2, 3]);
  });

  it("preserves token order, range order, and repeated pages", () => {
    expect(parsePdfPageRange("3, 1-2, 3, 01", 5)).toEqual([2, 0, 1, 2, 0]);
  });

  it.each([
    ["0", /start at 1/i],
    ["2-1", /lower page to a higher page/i],
    ["6", /outside.*1–5/i],
    ["1,,2", /empty item/i],
    [",1", /empty item/i],
    ["1,", /empty item/i],
    ["-1", /valid PDF page range/i],
    ["1-", /valid PDF page range/i],
    ["1--2", /valid PDF page range/i],
    ["1-2-3", /valid PDF page range/i],
    ["1.5", /valid PDF page number/i],
    ["+1", /valid PDF page number/i],
    ["all,1", /valid PDF page number/i],
    ["9007199254740992", /valid PDF page number/i],
  ])("rejects malformed or unavailable range %j", (value, expected) => {
    expect(() => parsePdfPageRange(value, 5)).toThrow(expected);
  });

  it("bounds repeated output expansion", () => {
    expect(() => parsePdfPageRange("1,1,1", 2, 2)).toThrow(/at most 2 selected pages/i);
  });
});
describe("PDF import placement", () => {
  it.each([
    ["before", ["one", "new-a", "new-b", "two", "three"]],
    ["after", ["one", "two", "new-a", "new-b", "three"]],
    ["end", ["one", "two", "three", "new-a", "new-b"]],
  ] as const)("inserts in explicit order at %s", (placement, expected) => {
    const current = ["one", "two", "three"];
    const inserted = ["new-a", "new-b"];
    expect(buildPdfPageOrderAfterInsertion(current, inserted, placement, "two")).toEqual(expected);
    expect(current).toEqual(["one", "two", "three"]);
    expect(inserted).toEqual(["new-a", "new-b"]);
  });

  it("defaults to insertion after the selected page", () => {
    expect(buildPdfPageOrderAfterInsertion(["one", "two"], ["new"], undefined, "one"))
      .toEqual(["one", "new", "two"]);
  });

  it("rejects a stale anchor, duplicate IDs, and collisions", () => {
    expect(() => buildPdfPageOrderAfterInsertion(["one"], ["new"], "after", "missing"))
      .toThrow(/no longer in the document/i);
    expect(() => buildPdfPageOrderAfterInsertion(["one"], ["new", "new"], "end"))
      .toThrow(/duplicate page identity/i);
    expect(() => buildPdfPageOrderAfterInsertion(["one"], ["one"], "end"))
      .toThrow(/already exists/i);
  });
});

describe("PDF import capacity", () => {
  it("counts repeated selected pages without deduplication", () => {
    expect(estimatePdfImportCapacity([
      selection([0, 1, 0]),
      selection([3, 3]),
    ], 4)).toEqual({
      selectedPageCount: 5,
      remainingPageCapacity: 4,
      remainingAfterImport: 0,
      overflowPageCount: 1,
      fits: false,
    });
  });

  it("reports remaining capacity for a fitting batch", () => {
    expect(estimatePdfImportCapacity([selection([0, 1])], 5)).toMatchObject({
      selectedPageCount: 2,
      remainingAfterImport: 3,
      overflowPageCount: 0,
      fits: true,
    });
  });

  it("rejects empty selections and invalid capacity", () => {
    expect(() => estimatePdfImportCapacity([selection([])], 5)).toThrow(/at least one selected page/i);
    expect(() => estimatePdfImportCapacity([selection([0])], -1)).toThrow(/capacity is invalid/i);
  });
});
