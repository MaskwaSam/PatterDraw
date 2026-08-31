import type { PdfInsertionPlacement, SceneId } from "../../types";
import { MAX_PDF_PAGES } from "../safety";

export const DEFAULT_PDF_INSERTION_PLACEMENT: PdfInsertionPlacement = "after";

/** One inspected local PDF in the user-controlled batch order. */
export interface PdfImportSelection {
  file: File;
  /** Teacher-facing source label; defaults to the local file name. */
  sourceName?: string;
  /** SHA-256 of the immutable local source bytes. */
  sha256: string;
  /** Authoritative source page count reported by PDF.js. */
  pageCount: number;
  /** Zero-based source indices in explicit output order. Repeats are allowed. */
  sourcePageIndices: readonly number[];
  /** Stable identity for this occurrence even when source bytes are deduplicated. */
  sourceInstanceId: string;
}

/** Complete ordered batch selection passed from the dialog to atomic import. */
export interface OrderedPdfImportSelection {
  documents: readonly PdfImportSelection[];
  placement: PdfInsertionPlacement;
}

export interface PdfImportCapacityEstimate {
  selectedPageCount: number;
  remainingPageCapacity: number;
  remainingAfterImport: number;
  overflowPageCount: number;
  fits: boolean;
}

function parseOneBasedPage(value: string, pageCount: number): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`“${value}” is not a valid PDF page number.`);
  }
  const page = Number(value);
  if (!Number.isSafeInteger(page)) {
    throw new Error(`“${value}” is not a valid PDF page number.`);
  }
  if (page < 1) {
    throw new Error("PDF page numbers start at 1.");
  }
  if (page > pageCount) {
    throw new Error(`PDF page ${page} is outside this document's 1–${pageCount} range.`);
  }
  return page;
}

function appendSelectedPage(
  result: number[],
  zeroBasedPageIndex: number,
  maxSelectedPages: number,
): void {
  if (result.length >= maxSelectedPages) {
    throw new Error(`A PDF import can contain at most ${maxSelectedPages} selected pages.`);
  }
  result.push(zeroBasedPageIndex);
}

/**
 * Parses a teacher-facing, one-based page range into immutable zero-based
 * source indices. Blank input and `all` select the full document. Token order
 * and repeated pages are intentionally retained for explicit output order.
 */
export function parsePdfPageRange(
  input: string,
  pageCount: number,
  maxSelectedPages = MAX_PDF_PAGES,
): number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error("The PDF page count is invalid.");
  }
  if (!Number.isSafeInteger(maxSelectedPages) || maxSelectedPages < 1) {
    throw new Error("The PDF selection limit is invalid.");
  }

  const normalized = input.trim();
  if (!normalized || normalized.toLowerCase() === "all") {
    if (pageCount > maxSelectedPages) {
      throw new Error(`A PDF import can contain at most ${maxSelectedPages} selected pages.`);
    }
    return Array.from({ length: pageCount }, (_, index) => index);
  }

  const result: number[] = [];
  for (const rawToken of normalized.split(",")) {
    const token = rawToken.trim();
    if (!token) throw new Error("PDF page ranges cannot contain an empty item.");

    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = parseOneBasedPage(range[1], pageCount);
      const end = parseOneBasedPage(range[2], pageCount);
      if (end < start) {
        throw new Error(`PDF page range ${start}-${end} must run from a lower page to a higher page.`);
      }
      for (let page = start; page <= end; page += 1) {
        appendSelectedPage(result, page - 1, maxSelectedPages);
      }
      continue;
    }

    if (token.includes("-")) {
      throw new Error(`“${token}” is not a valid PDF page range.`);
    }
    appendSelectedPage(result, parseOneBasedPage(token, pageCount) - 1, maxSelectedPages);
  }
  return result;
}

function assertUniquePageIds(ids: readonly SceneId[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id) throw new Error(`${label} contains an invalid page identity.`);
    if (seen.has(id)) throw new Error(`${label} contains a duplicate page identity.`);
    seen.add(id);
  }
}

/** Builds the authoritative explicit PDF page order for one atomic insertion. */
export function buildPdfPageOrderAfterInsertion(
  currentOrder: readonly SceneId[],
  insertedPageIds: readonly SceneId[],
  placement: PdfInsertionPlacement = DEFAULT_PDF_INSERTION_PLACEMENT,
  selectedPageId?: SceneId,
): SceneId[] {
  assertUniquePageIds(currentOrder, "The current PDF page order");
  assertUniquePageIds(insertedPageIds, "The inserted PDF pages");
  if (!insertedPageIds.length) throw new Error("Select at least one PDF page to insert.");

  const existing = new Set(currentOrder);
  if (insertedPageIds.some((id) => existing.has(id))) {
    throw new Error("An inserted PDF page already exists in the document order.");
  }
  if (placement !== "before" && placement !== "after" && placement !== "end") {
    throw new Error("The PDF insertion placement is invalid.");
  }
  if (placement === "end") return [...currentOrder, ...insertedPageIds];

  const selectedIndex = selectedPageId ? currentOrder.indexOf(selectedPageId) : -1;
  if (selectedIndex < 0) {
    throw new Error("The selected PDF page is no longer in the document.");
  }
  const insertionIndex = selectedIndex + (placement === "after" ? 1 : 0);
  return [
    ...currentOrder.slice(0, insertionIndex),
    ...insertedPageIds,
    ...currentOrder.slice(insertionIndex),
  ];
}

function selectedPageCount(selections: readonly Pick<PdfImportSelection, "sourcePageIndices">[]): number {
  let total = 0;
  for (const selection of selections) {
    if (!Array.isArray(selection.sourcePageIndices) || selection.sourcePageIndices.length < 1) {
      throw new Error("Each PDF must contain at least one selected page.");
    }
    total += selection.sourcePageIndices.length;
    if (!Number.isSafeInteger(total)) throw new Error("The PDF selection is too large.");
  }
  return total;
}

/** Estimates the batch against the caller's current project-scene capacity. */
export function estimatePdfImportCapacity(
  selections: readonly Pick<PdfImportSelection, "sourcePageIndices">[],
  remainingPageCapacity: number,
): PdfImportCapacityEstimate {
  if (!Number.isSafeInteger(remainingPageCapacity) || remainingPageCapacity < 0) {
    throw new Error("The remaining PDF page capacity is invalid.");
  }
  const count = selectedPageCount(selections);
  const overflowPageCount = Math.max(0, count - remainingPageCapacity);
  return Object.freeze({
    selectedPageCount: count,
    remainingPageCapacity,
    remainingAfterImport: Math.max(0, remainingPageCapacity - count),
    overflowPageCount,
    fits: overflowPageCount === 0,
  });
}
