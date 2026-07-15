export const PDF_POINTS_PER_INCH = 72;
export const PDF_POINTS_PER_CENTIMETRE = PDF_POINTS_PER_INCH / 2.54;
export const LETTER_WIDTH_POINTS = 8.5 * PDF_POINTS_PER_INCH;
export const LETTER_HEIGHT_POINTS = 11 * PDF_POINTS_PER_INCH;

export const RULER_LENGTH_INCHES = 12;
export const RULER_LENGTH_CENTIMETRES = 30;
export const RULER_WIDTH_POINTS = RULER_LENGTH_INCHES * PDF_POINTS_PER_INCH;
export const RULER_HEIGHT_POINTS = 90;

export interface DualScaleRulerAsset {
  dataUrl: string;
  height: number;
  svg: string;
  width: number;
}

function compactNumber(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

function tick(
  unit: "cm" | "in",
  value: number,
  x: number,
  y1: number,
  y2: number,
): string {
  return `<line data-unit="${unit}" data-value="${compactNumber(value)}" x1="${compactNumber(x)}" y1="${compactNumber(y1)}" x2="${compactNumber(x)}" y2="${compactNumber(y2)}"/>`;
}

function centimetreTicks(): string {
  const output: string[] = [];
  const subdivisions = RULER_LENGTH_CENTIMETRES * 10;
  for (let index = 0; index <= subdivisions; index += 1) {
    const millimetres = index;
    const value = millimetres / 10;
    const x = value * PDF_POINTS_PER_CENTIMETRE;
    const length = millimetres % 10 === 0 ? 22 : millimetres % 5 === 0 ? 15 : 8;
    output.push(tick("cm", value, x, 1, 1 + length));
  }
  return output.join("");
}

function inchTicks(): string {
  const output: string[] = [];
  const subdivisions = RULER_LENGTH_INCHES * 16;
  for (let index = 0; index <= subdivisions; index += 1) {
    const value = index / 16;
    const x = value * PDF_POINTS_PER_INCH;
    const length = index % 16 === 0
      ? 22
      : index % 8 === 0
        ? 16
        : index % 4 === 0
          ? 12
          : index % 2 === 0
            ? 9
            : 6;
    output.push(tick("in", value, x, RULER_HEIGHT_POINTS - 1, RULER_HEIGHT_POINTS - 1 - length));
  }
  return output.join("");
}

function labels(
  count: number,
  spacing: number,
  y: number,
  unit: "cm" | "in",
): string {
  const output: string[] = [];
  for (let value = 0; value <= count; value += 1) {
    const anchor = value === 0 ? "start" : value === count && unit === "in" ? "end" : "middle";
    output.push(
      `<text data-label-unit="${unit}" data-value="${value}" x="${compactNumber(value * spacing)}" y="${y}" text-anchor="${anchor}">${value}</text>`,
    );
  }
  return output.join("");
}

function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export function createDualScaleRulerAsset(): DualScaleRulerAsset {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${RULER_WIDTH_POINTS}" height="${RULER_HEIGHT_POINTS}" viewBox="0 0 ${RULER_WIDTH_POINTS} ${RULER_HEIGHT_POINTS}" role="img" aria-label="Twelve inch and thirty centimetre ruler">`,
    `<rect x="0.5" y="0.5" width="${RULER_WIDTH_POINTS - 1}" height="${RULER_HEIGHT_POINTS - 1}" rx="5" fill="#f7d66f" fill-opacity="0.86" stroke="#5f4a0f"/>`,
    `<g fill="none" stroke="#27200e" stroke-width="0.8">${centimetreTicks()}${inchTicks()}</g>`,
    `<g data-part="measurement-labels" fill="#27200e" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="600">`,
    labels(RULER_LENGTH_CENTIMETRES, PDF_POINTS_PER_CENTIMETRE, 32, "cm"),
    labels(RULER_LENGTH_INCHES, PDF_POINTS_PER_INCH, 65, "in"),
    `</g>`,
    `<g data-part="scale-captions" fill="#5f4a0f" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" letter-spacing="0.6">`,
    `<text data-scale-caption="cm" x="${RULER_WIDTH_POINTS / 2}" y="43" text-anchor="middle">CENTIMETRES</text>`,
    `<text data-scale-caption="in" x="${RULER_WIDTH_POINTS / 2}" y="54" text-anchor="middle">INCHES</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
  return {
    dataUrl: svgToDataUrl(svg),
    height: RULER_HEIGHT_POINTS,
    svg,
    width: RULER_WIDTH_POINTS,
  };
}
