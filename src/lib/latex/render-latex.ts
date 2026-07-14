const MAX_LATEX_LENGTH = 2_000;
const MAX_LATEX_NESTING = 48;
const MAX_LATEX_COMMANDS = 500;
const RENDER_TIMEOUT_MS = 8_000;
const MAX_SVG_ELEMENTS = 12_000;
const MAX_SVG_BYTES = 2_000_000;
const BLOCKED_LATEX_COMMAND = /\\(?:href|url|style|class|cssId|html(?:Data|Class|Id|Style)?|includegraphics|require|autoload|unicode|input|include|openin|read|write|special|def|edef|gdef|xdef|let|futurelet|csname|catcode|newcommand|renewcommand|providecommand|DeclareMathOperator|newenvironment|renewenvironment)\b/i;
const BLOCKED_LATEX_VALUE = /url\s*\(|(?:javascript|data|file|https?|ftp)\s*:/i;
const ALLOWED_SVG_TAGS = new Set([
  "defs",
  "g",
  "path",
  "rect",
  "svg",
  "text",
  "title",
  "use",
]);
const ALLOWED_SVG_ATTRIBUTES = new Set([
  "aria-hidden",
  "aria-label",
  "d",
  "fill",
  "focusable",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "height",
  "href",
  "id",
  "preserveAspectRatio",
  "role",
  "stroke",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-width",
  "text-anchor",
  "transform",
  "viewBox",
  "width",
  "x",
  "y",
  "xmlns",
]);

interface MathJaxApi {
  startup: {
    promise: Promise<void>;
    output?: { clearFontCache?: () => void };
  };
  tex2svg: (source: string, options: Record<string, unknown>) => HTMLElement;
  texReset?: () => void;
}

type MathJaxGlobal = MathJaxApi | Record<string, unknown>;

declare global {
  interface Window {
    MathJax?: MathJaxGlobal;
  }
}

export interface RenderedLatex {
  source: string;
  svg: string;
  dataUrl: string;
  width: number;
  height: number;
}

let mathJaxPromise: Promise<MathJaxApi> | null = null;
let renderQueue: Promise<void> = Promise.resolve();

function localAssetUrl(relativePath: string): string {
  return new URL(relativePath, window.location.href).toString();
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

export function validateLatexSource(value: string): string {
  const source = value.trim();
  if (!source) throw new Error("Enter a LaTeX equation.");
  if (source.length > MAX_LATEX_LENGTH) {
    throw new Error(`Keep equations under ${MAX_LATEX_LENGTH.toLocaleString()} characters.`);
  }
  if (BLOCKED_LATEX_COMMAND.test(source) || BLOCKED_LATEX_VALUE.test(source)) {
    throw new Error("Links, HTML, external files, and custom command definitions are disabled.");
  }
  let nesting = 0;
  let deepest = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "{") deepest = Math.max(deepest, ++nesting);
    else if (source[index] === "}") nesting = Math.max(0, nesting - 1);
  }
  const commandCount = source.match(/\\[a-zA-Z]+|\\./g)?.length || 0;
  if (deepest > MAX_LATEX_NESTING || commandCount > MAX_LATEX_COMMANDS) {
    throw new Error("That equation is too structurally complex for the classroom renderer.");
  }
  return source;
}

function mathJaxConfiguration(): Record<string, unknown> {
  return {
    loader: {
      load: ["ui/safe"],
      paths: {
        mathjax: withoutTrailingSlash(localAssetUrl("./mathjax/")),
        fonts: withoutTrailingSlash(localAssetUrl("./mathjax-fonts/")),
      },
    },
    startup: { typeset: false },
    tex: {
      maxBuffer: MAX_LATEX_LENGTH,
      packages: { "[-]": ["autoload", "require"] },
    },
    output: {
      font: "mathjax-newcm",
      fontPath: "[fonts]/%%FONT%%-font",
    },
    svg: { fontCache: "local" },
    options: {
      enableMenu: false,
      enableExplorer: false,
      safeOptions: {
        allow: {
          URLs: "none",
          classes: "none",
          cssIDs: "none",
          styles: "none",
        },
      },
    },
  };
}

async function loadMathJax(): Promise<MathJaxApi> {
  if (mathJaxPromise) return mathJaxPromise;
  mathJaxPromise = new Promise<MathJaxApi>((resolve, reject) => {
    window.MathJax = mathJaxConfiguration();
    const script = document.createElement("script");
    script.id = "canvas-classroom-mathjax";
    script.src = localAssetUrl("./mathjax/tex-svg.js");
    script.async = true;
    script.addEventListener("error", () => reject(new Error("The local equation renderer could not be loaded.")), { once: true });
    script.addEventListener("load", () => {
      const api = window.MathJax as MathJaxApi | undefined;
      if (!api?.startup?.promise) {
        reject(new Error("The local equation renderer did not start correctly."));
        return;
      }
      api.startup.promise.then(() => {
        const readyApi = window.MathJax as MathJaxApi | undefined;
        if (!readyApi?.tex2svg) {
          reject(new Error("The local equation renderer did not start correctly."));
          return;
        }
        // MathJax serializes conversion promises through startup.promise. Let
        // that promise settle before beginning a promise-based conversion.
        window.setTimeout(() => resolve(readyApi), 0);
      }, reject);
    }, { once: true });
    document.head.append(script);
  }).catch((error) => {
    mathJaxPromise = null;
    throw error;
  });
  return mathJaxPromise;
}

async function renderWithRetries(
  mathJax: MathJaxApi,
  source: string,
  options: Record<string, unknown>,
): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      return mathJax.tex2svg(source, options);
    } catch (error) {
      const retry = error && typeof error === "object"
        ? (error as { retry?: unknown }).retry
        : undefined;
      if (!(retry instanceof Promise)) throw error;
      await retry;
    }
  }
  throw new Error("The equation needed too many additional font files.");
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("That equation took too long to render.")),
      RENDER_TIMEOUT_MS,
    );
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task, task);
  renderQueue = result.then(() => undefined, () => undefined);
  return result;
}

function isSafePaint(value: string): boolean {
  const normalized = value.trim();
  return normalized === "none" ||
    normalized === "currentColor" ||
    /^#[0-9a-f]{3,8}$/i.test(normalized) ||
    /^rgba?\(\s*[\d.%]+(?:\s*,\s*[\d.%]+){2}(?:\s*,\s*[\d.%]+)?\s*\)$/i.test(normalized);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function sanitizeMathSvg(svg: SVGSVGElement, source: string): SVGSVGElement {
  const safe = svg.cloneNode(true) as SVGSVGElement;
  for (const element of [safe, ...Array.from(safe.querySelectorAll("*"))]) {
    if (element !== safe && !ALLOWED_SVG_TAGS.has(element.localName)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name === "xlink:href" ? "href" : attribute.name;
      const isInternalReference = name === "href" && attribute.value.startsWith("#");
      if (!ALLOWED_SVG_ATTRIBUTES.has(name) || (name === "href" && !isInternalReference)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === "fill" || name === "stroke") && !isSafePaint(attribute.value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (attribute.value.includes("currentColor")) {
        element.setAttribute(attribute.name, attribute.value.replaceAll("currentColor", "#111827"));
      }
    }
  }
  safe.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  safe.setAttribute("role", "img");
  safe.setAttribute("aria-label", `LaTeX equation: ${source.slice(0, 240)}`);
  safe.removeAttribute("style");
  if (safe.querySelectorAll("*").length > MAX_SVG_ELEMENTS) {
    throw new Error("That equation produced too much SVG content.");
  }
  return safe;
}

function equationSize(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  const viewWidth = Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : 1;
  const viewHeight = Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : 1;
  const aspectRatio = Math.max(0.05, Math.min(30, viewWidth / viewHeight));
  const preferredHeight = 72;
  const width = Math.min(1_200, Math.max(48, preferredHeight * aspectRatio));
  return { width, height: Math.max(24, width / aspectRatio) };
}

export async function renderLatexToSvg(value: string, signal?: AbortSignal): Promise<RenderedLatex> {
  const source = validateLatexSource(value);
  return withTimeout(enqueueRender(async () => {
    if (signal?.aborted) throw new DOMException("Equation rendering was cancelled.", "AbortError");
    const mathJax = await loadMathJax();
    if (signal?.aborted) throw new DOMException("Equation rendering was cancelled.", "AbortError");
    mathJax.texReset?.();
    const container = await renderWithRetries(mathJax, source, {
      display: true,
      em: 18,
      ex: 9,
      containerWidth: 1_200,
    });
    if (signal?.aborted) throw new DOMException("Equation rendering was cancelled.", "AbortError");
    const error = container.querySelector("mjx-merror, merror");
    if (error) throw new Error(error.textContent?.trim() || "MathJax could not render that equation.");
    const generated = container.querySelector("svg");
    if (!(generated instanceof SVGSVGElement)) throw new Error("MathJax did not return an SVG equation.");

    const safe = sanitizeMathSvg(generated, source);
    const { width, height } = equationSize(safe);
    safe.setAttribute("width", String(width));
    safe.setAttribute("height", String(height));
    const svg = new XMLSerializer().serializeToString(safe);
    const svgBytes = new TextEncoder().encode(svg);
    if (svgBytes.byteLength > MAX_SVG_BYTES) {
      throw new Error("That equation produced an image that is too large.");
    }
    const dataUrl = `data:image/svg+xml;base64,${bytesToBase64(svgBytes)}`;
    return { source, svg, dataUrl, width, height };
  }));
}
