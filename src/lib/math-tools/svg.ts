export const MAX_MATH_SVG_BYTES = 1_000_000;
export const MAX_MATH_SVG_ELEMENTS = 5_000;
export const MAX_MATH_TOOL_DIMENSION = 4_096;

const ALLOWED_TAGS = new Set([
  "circle",
  "defs",
  "ellipse",
  "g",
  "line",
  "mask",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "rect",
  "svg",
  "text",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "aria-label",
  "cx",
  "cy",
  "d",
  "dominant-baseline",
  "fill",
  "fill-opacity",
  "fill-rule",
  "font-family",
  "font-size",
  "font-weight",
  "height",
  "id",
  "letter-spacing",
  "mask",
  "maskUnits",
  "opacity",
  "patternUnits",
  "points",
  "preserveAspectRatio",
  "r",
  "role",
  "rx",
  "ry",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "transform",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
  "xmlns",
]);

const UNSAFE_VALUE = /(?:javascript|https?|ftp|file|data)\s*:|@import|<|>/i;
const SAFE_PAINT = /^(?:none|transparent|currentColor|#[0-9a-f]{3,8}|rgba?\(\s*[\d.%]+(?:\s*,\s*[\d.%]+){2}(?:\s*,\s*[\d.%]+)?\s*\)|url\(#[a-zA-Z][\w:.-]*\))$/i;
const SAFE_INTERNAL_REFERENCE = /^url\(#[a-zA-Z][\w:.-]*\)$/;

function finitePositive(value: string | null, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_MATH_TOOL_DIMENSION) {
    throw new Error(`Math tool SVG has an invalid ${label}.`);
  }
  return parsed;
}

function assertSafeAttribute(element: Element, name: string, value: string): void {
  if (name.startsWith("data-")) return;
  if (name.startsWith("on") || !ALLOWED_ATTRIBUTES.has(name)) {
    throw new Error(`Math tool SVG contains a disallowed ${name} attribute.`);
  }
  if (name === "xmlns" && value === "http://www.w3.org/2000/svg") return;
  if (UNSAFE_VALUE.test(value)) {
    throw new Error(`Math tool SVG contains an unsafe ${name} value.`);
  }
  if ((name === "fill" || name === "stroke") && !SAFE_PAINT.test(value.trim())) {
    throw new Error(`Math tool SVG contains an unsafe ${name} paint.`);
  }
  if (name === "mask" && !SAFE_INTERNAL_REFERENCE.test(value.trim())) {
    throw new Error("Math tool SVG contains an unsafe mask reference.");
  }
  if (name === "id" && !/^[a-zA-Z][\w:.-]*$/.test(value)) {
    throw new Error("Math tool SVG contains an invalid identifier.");
  }
  if ((name === "font-family" || name === "aria-label") && value.length > 300) {
    throw new Error(`Math tool SVG ${name} is too long.`);
  }
  if (element.localName === "svg" && name === "viewBox") {
    const values = value.trim().split(/[\s,]+/).map(Number);
    if (values.length !== 4 || values.some((part) => !Number.isFinite(part)) || values[2] <= 0 || values[3] <= 0) {
      throw new Error("Math tool SVG has an invalid viewBox.");
    }
  }
}

export function sanitizeGeneratedMathSvg(source: string): string {
  const bytes = new TextEncoder().encode(source);
  if (!source.trim() || bytes.byteLength > MAX_MATH_SVG_BYTES) {
    throw new Error("Math tool SVG is empty or too large.");
  }
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  if (document.querySelector("parsererror")) throw new Error("Math tool SVG is malformed.");
  const root = document.documentElement;
  if (root.localName !== "svg") throw new Error("Math tool content must be an SVG image.");
  finitePositive(root.getAttribute("width"), "width");
  finitePositive(root.getAttribute("height"), "height");

  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  if (elements.length > MAX_MATH_SVG_ELEMENTS) throw new Error("Math tool SVG has too many elements.");
  for (const element of elements) {
    if (!ALLOWED_TAGS.has(element.localName)) {
      throw new Error(`Math tool SVG contains a disallowed ${element.localName} element.`);
    }
    for (const attribute of Array.from(element.attributes)) {
      assertSafeAttribute(element, attribute.name, attribute.value);
    }
  }
  return source;
}

export function mathSvgToDataUrl(svg: string): string {
  const safe = sanitizeGeneratedMathSvg(svg);
  const bytes = new TextEncoder().encode(safe);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export function escapeMathSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
