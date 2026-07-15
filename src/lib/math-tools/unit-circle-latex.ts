import { renderLatexToSvg, type RenderedLatex } from "../latex/render-latex";
import {
  createUnitCircleAsset,
  type UnitCircleLabelMode,
  type UnitCircleRenderedMathLabel,
  type UnitCircleRenderedMathLabels,
} from "./static-tools";

const RADIAN_LATEX = new Map<number, string>([
  [0, "0"], [30, "\\frac{\\pi}{6}"], [45, "\\frac{\\pi}{4}"], [60, "\\frac{\\pi}{3}"], [90, "\\frac{\\pi}{2}"],
  [120, "\\frac{2\\pi}{3}"], [135, "\\frac{3\\pi}{4}"], [150, "\\frac{5\\pi}{6}"], [180, "\\pi"],
  [210, "\\frac{7\\pi}{6}"], [225, "\\frac{5\\pi}{4}"], [240, "\\frac{4\\pi}{3}"], [270, "\\frac{3\\pi}{2}"],
  [300, "\\frac{5\\pi}{3}"], [315, "\\frac{7\\pi}{4}"], [330, "\\frac{11\\pi}{6}"],
]);

const COORDINATE_LATEX = new Map<number, string>([
  [0, "(1,0)"], [30, "(\\frac{\\sqrt{3}}{2},\\frac{1}{2})"], [45, "(\\frac{\\sqrt{2}}{2},\\frac{\\sqrt{2}}{2})"], [60, "(\\frac{1}{2},\\frac{\\sqrt{3}}{2})"], [90, "(0,1)"],
  [120, "(-\\frac{1}{2},\\frac{\\sqrt{3}}{2})"], [135, "(-\\frac{\\sqrt{2}}{2},\\frac{\\sqrt{2}}{2})"], [150, "(-\\frac{\\sqrt{3}}{2},\\frac{1}{2})"], [180, "(-1,0)"],
  [210, "(-\\frac{\\sqrt{3}}{2},-\\frac{1}{2})"], [225, "(-\\frac{\\sqrt{2}}{2},-\\frac{\\sqrt{2}}{2})"], [240, "(-\\frac{1}{2},-\\frac{\\sqrt{3}}{2})"], [270, "(0,-1)"],
  [300, "(\\frac{1}{2},-\\frac{\\sqrt{3}}{2})"], [315, "(\\frac{\\sqrt{2}}{2},-\\frac{\\sqrt{2}}{2})"], [330, "(\\frac{\\sqrt{3}}{2},-\\frac{1}{2})"],
]);

const renderCache = new Map<string, Promise<ReturnType<typeof createUnitCircleAsset>>>();

function angleLatex(degrees: number, labelMode: UnitCircleLabelMode): string {
  const radians = RADIAN_LATEX.get(degrees);
  if (!radians) throw new Error(`Missing unit-circle radian label for ${degrees} degrees.`);
  if (labelMode === "radians") return radians;
  const degreeLabel = `${degrees}^{\\circ}`;
  return labelMode === "degrees" ? degreeLabel : `${degreeLabel}\\;\\;${radians}`;
}

function flattenMathJaxSvg(rendered: RenderedLatex): UnitCircleRenderedMathLabel {
  const document = new DOMParser().parseFromString(rendered.svg, "image/svg+xml");
  if (document.querySelector("parsererror")) throw new Error("MathJax returned malformed unit-circle label SVG.");
  const root = document.documentElement;
  const viewBox = root.getAttribute("viewBox") || "0 0 1 1";
  const viewBoxParts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (viewBoxParts.length !== 4 || !Number.isFinite(viewBoxParts[2]) || !Number.isFinite(viewBoxParts[3]) || viewBoxParts[2] <= 0 || viewBoxParts[3] <= 0) {
    throw new Error("MathJax returned an invalid unit-circle label viewBox.");
  }
  const definitions = new Map(
    Array.from(root.querySelectorAll("[id]"))
      .map((element) => [element.getAttribute("id"), element] as const)
      .filter((entry): entry is readonly [string, Element] => Boolean(entry[0])),
  );
  for (const use of Array.from(root.querySelectorAll("use"))) {
    const referenceId = (
      use.getAttribute("href")
      || use.getAttribute("xlink:href")
      || use.getAttributeNS("http://www.w3.org/1999/xlink", "href")
      || ""
    ).replace(/^#/, "");
    const referenced = referenceId ? definitions.get(referenceId) : null;
    if (!referenced) throw new Error("MathJax returned an unresolved unit-circle glyph.");
    const wrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const x = use.getAttribute("x");
    const y = use.getAttribute("y");
    const transforms = [use.getAttribute("transform")];
    if (x || y) transforms.push(`translate(${x || "0"} ${y || "0"})`);
    if (transforms.filter(Boolean).length) wrapper.setAttribute("transform", transforms.filter(Boolean).join(" "));
    const glyph = referenced.cloneNode(true) as Element;
    glyph.removeAttribute("id");
    wrapper.append(glyph);
    use.replaceWith(wrapper);
  }
  root.querySelectorAll("defs").forEach((defs) => defs.remove());
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    element.removeAttribute("id");
    element.removeAttribute("aria-hidden");
    element.removeAttribute("aria-label");
    element.removeAttribute("focusable");
    element.removeAttribute("role");
  }
  if (root.querySelector("use")) throw new Error("Unit-circle MathJax labels must not retain linked glyph references.");
  const serializer = new XMLSerializer();
  return {
    aspectRatio: viewBoxParts[2] / viewBoxParts[3],
    body: Array.from(root.childNodes).map((node) => serializer.serializeToString(node)).join(""),
    viewBox,
  };
}

async function buildUnitCircleMathJaxAsset(labelMode: UnitCircleLabelMode, showCoordinates: boolean) {
  const degrees = [...RADIAN_LATEX.keys()];
  const angleEntries = await Promise.all(degrees.map(async (degree) => [degree, flattenMathJaxSvg(await renderLatexToSvg(angleLatex(degree, labelMode)))] as const));
  const coordinateEntries = showCoordinates
    ? await Promise.all(degrees.map(async (degree) => {
      const source = COORDINATE_LATEX.get(degree);
      if (!source) throw new Error(`Missing unit-circle coordinate label for ${degree} degrees.`);
      return [degree, flattenMathJaxSvg(await renderLatexToSvg(source))] as const;
    }))
    : [];
  const labels: UnitCircleRenderedMathLabels = {
    angles: new Map(angleEntries),
    coordinates: new Map(coordinateEntries),
  };
  return createUnitCircleAsset(labelMode, showCoordinates, labels);
}

export function createUnitCircleMathJaxAsset(labelMode: UnitCircleLabelMode, showCoordinates: boolean) {
  const key = `${labelMode}:${showCoordinates}`;
  let pending = renderCache.get(key);
  if (!pending) {
    pending = buildUnitCircleMathJaxAsset(labelMode, showCoordinates).catch((error) => {
      renderCache.delete(key);
      throw error;
    });
    renderCache.set(key, pending);
  }
  return pending;
}
