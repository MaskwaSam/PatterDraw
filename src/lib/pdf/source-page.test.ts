import { describe, expect, it } from "vitest";
import { degrees, PDFBool, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import {
  getSourcePageUserUnit,
  getVisibleSourcePageBox,
  prepareSourcePdfForEmbedding,
} from "./source-page";

function addAnnotation(
  document: PDFDocument,
  page: ReturnType<PDFDocument["addPage"]>,
  values: Record<string, unknown>,
): void {
  const annotation = document.context.obj({
    Type: "Annot",
    Rect: [10, 10, 40, 40],
    ...values,
  });
  page.node.addAnnot(document.context.register(annotation));
}

function appearanceReference(document: PDFDocument) {
  return document.context.register(document.context.flateStream(
    "q 1 0 0 rg 0 0 30 30 re f Q",
    {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: [0, 0, 30, 30],
      Resources: {},
    },
  ));
}

describe("PDF source-page preparation", () => {
  it("uses the normalized intersection of CropBox and MediaBox", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    page.setMediaBox(10, 20, 200, 300);
    page.setCropBox(-20, 100, 100, 400);

    expect(getVisibleSourcePageBox(page)).toEqual({
      left: 10,
      bottom: 100,
      right: 80,
      top: 320,
    });
  });

  it("falls back to MediaBox when CropBox does not overlap it", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    page.setMediaBox(10, 20, 200, 300);
    page.setCropBox(400, 500, 10, 10);

    expect(getVisibleSourcePageBox(page)).toEqual({
      left: 10,
      bottom: 20,
      right: 210,
      top: 320,
    });
  });

  it("rejects a visible annotation with no reusable appearance", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    addAnnotation(document, page, { Subtype: "FreeText" });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/visible FreeText annotation without a reusable appearance/);
  });

  it("drops nonvisual and display-hidden annotations without creating content", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    addAnnotation(document, page, { Subtype: "Link" });
    addAnnotation(document, page, { Subtype: "Text", F: 2 });

    prepareSourcePdfForEmbedding(document);

    expect(page.node.Annots()).toBeUndefined();
    expect(page.node.Contents()).toBeUndefined();
  });

  it("ignores zero-area and fully cropped-out annotations", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    page.setCropBox(20, 30, 160, 240);
    addAnnotation(document, page, {
      Subtype: "Text",
      Rect: [40, 40, 40, 80],
    });
    addAnnotation(document, page, {
      Subtype: "Text",
      Rect: [300, 300, 340, 340],
    });

    prepareSourcePdfForEmbedding(document);

    expect(page.node.Annots()).toBeUndefined();
    expect(page.node.Contents()).toBeUndefined();
  });

  it("does not hide standard annotation types merely because the Invisible bit is set", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    addAnnotation(document, page, {
      Subtype: "Stamp",
      F: 1,
      AP: { N: appearanceReference(document) },
    });

    prepareSourcePdfForEmbedding(document);

    expect(page.node.Contents()).toBeDefined();
  });

  it("does hide unknown annotation types whose Invisible bit is set", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    addAnnotation(document, page, { Subtype: "ClassroomCustom", F: 1 });

    prepareSourcePdfForEmbedding(document);

    expect(page.node.Contents()).toBeUndefined();
  });

  it("does not substitute another appearance when AS selects a missing state", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    addAnnotation(document, page, {
      Subtype: "Widget",
      AS: "Missing",
      AP: {
        N: {
          Off: appearanceReference(document),
          Yes: appearanceReference(document),
        },
      },
    });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/visible Widget annotation without a reusable appearance/);
  });

  it("does not invent a state when an appearance dictionary omits AS", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    addAnnotation(document, page, {
      Subtype: "Widget",
      AP: { N: { Yes: appearanceReference(document) } },
    });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/visible Widget annotation without a reusable appearance/);
  });

  it("rejects unapplied redactions instead of leaving covered content extractable", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    addAnnotation(document, page, {
      Subtype: "Redact",
      AP: { N: appearanceReference(document) },
    });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/unapplied redaction/);
  });

  it("rejects widgets whose appearances are marked for regeneration", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    document.catalog.getOrCreateAcroForm().dict.set(
      PDFName.of("NeedAppearances"),
      PDFBool.True,
    );
    addAnnotation(document, page, {
      Subtype: "Widget",
      AP: { N: appearanceReference(document) },
    });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/requires regenerated appearances/);
  });

  it("rejects signed widgets rather than preserving an untrustworthy visual signature", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    const parent = document.context.obj({
      FT: "Sig",
      V: { Type: "Sig" },
    });
    addAnnotation(document, page, {
      Subtype: "Widget",
      Parent: document.context.register(parent),
      AP: { N: appearanceReference(document) },
    });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/signed field/);
  });

  it("allows an empty signature placeholder to become ordinary page content", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    const parent = document.context.obj({ FT: "Sig" });
    addAnnotation(document, page, {
      Subtype: "Widget",
      Parent: document.context.register(parent),
      AP: { N: appearanceReference(document) },
    });

    prepareSourcePdfForEmbedding(document);

    expect(page.node.Contents()).toBeDefined();
  });

  it("rejects an appearance stream that is not a Form XObject", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    const imageAppearance = document.context.register(document.context.flateStream(
      new Uint8Array([0, 0, 0]),
      {
        Type: "XObject",
        Subtype: "Image",
        Width: 1,
        Height: 1,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
        BBox: [0, 0, 1, 1],
      },
    ));
    addAnnotation(document, page, {
      Subtype: "Stamp",
      AP: { N: imageAppearance },
    });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/invalid Stamp annotation appearance stream/);
  });

  it("treats Text annotations as implicitly NoZoom", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    addAnnotation(document, page, {
      Subtype: "Text",
      AP: { N: appearanceReference(document) },
    });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/NoZoom Text annotation/);
  });

  it("rejects explicit NoZoom annotations instead of changing their apparent size", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    addAnnotation(document, page, {
      Subtype: "Stamp",
      F: 8,
      AP: { N: appearanceReference(document) },
    });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/NoZoom Stamp annotation/);
  });

  it("rejects explicit NoRotate annotations on rotated pages", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    page.setRotation(degrees(90));
    addAnnotation(document, page, {
      Subtype: "Stamp",
      F: 16,
      AP: { N: appearanceReference(document) },
    });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/NoRotate Stamp annotation/);
  });

  it("rejects annotation transforms whose derived values overflow", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    const appearance = document.context.register(document.context.flateStream(
      "q Q",
      {
        Type: "XObject",
        Subtype: "Form",
        FormType: 1,
        BBox: [0, 0, 1e-308, 1],
        Resources: {},
      },
    ));
    addAnnotation(document, page, {
      Subtype: "Stamp",
      Rect: [10, 10, 1e308, 40],
      AP: { N: appearance },
    });

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/invalid Stamp annotation transform/);
  });

  it("keeps flattened XObjects page-local when source resources are shared", async () => {
    const document = await PDFDocument.create();
    const pageOne = document.addPage([200, 300]);
    const pageTwo = document.addPage([200, 300]);
    const sharedResources = document.context.register(document.context.obj({
      XObject: {},
    }));
    pageOne.node.set(PDFName.of("Resources"), sharedResources);
    pageTwo.node.set(PDFName.of("Resources"), sharedResources);
    addAnnotation(document, pageOne, {
      Subtype: "Stamp",
      AP: { N: appearanceReference(document) },
    });
    addAnnotation(document, pageTwo, {
      Subtype: "Stamp",
      AP: { N: appearanceReference(document) },
    });

    prepareSourcePdfForEmbedding(document);

    const resourcesOne = pageOne.node.Resources();
    const resourcesTwo = pageTwo.node.Resources();
    const xObjectsOne = resourcesOne?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    const xObjectsTwo = resourcesTwo?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    expect(resourcesOne).not.toBe(resourcesTwo);
    expect(xObjectsOne).not.toBe(xObjectsTwo);
    expect(xObjectsOne?.keys()).toHaveLength(1);
    expect(xObjectsTwo?.keys()).toHaveLength(1);
  });

  it("rejects layered source content instead of exposing an off layer", async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 300]);
    document.catalog.set(PDFName.of("OCProperties"), document.context.obj({}));

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/Layered PDF pages cannot be exported faithfully/);
  });

  it("rejects XFA instead of letting pdf-lib silently remove it", async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 300]);
    document.catalog.getOrCreateAcroForm().dict.set(
      PDFName.of("XFA"),
      PDFName.of("fixture"),
    );

    expect(() => prepareSourcePdfForEmbedding(document))
      .toThrow(/XFA form pages cannot be exported faithfully/);
  });

  it("only prepares source pages retained by the project", async () => {
    const document = await PDFDocument.create();
    const retainedPage = document.addPage([200, 300]);
    const unusedPage = document.addPage([200, 300]);
    addAnnotation(document, retainedPage, {
      Subtype: "Stamp",
      AP: { N: appearanceReference(document) },
    });
    addAnnotation(document, unusedPage, { Subtype: "Text" });

    prepareSourcePdfForEmbedding(document, [0]);

    expect(retainedPage.node.Annots()).toBeUndefined();
    expect(retainedPage.node.Contents()).toBeDefined();
    expect(unusedPage.node.Annots()?.size()).toBe(1);
  });

  it("reads a positive UserUnit and rejects an invalid one", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 300]);
    expect(getSourcePageUserUnit(page)).toBe(1);

    page.node.set(PDFName.of("UserUnit"), document.context.obj(2));
    expect(getSourcePageUserUnit(page)).toBe(2);

    page.node.set(PDFName.of("UserUnit"), document.context.obj(0));
    expect(() => getSourcePageUserUnit(page)).toThrow(/invalid UserUnit/);
  });
});
