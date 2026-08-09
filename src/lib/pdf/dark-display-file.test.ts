import { describe, expect, it, vi } from "vitest";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import {
  DARK_PDF_RELEASE_PLACEHOLDER_DATA_URL,
  retireDarkPdfDisplayFile,
} from "./dark-display-file";

describe("dark PDF display-file retirement", () => {
  it("replaces a referenced full-page raster with a one-pixel cache placeholder", () => {
    const fileId = "patterdraw-dark-pdf-test" as FileId;
    const files = {
      [fileId]: {
        id: fileId,
        mimeType: "image/svg+xml",
        dataURL: "data:image/svg+xml;base64,bGFyZ2U=",
        created: 1,
      },
    } as BinaryFiles;
    const addFiles = vi.fn((added: readonly BinaryFiles[FileId][]) => {
      expect(files[fileId]).toBeUndefined();
      for (const file of added) files[file.id] = file;
    });
    const api = {
      addFiles,
      getFiles: () => files,
      getSceneElements: () => [{
        id: "background",
        type: "image",
        fileId,
        isDeleted: false,
      }] as unknown as ReturnType<ExcalidrawImperativeAPI["getSceneElements"]>,
    };

    expect(retireDarkPdfDisplayFile(api, fileId, 42)).toBe(true);
    expect(addFiles).toHaveBeenCalledOnce();
    expect(files[fileId]).toMatchObject({
      created: 42,
      dataURL: DARK_PDF_RELEASE_PLACEHOLDER_DATA_URL,
      id: fileId,
      mimeType: "image/svg+xml",
    });
    expect(String(files[fileId]?.dataURL).length).toBeLessThan(200);
  });

  it("drops an unreferenced transient file without adding a placeholder", () => {
    const fileId = "patterdraw-dark-pdf-test" as FileId;
    const files = {
      [fileId]: {
        id: fileId,
        mimeType: "image/svg+xml",
        dataURL: DARK_PDF_RELEASE_PLACEHOLDER_DATA_URL,
        created: 1,
      },
    } as BinaryFiles;
    const addFiles = vi.fn();

    expect(retireDarkPdfDisplayFile({
      addFiles,
      getFiles: () => files,
      getSceneElements: () => [],
    }, fileId)).toBe(true);
    expect(files[fileId]).toBeUndefined();
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("does nothing once the transient file is already absent", () => {
    const addFiles = vi.fn();
    expect(retireDarkPdfDisplayFile({
      addFiles,
      getFiles: () => ({} as BinaryFiles),
      getSceneElements: () => [],
    }, "patterdraw-dark-pdf-test" as FileId)).toBe(false);
    expect(addFiles).not.toHaveBeenCalled();
  });
});
