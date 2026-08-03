import {
  convertToExcalidrawElements,
  getCommonBounds,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

const MAX_SOURCE_LENGTH = 10_000;
const MAX_SOURCE_LINES = 400;
const MAX_OUTPUT_ELEMENTS = 800;
const MAX_ELEMENT_DIMENSION = 20_000;
const MAX_DIAGRAM_SPAN = 50_000;
const SUPPORTED_DIAGRAM = /^(?:flowchart|graph)\b|^sequenceDiagram\b|^classDiagram\b|^erDiagram\b|^stateDiagram(?:-v2)?\b/i;
const BLOCKED_SOURCE = [
  { pattern: /^\s*---(?:\r?\n|$)/, message: "Mermaid frontmatter is disabled." },
  { pattern: /%%\s*\{/i, message: "Mermaid configuration directives are disabled." },
  { pattern: /^\s*(?:click|callback|href)\b/im, message: "Mermaid links and callbacks are disabled." },
  { pattern: /^\s*(?:classDef|style|linkStyle)\b/im, message: "Custom Mermaid CSS and style directives are disabled." },
  { pattern: /(?:https?|javascript|data|file|ftp)\s*:|(?:^|[\s"'(])\/\//im, message: "Remote and executable URLs are disabled." },
  { pattern: /<\s*\/?\s*[a-z][^>]*>/i, message: "HTML is disabled in Mermaid diagrams." },
  { pattern: /\b(?:icon|image)\s*:/i, message: "Mermaid image and icon resources are disabled." },
];
const ALLOWED_ELEMENT_TYPES = new Set(["arrow", "diamond", "ellipse", "line", "rectangle", "text"]);
const SAFE_COLOR = /^(?:transparent|#[0-9a-f]{3,8}|rgba?\(\s*[\d.%]+(?:\s*,\s*[\d.%]+){2}(?:\s*,\s*[\d.%]+)?\s*\)|hsla?\(\s*[-\d.]+(?:deg|rad|turn)?\s*(?:,|\s)\s*[\d.]+%\s*(?:,|\s)\s*[\d.]+%(?:\s*[,/]\s*[\d.]+%?)?\s*\))$/i;

export interface RenderedMermaid {
  source: string;
  elements: readonly ExcalidrawElement[];
}

function firstDiagramLine(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("%%")) || "";
}

export function validateMermaidSource(value: string): string {
  const source = value.trim();
  if (!source) throw new Error("Enter a Mermaid diagram definition.");
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error(`Keep Mermaid definitions under ${MAX_SOURCE_LENGTH.toLocaleString()} characters.`);
  }
  if (source.split(/\r?\n/).length > MAX_SOURCE_LINES) {
    throw new Error(`Keep Mermaid definitions under ${MAX_SOURCE_LINES} lines.`);
  }
  for (const rule of BLOCKED_SOURCE) {
    if (rule.pattern.test(source)) throw new Error(rule.message);
  }
  if (!SUPPORTED_DIAGRAM.test(firstDiagramLine(source))) {
    throw new Error("Use a flowchart, sequence, class, ER, or state diagram.");
  }
  return source;
}

function isSafeColor(value: unknown): value is string {
  return typeof value === "string" && SAFE_COLOR.test(value.trim());
}

function sanitizeColor(record: Record<string, unknown>, key: string, fallback: string): void {
  if (key in record && !isSafeColor(record[key])) record[key] = fallback;
}

function sanitizeSkeleton(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("The Mermaid converter returned an invalid element.");
  const element = structuredClone(value) as Record<string, unknown>;
  if (typeof element.type !== "string" || !ALLOWED_ELEMENT_TYPES.has(element.type)) {
    throw new Error("This Mermaid diagram requires an unsafe image or unsupported element type.");
  }
  element.link = null;
  delete element.customData;
  sanitizeColor(element, "strokeColor", "#1e1e1e");
  sanitizeColor(element, "backgroundColor", "transparent");
  sanitizeColor(element, "bgColor", "transparent");
  sanitizeColor(element, "color", "#1e1e1e");
  if (element.label && typeof element.label === "object") {
    const label = { ...(element.label as Record<string, unknown>) };
    sanitizeColor(label, "color", "#1e1e1e");
    element.label = label;
  }
  return element;
}

function assertFiniteElement(element: ExcalidrawElement): void {
  const geometry = [element.x, element.y, element.width, element.height, element.angle];
  if (!geometry.every(Number.isFinite) || element.width < 0 || element.height < 0) {
    throw new Error("The Mermaid converter returned invalid geometry.");
  }
  if (element.width > MAX_ELEMENT_DIMENSION || element.height > MAX_ELEMENT_DIMENSION) {
    throw new Error("That Mermaid diagram is too large for the PatterDraw canvas.");
  }
  if ("points" in element && Array.isArray(element.points)) {
    for (const point of element.points) {
      if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        throw new Error("The Mermaid converter returned invalid line geometry.");
      }
    }
  }
}

export async function renderMermaidToElements(value: string): Promise<RenderedMermaid> {
  const source = validateMermaidSource(value);
  const runtime = await import("@excalidraw/mermaid-to-excalidraw/dist/index.js");
  const raw = await runtime.parseMermaidToExcalidraw(source, {
    startOnLoad: false,
    flowchart: { curve: "linear" },
    themeVariables: { fontSize: "20px" },
    maxEdges: 180,
    maxTextSize: MAX_SOURCE_LENGTH,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    deterministicIds: true,
    secure: ["securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "htmlLabels"],
  } as Parameters<typeof runtime.parseMermaidToExcalidraw>[1] & Record<string, unknown>);

  if (raw.files && Object.keys(raw.files).length) {
    throw new Error("This Mermaid type would require an SVG image fallback, which is disabled.");
  }
  if (!Array.isArray(raw.elements) || !raw.elements.length) {
    throw new Error("The Mermaid diagram did not produce any editable elements.");
  }
  if (raw.elements.length > MAX_OUTPUT_ELEMENTS) {
    throw new Error("That Mermaid diagram produces too many canvas objects.");
  }

  const elements = convertToExcalidrawElements(
    raw.elements.map(sanitizeSkeleton) as never,
    { regenerateIds: true },
  );
  elements.forEach(assertFiniteElement);
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  if (![minX, minY, maxX, maxY].every(Number.isFinite) ||
    maxX - minX > MAX_DIAGRAM_SPAN || maxY - minY > MAX_DIAGRAM_SPAN) {
    throw new Error("That Mermaid diagram is too large for the PatterDraw canvas.");
  }
  return { source, elements };
}
