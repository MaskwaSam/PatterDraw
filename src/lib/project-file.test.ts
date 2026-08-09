import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { createBlankProject, type SerializedScene } from "../types";
import {
  decodeProjectFile,
  encodePreparedProjectFile,
  encodeProjectFile,
} from "./project-file";
import { sanitizeProject } from "./safety";
import { MATH_TOOL_CATALOGUE } from "./math-tools/catalogue";

const MINIMAL_PDF_BASE64 = "JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDcwMDA3MzAwM0EwMDJGMDAyRjAwNjcwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwNjkwMDZFMDA2NzAwMkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyOT4KL01vZERhdGUgKEQ6MjAyNjA4MDUwMTQ2MzFaKQovQ3JlYXRvciA8RkVGRjAwNzAwMDY0MDA2NjAwMkQwMDZDMDA2OTAwNjIwMDIwMDAyODAwNjgwMDc0MDA3NDAwNzAwMDczMDAzQTAwMkYwMDJGMDA2NzAwNjkwMDc0MDA2ODAwNzUwMDYyMDAyRTAwNjMwMDZGMDA2RDAwMkYwMDQ4MDA2RjAwNzAwMDY0MDA2OTAwNkUwMDY3MDAyRjAwNzAwMDY0MDA2NjAwMkQwMDZDMDA2OTAwNjIwMDI5PgovQ3JlYXRpb25EYXRlIChEOjIwMjYwODA1MDE0NjMxWikKPj4KZW5kb2JqCgo0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9QYXJlbnQgMSAwIFIKL1Jlc291cmNlcyA8PAo+PgovTWVkaWFCb3ggWyAwIDAgNjEyIDc5MiBdCj4+CmVuZG9iagoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE2IDAwMDAwIG4gCjAwMDAwMDAwNzYgMDAwMDAgbiAKMDAwMDAwMDEyNiAwMDAwMCBuIAowMDAwMDAwNTk2IDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDUKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4KCnN0YXJ0eHJlZgo2ODcKJSVFT0Y=";
const validPdfBytes = () => Uint8Array.from(atob(MINIMAL_PDF_BASE64), (char) => char.charCodeAt(0));
const VALID_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  bytes[16] = width >>> 24;
  bytes[17] = width >>> 16;
  bytes[18] = width >>> 8;
  bytes[19] = width;
  bytes[20] = height >>> 24;
  bytes[21] = height >>> 16;
  bytes[22] = height >>> 8;
  bytes[23] = height;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

function pdfPageScene(
  id: string,
  pageIndex: number,
  width = 600,
  height = 800,
): SerializedScene {
  return {
    id,
    name: id,
    elements: [{
      id: `${id}-background`,
      type: "image",
      fileId: `${id}-file`,
      x: 0,
      y: 0,
      width,
      height,
      angle: 0,
      locked: true,
      isDeleted: false,
      opacity: 100,
      frameId: null,
      groupIds: [],
      scale: [1, 1],
      status: "saved",
      customData: {
        classroomRole: "pdf-background",
        pdfDocumentId: "pdf",
        pdfPageIndex: pageIndex,
      },
    }],
    appState: {},
    files: {
      [`${id}-file`]: {
        id: `${id}-file`,
        mimeType: "image/png",
        dataURL: VALID_PNG_DATA_URL,
      },
    },
    pdfPage: {
      documentId: "pdf",
      pageIndex,
      width,
      height,
      rotation: 0,
      backgroundElementId: `${id}-background`,
    },
  };
}

describe("classroom project files", () => {
  it("rejects an already-cancelled archive restore before extraction starts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(decodeProjectFile(
      new Uint8Array([1, 2, 3, 4]),
      undefined,
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
  });

  it("round-trips project metadata and original PDF bytes", async () => {
    const project = createBlankProject(new Date("2026-07-12T12:00:00.000Z"));
    const documentId = "pdf-1";
    const bytes = validPdfBytes();
    project.pdfDocuments[documentId] = {
      id: documentId,
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: `documents/${documentId}.pdf`,
    };
    const decoded = await decodeProjectFile(await encodeProjectFile(project, { [documentId]: bytes }));
    expect(decoded.project).toMatchObject(sanitizeProject(project));
    expect(decoded.project.pdfDocuments[documentId].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(decoded.pdfBytes[documentId]).toEqual(bytes);
  });

  it("round-trips already-sanitized state through the low-memory archive path", async () => {
    const project = createBlankProject();
    project.title = "Prepared classroom backup";
    project.titleMode = "custom";

    const decoded = await decodeProjectFile(await encodePreparedProjectFile(project, {}));

    expect(decoded.project).toMatchObject({
      id: project.id,
      title: "Prepared classroom backup",
    });
  });

  it.each([
    {
      name: "external links",
      element: { id: "unsafe", type: "rectangle", link: "https://example.invalid" },
      files: {},
      message: /External links/,
    },
    {
      name: "web embeds",
      element: { id: "unsafe", type: "embeddable" },
      files: {},
      message: /Web embeds/,
    },
    {
      name: "missing image data",
      element: { id: "unsafe", type: "image", fileId: "missing" },
      files: {},
      message: /missing its local data/,
    },
    {
      name: "unsafe image data",
      element: { id: "unsafe", type: "image", fileId: "unsafe-file" },
      files: {
        "unsafe-file": {
          id: "unsafe-file",
          mimeType: "image/png",
          dataURL: "https://example.invalid/image.png",
        },
      },
      message: /unsafe local data/,
    },
  ])("rejects $name through the prepared archive path", async ({
    element,
    files,
    message,
  }) => {
    const project = createBlankProject();
    const scene = project.scenes[project.activeSceneId];
    scene.elements = [element];
    scene.files = files as Record<string, Record<string, unknown>>;

    await expect(encodePreparedProjectFile(project, {})).rejects.toThrow(message);
  });

  it("round-trips the slide frame visibility preference", async () => {
    const project = createBlankProject();
    project.slideFramesVisible = false;
    const decoded = await decodeProjectFile(await encodeProjectFile(project, {}));
    expect(decoded.project.slideFramesVisible).toBe(false);
  });

  it("round-trips the slide-frame aspect-ratio preference", async () => {
    const project = createBlankProject();
    project.slideFrameAspectRatio = "4:3";
    const decoded = await decodeProjectFile(await encodeProjectFile(project, {}));
    expect(decoded.project.slideFrameAspectRatio).toBe("4:3");
  });

  it("migrates the legacy widescreen slide-frame preference", async () => {
    const project = createBlankProject();
    delete project.slideFrameAspectRatio;
    project.slideWidescreenFrames = true;
    const decoded = await decodeProjectFile(await encodeProjectFile(project, {}));
    expect(decoded.project.slideFrameAspectRatio).toBe("16:9");
    expect(decoded.project.slideWidescreenFrames).toBeUndefined();
  });

  it("round-trips the Morph slide-transition preference", async () => {
    const project = createBlankProject();
    project.slideMorphEnabled = true;
    project.slideMorphDurationMs = 1_250;
    const decoded = await decodeProjectFile(await encodeProjectFile(project, {}));
    expect(decoded.project.slideMorphEnabled).toBe(true);
    expect(decoded.project.slideMorphDurationMs).toBe(1_250);
  });

  it("rejects a project whose PDF bytes do not match its manifest", async () => {
    const project = createBlankProject();
    project.pdfDocuments.bad = {
      id: "bad",
      name: "bad.pdf",
      mimeType: "application/pdf",
      byteLength: 10,
      pageCount: 1,
      archivePath: "documents/bad.pdf",
    };
    await expect(encodeProjectFile(project, { bad: new Uint8Array([1]) })).rejects.toThrow(/does not match/);
  });

  it("rejects same-length PDF bytes that do not match a manifest content identity", async () => {
    const project = createBlankProject();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "source.pdf",
      mimeType: "application/pdf",
      byteLength: 4,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    await expect(
      encodeProjectFile(project, { pdf: new Uint8Array([4, 3, 2, 1]) }),
    ).rejects.toThrow(/does not match/);
  });

  it("upgrades a legacy archive with a verified PDF content identity", async () => {
    const project = createBlankProject();
    const bytes = validPdfBytes();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "legacy.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const archive = zipSync({
      "project.json": strToU8(JSON.stringify(project)),
      "documents/pdf.pdf": bytes,
    });

    await expect(decodeProjectFile(archive)).resolves.toMatchObject({
      project: {
        pdfDocuments: {
          pdf: {
            sha256: "b2771df32e3661390b42ff44701e91ce5463bbac40d9fc8f2b5e9b4f3d32b28c",
          },
        },
      },
      pdfBytes: { pdf: bytes },
    });
  });

  it("rejects an archive whose same-length PDF has the wrong content identity", async () => {
    const project = createBlankProject();
    const staleBytes = new Uint8Array([4, 3, 2, 1]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "source.pdf",
      mimeType: "application/pdf",
      byteLength: staleBytes.byteLength,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const archive = zipSync({
      "project.json": strToU8(JSON.stringify(project)),
      "documents/pdf.pdf": staleBytes,
    });

    await expect(decodeProjectFile(archive)).rejects.toThrow(/content identity/);
  });

  it("rejects archives whose expanded entries exceed the project limit", async () => {
    const archive = zipSync({
      "project.json": strToU8("x".repeat(1_024)),
    });
    expect(archive.byteLength).toBeLessThan(1_024);
    await expect(decodeProjectFile(archive, 512)).rejects.toThrow(/expands beyond/);
  });

  it("rejects a project with an oversized local raster header before archive creation", async () => {
    const project = createBlankProject();
    const scene = project.scenes[project.activeSceneId];
    scene.files.file = {
      id: "file",
      mimeType: "image/png",
      dataURL: pngDataUrl(9_000, 1),
    };
    scene.elements = [{ id: "image", type: "image", fileId: "file" }];
    await expect(encodeProjectFile(project, {}))
      .rejects.toThrow(/dimensions|decode safely/i);
  });

  it("rejects a source PDF that cannot pass embedded-image preflight before archive creation", async () => {
    const project = createBlankProject();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "malformed.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    await expect(encodeProjectFile(project, { pdf: bytes }))
      .rejects.toThrow(/could not be checked/i);
  });

  it("refuses to create a project whose complete uncompressed contents exceed the limit", async () => {
    const project = createBlankProject();
    project.title = "A".repeat(8_192);
    project.titleMode = "custom";
    await expect(encodeProjectFile(project, {}, 1_024)).rejects.toThrow(/too large to save safely/);
  });

  it("round-trips an explicit reordered PDF page list", async () => {
    const project = createBlankProject();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    source.addPage([600, 800]);
    const bytes = await source.save();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "pages.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 2,
      archivePath: "documents/pdf.pdf",
    };
    for (const [id, pageIndex] of [["page-1", 0], ["page-2", 1]] as const) {
      project.scenes[id] = pdfPageScene(id, pageIndex);
    }
    project.pdfPageOrder = ["page-2", "page-1"];
    const decoded = await decodeProjectFile(await encodeProjectFile(project, { pdf: bytes }));
    expect(decoded.project.pdfPageOrder).toEqual(["page-2", "page-1"]);
  });

  it("normalizes a legacy v1 project that has no PDF page-order field", async () => {
    const project = createBlankProject();
    const bytes = validPdfBytes();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "legacy.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    project.scenes.page = {
      ...pdfPageScene("page", 0, 612, 792),
      name: "Legacy page",
    };
    delete project.pdfPageOrder;
    const archive = zipSync({
      "project.json": strToU8(JSON.stringify(project)),
      "documents/pdf.pdf": bytes,
    });
    expect((await decodeProjectFile(archive)).project.pdfPageOrder).toEqual(["page"]);
  });

  it("rejects a restored PDF whose manifest claims a poisoned page count", async () => {
    const project = createBlankProject();
    const bytes = validPdfBytes();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "poisoned-count.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 2,
      archivePath: "documents/pdf.pdf",
    };
    project.scenes.page = pdfPageScene("page", 0, 612, 792);

    const archive = zipSync({
      "project.json": strToU8(JSON.stringify(project)),
      "documents/pdf.pdf": bytes,
    });
    await expect(decodeProjectFile(archive)).rejects.toThrow(
      /page count.*saved 2.*actual 1/i,
    );
  });

  it("rejects a restored PDF whose retained page geometry is stale", async () => {
    const project = createBlankProject();
    const bytes = validPdfBytes();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "poisoned-geometry.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    project.scenes.page = pdfPageScene("page", 0, 600, 800);

    const archive = zipSync({
      "project.json": strToU8(JSON.stringify(project)),
      "documents/pdf.pdf": bytes,
    });
    await expect(decodeProjectFile(archive)).rejects.toThrow(/geometry no longer matches/i);
  });

  it("round-trips every typed math-tool kind with its local SVG file", async () => {
    const project = createBlankProject(new Date("2026-07-15T12:00:00.000Z"));
    const scene = project.scenes[project.activeSceneId];
    const elements: Record<string, unknown>[] = [];
    let index = 0;
    for (const definition of MATH_TOOL_CATALOGUE) {
      const generated = definition.generate(definition.defaultConfiguration);
      const pieces = "pieces" in generated ? generated.pieces : [{ asset: generated.asset, metadata: generated.metadata }];
      for (const piece of pieces) {
        const fileId = `math-file-${index}`;
        scene.files[fileId] = { id: fileId, mimeType: "image/svg+xml", dataURL: piece.asset.dataUrl };
        elements.push({ id: `math-element-${index}`, type: "image", fileId, width: piece.asset.width, height: piece.asset.height, customData: { classroomMathTool: piece.metadata } });
        index += 1;
      }
    }
    scene.elements = elements;

    const decoded = (await decodeProjectFile(await encodeProjectFile(project, {}))).project;
    const metadata = decoded.scenes[decoded.activeSceneId].elements.map((element) => (element.customData as { classroomMathTool: Record<string, unknown> }).classroomMathTool);
    expect(metadata).toHaveLength(index);
    expect(new Set(metadata.map((item) => item.kind))).toEqual(new Set(MATH_TOOL_CATALOGUE.map((definition) => definition.kind)));
    expect(Object.values(decoded.scenes[decoded.activeSceneId].files)).toHaveLength(index);
    expect(Object.values(decoded.scenes[decoded.activeSceneId].files).every((file) => String(file.dataURL).startsWith("data:image/svg+xml;base64,"))).toBe(true);
  });
});
