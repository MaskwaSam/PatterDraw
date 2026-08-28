import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractProjectArchiveSync } from "./project-archive-engine";

function findCentralDirectoryEntry(bytes: Uint8Array): number {
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (
      bytes[offset] === 0x50
      && bytes[offset + 1] === 0x4b
      && bytes[offset + 2] === 0x01
      && bytes[offset + 3] === 0x02
    ) {
      return offset;
    }
  }
  throw new Error("The fixture does not contain a central directory entry.");
}

function forgeStoredOriginalSize(bytes: Uint8Array): Uint8Array {
  const forged = bytes.slice();
  const centralOffset = findCentralDirectoryEntry(forged);
  new DataView(forged.buffer, forged.byteOffset, forged.byteLength)
    .setUint32(centralOffset + 24, 0, true);
  return forged;
}

function forgeDeflatedOriginalSizeAndCrc(bytes: Uint8Array): Uint8Array {
  const forged = bytes.slice();
  const centralOffset = findCentralDirectoryEntry(forged);
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  const localOffset = view.getUint32(centralOffset + 42, true);

  // Forge both copies of the metadata so header-consistency and CRC checks
  // alone cannot distinguish the claimed empty file from the real stream.
  view.setUint32(centralOffset + 16, 0, true);
  view.setUint32(centralOffset + 24, 0, true);
  view.setUint32(localOffset + 14, 0, true);
  view.setUint32(localOffset + 22, 0, true);
  return forged;
}

function forgeDataDescriptorFlag(bytes: Uint8Array): Uint8Array {
  const forged = bytes.slice();
  const centralOffset = findCentralDirectoryEntry(forged);
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  const localOffset = view.getUint32(centralOffset + 42, true);
  view.setUint16(
    centralOffset + 8,
    view.getUint16(centralOffset + 8, true) | 0x0008,
    true,
  );
  view.setUint16(
    localOffset + 6,
    view.getUint16(localOffset + 6, true) | 0x0008,
    true,
  );
  return forged;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (
      bytes[offset] === 0x50
      && bytes[offset + 1] === 0x4b
      && bytes[offset + 2] === 0x05
      && bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  throw new Error("The fixture does not contain an end-of-central-directory record.");
}

function forgeOverlappingStoredEntries(bytes: Uint8Array): Uint8Array {
  const centralOffset = findCentralDirectoryEntry(bytes);
  const nameLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint16(centralOffset + 28, true);
  const extraLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint16(centralOffset + 30, true);
  const commentLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint16(centralOffset + 32, true);
  const recordLength = 46 + nameLength + extraLength + commentLength;
  const endOffset = findEndOfCentralDirectory(bytes);
  const forged = new Uint8Array(bytes.byteLength + recordLength);
  forged.set(bytes.subarray(0, centralOffset + recordLength));
  forged.set(bytes.subarray(centralOffset, endOffset), centralOffset + recordLength);
  forged.set(bytes.subarray(endOffset), endOffset + recordLength);

  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  // Both entries claim no uncompressed bytes, but point at the same local
  // payload. Keep the second name distinct while preserving record length.
  const duplicateOffset = centralOffset + recordLength;
  const duplicateName = new TextEncoder().encode("copybin.bin");
  forged.set(duplicateName, duplicateOffset + 46);
  view.setUint32(centralOffset + 24, 0, true);
  view.setUint32(duplicateOffset + 24, 0, true);
  const forgedEndOffset = endOffset + recordLength;
  view.setUint16(forgedEndOffset + 8, 2, true);
  view.setUint16(forgedEndOffset + 10, 2, true);
  view.setUint32(forgedEndOffset + 12, view.getUint32(forgedEndOffset + 12, true) + recordLength, true);
  return forged;
}

function forgeZip64DeflatedOriginalSize(bytes: Uint8Array): Uint8Array {
  const originalEndOffset = bytes.byteLength - 22;
  const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = source.getUint32(originalEndOffset + 16, true);
  const nameLength = source.getUint16(centralOffset + 28, true);
  const oldCentralLength = 46 + nameLength;
  const compressedSize = source.getUint32(centralOffset + 20, true);

  // Add a central ZIP64 extra field, ZIP64 end record, and locator while
  // forging only the uncompressed size down to zero.
  const forged = new Uint8Array(bytes.byteLength + 96);
  forged.set(bytes.subarray(0, centralOffset));
  forged.set(bytes.subarray(centralOffset, centralOffset + oldCentralLength), centralOffset);
  const view = new DataView(forged.buffer);
  view.setUint16(centralOffset + 6, 45, true);
  view.setUint32(centralOffset + 20, 0xffffffff, true);
  view.setUint32(centralOffset + 24, 0xffffffff, true);
  view.setUint16(centralOffset + 30, 20, true);

  const extraOffset = centralOffset + oldCentralLength;
  view.setUint16(extraOffset, 0x0001, true);
  view.setUint16(extraOffset + 2, 16, true);
  view.setBigUint64(extraOffset + 4, 0n, true);
  view.setBigUint64(extraOffset + 12, BigInt(compressedSize), true);

  const zip64EndOffset = extraOffset + 20;
  view.setUint32(zip64EndOffset, 0x06064b50, true);
  view.setBigUint64(zip64EndOffset + 4, 44n, true);
  view.setUint16(zip64EndOffset + 12, 45, true);
  view.setUint16(zip64EndOffset + 14, 45, true);
  view.setBigUint64(zip64EndOffset + 24, 1n, true);
  view.setBigUint64(zip64EndOffset + 32, 1n, true);
  view.setBigUint64(zip64EndOffset + 40, BigInt(oldCentralLength + 20), true);
  view.setBigUint64(zip64EndOffset + 48, BigInt(centralOffset), true);

  const locatorOffset = zip64EndOffset + 56;
  view.setUint32(locatorOffset, 0x07064b50, true);
  view.setBigUint64(locatorOffset + 8, BigInt(zip64EndOffset), true);
  view.setUint32(locatorOffset + 16, 1, true);

  const newEndOffset = locatorOffset + 20;
  forged.set(bytes.subarray(originalEndOffset), newEndOffset);
  view.setUint16(newEndOffset + 8, 0xffff, true);
  view.setUint16(newEndOffset + 10, 0xffff, true);
  view.setUint32(newEndOffset + 12, 0xffffffff, true);
  view.setUint32(newEndOffset + 16, 0xffffffff, true);
  return forged;
}

describe("project archive extraction limits", () => {
  it("rejects a stored entry whose central original size is forged to zero", () => {
    const payload = new Uint8Array(64 * 1024);
    payload.fill(0x41);
    const archive = forgeStoredOriginalSize(
      zipSync({ "payload.bin": payload }, { level: 0 }),
    );

    // fflate still returns the full stored payload despite the forged
    // originalSize metadata. The archive engine must reject it rather than
    // trusting the pre-extraction metadata total.
    expect(unzipSync(archive)["payload.bin"]).toHaveLength(payload.byteLength);
    expect(() => extractProjectArchiveSync(archive, archive.byteLength))
      .toThrow("Project archive metadata is inconsistent.");
  });

  it("rejects forged stored metadata before overlapping entries can amplify extraction", () => {
    const payload = new Uint8Array(96 * 1024);
    payload.fill(0x42);
    const archive = forgeOverlappingStoredEntries(
      zipSync({ "payload.bin": payload }, { level: 0 }),
    );

    const untrusted = unzipSync(archive);
    expect(untrusted["payload.bin"]).toHaveLength(payload.byteLength);
    expect(untrusted["copybin.bin"]).toHaveLength(payload.byteLength);
    expect(payload.byteLength * 2).toBeGreaterThan(archive.byteLength);
    expect(() => extractProjectArchiveSync(archive, archive.byteLength))
      .toThrow(/Project archive metadata/);
  });

  it("rejects a deflated entry whose forged zero size would otherwise truncate extraction", () => {
    const payload = new Uint8Array(64 * 1024);
    payload.fill(0x43);
    const archive = forgeStoredOriginalSize(
      zipSync({ "payload.bin": payload }, { level: 6 }),
    );

    // With a forged originalSize of zero fflate allocates an empty output,
    // so the byte-length check alone would not detect the lost payload. The
    // central-directory CRC check must reject the truncated result.
    expect(unzipSync(archive)["payload.bin"]).toHaveLength(0);
    expect(() => extractProjectArchiveSync(archive, archive.byteLength))
      .toThrow(/Project archive metadata/);
  });

  it("rejects a deflated stream when both headers forge its size and CRC as empty", () => {
    const payload = new Uint8Array(64 * 1024);
    payload.fill(0x45);
    const archive = forgeDeflatedOriginalSizeAndCrc(
      zipSync({ "payload.bin": payload }, { level: 6 }),
    );

    // fflate trusts the forged central size and returns the claimed empty
    // output. The archive engine independently inflates the bounded stream.
    expect(unzipSync(archive)["payload.bin"]).toHaveLength(0);
    expect(() => extractProjectArchiveSync(archive, archive.byteLength))
      .toThrow("Project archive metadata does not match extracted data.");
  });

  it("rejects ZIP64 rather than dropping CRC validation for forged deflate sizes", () => {
    const payload = new Uint8Array(64 * 1024);
    payload.fill(0x44);
    const archive = forgeZip64DeflatedOriginalSize(
      zipSync({ "payload.bin": payload }, { level: 6 }),
    );

    expect(unzipSync(archive)["payload.bin"]).toHaveLength(0);
    expect(() => extractProjectArchiveSync(archive, archive.byteLength))
      .toThrow("ZIP64 project archives are not supported.");
  });

  it("rejects data-descriptor archives instead of trusting unparsed trailing metadata", () => {
    const archive = forgeDataDescriptorFlag(
      zipSync({ "project.json": new TextEncoder().encode("{}") }, { level: 6 }),
    );

    expect(() => extractProjectArchiveSync(archive, archive.byteLength))
      .toThrow("Project archive metadata is inconsistent.");
  });
});
