import { createLocalId } from "../id";
import { mathSvgToDataUrl } from "./svg";
import type {
  AlgebraTileMathToolMetadata,
  FractionPieceMathToolMetadata,
  GeneratedMathToolBatch,
  GeneratedMathToolPiece,
  IntegerChipMathToolMetadata,
  MathToolAsset,
  ProbabilityPieceMathToolMetadata,
} from "./types";

const FONT = "Arial, Helvetica, sans-serif";
const FRACTION_COLOURS = ["#5b8ff9", "#61d9a8", "#f6bd4f", "#e98080", "#9270ca", "#6dc8ec", "#ff9d4d", "#78a65a"];

function makeAsset(svg: string, width: number, height: number): MathToolAsset {
  return { dataUrl: mathSvgToDataUrl(svg), height, svg, width };
}

function compact(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

function layoutPieces(pieces: Omit<GeneratedMathToolPiece, "offsetX" | "offsetY">[]): GeneratedMathToolPiece[] {
  if (!pieces.length) throw new Error("Choose at least one manipulative piece.");
  if (pieces.length > 100) throw new Error("Keep manipulative sets at 100 pieces or fewer.");
  const cellWidth = Math.max(...pieces.map((piece) => piece.asset.width), 72) + 14;
  const cellHeight = Math.max(...pieces.map((piece) => piece.asset.height), 72) + 14;
  const columns = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(pieces.length * cellHeight / cellWidth))));
  return pieces.map((piece, index) => ({
    ...piece,
    offsetX: (index % columns) * cellWidth,
    offsetY: Math.floor(index / columns) * cellHeight,
  }));
}

export function createFractionKit(representation: "bar" | "circle", maximumDenominator: number): GeneratedMathToolBatch {
  if (!Number.isInteger(maximumDenominator) || maximumDenominator < 2 || maximumDenominator > 8) {
    throw new Error("Maximum denominator must be an integer from 2 to 8.");
  }
  const setId = createLocalId();
  const pieces: Omit<GeneratedMathToolPiece, "offsetX" | "offsetY">[] = [];
  let pieceIndex = 0;
  for (let denominator = 1; denominator <= maximumDenominator; denominator += 1) {
    for (let copy = 0; copy < denominator; copy += 1) {
      const colour = FRACTION_COLOURS[(denominator - 1) % FRACTION_COLOURS.length];
      let asset: MathToolAsset;
      if (representation === "bar") {
        const width = 240 / denominator;
        const height = 52;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${compact(width)}" height="${height}" viewBox="0 0 ${compact(width)} ${height}" role="img" aria-label="One ${denominator === 1 ? "whole" : `${denominator}th`} fraction bar"><rect x="1" y="1" width="${compact(width - 2)}" height="${height - 2}" rx="5" fill="${colour}" fill-opacity="0.82" stroke="#263249" stroke-width="1.5"/><text x="${compact(width / 2)}" y="32" text-anchor="middle" fill="#172033" font-family="${FONT}" font-size="14" font-weight="700">1/${denominator}</text></svg>`;
        asset = makeAsset(svg, width, height);
      } else {
        const width = 108;
        const height = 108;
        const radius = 49;
        let shape: string;
        if (denominator === 1) {
          shape = `<circle cx="54" cy="54" r="${radius}"/>`;
        } else {
          const angle = Math.PI * 2 / denominator;
          const endX = 54 + radius * Math.cos(-Math.PI / 2 + angle);
          const endY = 54 + radius * Math.sin(-Math.PI / 2 + angle);
          const largeArc = angle > Math.PI ? 1 : 0;
          shape = `<path d="M 54 54 L 54 5 A ${radius} ${radius} 0 ${largeArc} 1 ${compact(endX)} ${compact(endY)} Z"/>`;
        }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="One ${denominator === 1 ? "whole" : `${denominator}th`} fraction circle piece"><g fill="${colour}" fill-opacity="0.82" stroke="#263249" stroke-width="1.5">${shape}</g><text x="54" y="59" text-anchor="middle" fill="#172033" font-family="${FONT}" font-size="13" font-weight="700">1/${denominator}</text></svg>`;
        asset = makeAsset(svg, width, height);
      }
      const metadata: FractionPieceMathToolMetadata = {
        schemaVersion: 1,
        kind: "fraction-piece",
        category: "manipulatives",
        calibration: "logical-units",
        naturalWidth: asset.width,
        naturalHeight: asset.height,
        setId,
        pieceIndex,
        representation,
        maximumDenominator,
        numerator: 1,
        denominator,
        colourPaletteVersion: 1,
        pieceGeometry: representation === "bar" ? "bar" : "sector",
        wholeSize: representation === "bar" ? 240 : 108,
      };
      pieces.push({ asset, metadata });
      pieceIndex += 1;
    }
  }
  return { pieces: layoutPieces(pieces), toastMessage: `Fraction ${representation} kit added (${pieces.length} pieces).` };
}

export interface AlgebraTileCounts {
  positiveUnits: number;
  negativeUnits: number;
  positiveX: number;
  negativeX: number;
  positiveXSquared: number;
  negativeXSquared: number;
}

function validateCount(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 10) throw new Error(`${label} must be an integer from 0 to 10.`);
  return value;
}

export function createAlgebraTileKit(input: AlgebraTileCounts): GeneratedMathToolBatch {
  const counts = {
    positiveUnits: validateCount(input.positiveUnits, "Positive unit count"),
    negativeUnits: validateCount(input.negativeUnits, "Negative unit count"),
    positiveX: validateCount(input.positiveX, "Positive x count"),
    negativeX: validateCount(input.negativeX, "Negative x count"),
    positiveXSquared: validateCount(input.positiveXSquared, "Positive x-squared count"),
    negativeXSquared: validateCount(input.negativeXSquared, "Negative x-squared count"),
  };
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (!total) throw new Error("Choose at least one algebra tile.");
  const setId = createLocalId();
  const unitSide = 46;
  const xLength = 126;
  const specifications: Array<{ count: number; sign: "negative" | "positive"; tileType: "unit" | "x" | "x-squared" }> = [
    { count: counts.positiveUnits, sign: "positive", tileType: "unit" },
    { count: counts.negativeUnits, sign: "negative", tileType: "unit" },
    { count: counts.positiveX, sign: "positive", tileType: "x" },
    { count: counts.negativeX, sign: "negative", tileType: "x" },
    { count: counts.positiveXSquared, sign: "positive", tileType: "x-squared" },
    { count: counts.negativeXSquared, sign: "negative", tileType: "x-squared" },
  ];
  const pieces: Omit<GeneratedMathToolPiece, "offsetX" | "offsetY">[] = [];
  for (const specification of specifications) {
    for (let copy = 0; copy < specification.count; copy += 1) {
      const width = specification.tileType === "unit" ? unitSide : xLength;
      const height = specification.tileType === "x-squared" ? xLength : unitSide;
      const positive = specification.sign === "positive";
      const label = specification.tileType === "unit" ? "1" : specification.tileType === "x" ? "x" : "x²";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${specification.sign} ${label} algebra tile"><rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="5" fill="${positive ? "#72d6a5" : "#f18d8d"}" fill-opacity="0.9" stroke="#263249" stroke-width="${positive ? 1.5 : 2.5}" stroke-dasharray="${positive ? "0" : "6 3"}"/><text x="${width / 2}" y="${height / 2 + 6}" text-anchor="middle" fill="#172033" font-family="${FONT}" font-size="18" font-weight="700">${positive ? "+" : "−"}${label}</text></svg>`;
      const asset = makeAsset(svg, width, height);
      const metadata: AlgebraTileMathToolMetadata = {
        schemaVersion: 1, kind: "algebra-tile", category: "manipulatives", calibration: "logical-units",
        naturalWidth: width, naturalHeight: height, setId, pieceIndex: pieces.length,
        variableSymbol: "x", tileType: specification.tileType, sign: specification.sign,
        unitSide, xLength, paletteVersion: 1,
        requestedPositiveUnits: counts.positiveUnits, requestedNegativeUnits: counts.negativeUnits,
        requestedPositiveX: counts.positiveX, requestedNegativeX: counts.negativeX,
        requestedPositiveXSquared: counts.positiveXSquared, requestedNegativeXSquared: counts.negativeXSquared,
      };
      pieces.push({ asset, metadata });
    }
  }
  return { pieces: layoutPieces(pieces), toastMessage: `Algebra tile kit added (${total} pieces).` };
}

export function createIntegerChipKit(positiveCount: number, negativeCount: number): GeneratedMathToolBatch {
  const positive = validateCount(positiveCount, "Positive chip count");
  const negative = validateCount(negativeCount, "Negative chip count");
  if (!positive && !negative) throw new Error("Choose at least one integer chip.");
  const setId = createLocalId();
  const diameter = 64;
  const pieces: Omit<GeneratedMathToolPiece, "offsetX" | "offsetY">[] = [];
  for (const sign of ["positive", "negative"] as const) {
    const count = sign === "positive" ? positive : negative;
    for (let copy = 0; copy < count; copy += 1) {
      const isPositive = sign === "positive";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}" viewBox="0 0 ${diameter} ${diameter}" role="img" aria-label="${sign} integer chip"><circle cx="32" cy="32" r="30" fill="${isPositive ? "#5b8ff9" : "#ef767a"}" stroke="#172033" stroke-width="${isPositive ? 1.5 : 2.5}" stroke-dasharray="${isPositive ? "0" : "5 3"}"/><text x="32" y="41" text-anchor="middle" fill="#fff" font-family="${FONT}" font-size="30" font-weight="700">${isPositive ? "+" : "−"}</text></svg>`;
      const asset = makeAsset(svg, diameter, diameter);
      const metadata: IntegerChipMathToolMetadata = {
        schemaVersion: 1, kind: "integer-chip", category: "manipulatives", calibration: "logical-units",
        naturalWidth: diameter, naturalHeight: diameter, setId, pieceIndex: pieces.length, sign,
        requestedPositiveCount: positive, requestedNegativeCount: negative, chipDiameter: diameter, paletteVersion: 1,
      };
      pieces.push({ asset, metadata });
    }
  }
  return { pieces: layoutPieces(pieces), toastMessage: `Integer chip kit added (${pieces.length} pieces).` };
}

function diePips(face: number): string {
  const positions: Record<number, Array<[number, number]>> = {
    1: [[36, 36]], 2: [[22, 22], [50, 50]], 3: [[22, 22], [36, 36], [50, 50]],
    4: [[22, 22], [50, 22], [22, 50], [50, 50]],
    5: [[22, 22], [50, 22], [36, 36], [22, 50], [50, 50]],
    6: [[22, 20], [22, 36], [22, 52], [50, 20], [50, 36], [50, 52]],
  };
  return positions[face].map(([cx, cy]) => `<circle data-pip="${face}" cx="${cx}" cy="${cy}" r="5" fill="#172033"/>`).join("");
}

export function createDieAsset(face: number): MathToolAsset {
  if (!Number.isInteger(face) || face < 1 || face > 6) throw new Error("Die face must be an integer from 1 to 6.");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72" role="img" aria-label="Die face ${face}"><rect x="2" y="2" width="68" height="68" rx="12" fill="#fff" stroke="#172033" stroke-width="2"/>${diePips(face)}</svg>`;
  return makeAsset(svg, 72, 72);
}

export type CoinSide = "Heads" | "Tails";

export function createCoinAsset(side: CoinSide): MathToolAsset {
  if (side !== "Heads" && side !== "Tails") throw new Error("Coin side must be Heads or Tails.");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72" role="img" aria-label="Coin ${side}"><circle cx="36" cy="36" r="33" fill="#f6c85f" stroke="#755815" stroke-width="2"/><circle cx="36" cy="36" r="27" fill="none" stroke="#a47a1b"/><text x="36" y="43" text-anchor="middle" fill="#49370d" font-family="${FONT}" font-size="22" font-weight="700">${side[0]}</text></svg>`;
  return makeAsset(svg, 72, 72);
}

export function createSpinnerAsset(sector: number | null = null): MathToolAsset {
  if (sector !== null && (!Number.isInteger(sector) || sector < 1 || sector > 8)) {
    throw new Error("Spinner sector must be an integer from 1 to 8.");
  }
  const rays = Array.from({ length: 8 }, (_, sectorIndex) => {
    const angle = sectorIndex * Math.PI / 4;
    return `<line data-spinner-sector="${sectorIndex + 1}" x1="76" y1="76" x2="${compact(76 + 68 * Math.cos(angle))}" y2="${compact(76 + 68 * Math.sin(angle))}"/>`;
  }).join("");
  const labels = Array.from({ length: 8 }, (_, sectorIndex) => {
    const angle = (sectorIndex + 0.5) * Math.PI / 4;
    return `<text x="${compact(76 + 48 * Math.cos(angle))}" y="${compact(80 + 48 * Math.sin(angle))}" text-anchor="middle">${sectorIndex + 1}</text>`;
  }).join("");
  const pointerAngle = sector === null ? -Math.PI / 2 : (sector - 0.5) * Math.PI / 4;
  const pointerX = compact(76 + 48 * Math.cos(pointerAngle));
  const pointerY = compact(76 + 48 * Math.sin(pointerAngle));
  const resultLabel = sector === null ? "ready to spin" : `showing ${sector}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="152" height="152" viewBox="0 0 152 152" role="img" aria-label="Eight sector numbered spinner ${resultLabel}"><circle cx="76" cy="76" r="70" fill="#e8f1ff" stroke="#204aa5" stroke-width="2"/><g stroke="#55708f">${rays}</g><g fill="#172033" font-family="${FONT}" font-size="12" font-weight="700">${labels}</g><circle cx="76" cy="76" r="5" fill="#204aa5"/><line data-spinner-pointer="${sector ?? "unspun"}" x1="76" y1="76" x2="${pointerX}" y2="${pointerY}" stroke="#b83232" stroke-width="4" stroke-linecap="round"/></svg>`;
  return makeAsset(svg, 152, 152);
}

export interface ProbabilityKitSelection {
  includeDice: boolean;
  includeCoins: boolean;
  includeSpinner: boolean;
  includeCards: boolean;
}

export function createProbabilityKit(selection: ProbabilityKitSelection): GeneratedMathToolBatch {
  if (!selection.includeDice && !selection.includeCoins && !selection.includeSpinner && !selection.includeCards) throw new Error("Choose at least one probability component.");
  const setId = createLocalId();
  const pieces: Omit<GeneratedMathToolPiece, "offsetX" | "offsetY">[] = [];
  const quantities: Record<ProbabilityPieceMathToolMetadata["componentType"], number> = { card: 10, coin: 2, die: 6, spinner: 1 };
  const addPiece = (asset: MathToolAsset, componentType: ProbabilityPieceMathToolMetadata["componentType"], faceOrValue: string, spinnerSectorCount = 0, cardMinimum = 0, cardMaximum = 0) => {
    const metadata: ProbabilityPieceMathToolMetadata = {
      schemaVersion: 1, kind: "probability-piece", category: "manipulatives", calibration: "logical-units",
      naturalWidth: asset.width, naturalHeight: asset.height, setId, pieceIndex: pieces.length,
      componentType, faceOrValue, spinnerSectorCount, cardMinimum, cardMaximum, paletteVersion: 1, componentQuantity: quantities[componentType],
    };
    pieces.push({ asset, metadata });
  };
  if (selection.includeDice) {
    for (let face = 1; face <= 6; face += 1) {
      addPiece(createDieAsset(face), "die", String(face));
    }
  }
  if (selection.includeCoins) {
    for (const side of ["Heads", "Tails"] as const) {
      addPiece(createCoinAsset(side), "coin", side);
    }
  }
  if (selection.includeSpinner) {
    addPiece(createSpinnerAsset(), "spinner", "1-8", 8);
  }
  if (selection.includeCards) {
    for (let value = 1; value <= 10; value += 1) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="92" viewBox="0 0 64 92" role="img" aria-label="Number card ${value}"><rect x="1" y="1" width="62" height="90" rx="7" fill="#fff" stroke="#263249" stroke-width="2"/><text x="32" y="55" text-anchor="middle" fill="#204aa5" font-family="${FONT}" font-size="28" font-weight="700">${value}</text></svg>`;
      addPiece(makeAsset(svg, 64, 92), "card", String(value), 0, 1, 10);
    }
  }
  return { pieces: layoutPieces(pieces), toastMessage: `Probability kit added (${pieces.length} pieces).` };
}
