import {
  concatTransformationMatrix,
  drawObject,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNumber,
  type PDFDocument,
  type PDFPage,
  PDFStream,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";

export interface PdfSourcePageBox {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

interface NormalizedRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

type TransformationMatrix = readonly [number, number, number, number, number, number];

const IDENTITY_MATRIX: TransformationMatrix = [1, 0, 0, 1, 0, 0];
const HIDDEN_ANNOTATION_FLAGS = 2 | 32;
const INVISIBLE_ANNOTATION_FLAG = 1;
const NO_ZOOM_ANNOTATION_FLAG = 8;
const NO_ROTATE_ANNOTATION_FLAG = 16;
const STANDARD_ANNOTATION_SUBTYPES = new Set([
  "3D",
  "Caret",
  "Circle",
  "FileAttachment",
  "FreeText",
  "Highlight",
  "Ink",
  "Line",
  "Link",
  "Movie",
  "PolyLine",
  "Polygon",
  "Popup",
  "PrinterMark",
  "Projection",
  "Redact",
  "RichMedia",
  "Screen",
  "Sound",
  "Square",
  "Squiggly",
  "Stamp",
  "StrikeOut",
  "Text",
  "TrapNet",
  "Underline",
  "Watermark",
  "Widget",
]);

const ANNOTS = PDFName.of("Annots");
const AP = PDFName.of("AP");
const AS = PDFName.of("AS");
const BBOX = PDFName.of("BBox");
const FT = PDFName.of("FT");
const F = PDFName.of("F");
const FORM_TYPE = PDFName.of("FormType");
const MATRIX = PDFName.of("Matrix");
const N = PDFName.of("N");
const NEED_APPEARANCES = PDFName.of("NeedAppearances");
const OC = PDFName.of("OC");
const OC_PROPERTIES = PDFName.of("OCProperties");
const PARENT = PDFName.of("Parent");
const RECT = PDFName.of("Rect");
const RESOURCES = PDFName.of("Resources");
const SUBTYPE = PDFName.of("Subtype");
const USER_UNIT = PDFName.of("UserUnit");
const V = PDFName.of("V");
const X_OBJECT = PDFName.of("XObject");
const XFA = PDFName.of("XFA");

function normalizeRectangle(
  rectangle: { x: number; y: number; width: number; height: number },
): NormalizedRectangle {
  const x2 = rectangle.x + rectangle.width;
  const y2 = rectangle.y + rectangle.height;
  const x = Math.min(rectangle.x, x2);
  const y = Math.min(rectangle.y, y2);
  return {
    x,
    y,
    width: Math.max(rectangle.x, x2) - x,
    height: Math.max(rectangle.y, y2) - y,
  };
}

function finiteRectangle(
  rectangle: NormalizedRectangle,
  description: string,
  allowEmpty = false,
): NormalizedRectangle {
  if (
    !Number.isFinite(rectangle.x)
    || !Number.isFinite(rectangle.y)
    || !Number.isFinite(rectangle.width)
    || !Number.isFinite(rectangle.height)
    || rectangle.width < 0
    || rectangle.height < 0
    || (!allowEmpty && (rectangle.width === 0 || rectangle.height === 0))
  ) {
    throw new Error(`The PDF has an invalid ${description}.`);
  }
  return rectangle;
}

function rectangleFromArray(
  array: PDFArray,
  description: string,
  allowEmpty = false,
): NormalizedRectangle {
  if (array.size() !== 4) throw new Error(`The PDF has an invalid ${description}.`);
  return finiteRectangle(normalizeRectangle(array.asRectangle()), description, allowEmpty);
}

function numberArray(array: PDFArray, length: number, description: string): number[] {
  if (array.size() !== length) throw new Error(`The PDF has an invalid ${description}.`);
  const values: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const value = array.lookupMaybe(index, PDFNumber)?.asNumber();
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`The PDF has an invalid ${description}.`);
    }
    values.push(value);
  }
  return values;
}

function annotationDescription(annotation: PDFDict): string {
  return annotation.lookupMaybe(SUBTYPE, PDFName)?.decodeText() || "unknown";
}

function annotationFlags(annotation: PDFDict): number {
  return annotation.lookupMaybe(F, PDFNumber)?.asNumber() || 0;
}

function inheritableName(dictionary: PDFDict, name: PDFName): PDFName | undefined {
  const visited = new Set<PDFDict>();
  let current: PDFDict | undefined = dictionary;
  while (current && !visited.has(current)) {
    visited.add(current);
    const value = current.lookupMaybe(name, PDFName);
    if (value) return value;
    current = current.lookupMaybe(PARENT, PDFDict);
  }
  return undefined;
}

function inheritableDictionary(dictionary: PDFDict, name: PDFName): PDFDict | undefined {
  const visited = new Set<PDFDict>();
  let current: PDFDict | undefined = dictionary;
  while (current && !visited.has(current)) {
    visited.add(current);
    const value = current.lookupMaybe(name, PDFDict);
    if (value) return value;
    current = current.lookupMaybe(PARENT, PDFDict);
  }
  return undefined;
}

function normalAppearance(annotation: PDFDict): PDFStream | null {
  const appearances = annotation.lookupMaybe(AP, PDFDict);
  const rawNormal = appearances?.get(N);
  const resolvedNormal = annotation.context.lookup(rawNormal);
  if (resolvedNormal instanceof PDFStream) return resolvedNormal;
  if (!(resolvedNormal instanceof PDFDict)) return null;

  const state = annotation.lookupMaybe(AS, PDFName);
  if (state) {
    const selected = annotation.context.lookup(resolvedNormal.get(state));
    return selected instanceof PDFStream ? selected : null;
  }
  return null;
}

function appearanceMatrix(appearance: PDFStream): TransformationMatrix {
  const matrix = appearance.dict.lookupMaybe(MATRIX, PDFArray);
  if (!matrix) return IDENTITY_MATRIX;
  return numberArray(matrix, 6, "annotation appearance matrix") as unknown as TransformationMatrix;
}

function transformedBounds(
  rectangle: NormalizedRectangle,
  matrix: TransformationMatrix,
): NormalizedRectangle {
  const [a, b, c, d, e, f] = matrix;
  const x2 = rectangle.x + rectangle.width;
  const y2 = rectangle.y + rectangle.height;
  const corners = [
    [rectangle.x, rectangle.y],
    [rectangle.x, y2],
    [x2, rectangle.y],
    [x2, y2],
  ].map(([x, y]) => ({
    x: a * x + c * y + e,
    y: b * x + d * y + f,
  }));
  const xs = corners.map(({ x }) => x);
  const ys = corners.map(({ y }) => y);
  return finiteRectangle({
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }, "annotation appearance bounds");
}

function flattenAnnotation(
  page: PDFPage,
  annotation: PDFDict,
  pageIndex: number,
  sourceBox: PdfSourcePageBox,
): void {
  const flags = annotationFlags(annotation);
  if ((flags & HIDDEN_ANNOTATION_FLAGS) !== 0) return;

  const subtype = annotationDescription(annotation);
  if (
    (flags & INVISIBLE_ANNOTATION_FLAG) !== 0
    && !STANDARD_ANNOTATION_SUBTYPES.has(subtype)
  ) return;
  const rectArray = annotation.lookupMaybe(RECT, PDFArray);
  if (!rectArray) return;
  const rectangle = rectangleFromArray(rectArray, "annotation rectangle", true);
  if (rectangle.width === 0 || rectangle.height === 0) return;
  if (
    rectangle.x >= sourceBox.right
    || rectangle.y >= sourceBox.top
    || rectangle.x + rectangle.width <= sourceBox.left
    || rectangle.y + rectangle.height <= sourceBox.bottom
  ) return;

  if (annotation.has(OC)) {
    throw new Error(
      `Page ${pageIndex + 1} has a layered ${subtype} annotation that cannot be flattened faithfully.`,
    );
  }
  if (subtype === "Redact") {
    throw new Error(
      `Page ${pageIndex + 1} has an unapplied redaction that cannot be exported safely.`,
    );
  }
  if (subtype === "Widget") {
    if (
      page.doc.catalog.getAcroForm()?.dict
        .lookupMaybe(NEED_APPEARANCES, PDFBool)?.asBoolean()
    ) {
      throw new Error(
        `Page ${pageIndex + 1} has a form that requires regenerated appearances.`,
      );
    }
    if (
      inheritableName(annotation, FT)?.decodeText() === "Sig"
      && inheritableDictionary(annotation, V)
    ) {
      throw new Error(
        `Page ${pageIndex + 1} has a signed field that cannot remain trustworthy in a new PDF.`,
      );
    }
  }
  if ((flags & NO_ZOOM_ANNOTATION_FLAG) !== 0 || subtype === "Text") {
    throw new Error(
      `Page ${pageIndex + 1} has a NoZoom ${subtype} annotation that cannot be flattened faithfully.`,
    );
  }
  const appearance = normalAppearance(annotation);
  if (!appearance) {
    // Link and Popup annotations are supplied by an interactive annotation
    // layer rather than the page canvas used for PatterDraw's local preview.
    if (subtype === "Link" || subtype === "Popup") return;
    throw new Error(
      `Page ${pageIndex + 1} has a visible ${subtype} annotation without a reusable appearance.`,
    );
  }
  const appearanceSubtype = appearance.dict.lookupMaybe(SUBTYPE, PDFName)?.decodeText();
  const appearanceFormType = appearance.dict.lookupMaybe(FORM_TYPE, PDFNumber)?.asNumber();
  if (
    appearanceSubtype !== "Form"
    || (appearanceFormType !== undefined && appearanceFormType !== 1)
  ) {
    throw new Error(
      `Page ${pageIndex + 1} has an invalid ${subtype} annotation appearance stream.`,
    );
  }

  const bboxArray = appearance.dict.lookupMaybe(BBOX, PDFArray);
  if (!bboxArray) {
    throw new Error(`Page ${pageIndex + 1} has an incomplete ${subtype} annotation appearance.`);
  }
  if (
    ((flags & NO_ROTATE_ANNOTATION_FLAG) !== 0 || subtype === "Text")
    && page.getRotation().angle % 360 !== 0
  ) {
    throw new Error(
      `Page ${pageIndex + 1} has a NoRotate ${subtype} annotation that cannot be flattened faithfully.`,
    );
  }

  const appearanceBounds = transformedBounds(
    rectangleFromArray(bboxArray, "annotation appearance bounding box"),
    appearanceMatrix(appearance),
  );
  const scaleX = rectangle.width / appearanceBounds.width;
  const scaleY = rectangle.height / appearanceBounds.height;
  const translateX = rectangle.x - scaleX * appearanceBounds.x;
  const translateY = rectangle.y - scaleY * appearanceBounds.y;
  if (![scaleX, scaleY, translateX, translateY].every(Number.isFinite)) {
    throw new Error(`Page ${pageIndex + 1} has an invalid ${subtype} annotation transform.`);
  }
  const appearanceRef = page.doc.context.getObjectRef(appearance)
    ?? page.doc.context.register(appearance);
  const xObjectKey = page.node.newXObject("FlatAnnot", appearanceRef);

  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(scaleX, 0, 0, scaleY, translateX, translateY),
    drawObject(xObjectKey),
    popGraphicsState(),
  );
}

function materializePageResources(page: PDFPage): void {
  const context = page.doc.context;
  const inheritedResources = page.node.Resources();
  const localResources = inheritedResources?.clone(context) ?? context.obj({});
  const inheritedXObjects = inheritedResources?.lookupMaybe(X_OBJECT, PDFDict);
  const localXObjects = inheritedXObjects?.clone(context) ?? context.obj({});
  localResources.set(X_OBJECT, localXObjects);
  page.node.set(RESOURCES, localResources);
}

function flattenPageAnnotations(page: PDFPage, pageIndex: number): void {
  const annotations = page.node.Annots();
  if (!annotations) return;
  const sourceBox = getVisibleSourcePageBox(page);
  // pdf-lib otherwise mutates inherited resource dictionaries while adding
  // XObjects, making each page retain every flattened appearance in the file.
  materializePageResources(page);

  for (let index = 0; index < annotations.size(); index += 1) {
    const rawAnnotation = annotations.get(index);
    const annotation = page.doc.context.lookupMaybe(rawAnnotation, PDFDict);
    // Some PDFs contain stale annotation references. They cannot contribute
    // visible source content, so ignore them rather than failing page export.
    if (annotation) flattenAnnotation(page, annotation, pageIndex, sourceBox);
  }

  // Interactive behavior is intentionally not copied into the classroom
  // export. Every reusable visible appearance is now part of page content.
  page.node.delete(ANNOTS);
}

export function prepareSourcePdfForEmbedding(
  document: PDFDocument,
  pageIndexes?: Iterable<number>,
): void {
  if (document.catalog.getAcroForm()?.dict.has(XFA)) {
    throw new Error("XFA form pages cannot be exported faithfully without rasterizing them.");
  }
  if (document.catalog.has(OC_PROPERTIES)) {
    throw new Error("Layered PDF pages cannot be exported faithfully without changing layer visibility.");
  }
  const indexes = pageIndexes
    ? Array.from(new Set(pageIndexes))
    : document.getPages().map((_, pageIndex) => pageIndex);
  for (const pageIndex of indexes) {
    if (
      !Number.isInteger(pageIndex)
      || pageIndex < 0
      || pageIndex >= document.getPageCount()
    ) {
      throw new Error("The project refers to a PDF page that does not exist.");
    }
    flattenPageAnnotations(document.getPage(pageIndex), pageIndex);
  }
}

export function getVisibleSourcePageBox(page: PDFPage): PdfSourcePageBox {
  const media = finiteRectangle(
    normalizeRectangle(page.getMediaBox()),
    "PDF media box",
  );
  const crop = finiteRectangle(
    normalizeRectangle(page.getCropBox()),
    "PDF crop box",
  );
  const left = Math.max(media.x, crop.x);
  const bottom = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);

  if (right > left && top > bottom) return { left, bottom, right, top };
  return {
    left: media.x,
    bottom: media.y,
    right: media.x + media.width,
    top: media.y + media.height,
  };
}

export function getSourcePageUserUnit(page: PDFPage): number {
  const userUnit = page.node.lookupMaybe(USER_UNIT, PDFNumber)?.asNumber() ?? 1;
  if (!Number.isFinite(userUnit) || userUnit <= 0) {
    throw new Error("The PDF has an invalid UserUnit value.");
  }
  return userUnit;
}
