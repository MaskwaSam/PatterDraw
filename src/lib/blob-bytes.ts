/**
 * Returns a standard ArrayBuffer-backed view for Blob construction without
 * copying ordinary worker/browser byte arrays. SharedArrayBuffer input still
 * gets a defensive copy because it is not a valid BlobPart in every browser.
 */
export function bytesForBlob(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return Uint8Array.from(bytes);
}
