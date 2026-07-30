import { describe, expect, it } from "vitest";
import { bytesForBlob } from "./blob-bytes";

describe("Blob byte views", () => {
  it("reuses ordinary ArrayBuffer storage without copying it", () => {
    const source = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
    const result = bytesForBlob(source);
    expect(result.buffer).toBe(source.buffer);
    expect([...result]).toEqual([2, 3]);
  });
});
