import { PDF_POINTS_PER_INCH } from "./ruler";

export const PROTRACTOR_DIAMETER_INCHES = 6;
export const PROTRACTOR_MAX_ANGLE_DEGREES = 180;
export const PROTRACTOR_SMALLEST_DIVISION_DEGREES = 1;
export const PROTRACTOR_WIDTH_POINTS = PROTRACTOR_DIAMETER_INCHES * PDF_POINTS_PER_INCH;
export const PROTRACTOR_RADIUS_POINTS = PROTRACTOR_WIDTH_POINTS / 2;
export const PROTRACTOR_HEIGHT_POINTS = PROTRACTOR_RADIUS_POINTS;

export interface ProtractorAsset {
  dataUrl: string;
  height: number;
  svg: string;
  width: number;
}

function compactNumber(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

function pointOnArc(radius: number, degree: number): { x: number; y: number } {
  const radians = degree * Math.PI / 180;
  return {
    x: PROTRACTOR_RADIUS_POINTS + radius * Math.cos(radians),
    y: PROTRACTOR_RADIUS_POINTS - radius * Math.sin(radians),
  };
}

function arcPath(radius: number): string {
  const left = PROTRACTOR_RADIUS_POINTS - radius;
  const right = PROTRACTOR_RADIUS_POINTS + radius;
  return `M ${compactNumber(left)} ${PROTRACTOR_RADIUS_POINTS} A ${compactNumber(radius)} ${compactNumber(radius)} 0 0 1 ${compactNumber(right)} ${PROTRACTOR_RADIUS_POINTS}`;
}

function degreeTicks(): string {
  const output: string[] = [];
  const outerRadius = PROTRACTOR_RADIUS_POINTS - 2;
  for (let degree = 0; degree <= PROTRACTOR_MAX_ANGLE_DEGREES; degree += 1) {
    const length = degree % 10 === 0 ? 22 : degree % 5 === 0 ? 14 : 8;
    const outer = pointOnArc(outerRadius, degree);
    const inner = pointOnArc(outerRadius - length, degree);
    output.push(
      `<line data-degree="${degree}" x1="${compactNumber(outer.x)}" y1="${compactNumber(outer.y)}" x2="${compactNumber(inner.x)}" y2="${compactNumber(inner.y)}"/>`,
    );
  }
  return output.join("");
}

function degreeLabels(): string {
  const output: string[] = [];
  for (let degree = 0; degree <= PROTRACTOR_MAX_ANGLE_DEGREES; degree += 10) {
    const clockwise = pointOnArc(PROTRACTOR_RADIUS_POINTS - 46, degree);
    const counterclockwise = pointOnArc(PROTRACTOR_RADIUS_POINTS - 70, degree);
    const clockwiseY = Math.min(clockwise.y + 3, PROTRACTOR_RADIUS_POINTS - 6);
    const counterclockwiseY = Math.min(counterclockwise.y + 3, PROTRACTOR_RADIUS_POINTS - 6);
    output.push(
      `<text data-scale="clockwise" data-angle-position="${degree}" data-value="${degree}" x="${compactNumber(clockwise.x)}" y="${compactNumber(clockwiseY)}" text-anchor="middle">${degree}</text>`,
      `<text data-scale="counterclockwise" data-angle-position="${degree}" data-value="${180 - degree}" x="${compactNumber(counterclockwise.x)}" y="${compactNumber(counterclockwiseY)}" text-anchor="middle">${180 - degree}</text>`,
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

export function createProtractorAsset(): ProtractorAsset {
  const bodyPath = `M 0 ${PROTRACTOR_RADIUS_POINTS} A ${PROTRACTOR_RADIUS_POINTS} ${PROTRACTOR_RADIUS_POINTS} 0 0 1 ${PROTRACTOR_WIDTH_POINTS} ${PROTRACTOR_RADIUS_POINTS} L 0 ${PROTRACTOR_RADIUS_POINTS} Z`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PROTRACTOR_WIDTH_POINTS}" height="${PROTRACTOR_HEIGHT_POINTS}" viewBox="0 0 ${PROTRACTOR_WIDTH_POINTS} ${PROTRACTOR_HEIGHT_POINTS}" role="img" aria-label="Six inch semicircular protractor marked in degrees">`,
    `<path data-part="body" d="${bodyPath}" fill="#70d7d2" fill-opacity="0.42" stroke="#174c58" stroke-width="1.2"/>`,
    `<g fill="none" stroke="#235866" stroke-width="0.75">`,
    `<path data-part="outer-label-guide" d="${arcPath(PROTRACTOR_RADIUS_POINTS - 35)}" opacity="0.42"/>`,
    `<path data-part="inner-label-guide" d="${arcPath(PROTRACTOR_RADIUS_POINTS - 59)}" opacity="0.32"/>`,
    degreeTicks(),
    `</g>`,
    `<g data-part="degree-labels" fill="#153f4a" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="650">${degreeLabels()}</g>`,
    `<line data-part="baseline" x1="1" y1="${PROTRACTOR_RADIUS_POINTS}" x2="${PROTRACTOR_WIDTH_POINTS - 1}" y2="${PROTRACTOR_RADIUS_POINTS}" stroke="#174c58" stroke-width="1.4"/>`,
    `<g data-part="centre-mark" fill="none" stroke="#174c58" stroke-width="1.2">`,
    `<circle cx="${PROTRACTOR_RADIUS_POINTS}" cy="${PROTRACTOR_RADIUS_POINTS}" r="4.5" fill="#fff" fill-opacity="0.82"/>`,
    `<line x1="${PROTRACTOR_RADIUS_POINTS - 11}" y1="${PROTRACTOR_RADIUS_POINTS}" x2="${PROTRACTOR_RADIUS_POINTS + 11}" y2="${PROTRACTOR_RADIUS_POINTS}"/>`,
    `<line x1="${PROTRACTOR_RADIUS_POINTS}" y1="${PROTRACTOR_RADIUS_POINTS - 11}" x2="${PROTRACTOR_RADIUS_POINTS}" y2="${PROTRACTOR_RADIUS_POINTS}"/>`,
    `</g>`,
    `<text data-part="caption" x="${PROTRACTOR_RADIUS_POINTS}" y="${PROTRACTOR_RADIUS_POINTS - 18}" text-anchor="middle" fill="#235866" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700" letter-spacing="0.8">DEGREES</text>`,
    `</svg>`,
  ].join("");
  return {
    dataUrl: svgToDataUrl(svg),
    height: PROTRACTOR_HEIGHT_POINTS,
    svg,
    width: PROTRACTOR_WIDTH_POINTS,
  };
}
