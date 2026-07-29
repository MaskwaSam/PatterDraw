import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("local SHA-256", () => {
  it("matches the standard empty and abc vectors", async () => {
    await expect(sha256Hex(new Uint8Array())).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    await expect(sha256Hex(new TextEncoder().encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("caches the digest promise for immutable byte-array identities", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(sha256Hex(bytes)).toBe(sha256Hex(bytes));
  });

  it("pads fallback blocks correctly around the SHA-256 boundary", async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {},
    });
    try {
      const vectors = [
        [55, "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"],
        [56, "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"],
        [64, "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"],
        [65, "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0"],
      ] as const;
      for (const [length, expected] of vectors) {
        await expect(sha256Hex(new Uint8Array(length).fill(0x61))).resolves.toBe(expected);
      }
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    }
  });
});
