import { describe, expect, it, vi } from "vitest";
import { createLocalId } from "./id";

describe("createLocalId", () => {
  it("uses randomUUID when the origin provides it", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    expect(createLocalId({ randomUUID })).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("creates an RFC 4122 version 4 UUID with getRandomValues on plain HTTP origins", () => {
    const getRandomValues = vi.fn((values: Uint8Array) => {
      values.set(Array.from({ length: 16 }, (_, index) => index));
      return values;
    });

    expect(createLocalId({ getRandomValues })).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});
