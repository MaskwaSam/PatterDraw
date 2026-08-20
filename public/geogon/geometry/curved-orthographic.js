// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 MaskwaSam <136355328+MaskwaSam@users.noreply.github.com>

/**
 * Analytic orthographic projections for the four curved primitives used by
 * 3DGeoGon.  This module deliberately works only with ordinary JavaScript
 * values.  There is no renderer, DOM, or THREE state involved.
 *
 * Screen coordinates are model-unit, screen-up coordinates in the right/up
 * basis supplied by geometry/orthographic-views.js.  Preview points are
 * merely deterministic drawing helpers; every outline and every bounds value
 * is represented by an exact descriptor/support calculation as well.
 */

import {
    ORTHOGRAPHIC_VIEW_BASES,
    getOrthographicViewDefinition,
    projectPointToView,
} from './orthographic-views.js';

const TAU = Math.PI * 2;
const DEFAULT_PREVIEW_SEGMENTS = 64;
const DEFAULT_TOLERANCE = 1e-10;
const CURVE_EPSILON = 1e-12;
const MACHINE_GEOMETRY_EPSILON = Number.EPSILON * 64;
const SUPPORTED_PRIMITIVES = new Set(['sphere', 'cylinder', 'cone', 'hemisphere']);

/** Error thrown for malformed parameters or impossible derived geometry. */
export class CurvedOrthographicError extends Error {
    constructor(code, message, details = undefined) {
        super(`${code}: ${message}`);
        this.name = 'CurvedOrthographicError';
        this.code = code;
        if (details !== undefined) {
            this.details = details;
            if (details && typeof details === 'object' && details.diagnostic !== undefined) {
                this.diagnostic = details.diagnostic;
            }
        }
    }
}

function fail(code, message, details = undefined) {
    throw new CurvedOrthographicError(code, message, details);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail('INVALID_PARAMETER', `${label} must be a finite number`, { parameter: label, value });
    }
    return value;
}

function positiveNumber(value, label) {
    finiteNumber(value, label);
    if (value <= 0) {
        fail('INVALID_PARAMETER', `${label} must be greater than zero`, { parameter: label, value });
    }
    return value;
}

function cleanZero(value) {
    return Object.is(value, -0) ? 0 : value;
}

function point(x, y) {
    return { x: cleanZero(x), y: cleanZero(y) };
}

function vector(x, y, z) {
    return { x: cleanZero(x), y: cleanZero(y), z: cleanZero(z) };
}

function readVector(value, label) {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        if (value.length < 3) {
            fail('INVALID_PARAMETER', `${label} must have at least three components`, { parameter: label });
        }
        return vector(
            finiteNumber(value[0], label),
            finiteNumber(value[1], label),
            finiteNumber(value[2], label)
        );
    }
    if (!isRecord(value) || !('x' in value) || !('y' in value) || !('z' in value)) {
        fail('INVALID_PARAMETER', `${label} must be an [x, y, z] array or an object with x, y, z`, {
            parameter: label,
        });
    }
    return vector(
        finiteNumber(value.x, label),
        finiteNumber(value.y, label),
        finiteNumber(value.z, label)
    );
}

function normalizeAxis(value, label = 'axis') {
    const raw = readVector(value, label);
    const magnitude = Math.hypot(raw.x, raw.y, raw.z);
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
        fail('INVALID_AXIS', `${label} must have non-zero finite magnitude`, {
            parameter: label,
            value: raw,
        });
    }
    // Preserve an already normalized vector within a few ulps.  Re-dividing
    // the frozen descriptor stored in a projection result can otherwise move
    // its components by one ulp and make strict semantic validation drift.
    let axis = magnitude <= 1 && Math.abs(magnitude - 1) <= Number.EPSILON * 4
        ? raw
        : vector(raw.x / magnitude, raw.y / magnitude, raw.z / magnitude);
    // A first division can round the resulting norm one ulp above one.  A
    // final correction makes the stored canonical vector idempotent while
    // avoiding an over-unit depth component in support calculations.
    const normalizedMagnitude = Math.hypot(axis.x, axis.y, axis.z);
    if (normalizedMagnitude > 1) {
        axis = vector(axis.x / normalizedMagnitude, axis.y / normalizedMagnitude, axis.z / normalizedMagnitude);
    }
    if (![axis.x, axis.y, axis.z].every(Number.isFinite)) {
        fail('DERIVED_GEOMETRY_OVERFLOW', `${label} normalization is not finite`, { parameter: label });
    }
    return axis;
}

function normalizePrimitiveKey(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        fail('INVALID_PRIMITIVE', 'primitiveKey must be a non-empty string');
    }
    const primitiveKey = value.trim().toLowerCase();
    if (!SUPPORTED_PRIMITIVES.has(primitiveKey)) {
        fail('UNSUPPORTED_PRIMITIVE', `unsupported curved primitive ${primitiveKey}`, { primitiveKey });
    }
    return primitiveKey;
}

function normalizeDescriptor(descriptor) {
    if (!isRecord(descriptor)) {
        fail('INVALID_DESCRIPTOR', 'descriptor must be an object');
    }
    const primitiveKey = normalizePrimitiveKey(descriptor.primitiveKey);
    const center = readVector(descriptor.center, 'center');
    const axis = descriptor.axis === undefined ? vector(0, 1, 0) : normalizeAxis(descriptor.axis);
    const radius = positiveNumber(descriptor.radius, 'radius');
    const hasHeight = Object.prototype.hasOwnProperty.call(descriptor, 'height');
    let height;
    if (primitiveKey === 'cylinder' || primitiveKey === 'cone') {
        if (!hasHeight) {
            fail('INVALID_PARAMETER', `${primitiveKey} height is required`, { parameter: 'height' });
        }
        height = positiveNumber(descriptor.height, 'height');
    } else if (hasHeight) {
        // A height on a sphere/hemisphere has no geometric meaning, but when a
        // caller supplies it it is still a dimension and must be valid.
        height = positiveNumber(descriptor.height, 'height');
    }

    const normalized = { primitiveKey, center, axis, radius };
    if (height !== undefined) normalized.height = height;
    return normalized;
}

function normalizeOptions(options) {
    if (options === undefined) options = {};
    if (!isRecord(options)) {
        fail('INVALID_OPTIONS', 'options must be an object');
    }
    if (options.showHiddenEdges !== undefined && typeof options.showHiddenEdges !== 'boolean') {
        fail('INVALID_OPTIONS', 'options.showHiddenEdges must be boolean');
    }
    const segmentValue = options.previewSegments
        ?? options.pathSegments
        ?? options.arcSegments
        ?? options.sampleCount
        ?? DEFAULT_PREVIEW_SEGMENTS;
    if (!Number.isInteger(segmentValue) || segmentValue < 4 || segmentValue > 4096) {
        fail('INVALID_OPTIONS', 'options.previewSegments must be an integer from 4 through 4096', {
            parameter: 'previewSegments',
            value: segmentValue,
        });
    }
    const tolerance = options.tolerance ?? options.epsilon ?? DEFAULT_TOLERANCE;
    finiteNumber(tolerance, 'options.tolerance');
    if (tolerance < 0) {
        fail('INVALID_OPTIONS', 'options.tolerance must not be negative', { parameter: 'tolerance', value: tolerance });
    }
    return {
        showHiddenEdges: options.showHiddenEdges === true,
        previewSegments: segmentValue,
        tolerance,
    };
}

function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    Object.values(value).forEach((child) => deepFreeze(child, seen));
    return Object.freeze(value);
}

function clonePoint(value) {
    return point(value.x, value.y);
}

function cloneCurve(value) {
    if (!isRecord(value)) return value;
    const output = {};
    Object.entries(value).forEach(([key, child]) => {
        if (key === 'points' || key === 'previewPoints' || key === 'curves' || key === 'segments') return;
        if (child && typeof child === 'object') {
            if (Array.isArray(child)) output[key] = child.map((item) => (isRecord(item) ? cloneCurve(item) : item));
            else if (isRecord(child)) output[key] = cloneCurve(child);
            else output[key] = child;
        } else {
            output[key] = child;
        }
    });
    return output;
}

function addAliasFields(curve) {
    // Keep the compact canonical fields while exposing descriptive aliases
    // used by SVG/canvas clients and by older geometry helpers.
    if (curve.type === 'line') {
        curve.from = curve.start;
        curve.to = curve.end;
        curve.a = curve.start;
        curve.b = curve.end;
        curve.length = Math.hypot(curve.end.x - curve.start.x, curve.end.y - curve.start.y);
    }
    if (curve.type === 'circle') {
        curve.radiusX = curve.radius;
        curve.radiusY = curve.radius;
        curve.rx = curve.radius;
        curve.ry = curve.radius;
        curve.rotation = 0;
    }
    if (curve.type === 'ellipse' || curve.type === 'ellipseArc') {
        curve.rx = curve.radiusX;
        curve.ry = curve.radiusY;
        curve.semiAxisX = curve.radiusX;
        curve.semiAxisY = curve.radiusY;
        curve.semiMajor = Math.max(curve.radiusX, curve.radiusY);
        curve.semiMinor = Math.min(curve.radiusX, curve.radiusY);
        curve.rotationRadians = curve.rotation;
        curve.angle = curve.rotation;
    }
    if (curve.startAngle !== undefined && curve.endAngle !== undefined) {
        curve.centralAngle = curve.endAngle - curve.startAngle;
        curve.span = curve.centralAngle;
        curve.centralAngleRadians = curve.centralAngle;
    }
    return curve;
}

function makeLine(start, end, extra = {}) {
    return addAliasFields({
        ...extra,
        type: 'line',
        kind: 'line',
        exact: true,
        closed: false,
        start: clonePoint(start),
        end: clonePoint(end),
    });
}

function makeCircle(center, radius, extra = {}) {
    return addAliasFields({
        type: 'circle',
        kind: 'circle',
        curveType: 'circle',
        exact: true,
        closed: true,
        center: clonePoint(center),
        radius,
        startAngle: 0,
        endAngle: TAU,
        ...extra,
    });
}

function makeEllipse(center, radiusX, radiusY, rotation, tolerance, extra = {}) {
    const degenerate = radiusX === 0 || radiusY === 0;
    if (degenerate) {
        const ex = { x: Math.cos(rotation), y: Math.sin(rotation) };
        const ey = { x: -Math.sin(rotation), y: Math.cos(rotation) };
        const major = Math.max(Math.abs(radiusX), Math.abs(radiusY));
        const majorAlongX = Math.abs(radiusX) >= Math.abs(radiusY);
        const direction = majorAlongX ? ex : ey;
        const line = makeLine(
            point(center.x - direction.x * major, center.y - direction.y * major),
            point(center.x + direction.x * major, center.y + direction.y * major),
            {
                ...extra,
                kind: 'degenerate-ellipse-line',
                sourceType: 'ellipse',
                sourceKind: 'rotated-ellipse',
                degenerate: true,
                closed: false,
            }
        );
        return line;
    }
    const circleLike = radiusX === radiusY;
    if (circleLike) {
        return makeCircle(center, (radiusX + radiusY) / 2, {
            ...extra,
            sourceType: 'ellipse',
            sourceKind: 'rotated-ellipse',
            rotation,
        });
    }
    return addAliasFields({
        type: 'ellipse',
        kind: 'rotated-ellipse',
        curveType: 'ellipse',
        exact: true,
        closed: true,
        center: clonePoint(center),
        radiusX,
        radiusY,
        rotation,
        ...extra,
    });
}

function makeEllipseArc(center, radiusX, radiusY, rotation, startAngle, endAngle, tolerance, extra = {}) {
    if (radiusX === 0 || radiusY === 0) {
        const ex = { x: Math.cos(rotation), y: Math.sin(rotation) };
        const ey = { x: -Math.sin(rotation), y: Math.cos(rotation) };
        const start = point(
            center.x + radiusX * Math.cos(startAngle) * ex.x + radiusY * Math.sin(startAngle) * ey.x,
            center.y + radiusX * Math.cos(startAngle) * ex.y + radiusY * Math.sin(startAngle) * ey.y
        );
        const end = point(
            center.x + radiusX * Math.cos(endAngle) * ex.x + radiusY * Math.sin(endAngle) * ey.x,
            center.y + radiusX * Math.cos(endAngle) * ex.y + radiusY * Math.sin(endAngle) * ey.y
        );
        return makeLine(start, end, {
            ...extra,
            kind: 'degenerate-ellipse-arc-line',
            sourceType: 'ellipseArc',
            sourceKind: 'ellipse-arc',
            startAngle,
            endAngle,
            degenerate: true,
        });
    }
    const circleLike = radiusX === radiusY;
    return addAliasFields({
        type: 'ellipseArc',
        kind: circleLike ? 'circle-arc' : 'ellipse-arc',
        curveType: circleLike ? 'circleArc' : 'ellipseArc',
        exact: true,
        closed: false,
        center: clonePoint(center),
        radiusX,
        radiusY,
        rotation,
        startAngle,
        endAngle,
        isCircle: circleLike,
        ...extra,
    });
}

function localToScreen(center, basis, localX, localY) {
    return point(
        center.x + basis.eA.x * localX + basis.eB.x * localY,
        center.y + basis.eA.y * localX + basis.eB.y * localY
    );
}

function sampleCurve(curve, segments) {
    if (curve.type === 'line') {
        return [clonePoint(curve.start), clonePoint(curve.end)];
    }
    if (curve.type === 'circle') {
        const count = Math.max(4, segments);
        const samples = [];
        for (let index = 0; index <= count; index += 1) {
            const angle = (TAU * index) / count;
            samples.push(point(
                curve.center.x + curve.radius * Math.cos(angle),
                curve.center.y + curve.radius * Math.sin(angle)
            ));
        }
        samples[samples.length - 1] = clonePoint(samples[0]);
        return samples;
    }
    if (curve.type === 'ellipse' || curve.type === 'ellipseArc') {
        const span = curve.endAngle - curve.startAngle;
        const count = curve.type === 'ellipse' ? Math.max(4, segments) : Math.max(2, Math.ceil(segments * Math.abs(span) / TAU));
        const ex = { x: Math.cos(curve.rotation), y: Math.sin(curve.rotation) };
        const ey = { x: -Math.sin(curve.rotation), y: Math.cos(curve.rotation) };
        const samples = [];
        for (let index = 0; index <= count; index += 1) {
            const angle = curve.type === 'ellipse'
                ? (TAU * index) / count
                : curve.startAngle + (span * index) / count;
            samples.push(point(
                curve.center.x + curve.radiusX * Math.cos(angle) * ex.x + curve.radiusY * Math.sin(angle) * ey.x,
                curve.center.y + curve.radiusX * Math.cos(angle) * ex.y + curve.radiusY * Math.sin(angle) * ey.y
            ));
        }
        if (curve.type === 'ellipse') samples[samples.length - 1] = clonePoint(samples[0]);
        return samples;
    }
    return [];
}

function withPreview(curve, segments) {
    const preview = sampleCurve(curve, segments);
    return { ...curve, points: preview, previewPoints: preview };
}

function joinPreviewCurves(curves, segments) {
    const points = [];
    curves.forEach((curve, curveIndex) => {
        const sampled = sampleCurve(curve, segments);
        sampled.forEach((item, pointIndex) => {
            if (curveIndex > 0 && pointIndex === 0 && points.length > 0) {
                const previous = points[points.length - 1];
                if (Math.abs(previous.x - item.x) <= CURVE_EPSILON && Math.abs(previous.y - item.y) <= CURVE_EPSILON) {
                    return;
                }
            }
            points.push(item);
        });
    });
    if (points.length > 0) {
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.abs(first.x - last.x) > CURVE_EPSILON || Math.abs(first.y - last.y) > CURVE_EPSILON) {
            points.push(clonePoint(first));
        } else {
            points[points.length - 1] = clonePoint(first);
        }
    }
    return points;
}

function addCurveIdentity(curve, id, role, visibility = undefined) {
    const output = { ...curve, id, role };
    if (visibility !== undefined) output.visibility = visibility;
    return output;
}

function makePathOutline(id, curves, segments) {
    const points = joinPreviewCurves(curves, segments);
    const exactCurves = curves.map((curve) => cloneCurve(curve));
    return {
        id,
        type: 'path',
        kind: 'closed-path',
        curveType: 'path',
        exact: true,
        closed: true,
        curves: exactCurves,
        segments: exactCurves.map((curve) => cloneCurve(curve)),
        points,
        previewPoints: points.map(clonePoint),
    };
}

function makeSimpleOutline(curve, segments) {
    const preview = sampleCurve(curve, segments);
    return {
        ...curve,
        closed: true,
        points: preview,
        previewPoints: preview.map(clonePoint),
    };
}

function projectionBasis(definition, centerProjection, axis) {
    const a = point(
        axis.x * definition.right.x + axis.y * definition.right.y + axis.z * definition.right.z,
        axis.x * definition.up.x + axis.y * definition.up.y + axis.z * definition.up.z
    );
    const depth = axis.x * definition.cameraDirection.x
        + axis.y * definition.cameraDirection.y
        + axis.z * definition.cameraDirection.z;
    const length = Math.hypot(a.x, a.y);
    let eA;
    if (length > 0) {
        eA = point(a.x / length, a.y / length);
    } else {
        // The orientation of an end-on circle is arbitrary; +screen-X keeps
        // descriptors deterministic across all canonical views.
        eA = point(1, 0);
    }
    const eB = point(-eA.y, eA.x);
    // A normalized component near one can round to exactly one (losing the
    // tiny transverse component), while a component near zero is represented
    // accurately.  Select the stable side of the unit identity for the view
    // depth so large model radii retain their nonzero projected rim radius.
    const complementDepth = Math.sqrt(Math.max(0, 1 - length * length));
    const depthMagnitude = length < 0.5 ? complementDepth : Math.abs(depth);
    const stableDepth = depth === 0 ? 0 : Math.sign(depth) * depthMagnitude;
    return {
        center: point(centerProjection.x, centerProjection.y),
        centerDepth: centerProjection.depth,
        a,
        depth: stableDepth,
        rawDepth: depth,
        axisScreenLength: length,
        eA,
        eB,
        rotation: Math.atan2(eA.y, eA.x),
    };
}

function scaleIsNearZero(value, scale = 1) {
    return value === 0;
}

function ellipseSupport(basis, radius, normalX, normalY) {
    // For a circular section in the plane perpendicular to axis, the
    // projected support is R*sqrt(1-(axisScreen dot normal)^2).
    // Compute the complement as d^2 + |a|^2*sin^2(theta), rather than
    // subtracting a nearly-one square.  This preserves a nonzero rim minor
    // radius for near-end-on axes at very large model scales.
    const across = basis.eB.x * normalX + basis.eB.y * normalY;
    let remaining = basis.depth * basis.depth
        + basis.axisScreenLength * basis.axisScreenLength * across * across;
    if (remaining < 0) remaining = 0;
    if (remaining > 1 && remaining - 1 <= MACHINE_GEOMETRY_EPSILON * 4) remaining = 1;
    return radius * Math.sqrt(remaining);
}

function cylinderSupport(basis, radius, height, normalX, normalY) {
    const axial = basis.a.x * normalX + basis.a.y * normalY;
    return ellipseSupport(basis, radius, normalX, normalY) + (height / 2) * Math.abs(axial);
}

function coneSupport(basis, radius, height, normalX, normalY) {
    const axial = basis.a.x * normalX + basis.a.y * normalY;
    return Math.max(ellipseSupport(basis, radius, normalX, normalY), height * axial);
}

function hemisphereSupport(basis, radius, normalX, normalY) {
    const axial = basis.a.x * normalX + basis.a.y * normalY;
    // Normals facing the projected dome have a spherical support point.  The
    // opposite normals are supported by the flat circular rim.
    if (axial >= 0) return radius;
    return ellipseSupport(basis, radius, normalX, normalY);
}

function boundsFromSupport(center, support) {
    const positiveX = support(1, 0);
    const negativeX = support(-1, 0);
    const positiveY = support(0, 1);
    const negativeY = support(0, -1);
    const minX = center.x - negativeX;
    const maxX = center.x + positiveX;
    const minY = center.y - negativeY;
    const maxY = center.y + positiveY;
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
        fail('DERIVED_GEOMETRY_OVERFLOW', 'analytic projection bounds are not finite');
    }
    const width = maxX - minX;
    const height = maxY - minY;
    if (![width, height].every(Number.isFinite) || width < 0 || height < 0) {
        fail('DERIVED_GEOMETRY_OVERFLOW', 'analytic projection bounds dimensions are not finite');
    }
    const centerX = minX / 2 + maxX / 2;
    const centerY = minY / 2 + maxY / 2;
    return {
        minX: cleanZero(minX),
        minY: cleanZero(minY),
        maxX: cleanZero(maxX),
        maxY: cleanZero(maxY),
        width: cleanZero(width),
        height: cleanZero(height),
        centerX: cleanZero(centerX),
        centerY: cleanZero(centerY),
        min: point(minX, minY),
        max: point(maxX, maxY),
        center: point(centerX, centerY),
        size: point(width, height),
        exact: true,
        method: 'analytic-support',
    };
}

function rimEllipse(basis, radius, tolerance, extra = {}, center = basis.center) {
    const radiusX = radius * Math.abs(basis.depth);
    const radiusY = radius;
    return makeEllipse(center, radiusX, radiusY, basis.rotation, tolerance, extra);
}

function rimArc(basis, radius, startAngle, endAngle, tolerance, extra = {}, center = basis.center) {
    const radiusX = radius * Math.abs(basis.depth);
    const radiusY = radius;
    return makeEllipseArc(center, radiusX, radiusY, basis.rotation, startAngle, endAngle, tolerance, extra);
}

function localPoint(basis, x, y) {
    return localToScreen(basis.center, basis, x, y);
}

function projectedApex(basis, height) {
    return point(basis.center.x + basis.a.x * height, basis.center.y + basis.a.y * height);
}

function capVisibility(dot, tolerance) {
    if (Math.abs(dot) <= Math.max(CURVE_EPSILON, tolerance)) return 'visible';
    return dot > 0 ? 'visible' : 'hidden';
}

function buildSphereGeometry(descriptor, basis, options) {
    const outlineCurve = makeCircle(basis.center, descriptor.radius, { id: 'sphere-silhouette', role: 'silhouette' });
    const outline = makeSimpleOutline(outlineCurve, options.previewSegments);
    const bounds = boundsFromSupport(basis.center, (nx, ny) => descriptor.radius);
    return {
        outlines: [outline],
        outlineCurves: [cloneCurve(outlineCurve)],
        featureCurves: [],
        bounds,
        previewPoints: outline.points.map(clonePoint),
        diagnostics: {
            exact: true,
            support: 'sphere-disk',
            axisScreenLength: basis.axisScreenLength,
            axisDepth: basis.depth,
        },
    };
}

function buildCylinderGeometry(descriptor, basis, options) {
    const { radius, height } = descriptor;
    const halfProjectedLength = (height / 2) * basis.axisScreenLength;
    const edgeOn = scaleIsNearZero(radius * Math.abs(basis.depth), radius);
    const plusCenter = localPoint(basis, halfProjectedLength, 0);
    const minusCenter = localPoint(basis, -halfProjectedLength, 0);
    const endPlus = rimEllipse(basis, radius, options.tolerance, { id: 'cylinder-end-rim-plus', role: 'end-rim', cap: 'plus', endCap: 'plus' }, plusCenter);
    const endMinus = rimEllipse(basis, radius, options.tolerance, { id: 'cylinder-end-rim-minus', role: 'end-rim', cap: 'minus', endCap: 'minus' }, minusCenter);
    const plusVisibility = capVisibility(basis.depth, options.tolerance);
    const minusVisibility = capVisibility(-basis.depth, options.tolerance);
    const featureCurves = [];
    featureCurves.push(addCurveIdentity(endPlus, 'cylinder-end-rim-plus', 'end-rim', plusVisibility));
    featureCurves.push(addCurveIdentity(endMinus, 'cylinder-end-rim-minus', 'end-rim', minusVisibility));

    let outlineCurves;
    if (scaleIsNearZero(halfProjectedLength, radius)) {
        const end = makeEllipse(basis.center, radius * Math.abs(basis.depth), radius, basis.rotation, options.tolerance, {
            id: 'cylinder-silhouette',
            role: 'silhouette',
        });
        outlineCurves = [end];
    } else if (edgeOn) {
        const top = localPoint(basis, halfProjectedLength, radius);
        const leftTop = localPoint(basis, -halfProjectedLength, radius);
        const leftBottom = localPoint(basis, -halfProjectedLength, -radius);
        const bottom = localPoint(basis, halfProjectedLength, -radius);
        outlineCurves = [
            makeLine(localPoint(basis, halfProjectedLength, -radius), top, { id: 'cylinder-end-plus-edge', role: 'end-rim' }),
            makeLine(top, leftTop, { id: 'cylinder-side-upper', role: 'side-silhouette' }),
            makeLine(leftTop, leftBottom, { id: 'cylinder-end-minus-edge', role: 'end-rim' }),
            makeLine(leftBottom, bottom, { id: 'cylinder-side-lower', role: 'side-silhouette' }),
        ];
    } else {
        const rightArc = rimArc(basis, radius, -Math.PI / 2, Math.PI / 2, options.tolerance, {
            id: 'cylinder-end-plus-silhouette', role: 'end-rim-silhouette', cap: 'plus', endCap: 'plus',
        }, plusCenter);
        const leftArc = rimArc(basis, radius, Math.PI / 2, Math.PI * 1.5, options.tolerance, {
            id: 'cylinder-end-minus-silhouette', role: 'end-rim-silhouette', cap: 'minus', endCap: 'minus',
        }, minusCenter);
        const rightTop = localPoint(basis, halfProjectedLength, radius);
        const leftTop = localPoint(basis, -halfProjectedLength, radius);
        const leftBottom = localPoint(basis, -halfProjectedLength, -radius);
        const rightBottom = localPoint(basis, halfProjectedLength, -radius);
        outlineCurves = [
            rightArc,
            makeLine(rightTop, leftTop, { id: 'cylinder-side-upper', role: 'side-silhouette' }),
            leftArc,
            makeLine(leftBottom, rightBottom, { id: 'cylinder-side-lower', role: 'side-silhouette' }),
        ];
    }
    outlineCurves.forEach((curve) => {
        if (curve.role === 'side-silhouette') {
            featureCurves.push(addCurveIdentity(curve, curve.id, curve.role, 'visible'));
        }
    });
    const outline = outlineCurves.length === 1 && (outlineCurves[0].type === 'circle' || outlineCurves[0].type === 'ellipse')
        ? makeSimpleOutline(outlineCurves[0], options.previewSegments)
        : makePathOutline('cylinder-silhouette', outlineCurves, options.previewSegments);
    const visibleFeatures = featureCurves
        .filter((curve) => curve.visibility === 'visible' || options.showHiddenEdges)
        .map((curve) => withPreview(curve, options.previewSegments));
    const bounds = boundsFromSupport(
        basis.center,
        (nx, ny) => cylinderSupport(basis, radius, height, nx, ny)
    );
    return {
        outlines: [outline],
        outlineCurves: outlineCurves.map(cloneCurve),
        featureCurves: visibleFeatures,
        bounds,
        previewPoints: outline.points.map(clonePoint),
        diagnostics: {
            exact: true,
            support: 'axis-segment-minkowski-projected-disk',
            axisScreenLength: basis.axisScreenLength,
            axisDepth: basis.depth,
            halfProjectedAxisLength: halfProjectedLength,
            projectedRim: edgeOn ? 'line' : 'ellipse',
        },
    };
}

function buildConeGeometry(descriptor, basis, options) {
    const { radius, height } = descriptor;
    const apex = projectedApex(basis, height);
    const apexDistance = height * basis.axisScreenLength;
    const rimX = radius * Math.abs(basis.depth);
    const rimY = radius;
    const baseRim = rimEllipse(basis, radius, options.tolerance, { id: 'cone-base-rim', role: 'base-rim' });
    const baseVisibility = capVisibility(-basis.depth, options.tolerance);
    const featureCurves = [addCurveIdentity(baseRim, 'cone-base-rim', 'base-rim', baseVisibility)];
    let outlineCurves;
    const baseDegenerate = scaleIsNearZero(rimX, radius);
    const apexInside = apexDistance <= rimX + MACHINE_GEOMETRY_EPSILON
        * Math.max(Number.MIN_VALUE, radius, apexDistance);
    if (apexInside) {
        if (baseDegenerate) {
            const baseLine = makeEllipse(basis.center, rimX, rimY, basis.rotation, options.tolerance, {
                id: 'cone-base-silhouette', role: 'base-rim-silhouette',
            });
            outlineCurves = [baseLine];
        } else {
            outlineCurves = [makeEllipse(basis.center, rimX, rimY, basis.rotation, options.tolerance, {
                id: 'cone-base-silhouette', role: 'base-rim-silhouette',
            })];
        }
    } else if (baseDegenerate) {
        const top = localPoint(basis, 0, radius);
        const bottom = localPoint(basis, 0, -radius);
        outlineCurves = [
            makeLine(apex, top, { id: 'cone-side-upper', role: 'side-silhouette' }),
            makeLine(top, bottom, { id: 'cone-base-edge', role: 'base-rim-silhouette' }),
            makeLine(bottom, apex, { id: 'cone-side-lower', role: 'side-silhouette' }),
        ];
    } else {
        const tangentCos = Math.min(1, Math.max(-1, rimX / apexDistance));
        const tangentAngle = Math.acos(tangentCos);
        const tangentUpper = localPoint(basis, rimX * rimX / apexDistance, rimY * Math.sqrt(Math.max(0, 1 - tangentCos * tangentCos)));
        const tangentLower = localPoint(basis, rimX * rimX / apexDistance, -rimY * Math.sqrt(Math.max(0, 1 - tangentCos * tangentCos)));
        const baseArc = makeEllipseArc(
            basis.center,
            rimX,
            rimY,
            basis.rotation,
            tangentAngle,
            TAU - tangentAngle,
            options.tolerance,
            { id: 'cone-base-silhouette-arc', role: 'base-rim-silhouette' }
        );
        outlineCurves = [
            makeLine(apex, tangentUpper, { id: 'cone-side-upper', role: 'side-silhouette' }),
            baseArc,
            makeLine(tangentLower, apex, { id: 'cone-side-lower', role: 'side-silhouette' }),
        ];
    }
    outlineCurves.forEach((curve) => {
        if (curve.role === 'side-silhouette') {
            featureCurves.push(addCurveIdentity(curve, curve.id, curve.role, 'visible'));
        }
    });
    const outline = outlineCurves.length === 1 && (outlineCurves[0].type === 'circle' || outlineCurves[0].type === 'ellipse')
        ? makeSimpleOutline(outlineCurves[0], options.previewSegments)
        : makePathOutline('cone-silhouette', outlineCurves, options.previewSegments);
    const visibleFeatures = featureCurves
        .filter((curve) => curve.visibility === 'visible' || options.showHiddenEdges)
        .map((curve) => withPreview(curve, options.previewSegments));
    const bounds = boundsFromSupport(basis.center, (nx, ny) => coneSupport(basis, radius, height, nx, ny));
    return {
        outlines: [outline],
        outlineCurves: outlineCurves.map(cloneCurve),
        featureCurves: visibleFeatures,
        bounds,
        previewPoints: outline.points.map(clonePoint),
        diagnostics: {
            exact: true,
            support: 'convex-hull-projected-base-ellipse-apex',
            axisScreenLength: basis.axisScreenLength,
            axisDepth: basis.depth,
            apex: clonePoint(apex),
            apexProjectedDistance: apexDistance,
            apexInsideBaseEllipse: apexInside,
            projectedRim: baseDegenerate ? 'line' : 'ellipse',
        },
    };
}

function buildHemisphereGeometry(descriptor, basis, options) {
    const { radius } = descriptor;
    const projectedAxis = basis.axisScreenLength;
    const rim = rimEllipse(basis, radius, options.tolerance, { id: 'hemisphere-flat-rim', role: 'flat-rim' });
    const rimVisibility = capVisibility(-basis.depth, options.tolerance);
    const featureCurves = [addCurveIdentity(rim, 'hemisphere-flat-rim', 'flat-rim', rimVisibility)];
    let outlineCurves;
    const axisEdgeOn = scaleIsNearZero(projectedAxis, 1);
    if (axisEdgeOn) {
        outlineCurves = [makeCircle(basis.center, radius, { id: 'hemisphere-silhouette', role: 'silhouette' })];
    } else {
        const domeArc = makeEllipseArc(
            basis.center,
            radius,
            radius,
            basis.rotation,
            -Math.PI / 2,
            Math.PI / 2,
            options.tolerance,
            { id: 'hemisphere-dome-silhouette', role: 'dome-silhouette', source: 'spherical-surface' }
        );
        const rimArcCurve = makeEllipseArc(
            basis.center,
            radius * Math.abs(basis.depth),
            radius,
            basis.rotation,
            Math.PI / 2,
            Math.PI * 1.5,
            options.tolerance,
            { id: 'hemisphere-rim-silhouette', role: 'flat-rim-silhouette', source: 'flat-rim' }
        );
        outlineCurves = [domeArc, rimArcCurve];
    }
    const outline = outlineCurves.length === 1 && outlineCurves[0].type === 'circle'
        ? makeSimpleOutline(outlineCurves[0], options.previewSegments)
        : makePathOutline('hemisphere-silhouette', outlineCurves, options.previewSegments);
    const visibleFeatures = featureCurves
        .filter((curve) => curve.visibility === 'visible' || options.showHiddenEdges)
        .map((curve) => withPreview(curve, options.previewSegments));
    const bounds = boundsFromSupport(basis.center, (nx, ny) => hemisphereSupport(basis, radius, nx, ny));
    return {
        outlines: [outline],
        outlineCurves: outlineCurves.map(cloneCurve),
        featureCurves: visibleFeatures,
        bounds,
        previewPoints: outline.points.map(clonePoint),
        diagnostics: {
            exact: true,
            support: 'half-ball-support-boundary-plus-flat-rim',
            axisScreenLength: basis.axisScreenLength,
            axisDepth: basis.depth,
            projectedRim: axisEdgeOn ? 'circle' : (scaleIsNearZero(radius * Math.abs(basis.depth), radius) ? 'line' : 'ellipse'),
        },
    };
}

function normalizeView(viewId) {
    try {
        return getOrthographicViewDefinition(viewId);
    } catch (error) {
        fail('INVALID_VIEW', error instanceof Error ? error.message : `unknown orthographic view ${String(viewId)}`);
    }
}

/**
 * Project one curved primitive into a canonical orthographic view.
 *
 * The returned value is deeply frozen and contains only JSON-friendly
 * semantic geometry.  `showHiddenEdges` controls feature curves only; the
 * outer projection outline is always present.
 */
export function projectCurvedPrimitiveToView(descriptor, viewId, options = {}) {
    const primitive = normalizeDescriptor(descriptor);
    const normalizedOptions = normalizeOptions(options);
    const definition = normalizeView(viewId);
    const centerProjection = projectPointToView(primitive.center, definition);
    const basis = projectionBasis(definition, centerProjection, primitive.axis);
    const geometry = primitive.primitiveKey === 'sphere'
        ? buildSphereGeometry(primitive, basis, normalizedOptions)
        : primitive.primitiveKey === 'cylinder'
            ? buildCylinderGeometry(primitive, basis, normalizedOptions)
            : primitive.primitiveKey === 'cone'
                ? buildConeGeometry(primitive, basis, normalizedOptions)
                : buildHemisphereGeometry(primitive, basis, normalizedOptions);

    const result = {
        primitiveKey: primitive.primitiveKey,
        primitive: primitive.primitiveKey,
        descriptor: { ...primitive, center: { ...primitive.center }, axis: { ...primitive.axis } },
        parameters: { ...primitive, center: { ...primitive.center }, axis: { ...primitive.axis } },
        viewId: definition.id,
        view: definition,
        definition,
        viewBasis: {
            right: { ...definition.right },
            up: { ...definition.up },
            cameraDirection: { ...definition.cameraDirection },
        },
        options: normalizedOptions,
        outlines: geometry.outlines,
        outlineCurves: geometry.outlineCurves,
        featureCurves: geometry.featureCurves,
        bounds: geometry.bounds,
        previewPoints: geometry.previewPoints,
        points: geometry.previewPoints.map(clonePoint),
        diagnostics: {
            ...geometry.diagnostics,
            options: normalizedOptions,
            viewId: definition.id,
            viewLabel: definition.label,
            center: clonePoint({ x: centerProjection.x, y: centerProjection.y }),
            centerDepth: centerProjection.depth,
            modelUnits: true,
            boundsExact: true,
            previewIsApproximation: true,
            canonicalViewBases: ORTHOGRAPHIC_VIEW_BASES,
        },
    };
    deepFreeze(result);
    return result;
}

function numbersClose(actual, expected, tolerance) {
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
    const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
    return Math.abs(actual - expected) <= tolerance * scale + Number.EPSILON * 64 * scale;
}

function isJsonFriendly(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object') return false;
    // Shared immutable aliases (for example `view` and `definition`) are
    // perfectly JSON-friendly; only a recursion cycle is invalid here.
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = Array.isArray(value)
        ? value.every((item) => isJsonFriendly(item, seen))
        : Object.values(value).every((child) => isJsonFriendly(child, seen));
    seen.delete(value);
    return valid;
}

function assertFinitePoint(value, label) {
    if (!isRecord(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
        fail('INVALID_PROJECTION', `${label} must contain finite x and y`, { path: label });
    }
}

function validateCurve(curve, label, tolerance) {
    if (!isRecord(curve) || typeof curve.type !== 'string') {
        fail('INVALID_PROJECTION', `${label} must be a curve descriptor`, { path: label });
    }
    if (curve.exact !== true) {
        fail('INVALID_PROJECTION', `${label} must preserve an exact descriptor`, { path: label });
    }
    if (curve.type === 'line') {
        assertFinitePoint(curve.start, `${label}.start`);
        assertFinitePoint(curve.end, `${label}.end`);
    } else if (curve.type === 'circle') {
        assertFinitePoint(curve.center, `${label}.center`);
        positiveNumber(curve.radius, `${label}.radius`);
    } else if (curve.type === 'ellipse' || curve.type === 'ellipseArc') {
        assertFinitePoint(curve.center, `${label}.center`);
        positiveNumber(curve.radiusX, `${label}.radiusX`);
        positiveNumber(curve.radiusY, `${label}.radiusY`);
        finiteNumber(curve.rotation, `${label}.rotation`);
        if (curve.type === 'ellipseArc') {
            finiteNumber(curve.startAngle, `${label}.startAngle`);
            finiteNumber(curve.endAngle, `${label}.endAngle`);
            if (curve.endAngle < curve.startAngle) {
                fail('INVALID_PROJECTION', `${label} arc angles must be ordered`);
            }
        }
    } else if (curve.type === 'path') {
        if (curve.closed !== true || !Array.isArray(curve.curves) || curve.curves.length === 0) {
            fail('INVALID_PROJECTION', `${label} must be a non-empty closed path`);
        }
        curve.curves.forEach((child, index) => validateCurve(child, `${label}.curves[${index}]`, tolerance));
    } else {
        fail('INVALID_PROJECTION', `${label} has unknown curve type ${curve.type}`);
    }
    if (curve.points !== undefined) {
        if (!Array.isArray(curve.points) || curve.points.length === 0) {
            fail('INVALID_PROJECTION', `${label}.points must be a non-empty array`);
        }
        curve.points.forEach((item, index) => assertFinitePoint(item, `${label}.points[${index}]`));
        if (curve.closed === true) {
            const first = curve.points[0];
            const last = curve.points[curve.points.length - 1];
            const closureScale = Math.max(
                1,
                Math.abs(first.x),
                Math.abs(first.y),
                Math.abs(last.x),
                Math.abs(last.y)
            );
            if (Math.abs(first.x - last.x) > tolerance * closureScale
                || Math.abs(first.y - last.y) > tolerance * closureScale) {
                fail('INVALID_PROJECTION', `${label}.points must close`, { path: `${label}.points` });
            }
        }
    }
}

function semanticValue(value) {
    if (typeof value === 'number') return cleanZero(value);
    if (Array.isArray(value)) return value.map((item) => semanticValue(item));
    if (isRecord(value)) {
        const output = {};
        Object.keys(value).sort().forEach((key) => {
            if (key === 'points' || key === 'previewPoints') return;
            output[key] = semanticValue(value[key]);
        });
        return output;
    }
    return value;
}

function semanticGeometrySignature(result) {
    return semanticValue({
        outlines: result.outlines,
        outlineCurves: result.outlineCurves,
        featureCurves: result.featureCurves,
    });
}

function validateBounds(bounds, label, tolerance) {
    if (!isRecord(bounds)) fail('INVALID_BOUNDS', `${label} must be an object`);
    for (const key of ['minX', 'minY', 'maxX', 'maxY', 'width', 'height', 'centerX', 'centerY']) {
        finiteNumber(bounds[key], `${label}.${key}`);
    }
    if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) {
        fail('INVALID_BOUNDS', `${label} extrema must be ordered`);
    }
    if (!numbersClose(bounds.width, bounds.maxX - bounds.minX, tolerance)
        || !numbersClose(bounds.height, bounds.maxY - bounds.minY, tolerance)) {
        fail('INVALID_BOUNDS', `${label} dimensions do not match extrema`);
    }
    assertFinitePoint(bounds.min, `${label}.min`);
    assertFinitePoint(bounds.max, `${label}.max`);
    assertFinitePoint(bounds.center, `${label}.center`);
    assertFinitePoint(bounds.size, `${label}.size`);
}

/** Validate projection structure, exact bounds, visibility filtering, and JSON safety. */
export function validateCurvedProjection(result, options = undefined) {
    if (!isRecord(result)) fail('INVALID_PROJECTION', 'result must be an object');
    if (!isJsonFriendly(result)) fail('NON_JSON_PROJECTION', 'result must contain only JSON-friendly values');
    const validationOptions = normalizeOptions(options);
    const callerSpecifiedTolerance = isRecord(options)
        && (Object.prototype.hasOwnProperty.call(options, 'tolerance') || Object.prototype.hasOwnProperty.call(options, 'epsilon'));
    const effectiveTolerance = callerSpecifiedTolerance
        ? validationOptions.tolerance
        : (Number.isFinite(result.options?.tolerance) ? result.options.tolerance : validationOptions.tolerance);
    const effectiveSegments = isRecord(options)
        && (Object.prototype.hasOwnProperty.call(options, 'previewSegments')
            || Object.prototype.hasOwnProperty.call(options, 'pathSegments')
            || Object.prototype.hasOwnProperty.call(options, 'arcSegments')
            || Object.prototype.hasOwnProperty.call(options, 'sampleCount'))
        ? validationOptions.previewSegments
        : (Number.isInteger(result.options?.previewSegments) ? result.options.previewSegments : validationOptions.previewSegments);
    const descriptor = normalizeDescriptor(result.descriptor ?? result.parameters);
    const definition = normalizeView(result.viewId ?? (result.definition && result.definition.id));
    if (!isRecord(result.options)) {
        fail('INVALID_PROJECTION', 'options must be present on a projection result');
    }
    const storedOptions = normalizeOptions(result.options);
    if (JSON.stringify(semanticValue(storedOptions)) !== JSON.stringify(semanticValue(result.options))) {
        fail('INVALID_OPTIONS', 'projection options are not normalized');
    }
    if (!isRecord(result.diagnostics) || JSON.stringify(semanticValue(result.options))
        !== JSON.stringify(semanticValue(result.diagnostics.options))) {
        fail('INVALID_OPTIONS', 'projection diagnostics options do not match options');
    }
    validateBounds(result.bounds, 'bounds', effectiveTolerance);
    if (!Array.isArray(result.outlines) || result.outlines.length === 0) {
        fail('INVALID_PROJECTION', 'outlines must be a non-empty array');
    }
    if (!Array.isArray(result.outlineCurves)) {
        fail('INVALID_PROJECTION', 'outlineCurves must be an array');
    }
    result.outlines.forEach((outline, index) => validateCurve(outline, `outlines[${index}]`, effectiveTolerance));
    if (!Array.isArray(result.featureCurves)) {
        fail('INVALID_PROJECTION', 'featureCurves must be an array');
    }
    const callerSpecifiedHidden = isRecord(options) && Object.prototype.hasOwnProperty.call(options, 'showHiddenEdges');
    const allowHiddenEdges = callerSpecifiedHidden
        ? validationOptions.showHiddenEdges
        : result.options?.showHiddenEdges === true;
    result.featureCurves.forEach((curve, index) => {
        validateCurve(curve, `featureCurves[${index}]`, effectiveTolerance);
        if (curve.visibility !== 'visible' && curve.visibility !== 'hidden') {
            fail('INVALID_PROJECTION', `featureCurves[${index}].visibility must be visible or hidden`);
        }
        if (curve.visibility === 'hidden' && !allowHiddenEdges) {
            fail('INVALID_PROJECTION', 'hidden feature curves require showHiddenEdges:true');
        }
    });
    if (result.previewPoints !== undefined) {
        if (!Array.isArray(result.previewPoints)) fail('INVALID_PROJECTION', 'previewPoints must be an array');
        result.previewPoints.forEach((item, index) => assertFinitePoint(item, `previewPoints[${index}]`));
    }

    // Rebuild with the stored visibility/preview settings.  This proves the
    // semantic dimensions and support-derived extrema without ever using the
    // sampled points as authoritative geometry.
    const expected = projectCurvedPrimitiveToView(descriptor, definition.id, {
        showHiddenEdges: result.options?.showHiddenEdges === true,
        previewSegments: effectiveSegments,
        tolerance: effectiveTolerance,
    });
    if (JSON.stringify(semanticGeometrySignature(result)) !== JSON.stringify(semanticGeometrySignature(expected))) {
        fail('INVALID_PROJECTION', 'semantic curves do not match the descriptor and view');
    }
    for (const key of ['minX', 'minY', 'maxX', 'maxY', 'width', 'height']) {
        if (!numbersClose(result.bounds[key], expected.bounds[key], effectiveTolerance)) {
            fail('INVALID_BOUNDS', `bounds.${key} does not match analytic support`, { key });
        }
    }
    if (result.featureCurves.length !== expected.featureCurves.length) {
        fail('INVALID_PROJECTION', 'featureCurves do not match visibility filtering');
    }
    return true;
}

export const CURVED_ORTHOGRAPHIC_CONSTANTS = Object.freeze({
    TAU,
    DEFAULT_PREVIEW_SEGMENTS,
    DEFAULT_TOLERANCE,
});
