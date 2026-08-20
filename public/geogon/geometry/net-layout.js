// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 MaskwaSam <136355328+MaskwaSam@users.noreply.github.com>

/**
 * Dependency-free polyhedral net layout helpers.
 *
 * A net is made entirely from the coordinates in a structural topology.  No
 * primitive dimensions are reconstructed here: every 2-D edge length is
 * derived from the supplied 3-D points.  The implementation intentionally
 * keeps all state in ordinary arrays/maps while searching, and serialises a
 * plain JSON-friendly result at the API boundary.
 */

import { validatePolyhedralTopology } from './solid-topology.js';
import { validateCompositeExteriorTopology } from './composite-topology.js';

const DEFAULT_TOLERANCE = 1e-8;
const DEFAULT_MAX_SEARCH_ATTEMPTS = 20000;
// All public length tolerances are relative to a characteristic source
// length.  Keep the geometric floor at machine precision so a uniformly
// scaled 1e-5 solid is not treated as degenerate.
const MACHINE_EPSILON = Number.EPSILON * 64;
const CURVED_PRIMITIVES = new Set(['sphere', 'cylinder', 'cone', 'hemisphere']);

/** Coded error used for malformed topologies and invalid layouts. */
export class NetLayoutError extends Error {
    constructor(code, message, details = undefined) {
        super(`${code}: ${message}`);
        this.name = 'NetLayoutError';
        this.code = code;
        if (details !== undefined) {
            this.details = details;
        }
    }
}

function fail(code, message, details = undefined) {
    throw new NetLayoutError(code, message, details);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function compareIds(first, second) {
    const a = String(first);
    const b = String(second);
    return a < b ? -1 : (a > b ? 1 : 0);
}

function point2(x, y) {
    return { x: cleanNumber(x), y: cleanNumber(y) };
}

function cleanNumber(value) {
    // Avoid -0 in serialised output, but retain every meaningful small
    // coordinate.  Absolute zeroing would destroy scale-free 1e-5 layouts.
    return Object.is(value, -0) ? 0 : value;
}

function clonePoint2(point) {
    return point2(point.x, point.y);
}

function distance2(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function subtract2(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
}

function cross2(a, b) {
    return a.x * b.y - a.y * b.x;
}

function dot2(a, b) {
    return a.x * b.x + a.y * b.y;
}

function area2(points) {
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        area += current.x * next.y - next.x * current.y;
    }
    return area;
}

function polygonArea(points) {
    return Math.abs(area2(points)) / 2;
}

function polygonScale(points) {
    let scale = 0;
    for (let index = 0; index < points.length; index += 1) {
        scale = Math.max(scale, distance2(points[index], points[(index + 1) % points.length]));
    }
    return scale;
}

function coordinateTolerance(scale, relativeTolerance) {
    const safeScale = Math.max(scale, Number.MIN_VALUE);
    return Math.max(MACHINE_EPSILON * safeScale, relativeTolerance * safeScale);
}

function polygonPoints(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (isRecord(value) && Array.isArray(value.points)) {
        return value.points;
    }
    if (isRecord(value) && Array.isArray(value.polygon)) {
        return value.polygon;
    }
    return null;
}

function assertPolygonPoints(value, label) {
    const points = polygonPoints(value);
    if (!points || points.length < 3 || points.some((point) => !isRecord(point) || !finiteNumber(point.x) || !finiteNumber(point.y))) {
        fail('INVALID_POLYGON', `${label} must contain at least three finite 2-D points`);
    }
    return points;
}

function orientCounterClockwise(points) {
    return area2(points) >= 0 ? points : points.slice().reverse();
}

function insideHalfPlane(point, edgeStart, edgeEnd, relativeTolerance) {
    const edge = subtract2(edgeEnd, edgeStart);
    const edgeLength = Math.hypot(edge.x, edge.y);
    return cross2(edge, subtract2(point, edgeStart)) >= -relativeTolerance * Math.max(Number.MIN_VALUE, edgeLength) ** 2;
}

function lineIntersection(firstStart, firstEnd, secondStart, secondEnd) {
    const firstDirection = subtract2(firstEnd, firstStart);
    const secondDirection = subtract2(secondEnd, secondStart);
    const denominator = cross2(firstDirection, secondDirection);
    const denominatorScale = Math.max(Number.MIN_VALUE, Math.hypot(firstDirection.x, firstDirection.y) * Math.hypot(secondDirection.x, secondDirection.y));
    if (Math.abs(denominator) <= MACHINE_EPSILON * denominatorScale) {
        return clonePoint2(firstEnd);
    }
    const offset = subtract2(secondStart, firstStart);
    const t = cross2(offset, secondDirection) / denominator;
    return point2(firstStart.x + firstDirection.x * t, firstStart.y + firstDirection.y * t);
}

function clipConvexPolygon(subject, clip, tolerance) {
    let output = subject.slice();
    for (let index = 0; index < clip.length; index += 1) {
        if (output.length === 0) {
            break;
        }
        const clipStart = clip[index];
        const clipEnd = clip[(index + 1) % clip.length];
        const input = output;
        output = [];
        let previous = input[input.length - 1];
        let previousInside = insideHalfPlane(previous, clipStart, clipEnd, tolerance);
        input.forEach((current) => {
            const currentInside = insideHalfPlane(current, clipStart, clipEnd, tolerance);
            if (currentInside) {
                if (!previousInside) {
                    output.push(lineIntersection(previous, current, clipStart, clipEnd));
                }
                output.push(clonePoint2(current));
            } else if (previousInside) {
                output.push(lineIntersection(previous, current, clipStart, clipEnd));
            }
            previous = current;
            previousInside = currentInside;
        });
    }
    return output;
}

function pointOnSegment(point, start, end, relativeTolerance) {
    const edge = subtract2(end, start);
    const offset = subtract2(point, start);
    const edgeLength = Math.hypot(edge.x, edge.y);
    const edgeSquare = Math.max(Number.MIN_VALUE, edgeLength) ** 2;
    if (Math.abs(cross2(edge, offset)) > relativeTolerance * edgeSquare) {
        return false;
    }
    const projection = dot2(offset, edge);
    const projectionTolerance = relativeTolerance * edgeSquare;
    return projection >= -projectionTolerance && projection <= edgeLength * edgeLength + projectionTolerance;
}

function pointStrictlyInside(point, polygon, tolerance) {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
        const current = polygon[index];
        const prior = polygon[previous];
        if (pointOnSegment(point, prior, current, tolerance)) {
            return false;
        }
        const crosses = ((current.y > point.y) !== (prior.y > point.y))
            && (point.x < ((prior.x - current.x) * (point.y - current.y) / (prior.y - current.y)) + current.x);
        if (crosses) inside = !inside;
    }
    return inside;
}

function properSegmentCross(firstStart, firstEnd, secondStart, secondEnd, tolerance) {
    const first = subtract2(firstEnd, firstStart);
    const second = subtract2(secondEnd, secondStart);
    const firstToSecondStart = subtract2(secondStart, firstStart);
    const firstToSecondEnd = subtract2(secondEnd, firstStart);
    const secondToFirstStart = subtract2(firstStart, secondStart);
    const secondToFirstEnd = subtract2(firstEnd, secondStart);
    const firstLength = Math.hypot(first.x, first.y);
    const secondLength = Math.hypot(second.x, second.y);
    const threshold = tolerance * Math.max(Number.MIN_VALUE, firstLength * secondLength);
    const firstSigns = [cross2(first, firstToSecondStart), cross2(first, firstToSecondEnd)];
    const secondSigns = [cross2(second, secondToFirstStart), cross2(second, secondToFirstEnd)];
    if (firstSigns.some((value) => Math.abs(value) <= threshold) || secondSigns.some((value) => Math.abs(value) <= threshold)) {
        return false;
    }
    return firstSigns[0] * firstSigns[1] < 0 && secondSigns[0] * secondSigns[1] < 0;
}

/**
 * Return true only when two polygons share positive area.  Touching at an
 * edge or vertex (including a shared fold edge) is intentionally allowed.
 * Supported primitive faces are convex, so clipping gives a stable area test.
 */
export function polygonsOverlap(firstPolygon, secondPolygon, options = {}) {
    const first = assertPolygonPoints(firstPolygon, 'first polygon');
    const second = assertPolygonPoints(secondPolygon, 'second polygon');
    const tolerance = finiteNumber(options?.tolerance) && options.tolerance >= 0
        ? options.tolerance
        : DEFAULT_TOLERANCE;
    // Overlap classification is a geometric/topological predicate.  Do not
    // let a user-facing relative length tolerance erase a very narrow valid
    // gap (for example a 1e-4 side beside a 1e5 side).
    const geometricTolerance = Math.max(MACHINE_EPSILON, Math.min(tolerance, 1e-12));
    const localScale = Math.max(polygonScale(first), polygonScale(second), Number.MIN_VALUE);
    const areaTolerance = Math.max(MACHINE_EPSILON * localScale * localScale, (geometricTolerance * localScale) ** 2);
    const firstOriented = orientCounterClockwise(first);
    const secondOriented = orientCounterClockwise(second);
    const intersection = clipConvexPolygon(firstOriented, secondOriented, geometricTolerance);
    if (intersection.length >= 3 && polygonArea(intersection) > areaTolerance) {
        return true;
    }
    // The supported solids are convex, but retain a generic positive-area
    // fallback for callers passing a concave polygon: a strict interior point
    // or a proper edge crossing proves area overlap, while collinear or
    // endpoint-only contacts remain allowed.
    if (first.some((point) => pointStrictlyInside(point, second, geometricTolerance))
        || second.some((point) => pointStrictlyInside(point, first, geometricTolerance))) {
        return true;
    }
    for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
        const firstNext = first[(firstIndex + 1) % first.length];
        for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
            const secondNext = second[(secondIndex + 1) % second.length];
            if (properSegmentCross(first[firstIndex], firstNext, second[secondIndex], secondNext, geometricTolerance)) {
                return true;
            }
        }
    }
    return false;
}

function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
        return value;
    }
    seen.add(value);
    Object.values(value).forEach((child) => deepFreeze(child, seen));
    return Object.freeze(value);
}

function normalizeTolerance(options) {
    const candidate = options?.tolerance ?? options?.epsilon;
    if (candidate === undefined) {
        return DEFAULT_TOLERANCE;
    }
    if (!finiteNumber(candidate) || candidate < 0) {
        fail('INVALID_OPTIONS', 'tolerance must be a finite non-negative number');
    }
    return candidate;
}

function normalizeSearchLimit(options) {
    const candidate = options?.maxSearchAttempts ?? options?.maxAttempts;
    if (candidate === undefined) {
        return DEFAULT_MAX_SEARCH_ATTEMPTS;
    }
    if (!Number.isInteger(candidate) || candidate < 1) {
        fail('INVALID_OPTIONS', 'maxSearchAttempts must be a positive integer');
    }
    return candidate;
}

function topologyData(topology) {
    if (!isRecord(topology)) {
        fail('INVALID_TOPOLOGY', 'topology must be a plain object');
    }
    // The topology validator checks array ordering against structural vertex
    // order. Net construction is invariant to shuffled arrays, so validate a
    // canonical view whose IDs establish order while retaining source
    // geometry and winding.
    const canonicalTopology = canonicalizeTopology(topology);
    try {
        if (canonicalTopology.primitiveKey === 'composite') {
            validateCompositeExteriorTopology(canonicalTopology);
        } else {
            validatePolyhedralTopology(canonicalTopology);
        }
    } catch (error) {
        fail('INVALID_TOPOLOGY', error?.message || 'topology failed validation', { cause: error?.code });
    }
    if (CURVED_PRIMITIVES.has(topology.primitiveKey)) {
        fail('UNSUPPORTED_PRIMITIVE', `Curved primitive "${topology.primitiveKey}" is not a planar polyhedral net`);
    }
    const faces = canonicalTopology.faces.slice().sort((first, second) => compareIds(first.id, second.id));
    const vertices = new Map(canonicalTopology.vertices.map((vertex) => [vertex.id, vertex.position]));
    const edges = canonicalTopology.edges.slice().map((edge) => ({
        ...edge,
        // The validator only needs an endpoint pair; emit the pair in stable
        // ID order so shuffled source vertex arrays cannot affect net JSON.
        vertexIds: edge.vertexIds.slice().sort(compareIds),
        faceIds: edge.faceIds.slice().sort(compareIds),
    })).sort((first, second) => compareIds(first.id, second.id));
    const faceById = new Map(faces.map((face) => [face.id, face]));
    const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
    if (faces.length < 4 || edges.length < faces.length - 1) {
        fail('INVALID_TOPOLOGY', 'a closed polyhedral topology requires at least four faces and enough edges');
    }
    edges.forEach((edge) => {
        if (!Array.isArray(edge.faceIds) || edge.faceIds.length !== 2) {
            fail('INVALID_FOLD', `edge "${edge.id}" must have exactly two incident faces`);
        }
        if (!faceById.has(edge.faceIds[0]) || !faceById.has(edge.faceIds[1])) {
            fail('INVALID_FOLD', `edge "${edge.id}" references an unknown face`);
        }
    });
    return { faces, vertices, edges, faceById, edgeById };
}

function canonicalizeTopology(topology) {
    const vertices = Array.isArray(topology.vertices)
        ? topology.vertices.slice()
        : topology.vertices;
    const vertexIds = vertices?.map((vertex) => vertex?.id).filter((id) => typeof id === 'string') || [];
    const vertexRank = new Map(vertexIds.map((id, index) => [id, index]));
    const faces = Array.isArray(topology.faces)
        ? topology.faces.slice().sort((first, second) => compareIds(first?.id, second?.id))
        : topology.faces;
    const edges = Array.isArray(topology.edges)
        ? topology.edges.slice().map((edge) => ({
            ...edge,
            vertexIds: Array.isArray(edge?.vertexIds) ? edge.vertexIds.slice().sort((first, second) => (
                (vertexRank.get(first) ?? Number.MAX_SAFE_INTEGER) - (vertexRank.get(second) ?? Number.MAX_SAFE_INTEGER)
            )) : edge?.vertexIds,
            faceIds: Array.isArray(edge?.faceIds) ? edge.faceIds.slice().sort() : edge?.faceIds,
        })).sort((first, second) => compareIds(first?.id, second?.id))
        : topology.edges;
    const adjacency = isRecord(topology.adjacency)
        ? Object.fromEntries(vertexIds.map((id) => [id, Array.isArray(topology.adjacency[id])
            ? topology.adjacency[id].slice().sort((first, second) => (
                (vertexRank.get(first) ?? Number.MAX_SAFE_INTEGER) - (vertexRank.get(second) ?? Number.MAX_SAFE_INTEGER)
            ))
            : topology.adjacency[id]]))
        : topology.adjacency;
    const faceIds = faces?.map((face) => face?.id).filter((id) => typeof id === 'string') || [];
    const faceAdjacency = isRecord(topology.faceAdjacency)
        ? Object.fromEntries(faceIds.map((id) => [id, Array.isArray(topology.faceAdjacency[id])
            ? topology.faceAdjacency[id].slice().sort()
            : topology.faceAdjacency[id]]))
        : topology.faceAdjacency;
    return {
        // Composite validation includes slot, attachment, provenance, and
        // overlap metadata. Preserve that auditable context while replacing
        // only the structural arrays with their deterministic canonical view.
        ...topology,
        primitiveKey: topology.primitiveKey,
        vertices,
        faces,
        edges,
        adjacency,
        faceAdjacency,
    };
}

function vector3(first, second) {
    return {
        x: second.x - first.x,
        y: second.y - first.y,
        z: second.z - first.z,
    };
}

function dot3(first, second) {
    return first.x * second.x + first.y * second.y + first.z * second.z;
}

function cross3(first, second) {
    return {
        x: first.y * second.z - first.z * second.y,
        y: first.z * second.x - first.x * second.z,
        z: first.x * second.y - first.y * second.x,
    };
}

function length3(vector) {
    return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize3(vector) {
    const length = length3(vector);
    return length > 0 && Number.isFinite(length)
        ? { x: vector.x / length, y: vector.y / length, z: vector.z / length }
        : null;
}

function sourceFaceGeometry(face, vertices, tolerance) {
    const points3 = face.vertexIds.map((id) => vertices.get(id));
    if (points3.some((point) => !point || !finiteNumber(point.x) || !finiteNumber(point.y) || !finiteNumber(point.z))) {
        fail('INVALID_TOPOLOGY', `face "${face.id}" references non-finite coordinates`);
    }
    const first = points3[0];
    const second = points3[1];
    const axis = normalize3(vector3(first, second));
    if (!axis) {
        fail('INVALID_FACE_LENGTH', `face "${face.id}" has a zero-length first edge`);
    }
    const normal = normalize3(face.normal);
    if (!normal) {
        fail('INVALID_TOPOLOGY', `face "${face.id}" has no usable normal`);
    }
    let perpendicular = normalize3(cross3(normal, axis));
    if (!perpendicular) {
        fail('INVALID_FACE_LENGTH', `face "${face.id}" is degenerate`);
    }
    let sourceFaceScale = 0;
    for (let firstIndex = 0; firstIndex < points3.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < points3.length; secondIndex += 1) {
            sourceFaceScale = Math.max(sourceFaceScale, length3(vector3(points3[firstIndex], points3[secondIndex])));
        }
    }
    sourceFaceScale = Math.max(sourceFaceScale, Number.MIN_VALUE);
    const faceCoordinateTolerance = coordinateTolerance(sourceFaceScale, tolerance);
    const points = points3.map((point) => {
        const relative = vector3(first, point);
        if (Math.abs(dot3(relative, normal)) > faceCoordinateTolerance) {
            fail('INVALID_TOPOLOGY', `face "${face.id}" is not planar`);
        }
        return point2(dot3(relative, axis), dot3(relative, perpendicular));
    });
    if (area2(points) < 0) {
        perpendicular = { x: -perpendicular.x, y: -perpendicular.y, z: -perpendicular.z };
        points.forEach((point) => { point.y = cleanNumber(-point.y); });
    }
    const faceScale = Math.max(polygonScale(points), Number.MIN_VALUE);
    if (polygonArea(points) <= MACHINE_EPSILON * faceScale * faceScale) {
        fail('INVALID_FACE_LENGTH', `face "${face.id}" has zero area`);
    }
    for (let index = 0; index < points.length; index += 1) {
        const next = (index + 1) % points.length;
        const actual = distance2(points[index], points[next]);
        const expected = length3(vector3(points3[index], points3[next]));
        if (!compareLength(actual, expected, tolerance, sourceFaceScale, sourceFaceScale)) {
            fail('INVALID_LENGTH', `face "${face.id}" edge length is not planar`, { actual, expected });
        }
    }
    validateSimpleConvexPolygon(points, `face "${face.id}"`, tolerance);
    return { points, points3 };
}

function segmentsIntersectInclusive(firstStart, firstEnd, secondStart, secondEnd, tolerance) {
    const first = subtract2(firstEnd, firstStart);
    const second = subtract2(secondEnd, secondStart);
    const firstScale = Math.max(Number.MIN_VALUE, Math.hypot(first.x, first.y));
    const secondScale = Math.max(Number.MIN_VALUE, Math.hypot(second.x, second.y));
    const firstToSecondStart = subtract2(secondStart, firstStart);
    const firstToSecondEnd = subtract2(secondEnd, firstStart);
    const secondToFirstStart = subtract2(firstStart, secondStart);
    const secondToFirstEnd = subtract2(firstEnd, secondStart);
    const threshold = tolerance * Math.max(Number.MIN_VALUE, firstScale * secondScale);
    const firstSigns = [cross2(first, firstToSecondStart), cross2(first, firstToSecondEnd)];
    const secondSigns = [cross2(second, secondToFirstStart), cross2(second, secondToFirstEnd)];
    if (Math.abs(firstSigns[0]) <= threshold && pointOnSegment(secondStart, firstStart, firstEnd, tolerance)) return true;
    if (Math.abs(firstSigns[1]) <= threshold && pointOnSegment(secondEnd, firstStart, firstEnd, tolerance)) return true;
    if (Math.abs(secondSigns[0]) <= threshold && pointOnSegment(firstStart, secondStart, secondEnd, tolerance)) return true;
    if (Math.abs(secondSigns[1]) <= threshold && pointOnSegment(firstEnd, secondStart, secondEnd, tolerance)) return true;
    return firstSigns[0] * firstSigns[1] < 0 && secondSigns[0] * secondSigns[1] < 0;
}

function validateSimpleConvexPolygon(points, label, relativeTolerance) {
    const scale = Math.max(polygonScale(points), Number.MIN_VALUE);
    // Face simplicity/convexity is structural; use machine precision rather
    // than a loose user length tolerance so extreme aspect ratios remain
    // valid while exact bow-ties are rejected.
    const tolerance = MACHINE_EPSILON;
    if (Math.abs(area2(points)) <= MACHINE_EPSILON * scale * scale) {
        fail('INVALID_FACE_SHAPE', `${label} has zero area`);
    }
    for (let firstIndex = 0; firstIndex < points.length; firstIndex += 1) {
        const first = points[firstIndex];
        const second = points[(firstIndex + 1) % points.length];
        if (distance2(first, second) <= coordinateTolerance(Math.max(distance2(first, second), Number.MIN_VALUE), tolerance)) {
            fail('INVALID_FACE_SHAPE', `${label} has a zero-length perimeter edge`);
        }
        for (let secondIndex = firstIndex + 1; secondIndex < points.length; secondIndex += 1) {
            if (secondIndex === firstIndex || secondIndex === (firstIndex + 1) % points.length || firstIndex === (secondIndex + 1) % points.length) {
                continue;
            }
            const otherStart = points[secondIndex];
            const otherEnd = points[(secondIndex + 1) % points.length];
            if (segmentsIntersectInclusive(first, second, otherStart, otherEnd, tolerance)) {
                fail('INVALID_FACE_SHAPE', `${label} has self-intersecting perimeter edges`);
            }
        }
    }
    const winding = Math.sign(area2(points));
    for (let index = 0; index < points.length; index += 1) {
        const previous = points[(index + points.length - 1) % points.length];
        const current = points[index];
        const next = points[(index + 1) % points.length];
        const incoming = subtract2(current, previous);
        const outgoing = subtract2(next, current);
        const turn = cross2(incoming, outgoing);
        const turnTolerance = tolerance * Math.max(Number.MIN_VALUE, Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y));
        if (Math.abs(turn) <= turnTolerance || Math.sign(turn) !== winding) {
            fail('INVALID_FACE_SHAPE', `${label} must be a simple convex polygon`);
        }
    }
}

function sourceLength(vertices, firstId, secondId) {
    const first = vertices.get(firstId);
    const second = vertices.get(secondId);
    if (!first || !second) {
        fail('INVALID_TOPOLOGY', `edge references missing vertex ${firstId}-${secondId}`);
    }
    const result = length3(vector3(first, second));
    if (!Number.isFinite(result) || result <= 0) {
        fail('INVALID_EDGE_LENGTH', `edge ${firstId}-${secondId} has an invalid length`);
    }
    return result;
}

function edgePairInFace(face, edge) {
    const [first, second] = edge.vertexIds;
    const ids = face.vertexIds;
    for (let index = 0; index < ids.length; index += 1) {
        const current = ids[index];
        const next = ids[(index + 1) % ids.length];
        if ((current === first && next === second) || (current === second && next === first)) {
            return [current, next];
        }
    }
    return null;
}

function intrinsicByFace(data, tolerance) {
    const result = new Map();
    data.faces.forEach((face) => {
        result.set(face.id, sourceFaceGeometry(face, data.vertices, tolerance));
    });
    return result;
}

function mapRootFace(face, geometry) {
    const origin = geometry.points[0];
    return new Map(face.vertexIds.map((id, index) => [id, point2(geometry.points[index].x - origin.x, geometry.points[index].y - origin.y)]));
}

function transformIntrinsicFace(face, geometry, edge, parentPlacement, parentFace, tolerance) {
    const localPair = edgePairInFace(face, edge);
    const parentPair = edgePairInFace(parentFace, edge);
    if (!localPair || !parentPair) {
        return [];
    }
    const localById = new Map(face.vertexIds.map((id, index) => [id, geometry.points[index]]));
    const localA = localById.get(localPair[0]);
    const localB = localById.get(localPair[1]);
    const targetA = parentPlacement.get(localPair[0]);
    const targetB = parentPlacement.get(localPair[1]);
    if (!localA || !localB || !targetA || !targetB) {
        return [];
    }
    const localVector = subtract2(localB, localA);
    const targetVector = subtract2(targetB, targetA);
    const localLength = Math.hypot(localVector.x, localVector.y);
    const targetLength = Math.hypot(targetVector.x, targetVector.y);
    if (!(localLength > 0) || !(targetLength > 0)) {
        fail('INVALID_FOLD', `edge "${edge.id}" cannot be unfolded from a zero-length segment`);
    }
    const localUnit = { x: localVector.x / localLength, y: localVector.y / localLength };
    const targetUnit = { x: targetVector.x / targetLength, y: targetVector.y / targetLength };
    const targetLeft = { x: -targetUnit.y, y: targetUnit.x };
    const scale = targetLength / localLength;
    const parentCentroid = parentFace.vertexIds.reduce((sum, id) => {
        const point = parentPlacement.get(id);
        return { x: sum.x + point.x / parentFace.vertexIds.length, y: sum.y + point.y / parentFace.vertexIds.length };
    }, { x: 0, y: 0 });
    const parentSideActual = cross2(targetVector, subtract2(parentCentroid, targetA));

    const candidates = [false, true].map((reflected) => {
        const placement = new Map();
        face.vertexIds.forEach((id) => {
            const local = localById.get(id);
            const relative = subtract2(local, localA);
            const along = dot2(relative, localUnit) * scale;
            const across = dot2(relative, { x: -localUnit.y, y: localUnit.x }) * scale * (reflected ? -1 : 1);
            placement.set(id, point2(
                targetA.x + targetUnit.x * along + targetLeft.x * across,
                targetA.y + targetUnit.y * along + targetLeft.y * across,
            ));
        });
        // Preserve one exact shared coordinate along the fold.  The endpoint
        // formulas above are mathematically identical but can differ by a few
        // ulps after rotation/scaling; anchoring removes that representation
        // drift without changing any length.
        placement.set(localPair[0], clonePoint2(targetA));
        placement.set(localPair[1], clonePoint2(targetB));
        const childCentroid = face.vertexIds.reduce((sum, id) => {
            const point = placement.get(id);
            return { x: sum.x + point.x / face.vertexIds.length, y: sum.y + point.y / face.vertexIds.length };
        }, { x: 0, y: 0 });
        const childSide = cross2(targetVector, subtract2(childCentroid, targetA));
        const opposite = Math.abs(parentSideActual) <= coordinateTolerance(targetLength, MACHINE_EPSILON) * targetLength
            ? true
            : childSide * parentSideActual < 0;
        return { placement, reflected, opposite, childSide };
    });
    // Prefer the orientation-preserving candidate, but always enforce the
    // child-on-the-opposite-side rule.  If malformed winding makes direct
    // alignment unsuitable, the reflected isometry is the deterministic
    // recovery path.
    const valid = candidates.filter((candidate) => candidate.opposite);
    valid.sort((first, second) => Number(first.reflected) - Number(second.reflected));
    return valid.map((candidate) => candidate.placement);
}

function placementPolygon(face, placement) {
    return face.vertexIds.map((id) => placement.get(id));
}

function frontier(data, placed) {
    const result = [];
    data.edges.forEach((edge) => {
        const [first, second] = edge.faceIds;
        const firstPlaced = placed.has(first);
        const secondPlaced = placed.has(second);
        if (firstPlaced !== secondPlaced) {
            result.push({
                parentFaceId: firstPlaced ? first : second,
                childFaceId: firstPlaced ? second : first,
                edgeId: edge.id,
            });
        }
    });
    result.sort((first, second) => (
        compareIds(first.parentFaceId, second.parentFaceId)
        || compareIds(first.childFaceId, second.childFaceId)
        || compareIds(first.edgeId, second.edgeId)
    ));
    return result;
}

function tryBuildLayout(data, intrinsic, rootFaceId, tolerance, maxAttempts) {
    const rootFace = data.faceById.get(rootFaceId);
    const rootPlacement = mapRootFace(rootFace, intrinsic.get(rootFace.id));
    const placements = new Map([[rootFace.id, rootPlacement]]);
    const tree = [];
    let attempts = 0;
    let exhausted = false;

    function search() {
        if (placements.size === data.faces.length) {
            return { placements: new Map(placements), tree: tree.slice(), attempts };
        }
        if (attempts >= maxAttempts) {
            exhausted = true;
            return null;
        }
        const choices = frontier(data, placements);
        if (choices.length === 0) {
            return null;
        }
        for (const choice of choices) {
            if (attempts >= maxAttempts) {
                exhausted = true;
                return null;
            }
            attempts += 1;
            const parentFace = data.faceById.get(choice.parentFaceId);
            const childFace = data.faceById.get(choice.childFaceId);
            const edge = data.edgeById.get(choice.edgeId);
            const candidates = transformIntrinsicFace(
                childFace,
                intrinsic.get(childFace.id),
                edge,
                placements.get(parentFace.id),
                parentFace,
                tolerance,
            );
            for (const candidate of candidates) {
                const candidatePolygon = placementPolygon(childFace, candidate);
                if (candidatePolygon.some((point) => !finiteNumber(point.x) || !finiteNumber(point.y))) {
                    continue;
                }
                let overlaps = false;
                for (const [placedId, placed] of placements.entries()) {
                    if (polygonsOverlap(candidatePolygon, placementPolygon(data.faceById.get(placedId), placed), { tolerance })) {
                        overlaps = true;
                        break;
                    }
                }
                if (overlaps) {
                    continue;
                }
                placements.set(childFace.id, candidate);
                tree.push(choice);
                const result = search();
                if (result) {
                    return result;
                }
                tree.pop();
                placements.delete(childFace.id);
            }
        }
        return null;
    }

    const result = search();
    if (!result) {
        return { result: null, attempts, exhausted };
    }
    return { result, attempts, exhausted };
}

function clonePoints(points) {
    return points.map((point) => clonePoint2(point));
}

function edgeLengthMap(data) {
    return new Map(data.edges.map((edge) => [edge.id, sourceLength(data.vertices, edge.vertexIds[0], edge.vertexIds[1])]));
}

function compareLength(actual, expected, tolerance, scale = Math.abs(expected), coordinateScale = scale) {
    const relativeAllowance = tolerance * Math.max(Number.MIN_VALUE, scale);
    const numericalAllowance = MACHINE_EPSILON * Math.max(Number.MIN_VALUE, coordinateScale, scale);
    return Math.abs(actual - expected) <= relativeAllowance + numericalAllowance;
}

function makeNet(data, layout, diagnostics) {
    const tree = layout.tree.slice().sort((first, second) => (
        compareIds(first.childFaceId, second.childFaceId)
        || compareIds(first.parentFaceId, second.parentFaceId)
        || compareIds(first.edgeId, second.edgeId)
    ));
    const treeEdgeIds = new Set(tree.map((item) => item.edgeId));
    const faces = data.faces.map((face) => ({
        id: face.id,
        label: face.label,
        type: face.type,
        vertexIds: face.vertexIds.slice(),
        points: clonePoints(placementPolygon(face, layout.placements.get(face.id))),
    }));
    const edgePoints = (edge, faceId) => {
        const placement = layout.placements.get(faceId);
        return edge.vertexIds.map((vertexId) => clonePoint2(placement.get(vertexId)));
    };
    const foldEdges = data.edges.filter((edge) => treeEdgeIds.has(edge.id)).map((edge) => {
        const firstFace = edge.faceIds.slice().sort()[0];
        return {
            edgeId: edge.id,
            vertexIds: edge.vertexIds.slice(),
            faceIds: edge.faceIds.slice(),
            points: edgePoints(edge, firstFace),
        };
    });
    const cutEdges = data.edges.filter((edge) => !treeEdgeIds.has(edge.id)).map((edge) => ({
        edgeId: edge.id,
        vertexIds: edge.vertexIds.slice(),
        faceIds: edge.faceIds.slice(),
        segments: edge.faceIds.slice().sort().map((faceId) => ({
            faceId,
            points: edgePoints(edge, faceId),
        })),
    }));
    const allPoints = faces.flatMap((face) => face.points);
    const minX = Math.min(...allPoints.map((point) => point.x));
    const minY = Math.min(...allPoints.map((point) => point.y));
    const maxX = Math.max(...allPoints.map((point) => point.x));
    const maxY = Math.max(...allPoints.map((point) => point.y));
    const bounds = {
        minX: cleanNumber(minX),
        minY: cleanNumber(minY),
        maxX: cleanNumber(maxX),
        maxY: cleanNumber(maxY),
        width: cleanNumber(maxX - minX),
        height: cleanNumber(maxY - minY),
        centerX: cleanNumber((minX + maxX) / 2),
        centerY: cleanNumber((minY + maxY) / 2),
    };
    const result = {
        primitiveKey: data.primitiveKey,
        rootFaceId: layout.rootFaceId,
        faces,
        foldEdges,
        cutEdges,
        tree,
        bounds,
        diagnostics: {
            ...diagnostics,
            faceCount: faces.length,
            edgeCount: data.edges.length,
            foldCount: foldEdges.length,
            cutCount: cutEdges.length,
            coverage: true,
        },
    };
    return result;
}

/**
 * Build a deterministic unfolded net for a closed polyhedral topology.
 */
export function buildPolyhedralNet(topology, options = {}) {
    if (!isRecord(options)) {
        fail('INVALID_OPTIONS', 'options must be a plain object');
    }
    const tolerance = normalizeTolerance(options);
    const maxSearchAttempts = normalizeSearchLimit(options);
    const data = topologyData(topology);
    data.primitiveKey = topology.primitiveKey;
    const intrinsic = intrinsicByFace(data, tolerance);
    const rootFaceId = options.rootFaceId === undefined
        ? data.faces[0].id
        : options.rootFaceId;
    if (typeof rootFaceId !== 'string' || !data.faceById.has(rootFaceId)) {
        fail('INVALID_ROOT_FACE', `rootFaceId "${String(rootFaceId)}" is not a topology face`);
    }
    const search = tryBuildLayout(data, intrinsic, rootFaceId, tolerance, maxSearchAttempts);
    if (!search.result) {
        fail(search.exhausted ? 'SEARCH_LIMIT' : 'NO_VALID_NET', 'unable to find a non-overlapping spanning-tree net', {
            attempts: search.attempts,
            maxSearchAttempts,
        });
    }
    search.result.rootFaceId = rootFaceId;
    const result = makeNet(data, search.result, {
        searchAttempts: search.attempts,
        maxSearchAttempts,
        rootFaceId,
    });
    try {
        validatePolyhedralNet(topology, result, options);
    } catch (error) {
        if (error instanceof NetLayoutError) {
            throw error;
        }
        throw new NetLayoutError('INVALID_NET', error?.message || 'generated net failed validation');
    }
    return deepFreeze(result);
}

function netMaps(topology, net, tolerance) {
    const data = topologyData(topology);
    if (!isRecord(net)) {
        fail('INVALID_NET', 'net must be a plain object');
    }
    if (net.primitiveKey !== topology.primitiveKey) {
        fail('COVERAGE', 'net primitiveKey does not match topology');
    }
    if (!Array.isArray(net.faces) || !Array.isArray(net.foldEdges) || !Array.isArray(net.cutEdges) || !Array.isArray(net.tree)) {
        fail('COVERAGE', 'net faces, foldEdges, cutEdges, and tree must be arrays');
    }
    const facesById = new Map();
    net.faces.forEach((face) => {
        if (!isRecord(face) || typeof face.id !== 'string' || facesById.has(face.id)) {
            fail('COVERAGE', 'net faces must have unique string IDs');
        }
        facesById.set(face.id, face);
    });
    const expectedFaces = data.faces.map((face) => face.id);
    if (facesById.size !== expectedFaces.length || expectedFaces.some((id) => !facesById.has(id))) {
        fail('COVERAGE', 'net must contain every source face exactly once');
    }
    const edgeRecords = new Map();
    [...net.foldEdges, ...net.cutEdges].forEach((edge) => {
        if (!isRecord(edge) || typeof edge.edgeId !== 'string' || edgeRecords.has(edge.edgeId)) {
            fail('COVERAGE', 'net edge records must have unique edge IDs');
        }
        edgeRecords.set(edge.edgeId, edge);
    });
    if (edgeRecords.size !== data.edges.length || data.edges.some((edge) => !edgeRecords.has(edge.id))) {
        fail('COVERAGE', 'net must classify every source edge exactly once');
    }
    return { data, facesById, edgeRecords };
}

function assertNetPoint(point, label) {
    if (!isRecord(point) || !finiteNumber(point.x) || !finiteNumber(point.y)) {
        fail('COVERAGE', `${label} must be a finite 2-D point`);
    }
}

function assertClose(actual, expected, tolerance, code, message, scale = Math.abs(expected), coordinateScale = scale) {
    if (!compareLength(actual, expected, tolerance, scale, coordinateScale)) {
        fail(code, message, { actual, expected });
    }
}

/** Validate lengths, tree/fold incidence, overlap, and source coverage. */
export function validatePolyhedralNet(topology, net, options = {}) {
    if (!isRecord(options)) {
        fail('INVALID_OPTIONS', 'options must be a plain object');
    }
    const tolerance = normalizeTolerance(options);
    const { data, facesById, edgeRecords } = netMaps(topology, net, tolerance);
    const lengths = edgeLengthMap(data);
    const sourceScale = Math.max(...lengths.values(), Number.MIN_VALUE);
    const netCoordinateEpsilon = coordinateTolerance(sourceScale, tolerance);
    const expectedFaceById = data.faceById;
    const polygonByFaceId = new Map();
    data.faces.forEach((sourceFace) => {
        const face = facesById.get(sourceFace.id);
        if (face.label !== sourceFace.label || face.type !== sourceFace.type || JSON.stringify(face.vertexIds) !== JSON.stringify(sourceFace.vertexIds)) {
            fail('COVERAGE', `net face "${sourceFace.id}" does not preserve source metadata or ordered vertex IDs`);
        }
        if (!Array.isArray(face.points) || face.points.length !== sourceFace.vertexIds.length) {
            fail('COVERAGE', `net face "${sourceFace.id}" has the wrong point count`);
        }
        face.points.forEach((point, index) => assertNetPoint(point, `face ${sourceFace.id} point ${index}`));
        polygonByFaceId.set(sourceFace.id, face.points);
        validateSimpleConvexPolygon(face.points, `net face "${sourceFace.id}"`, tolerance);
        const netFaceScale = Math.max(polygonScale(face.points), Number.MIN_VALUE);
        if (polygonArea(face.points) <= MACHINE_EPSILON * netFaceScale * netFaceScale) {
            fail('COVERAGE', `net face "${sourceFace.id}" is degenerate`);
        }
        let sourceFaceScale = 0;
        for (let firstIndex = 0; firstIndex < sourceFace.vertexIds.length; firstIndex += 1) {
            for (let secondIndex = firstIndex + 1; secondIndex < sourceFace.vertexIds.length; secondIndex += 1) {
                sourceFaceScale = Math.max(sourceFaceScale, sourceLength(data.vertices, sourceFace.vertexIds[firstIndex], sourceFace.vertexIds[secondIndex]));
            }
        }
        sourceFaceScale = Math.max(sourceFaceScale, Number.MIN_VALUE);
        sourceFace.vertexIds.forEach((firstId, index) => {
            const secondId = sourceFace.vertexIds[(index + 1) % sourceFace.vertexIds.length];
            const edgeId = data.edges.find((edge) => edge.vertexIds.includes(firstId) && edge.vertexIds.includes(secondId))?.id;
            if (!edgeId) {
                fail('COVERAGE', `source face ${sourceFace.id} has an unknown edge ${firstId}-${secondId}`);
            }
            const expectedLength = sourceLength(data.vertices, firstId, secondId);
            const actualLength = distance2(face.points[index], face.points[(index + 1) % face.points.length]);
            assertClose(actualLength, expectedLength, tolerance, 'INVALID_LENGTH', `face ${sourceFace.id} edge ${edgeId} length mismatch`, expectedLength, sourceScale);
        });
        // Perimeter lengths alone do not determine a quadrilateral: a shear
        // can preserve all four sides while changing its diagonal. Compare
        // every pairwise vertex distance to prove a rigid planar congruency.
        for (let firstIndex = 0; firstIndex < sourceFace.vertexIds.length; firstIndex += 1) {
            for (let secondIndex = firstIndex + 1; secondIndex < sourceFace.vertexIds.length; secondIndex += 1) {
                const expected = sourceLength(data.vertices, sourceFace.vertexIds[firstIndex], sourceFace.vertexIds[secondIndex]);
                const actual = distance2(face.points[firstIndex], face.points[secondIndex]);
                assertClose(actual, expected, tolerance, 'INVALID_LENGTH', `face ${sourceFace.id} is not congruent to its source face`, sourceFaceScale, sourceScale);
            }
        }
    });
    for (let firstIndex = 0; firstIndex < data.faces.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < data.faces.length; secondIndex += 1) {
            const first = data.faces[firstIndex];
            const second = data.faces[secondIndex];
            if (polygonsOverlap(polygonByFaceId.get(first.id), polygonByFaceId.get(second.id), { tolerance })) {
                fail('OVERLAP', `faces ${first.id} and ${second.id} have positive-area overlap`);
            }
        }
    }

    const tree = net.tree;
    if (tree.length !== data.faces.length - 1) {
        fail('INVALID_FOLD', `tree must contain exactly ${data.faces.length - 1} edges`);
    }
    const treeChildren = new Set();
    const treeEdgeIds = new Set();
    tree.forEach((item) => {
        if (!isRecord(item) || typeof item.parentFaceId !== 'string' || typeof item.childFaceId !== 'string' || typeof item.edgeId !== 'string') {
            fail('INVALID_FOLD', 'tree records require parentFaceId, childFaceId, and edgeId');
        }
        if (item.parentFaceId === item.childFaceId || !expectedFaceById.has(item.parentFaceId) || !expectedFaceById.has(item.childFaceId)) {
            fail('INVALID_FOLD', 'tree references invalid or self-linked faces');
        }
        const edge = data.edgeById.get(item.edgeId);
        if (!edge || !edge.faceIds.includes(item.parentFaceId) || !edge.faceIds.includes(item.childFaceId)) {
            fail('INVALID_FOLD', `tree edge ${item.edgeId} does not join its faces`);
        }
        if (treeChildren.has(item.childFaceId) || item.childFaceId === net.rootFaceId) {
            fail('INVALID_FOLD', 'tree must have one parent per non-root face');
        }
        if (treeEdgeIds.has(item.edgeId)) {
            fail('INVALID_FOLD', `tree repeats edge ${item.edgeId}`);
        }
        treeChildren.add(item.childFaceId);
        treeEdgeIds.add(item.edgeId);
    });
    if (typeof net.rootFaceId !== 'string' || !expectedFaceById.has(net.rootFaceId) || treeChildren.size !== data.faces.length - 1) {
        fail('INVALID_FOLD', 'rootFaceId or tree coverage is invalid');
    }
    // Follow parent links to establish connectedness and reject cycles.
    const parentByChild = new Map(tree.map((item) => [item.childFaceId, item.parentFaceId]));
    data.faces.forEach((face) => {
        let current = face.id;
        const seen = new Set();
        while (current !== net.rootFaceId) {
            if (seen.has(current) || !parentByChild.has(current)) {
                fail('INVALID_FOLD', 'tree is disconnected or cyclic');
            }
            seen.add(current);
            current = parentByChild.get(current);
        }
    });
    data.edges.forEach((sourceEdge) => {
        const record = edgeRecords.get(sourceEdge.id);
        const expectedFaceIds = sourceEdge.faceIds.slice().sort();
        if (JSON.stringify(record.vertexIds) !== JSON.stringify(sourceEdge.vertexIds) || JSON.stringify((record.faceIds || []).slice().sort()) !== JSON.stringify(expectedFaceIds)) {
            fail('COVERAGE', `edge ${sourceEdge.id} does not preserve source incidence`);
        }
        if (treeEdgeIds.has(sourceEdge.id)) {
            if (!net.foldEdges.includes(record) || !Array.isArray(record.points) || record.points.length !== 2) {
                fail('INVALID_FOLD', `fold edge ${sourceEdge.id} is malformed`);
            }
            record.points.forEach((point, index) => assertNetPoint(point, `fold edge ${sourceEdge.id} point ${index}`));
            const expectedLength = lengths.get(sourceEdge.id);
            assertClose(distance2(record.points[0], record.points[1]), expectedLength, tolerance, 'INVALID_LENGTH', `fold edge ${sourceEdge.id} length mismatch`, expectedLength, sourceScale);
            const parent = tree.find((item) => item.edgeId === sourceEdge.id);
            const parentPolygon = polygonByFaceId.get(parent.parentFaceId);
            const childPolygon = polygonByFaceId.get(parent.childFaceId);
            const parentFace = expectedFaceById.get(parent.parentFaceId);
            const childFace = expectedFaceById.get(parent.childFaceId);
            const parentCentroid = parentFace.vertexIds.reduce((sum, id) => {
                const point = polygonByFaceId.get(parent.parentFaceId)[parentFace.vertexIds.indexOf(id)];
                return { x: sum.x + point.x / parentFace.vertexIds.length, y: sum.y + point.y / parentFace.vertexIds.length };
            }, { x: 0, y: 0 });
            const childCentroid = childFace.vertexIds.reduce((sum, id) => {
                const point = polygonByFaceId.get(parent.childFaceId)[childFace.vertexIds.indexOf(id)];
                return { x: sum.x + point.x / childFace.vertexIds.length, y: sum.y + point.y / childFace.vertexIds.length };
            }, { x: 0, y: 0 });
            const foldVector = subtract2(record.points[1], record.points[0]);
            const parentSide = cross2(foldVector, subtract2(parentCentroid, record.points[0]));
            const childSide = cross2(foldVector, subtract2(childCentroid, record.points[0]));
            const foldCoordinateEpsilon = coordinateTolerance(Math.max(Number.MIN_VALUE, distance2(record.points[0], record.points[1])), MACHINE_EPSILON);
            if (parentSide * childSide >= -((foldCoordinateEpsilon * Math.max(Number.MIN_VALUE, distance2(record.points[0], record.points[1]))) ** 2)) {
                fail('INVALID_FOLD', `fold edge ${sourceEdge.id} does not place child opposite parent`);
            }
            sourceEdge.vertexIds.forEach((vertexId, index) => {
                const parentPoint = parentPolygon[parentFace.vertexIds.indexOf(vertexId)];
                const childPoint = childPolygon[childFace.vertexIds.indexOf(vertexId)];
                if (distance2(record.points[index], parentPoint) > netCoordinateEpsilon || distance2(record.points[index], childPoint) > netCoordinateEpsilon) {
                    fail('INVALID_FOLD', `fold edge ${sourceEdge.id} endpoints are not shared by both faces`);
                }
            });
        } else {
            if (!net.cutEdges.includes(record) || !Array.isArray(record.segments) || record.segments.length !== 2) {
                fail('INVALID_FOLD', `cut edge ${sourceEdge.id} is malformed`);
            }
            const segmentFaces = new Set();
            record.segments.forEach((segment) => {
                if (!isRecord(segment) || !expectedFaceById.has(segment.faceId) || segmentFaces.has(segment.faceId) || !sourceEdge.faceIds.includes(segment.faceId)) {
                    fail('INVALID_FOLD', `cut edge ${sourceEdge.id} has invalid segments`);
                }
                segmentFaces.add(segment.faceId);
                if (!Array.isArray(segment.points) || segment.points.length !== 2) {
                    fail('INVALID_FOLD', `cut edge ${sourceEdge.id} segment ${segment.faceId} is malformed`);
                }
                segment.points.forEach((point, index) => assertNetPoint(point, `cut edge ${sourceEdge.id} segment ${segment.faceId} point ${index}`));
                const expectedLength = lengths.get(sourceEdge.id);
                assertClose(distance2(segment.points[0], segment.points[1]), expectedLength, tolerance, 'INVALID_LENGTH', `cut edge ${sourceEdge.id} length mismatch`, expectedLength, sourceScale);
                const face = expectedFaceById.get(segment.faceId);
                sourceEdge.vertexIds.forEach((vertexId, index) => {
                    const facePoint = polygonByFaceId.get(segment.faceId)[face.vertexIds.indexOf(vertexId)];
                    if (distance2(segment.points[index], facePoint) > netCoordinateEpsilon) {
                        fail('INVALID_FOLD', `cut edge ${sourceEdge.id} segment does not match face ${segment.faceId}`);
                    }
                });
            });
            if (segmentFaces.size !== 2) {
                fail('INVALID_FOLD', `cut edge ${sourceEdge.id} must have one segment per incident face`);
            }
        }
    });
    if (!isRecord(net.bounds) || !['minX', 'minY', 'maxX', 'maxY', 'width', 'height', 'centerX', 'centerY'].every((key) => finiteNumber(net.bounds[key]))) {
        fail('COVERAGE', 'net bounds are missing or non-finite');
    }
    const allPoints = Array.from(polygonByFaceId.values()).flat();
    const expectedBounds = {
        minX: Math.min(...allPoints.map((point) => point.x)),
        minY: Math.min(...allPoints.map((point) => point.y)),
        maxX: Math.max(...allPoints.map((point) => point.x)),
        maxY: Math.max(...allPoints.map((point) => point.y)),
    };
    ['minX', 'minY', 'maxX', 'maxY'].forEach((key) => {
        if (Math.abs(net.bounds[key] - expectedBounds[key]) > netCoordinateEpsilon) {
            fail('COVERAGE', `net bounds.${key} does not cover all face points`);
        }
    });
    assertClose(net.bounds.width, expectedBounds.maxX - expectedBounds.minX, tolerance, 'COVERAGE', 'net bounds width mismatch', expectedBounds.maxX - expectedBounds.minX, sourceScale);
    assertClose(net.bounds.height, expectedBounds.maxY - expectedBounds.minY, tolerance, 'COVERAGE', 'net bounds height mismatch', expectedBounds.maxY - expectedBounds.minY, sourceScale);
    assertClose(net.bounds.centerX, (expectedBounds.maxX + expectedBounds.minX) / 2, tolerance, 'COVERAGE', 'net bounds centerX mismatch', Math.abs((expectedBounds.maxX + expectedBounds.minX) / 2), sourceScale);
    assertClose(net.bounds.centerY, (expectedBounds.maxY + expectedBounds.minY) / 2, tolerance, 'COVERAGE', 'net bounds centerY mismatch', Math.abs((expectedBounds.maxY + expectedBounds.minY) / 2), sourceScale);
    return true;
}
