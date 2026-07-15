import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { createBlankProject } from "../types";
import { decodeProjectFile, encodeProjectFile } from "./project-file";
import { sanitizeProject } from "./safety";
import { MATH_TOOL_CATALOGUE } from "./math-tools/catalogue";

describe("classroom project files", () => {
  it("round-trips project metadata and original PDF bytes", () => {
    const project = createBlankProject(new Date("2026-07-12T12:00:00.000Z"));
    const documentId = "pdf-1";
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    project.pdfDocuments[documentId] = {
      id: documentId,
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: `documents/${documentId}.pdf`,
    };
    const decoded = decodeProjectFile(encodeProjectFile(project, { [documentId]: bytes }));
    expect(decoded.project).toEqual(sanitizeProject(project));
    expect(decoded.pdfBytes[documentId]).toEqual(bytes);
  });

  it("round-trips the slide frame visibility preference", () => {
    const project = createBlankProject();
    project.slideFramesVisible = false;
    const decoded = decodeProjectFile(encodeProjectFile(project, {}));
    expect(decoded.project.slideFramesVisible).toBe(false);
  });

  it("rejects a project whose PDF bytes do not match its manifest", () => {
    const project = createBlankProject();
    project.pdfDocuments.bad = {
      id: "bad",
      name: "bad.pdf",
      mimeType: "application/pdf",
      byteLength: 10,
      pageCount: 1,
      archivePath: "documents/bad.pdf",
    };
    expect(() => encodeProjectFile(project, { bad: new Uint8Array([1]) })).toThrow(/does not match/);
  });

  it("round-trips an explicit reordered PDF page list", () => {
    const project = createBlankProject();
    const bytes = new Uint8Array([37, 80, 68, 70]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "pages.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 2,
      archivePath: "documents/pdf.pdf",
    };
    for (const [id, pageIndex] of [["page-1", 0], ["page-2", 1]] as const) {
      project.scenes[id] = {
        id,
        name: id,
        elements: [],
        appState: {},
        files: {},
        pdfPage: { documentId: "pdf", pageIndex, width: 600, height: 800, rotation: 0, backgroundElementId: `${id}-background` },
      };
    }
    project.pdfPageOrder = ["page-2", "page-1"];
    const decoded = decodeProjectFile(encodeProjectFile(project, { pdf: bytes }));
    expect(decoded.project.pdfPageOrder).toEqual(["page-2", "page-1"]);
  });

  it("normalizes a legacy v1 project that has no PDF page-order field", () => {
    const project = createBlankProject();
    const bytes = new Uint8Array([37, 80, 68, 70]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "legacy.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    project.scenes.page = {
      id: "page",
      name: "Legacy page",
      elements: [],
      appState: {},
      files: {},
      pdfPage: { documentId: "pdf", pageIndex: 0, width: 600, height: 800, rotation: 0, backgroundElementId: "page-background" },
    };
    delete project.pdfPageOrder;
    const archive = zipSync({
      "project.json": strToU8(JSON.stringify(project)),
      "documents/pdf.pdf": bytes,
    });
    expect(decodeProjectFile(archive).project.pdfPageOrder).toEqual(["page"]);
  });

  it("round-trips every typed math-tool kind with its local SVG file", () => {
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

    const decoded = decodeProjectFile(encodeProjectFile(project, {})).project;
    const metadata = decoded.scenes[decoded.activeSceneId].elements.map((element) => (element.customData as { classroomMathTool: Record<string, unknown> }).classroomMathTool);
    expect(metadata).toHaveLength(index);
    expect(new Set(metadata.map((item) => item.kind))).toEqual(new Set(MATH_TOOL_CATALOGUE.map((definition) => definition.kind)));
    expect(Object.values(decoded.scenes[decoded.activeSceneId].files)).toHaveLength(index);
    expect(Object.values(decoded.scenes[decoded.activeSceneId].files).every((file) => String(file.dataURL).startsWith("data:image/svg+xml;base64,"))).toBe(true);
  });
});
