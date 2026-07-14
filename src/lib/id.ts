interface LocalRandomSource {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
}

let fallbackSequence = 0;

function browserRandomSource(): LocalRandomSource | undefined {
  return globalThis.crypto as unknown as LocalRandomSource | undefined;
}

function fillWithoutWebCrypto(values: Uint8Array): void {
  fallbackSequence = (fallbackSequence + 1) >>> 0;
  const timestamp = Date.now();
  for (let index = 0; index < values.length; index += 1) {
    values[index] = Math.floor(Math.random() * 256);
  }
  for (let index = 0; index < 6; index += 1) {
    values[index] ^= Math.floor(timestamp / (2 ** (index * 8))) & 0xff;
  }
  for (let index = 0; index < 4; index += 1) {
    values[12 + index] ^= (fallbackSequence >>> (index * 8)) & 0xff;
  }
}

/** Creates a local UUID without requiring a secure HTTP context. */
export function createLocalId(source = browserRandomSource()): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID();

  const values = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function") source.getRandomValues(values);
  else fillWithoutWebCrypto(values);

  values[6] = (values[6] & 0x0f) | 0x40;
  values[8] = (values[8] & 0x3f) | 0x80;
  const hex = Array.from(values, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
