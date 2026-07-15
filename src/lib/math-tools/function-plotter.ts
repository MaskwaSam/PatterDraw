import { escapeMathSvgText, mathSvgToDataUrl } from "./svg";
import type { FunctionPlotMathToolMetadata, MathToolAsset } from "./types";

type Evaluator = (x: number) => number;
type Token = { type: "identifier" | "number" | "operator" | "paren"; value: string };

const MAX_EXPRESSION_LENGTH = 160;
const MAX_TOKENS = 200;
const FUNCTIONS: Record<string, (value: number) => number> = {
  abs: Math.abs,
  cos: Math.cos,
  exp: Math.exp,
  ln: Math.log,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
};

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (/[+\-*/^]/.test(character)) { tokens.push({ type: "operator", value: character }); index += 1; continue; }
    if (character === "(" || character === ")") { tokens.push({ type: "paren", value: character }); index += 1; continue; }
    const number = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)?.[0];
    if (number) { tokens.push({ type: "number", value: number }); index += number.length; continue; }
    const identifier = source.slice(index).match(/^[a-z]+/i)?.[0];
    if (identifier) { tokens.push({ type: "identifier", value: identifier.toLowerCase() }); index += identifier.length; continue; }
    throw new Error(`Unsupported character "${character}" in function.`);
  }
  if (!tokens.length) throw new Error("Enter a function of x.");
  if (tokens.length > MAX_TOKENS) throw new Error("That function is too complex.");
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Evaluator {
    const evaluator = this.expression();
    if (this.index !== this.tokens.length) throw new Error(`Unexpected token "${this.tokens[this.index].value}".`);
    return evaluator;
  }

  private expression(): Evaluator {
    let left = this.term();
    while (this.matchOperator("+") || this.matchOperator("-")) {
      const operator = this.tokens[this.index - 1].value;
      const right = this.term();
      const previous = left;
      left = operator === "+" ? (x) => previous(x) + right(x) : (x) => previous(x) - right(x);
    }
    return left;
  }

  private term(): Evaluator {
    let left = this.power();
    while (this.matchOperator("*") || this.matchOperator("/")) {
      const operator = this.tokens[this.index - 1].value;
      const right = this.power();
      const previous = left;
      left = operator === "*" ? (x) => previous(x) * right(x) : (x) => previous(x) / right(x);
    }
    return left;
  }

  private power(): Evaluator {
    const left = this.unary();
    if (!this.matchOperator("^")) return left;
    const right = this.power();
    return (x) => left(x) ** right(x);
  }

  private unary(): Evaluator {
    if (this.matchOperator("+")) return this.unary();
    if (this.matchOperator("-")) {
      const value = this.unary();
      return (x) => -value(x);
    }
    return this.primary();
  }

  private primary(): Evaluator {
    const token = this.tokens[this.index];
    if (!token) throw new Error("Function ended unexpectedly.");
    if (token.type === "number") {
      this.index += 1;
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new Error("Function contains an invalid number.");
      return () => value;
    }
    if (token.type === "identifier") {
      this.index += 1;
      if (token.value === "x") return (x) => x;
      if (token.value === "pi") return () => Math.PI;
      if (token.value === "e") return () => Math.E;
      const operation = FUNCTIONS[token.value];
      if (!operation) throw new Error(`Unknown function or constant "${token.value}".`);
      if (!this.matchParen("(")) throw new Error(`${token.value} must be followed by parentheses.`);
      const argument = this.expression();
      if (!this.matchParen(")")) throw new Error(`Close the ${token.value} parentheses.`);
      return (x) => operation(argument(x));
    }
    if (this.matchParen("(")) {
      const value = this.expression();
      if (!this.matchParen(")")) throw new Error("Close the function parentheses.");
      return value;
    }
    throw new Error(`Unexpected token "${token.value}".`);
  }

  private matchOperator(value: string): boolean {
    const token = this.tokens[this.index];
    if (token?.type !== "operator" || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private matchParen(value: string): boolean {
    const token = this.tokens[this.index];
    if (token?.type !== "paren" || token.value !== value) return false;
    this.index += 1;
    return true;
  }
}

export function compileFunctionExpression(value: string): { evaluator: Evaluator; expression: string } {
  const expression = value.trim();
  if (!expression) throw new Error("Enter a function of x.");
  if (expression.length > MAX_EXPRESSION_LENGTH) throw new Error(`Keep functions under ${MAX_EXPRESSION_LENGTH} characters.`);
  if (/[=;{}\[\].'"`_]|(?:constructor|prototype|window|document|eval|function)/i.test(expression)) throw new Error("Assignments, code, and property access are not allowed.");
  return { evaluator: new Parser(tokenize(expression)).parse(), expression: expression.replace(/\s+/g, "") };
}

export interface FunctionPlotConfiguration {
  expression: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  showGrid: boolean;
  showAxes: boolean;
}

export const DEFAULT_FUNCTION_PLOT: FunctionPlotConfiguration = {
  expression: "x^2 - 4",
  xMin: -10,
  xMax: 10,
  yMin: -10,
  yMax: 10,
  showGrid: true,
  showAxes: true,
};

export function functionPlotConfigurationFromMetadata(metadata: FunctionPlotMathToolMetadata): FunctionPlotConfiguration {
  return {
    expression: metadata.expression,
    xMin: metadata.xMin,
    xMax: metadata.xMax,
    yMin: metadata.yMin,
    yMax: metadata.yMax,
    showGrid: metadata.showGrid,
    showAxes: metadata.showAxes,
  };
}

export function createFunctionPlotAsset(input: FunctionPlotConfiguration): { asset: MathToolAsset; metadata: Omit<FunctionPlotMathToolMetadata, "category" | "kind" | "naturalHeight" | "naturalWidth" | "schemaVersion"> } {
  const ranges = [input.xMin, input.xMax, input.yMin, input.yMax];
  if (ranges.some((value) => !Number.isFinite(value))) throw new Error("Plot ranges must be finite numbers.");
  if (input.xMin >= input.xMax || input.yMin >= input.yMax) throw new Error("Each plot minimum must be less than its maximum.");
  if (input.xMax - input.xMin > 100 || input.yMax - input.yMin > 100) throw new Error("Keep each plot span at 100 units or fewer.");
  const { evaluator, expression } = compileFunctionExpression(input.expression);
  const width = 640;
  const height = 480;
  const padding = 40;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const xFor = (x: number) => padding + (x - input.xMin) / (input.xMax - input.xMin) * plotWidth;
  const yFor = (y: number) => padding + (input.yMax - y) / (input.yMax - input.yMin) * plotHeight;
  const sampleCount = 401;
  const discontinuityThreshold = (input.yMax - input.yMin) * 3;
  const path: string[] = [];
  let drawing = false;
  let previousY = Number.NaN;
  for (let index = 0; index < sampleCount; index += 1) {
    const x = input.xMin + index / (sampleCount - 1) * (input.xMax - input.xMin);
    const y = evaluator(x);
    const visible = Number.isFinite(y) && y >= input.yMin && y <= input.yMax && (!Number.isFinite(previousY) || Math.abs(y - previousY) <= discontinuityThreshold);
    if (visible) {
      path.push(`${drawing ? "L" : "M"} ${xFor(x).toFixed(2)} ${yFor(y).toFixed(2)}`);
      drawing = true;
    } else {
      drawing = false;
    }
    previousY = y;
  }
  if (!path.length) throw new Error("That function has no visible finite values in the selected window.");
  const grid: string[] = [];
  if (input.showGrid) {
    const xStart = Math.ceil(input.xMin);
    for (let x = xStart; x <= input.xMax; x += 1) grid.push(`<line data-grid-x="${x}" x1="${xFor(x)}" y1="${padding}" x2="${xFor(x)}" y2="${height - padding}"/>`);
    const yStart = Math.ceil(input.yMin);
    for (let y = yStart; y <= input.yMax; y += 1) grid.push(`<line data-grid-y="${y}" x1="${padding}" y1="${yFor(y)}" x2="${width - padding}" y2="${yFor(y)}"/>`);
  }
  const axes: string[] = [];
  if (input.showAxes && input.yMin <= 0 && input.yMax >= 0) axes.push(`<line data-axis="x" x1="${padding}" y1="${yFor(0)}" x2="${width - padding}" y2="${yFor(0)}"/>`);
  if (input.showAxes && input.xMin <= 0 && input.xMax >= 0) axes.push(`<line data-axis="y" x1="${xFor(0)}" y1="${padding}" x2="${xFor(0)}" y2="${height - padding}"/>`);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Function plot y equals ${escapeMathSvgText(expression)}">`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="#fff" stroke="#9fb1c5"/>`,
    `<g data-part="grid" stroke="#dbe5f0" stroke-width="0.7">${grid.join("")}</g>`,
    `<g data-part="axes" stroke="#172033" stroke-width="1.8">${axes.join("")}</g>`,
    `<path data-part="function" d="${path.join(" ")}" fill="none" stroke="#d63c54" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<text x="${padding}" y="24" fill="#172033" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700">y = ${escapeMathSvgText(expression)}</text>`,
    `</svg>`,
  ].join("");
  return {
    asset: { dataUrl: mathSvgToDataUrl(svg), height, svg, width },
    metadata: { calibration: "logical-units", configurationVersion: 1, parserVersion: 1, expression, xMin: input.xMin, xMax: input.xMax, yMin: input.yMin, yMax: input.yMax, sampleCount, discontinuityThreshold, showGrid: input.showGrid, showAxes: input.showAxes, plotStrokeColor: "#d63c54", plotStrokeWidth: 2.8 },
  };
}
