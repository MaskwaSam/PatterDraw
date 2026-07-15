import { mathSvgToDataUrl } from "./svg";
import type {
  AngleMeasurementMathToolMetadata,
  CompassMathToolMetadata,
  GeneratedMathTool,
  TransformationMathToolMetadata,
} from "./types";

export interface MathPoint {
  x: number;
  y: number;
}

export interface CompassOptions {
  fullCircle: boolean;
  arcExtentDegrees: number;
  direction: "clockwise" | "counterclockwise";
  centerMark: boolean;
}

export interface AngleMeasurementOptions {
  reflex: boolean;
  precision: number;
}

export interface TransformationOptions {
  transformationType: "dilate" | "reflect-horizontal" | "reflect-line" | "reflect-vertical" | "rotate" | "translate";
  translateX: number;
  translateY: number;
  angleDegrees: number;
  scaleFactor: number;
  mirrorLineAngleDegrees: number;
}

export interface TransformableGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
}

function finitePoint(point: MathPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 1_000_000 && Math.abs(point.y) <= 1_000_000;
}

function compact(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

function degrees(radians: number): number {
  return radians * 180 / Math.PI;
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function createCompassConstruction(center: MathPoint, radiusPoint: MathPoint, options: CompassOptions): GeneratedMathTool {
  if (!finitePoint(center) || !finitePoint(radiusPoint)) throw new Error("Compass points must have finite scene coordinates.");
  const radius = Math.hypot(radiusPoint.x - center.x, radiusPoint.y - center.y);
  if (radius < 4 || radius > 2_000) throw new Error("Compass radius must be between 4 and 2,000 scene units.");
  if (!options.fullCircle && (!Number.isFinite(options.arcExtentDegrees) || options.arcExtentDegrees < 1 || options.arcExtentDegrees > 359)) {
    throw new Error("Arc extent must be from 1 to 359 degrees.");
  }
  const padding = 16;
  const width = radius * 2 + padding * 2;
  const height = width;
  const localCenter = radius + padding;
  const startAngle = normalizeDegrees(degrees(Math.atan2(radiusPoint.y - center.y, radiusPoint.x - center.x)));
  const signedExtent = (options.direction === "clockwise" ? 1 : -1) * options.arcExtentDegrees;
  const endAngle = options.fullCircle ? startAngle + 360 : startAngle + signedExtent;
  let geometry: string;
  if (options.fullCircle) {
    geometry = `<circle data-part="construction" cx="${compact(localCenter)}" cy="${compact(localCenter)}" r="${compact(radius)}"/>`;
  } else {
    const startRadians = startAngle * Math.PI / 180;
    const endRadians = endAngle * Math.PI / 180;
    const startX = localCenter + radius * Math.cos(startRadians);
    const startY = localCenter + radius * Math.sin(startRadians);
    const endX = localCenter + radius * Math.cos(endRadians);
    const endY = localCenter + radius * Math.sin(endRadians);
    const largeArc = options.arcExtentDegrees > 180 ? 1 : 0;
    const sweep = options.direction === "clockwise" ? 1 : 0;
    geometry = `<path data-part="construction" d="M ${compact(startX)} ${compact(startY)} A ${compact(radius)} ${compact(radius)} 0 ${largeArc} ${sweep} ${compact(endX)} ${compact(endY)}"/>`;
  }
  const centerMark = options.centerMark ? `<g data-part="center-mark"><circle cx="${compact(localCenter)}" cy="${compact(localCenter)}" r="4"/><line x1="${compact(localCenter - 9)}" y1="${compact(localCenter)}" x2="${compact(localCenter + 9)}" y2="${compact(localCenter)}"/><line x1="${compact(localCenter)}" y1="${compact(localCenter - 9)}" x2="${compact(localCenter)}" y2="${compact(localCenter + 9)}"/></g>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${compact(width)}" height="${compact(height)}" viewBox="0 0 ${compact(width)} ${compact(height)}" role="img" aria-label="Compass ${options.fullCircle ? "circle" : "arc"} with radius ${compact(radius)}"><g fill="none" stroke="#2859c5" stroke-width="2.5" stroke-linecap="round">${geometry}${centerMark}</g></svg>`;
  const metadata: CompassMathToolMetadata = {
    schemaVersion: 1, kind: "compass", category: "instruments", calibration: "scene-geometry",
    naturalWidth: width, naturalHeight: height, constructionVersion: 1,
    centerX: center.x, centerY: center.y, radiusPointX: radiusPoint.x, radiusPointY: radiusPoint.y,
    radiusSceneUnits: radius, startAngleDegrees: startAngle, endAngleDegrees: endAngle,
    direction: options.direction, fullCircle: options.fullCircle, centerMark: options.centerMark,
    strokeColor: "#2859c5", strokeWidth: 2.5, strokeStyle: "solid",
  };
  return {
    asset: { dataUrl: mathSvgToDataUrl(svg), height, svg, width },
    metadata,
    scenePosition: { x: center.x - localCenter, y: center.y - localCenter },
    toastMessage: `Compass ${options.fullCircle ? "circle" : "arc"} added.`,
  };
}

export function regenerateCompassConstruction(metadata: CompassMathToolMetadata): GeneratedMathTool {
  return createCompassConstruction(
    { x: metadata.centerX, y: metadata.centerY },
    { x: metadata.radiusPointX, y: metadata.radiusPointY },
    {
      fullCircle: metadata.fullCircle,
      arcExtentDegrees: metadata.fullCircle ? 180 : Math.abs(metadata.endAngleDegrees - metadata.startAngleDegrees),
      direction: metadata.direction,
      centerMark: metadata.centerMark,
    },
  );
}

export function measuredAngleDegrees(vertex: MathPoint, firstRay: MathPoint, secondRay: MathPoint, reflex = false): number {
  if (![vertex, firstRay, secondRay].every(finitePoint)) throw new Error("Angle points must have finite scene coordinates.");
  const first = { x: firstRay.x - vertex.x, y: firstRay.y - vertex.y };
  const second = { x: secondRay.x - vertex.x, y: secondRay.y - vertex.y };
  const firstLength = Math.hypot(first.x, first.y);
  const secondLength = Math.hypot(second.x, second.y);
  if (firstLength < 4 || secondLength < 4) throw new Error("Angle rays must extend at least 4 scene units from the vertex.");
  const cosine = Math.max(-1, Math.min(1, (first.x * second.x + first.y * second.y) / (firstLength * secondLength)));
  const interior = degrees(Math.acos(cosine));
  return reflex && interior > 0 ? 360 - interior : interior;
}

export function createAngleMeasurement(vertex: MathPoint, firstRay: MathPoint, secondRay: MathPoint, options: AngleMeasurementOptions): GeneratedMathTool {
  if (!Number.isInteger(options.precision) || options.precision < 0 || options.precision > 2) throw new Error("Angle precision must be 0, 1, or 2 decimal places.");
  const angle = measuredAngleDegrees(vertex, firstRay, secondRay, options.reflex);
  const padding = 42;
  const minX = Math.min(vertex.x, firstRay.x, secondRay.x) - padding;
  const minY = Math.min(vertex.y, firstRay.y, secondRay.y) - padding;
  const maxX = Math.max(vertex.x, firstRay.x, secondRay.x) + padding;
  const maxY = Math.max(vertex.y, firstRay.y, secondRay.y) + padding;
  const width = maxX - minX;
  const height = maxY - minY;
  if (width > 4_096 || height > 4_096) throw new Error("Measured angle is too large to insert.");
  const local = (point: MathPoint) => ({ x: point.x - minX, y: point.y - minY });
  const v = local(vertex);
  const a = local(firstRay);
  const b = local(secondRay);
  const firstDirection = Math.atan2(a.y - v.y, a.x - v.x);
  const secondDirection = Math.atan2(b.y - v.y, b.x - v.x);
  let sweep = secondDirection - firstDirection;
  while (sweep < 0) sweep += Math.PI * 2;
  if (!options.reflex && sweep > Math.PI) sweep -= Math.PI * 2;
  if (options.reflex && Math.abs(sweep) < Math.PI) sweep += sweep >= 0 ? -Math.PI * 2 : Math.PI * 2;
  const arcRadius = Math.min(44, Math.max(20, Math.min(Math.hypot(a.x - v.x, a.y - v.y), Math.hypot(b.x - v.x, b.y - v.y)) / 3));
  const arcStart = { x: v.x + arcRadius * Math.cos(firstDirection), y: v.y + arcRadius * Math.sin(firstDirection) };
  const arcEnd = { x: v.x + arcRadius * Math.cos(firstDirection + sweep), y: v.y + arcRadius * Math.sin(firstDirection + sweep) };
  const largeArc = Math.abs(sweep) > Math.PI ? 1 : 0;
  const sweepFlag = sweep >= 0 ? 1 : 0;
  const labelDirection = firstDirection + sweep / 2;
  const label = { x: v.x + (arcRadius + 24) * Math.cos(labelDirection), y: v.y + (arcRadius + 24) * Math.sin(labelDirection) };
  const rounded = Number(angle.toFixed(options.precision));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${compact(width)}" height="${compact(height)}" viewBox="0 0 ${compact(width)} ${compact(height)}" role="img" aria-label="Measured angle ${rounded} degrees"><g fill="none" stroke="#7a3db8" stroke-width="2.2" stroke-linecap="round"><line data-ray="first" x1="${compact(v.x)}" y1="${compact(v.y)}" x2="${compact(a.x)}" y2="${compact(a.y)}"/><line data-ray="second" x1="${compact(v.x)}" y1="${compact(v.y)}" x2="${compact(b.x)}" y2="${compact(b.y)}"/><path data-part="angle-arc" d="M ${compact(arcStart.x)} ${compact(arcStart.y)} A ${compact(arcRadius)} ${compact(arcRadius)} 0 ${largeArc} ${sweepFlag} ${compact(arcEnd.x)} ${compact(arcEnd.y)}"/></g><circle cx="${compact(v.x)}" cy="${compact(v.y)}" r="3.5" fill="#7a3db8"/><text data-part="angle-label" x="${compact(label.x)}" y="${compact(label.y)}" text-anchor="middle" fill="#51277d" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700">${rounded}°</text></svg>`;
  const metadata: AngleMeasurementMathToolMetadata = {
    schemaVersion: 1, kind: "angle-measurement", category: "instruments", calibration: "scene-geometry",
    naturalWidth: width, naturalHeight: height, measurementVersion: 1,
    vertexX: vertex.x, vertexY: vertex.y, firstRayX: firstRay.x, firstRayY: firstRay.y, secondRayX: secondRay.x, secondRayY: secondRay.y,
    reflex: options.reflex, precision: options.precision, measuredDegrees: rounded, commitAnnotation: true,
    unit: "degrees", annotationStrokeColor: "#7a3db8", annotationStrokeWidth: 2.2,
  };
  return { asset: { dataUrl: mathSvgToDataUrl(svg), height, svg, width }, metadata, scenePosition: { x: minX, y: minY }, toastMessage: `Angle measured: ${rounded}°.` };
}

export function regenerateAngleMeasurement(metadata: AngleMeasurementMathToolMetadata): GeneratedMathTool {
  return createAngleMeasurement(
    { x: metadata.vertexX, y: metadata.vertexY },
    { x: metadata.firstRayX, y: metadata.firstRayY },
    { x: metadata.secondRayX, y: metadata.secondRayY },
    { reflex: metadata.reflex, precision: metadata.precision },
  );
}

export function transformElementGeometry(geometry: TransformableGeometry, centre: MathPoint, options: TransformationOptions): TransformableGeometry {
  if (![geometry.x, geometry.y, geometry.width, geometry.height, geometry.angle, centre.x, centre.y].every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0) {
    throw new Error("Selected element has invalid transform geometry.");
  }
  if (![options.translateX, options.translateY, options.angleDegrees, options.scaleFactor, options.mirrorLineAngleDegrees].every(Number.isFinite)) throw new Error("Transformation values must be finite numbers.");
  if (Math.abs(options.translateX) > 10_000 || Math.abs(options.translateY) > 10_000) throw new Error("Translation must stay within 10,000 scene units.");
  if (Math.abs(options.angleDegrees) > 360) throw new Error("Rotation must stay within 360 degrees.");
  if (Math.abs(options.mirrorLineAngleDegrees) > 360) throw new Error("Mirror-line angle must stay within 360 degrees.");
  if (options.scaleFactor < 0.05 || options.scaleFactor > 20) throw new Error("Dilation scale must be from 0.05 to 20.");
  const elementCentre = { x: geometry.x + geometry.width / 2, y: geometry.y + geometry.height / 2 };
  if (options.transformationType === "translate") return { ...geometry, x: geometry.x + options.translateX, y: geometry.y + options.translateY };
  if (options.transformationType === "rotate") {
    const radians = options.angleDegrees * Math.PI / 180;
    const deltaX = elementCentre.x - centre.x;
    const deltaY = elementCentre.y - centre.y;
    const nextCentre = { x: centre.x + deltaX * Math.cos(radians) - deltaY * Math.sin(radians), y: centre.y + deltaX * Math.sin(radians) + deltaY * Math.cos(radians) };
    return { ...geometry, x: nextCentre.x - geometry.width / 2, y: nextCentre.y - geometry.height / 2, angle: geometry.angle + radians };
  }
  if (options.transformationType === "reflect-vertical") {
    const nextCentreX = centre.x * 2 - elementCentre.x;
    return { ...geometry, x: nextCentreX - geometry.width / 2, angle: Math.PI - geometry.angle };
  }
  if (options.transformationType === "reflect-horizontal") {
    const nextCentreY = centre.y * 2 - elementCentre.y;
    return { ...geometry, y: nextCentreY - geometry.height / 2, angle: -geometry.angle };
  }
  if (options.transformationType === "reflect-line") {
    const radians = options.mirrorLineAngleDegrees * Math.PI / 180;
    const unit = { x: Math.cos(radians), y: Math.sin(radians) };
    const delta = { x: elementCentre.x - centre.x, y: elementCentre.y - centre.y };
    const projection = delta.x * unit.x + delta.y * unit.y;
    const reflected = {
      x: 2 * projection * unit.x - delta.x,
      y: 2 * projection * unit.y - delta.y,
    };
    const nextCentre = { x: centre.x + reflected.x, y: centre.y + reflected.y };
    return { ...geometry, x: nextCentre.x - geometry.width / 2, y: nextCentre.y - geometry.height / 2, angle: 2 * radians - geometry.angle };
  }
  const width = geometry.width * options.scaleFactor;
  const height = geometry.height * options.scaleFactor;
  const nextCentre = { x: centre.x + (elementCentre.x - centre.x) * options.scaleFactor, y: centre.y + (elementCentre.y - centre.y) * options.scaleFactor };
  return { ...geometry, x: nextCentre.x - width / 2, y: nextCentre.y - height / 2, width, height };
}

export function transformationMetadata(sourceElementId: string, naturalWidth: number, naturalHeight: number, centre: MathPoint, options: TransformationOptions): TransformationMathToolMetadata {
  const mirrorRadians = options.mirrorLineAngleDegrees * Math.PI / 180;
  const mirrorVector = { x: Math.cos(mirrorRadians) * 100, y: Math.sin(mirrorRadians) * 100 };
  const metadata: TransformationMathToolMetadata = {
    schemaVersion: 1, kind: "transformation", category: "graphs", calibration: "scene-geometry",
    naturalWidth, naturalHeight, transformationVersion: 1, transformationType: options.transformationType,
    sourceElementId, copyPolicy: "copy", translateX: options.translateX, translateY: options.translateY,
    angleDegrees: options.angleDegrees, scaleFactor: options.scaleFactor, centreX: centre.x, centreY: centre.y,
    mirrorLineStartX: centre.x - mirrorVector.x, mirrorLineStartY: centre.y - mirrorVector.y,
    mirrorLineEndX: centre.x + mirrorVector.x, mirrorLineEndY: centre.y + mirrorVector.y,
  };
  return metadata;
}

export function createTransformationPreview(options: TransformationOptions): GeneratedMathTool {
  const width = 320;
  const height = 180;
  const source = { x: 54, y: 55, width: 70, height: 70, angle: 0 };
  const centre = { x: 160, y: 90 };
  const transformed = transformElementGeometry(source, centre, options);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Transformation preview"><rect x="${source.x}" y="${source.y}" width="${source.width}" height="${source.height}" fill="#dbe7ff" stroke="#2859c5" stroke-dasharray="5 3"/><rect x="${compact(transformed.x)}" y="${compact(transformed.y)}" width="${compact(transformed.width)}" height="${compact(transformed.height)}" transform="rotate(${compact(degrees(transformed.angle))} ${compact(transformed.x + transformed.width / 2)} ${compact(transformed.y + transformed.height / 2)})" fill="#f3d5ff" fill-opacity="0.75" stroke="#7a3db8"/><circle cx="${centre.x}" cy="${centre.y}" r="4" fill="#172033"/></svg>`;
  return { asset: { dataUrl: mathSvgToDataUrl(svg), height, svg, width }, metadata: transformationMetadata("preview", width, height, centre, options), toastMessage: "Transformation preview added." };
}
