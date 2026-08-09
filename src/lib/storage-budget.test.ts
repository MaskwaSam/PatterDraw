import { describe, expect, it } from "vitest";
import {
  assertAuxiliaryStoragePhysicalValuesFit,
  assertAuxiliaryStorageValuesFit,
  estimateStructuredStorageBytes,
} from "./storage-budget";

describe("shared auxiliary storage budget", () => {
  it("counts Blob payload bytes as well as structured metadata", () => {
    const blob = new Blob(["1234567890"], { type: "image/png" });
    expect(estimateStructuredStorageBytes({ version: 1, items: [{ blob }] })).toBeGreaterThan(10);
  });

  it("shares one ceiling between personal and screenshot libraries", () => {
    const library = [{ dataURL: `data:image/png;base64,${"A".repeat(80)}` }];
    const screenshots = {
      version: 1,
      items: [{ blob: new Blob(["B".repeat(80)], { type: "image/png" }) }],
    };
    expect(() => assertAuxiliaryStorageValuesFit(library, screenshots, 120))
      .toThrow(/Libraries are full/);
  });

  it("accepts both libraries when their combined payload fits", () => {
    expect(assertAuxiliaryStorageValuesFit([{ id: "shape" }], { version: 1, items: [] }, 1_024))
      .toBeLessThan(1_024);
  });

  it("counts canonical and legacy physical records instead of coalescing duplicate keys", () => {
    const canonical = { items: [{ id: "canonical", payload: "x".repeat(40) }] };
    const legacy = { items: [{ id: "legacy", payload: "y".repeat(40) }] };
    const oneRecord = estimateStructuredStorageBytes(canonical);
    expect(() => assertAuxiliaryStoragePhysicalValuesFit([canonical, legacy], oneRecord + 1))
      .toThrow(/Libraries are full/);
  });
});
