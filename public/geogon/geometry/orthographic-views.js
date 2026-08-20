// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 MaskwaSam <136355328+MaskwaSam@users.noreply.github.com>

/**
 * Small, dependency-free orthographic projection helpers.
 *
 * A view's camera vector points from the object toward the camera.  Therefore
 * depth increases toward the viewer and an exterior face is front-facing when
 * its outward normal has a positive dot product with that vector.
 */

const VIEW_EPSILON = 1e-12;

function freezeVector(x, y, z) {
    return Object.freeze({ x, y, z });
}

function freezeView({ id, label, cameraDirection, right, up }) {
    const viewDirection = freezeVector(-cameraDirection.x, -cameraDirection.y, -cameraDirection.z);
    return Object.freeze({
        id,
        label,
        cameraDirection,
        // `camera` is a convenient name for callers that treat the vector as
        // the camera position relative to the target.
        camera: cameraDirection,
        viewDirection,
        right,
        screenRight: right,
        up,
        screenUp: up,
    });
}

/** Front camera: +Z, screen right +X, screen up +Y. */
export const FRONT_VIEW = freezeView({
    id: 'front',
    label: 'Front',
    cameraDirection: freezeVector(0, 0, 1),
    right: freezeVector(1, 0, 0),
    up: freezeVector(0, 1, 0),
});

/** Top camera: +Y, screen right +X, screen up -Z. */
export const TOP_VIEW = freezeView({
    id: 'top',
    label: 'Top',
    cameraDirection: freezeVector(0, 1, 0),
    right: freezeVector(1, 0, 0),
    up: freezeVector(0, 0, -1),
});

/** Right-side camera: +X, screen right -Z, screen up +Y. */
export const RIGHT_SIDE_VIEW = freezeView({
    id: 'right',
    label: 'Right Side',
    cameraDirection: freezeVector(1, 0, 0),
    right: freezeVector(0, 0, -1),
    up: freezeVector(0, 1, 0),
});

const canonicalViews = {
    front: FRONT_VIEW,
    top: TOP_VIEW,
    right: RIGHT_SIDE_VIEW,
};

/**
 * Frozen view definitions keyed by their canonical ids.  Aliases accepted by
 * getOrthographicViewDefinition are intentionally kept out of this object so
 * that its ordering and public shape remain stable.
 */
export const ORTHOGRAPHIC_VIEW_BASES = Object.freeze(canonicalViews);
export const ORTHOGRAPHIC_VIEWS = ORTHOGRAPHIC_VIEW_BASES;
export const VIEW_BASES = ORTHOGRAPHIC_VIEW_BASES;
export const ORTHOGRAPHIC_VIEW_DEFINITIONS = Object.freeze([
    FRONT_VIEW,
    TOP_VIEW,
    RIGHT_SIDE_VIEW,
]);
export const FRONT_VIEW_BASE = FRONT_VIEW;
export const TOP_VIEW_BASE = TOP_VIEW;
export const RIGHT_SIDE_VIEW_BASE = RIGHT_SIDE_VIEW;

const VIEW_ALIASES = new Map([
    ['front', FRONT_VIEW],
    ['front-view', FRONT_VIEW],
    ['top', TOP_VIEW],
    ['top-view', TOP_VIEW],
    ['right', RIGHT_SIDE_VIEW],
    ['right-side', RIGHT_SIDE_VIEW],
    ['rightside', RIGHT_SIDE_VIEW],
    ['right-side-view', RIGHT_SIDE_VIEW],
    ['side', RIGHT_SIDE_VIEW],
]);

function normalizeViewId(viewId) {
    if (typeof viewId !== 'string' || viewId.trim() === '') {
        throw new TypeError('viewId must be a non-empty string');
    }
    return viewId.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function resolveViewDefinition(viewOrId) {
    if (viewOrId && typeof viewOrId === 'object' && typeof viewOrId.id === 'string') {
        const definition = VIEW_ALIASES.get(normalizeViewId(viewOrId.id));
        if (definition && definition === viewOrId) {
            return definition;
        }
        if (definition) {
            return definition;
        }
        throw new RangeError(`Unknown orthographic view: ${viewOrId.id}`);
    }
    const normalizedId = normalizeViewId(viewOrId);
    const definition = VIEW_ALIASES.get(normalizedId);
    if (!definition) {
        throw new RangeError(`Unknown orthographic view: ${viewOrId}`);
    }
    return definition;
}

/** Return the frozen canonical definition for a front/top/right-side view. */
export function getOrthographicViewDefinition(viewId) {
    return resolveViewDefinition(viewId);
}

function finiteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} must contain finite numeric components`);
    }
    return value;
}

function readVector(value, label) {
    if (value && typeof value === 'object' && 'position' in value && !('x' in value)) {
        return readVector(value.position, `${label}.position`);
    }

    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        if (value.length < 3) {
            throw new TypeError(`${label} must have at least three components`);
        }
        return {
            x: finiteNumber(value[0], label),
            y: finiteNumber(value[1], label),
            z: finiteNumber(value[2], label),
        };
    }

    if (value && typeof value === 'object') {
        if (!('x' in value) || !('y' in value) || !('z' in value)) {
            throw new TypeError(`${label} must be an [x, y, z] array or an object with x, y, z`);
        }
        return {
            x: finiteNumber(value.x, label),
            y: finiteNumber(value.y, label),
            z: finiteNumber(value.z, label),
        };
    }

    throw new TypeError(`${label} must be an [x, y, z] array or an object with x, y, z`);
}

function readId(value, label) {
    if (value === undefined || value === null) {
        throw new TypeError(`${label} must be defined`);
    }
    const type = typeof value;
    if (type === 'object' || type === 'function' || type === 'symbol') {
        throw new TypeError(`${label} must be a primitive id`);
    }
    return value;
}

function readIdArray(value, label, minimumLength = 0) {
    if (!Array.isArray(value) || value.length < minimumLength) {
        throw new TypeError(`${label} must be an array with at least ${minimumLength} item(s)`);
    }
    return value.map((id, index) => readId(id, `${label}[${index}]`));
}

function assertUniqueIds(ids, label) {
    if (new Set(ids).size !== ids.length) {
        throw new RangeError(`${label} must not contain duplicate ids`);
    }
}

function makeUniqueMap(items, label) {
    const map = new Map();
    items.forEach((item, index) => {
        if (map.has(item.id)) {
            throw new RangeError(`Duplicate ${label} id: ${String(item.id)}`);
        }
        map.set(item.id, item);
        // Keep this check here rather than relying on Map's semantics so a
        // malformed object cannot silently become an "undefined" key.
        if (item.id === undefined || item.id === null) {
            throw new TypeError(`${label}[${index}].id must be defined`);
        }
    });
    return map;
}

function normalizeTopology(topology) {
    if (!topology || typeof topology !== 'object') {
        throw new TypeError('topology must be an object');
    }
    if (!Array.isArray(topology.vertices)) {
        throw new TypeError('topology.vertices must be an array');
    }
    if (!Array.isArray(topology.faces)) {
        throw new TypeError('topology.faces must be an array');
    }
    if (!Array.isArray(topology.edges)) {
        throw new TypeError('topology.edges must be an array');
    }

    const vertices = topology.vertices.map((vertex, index) => {
        if (!vertex || typeof vertex !== 'object') {
            throw new TypeError(`topology.vertices[${index}] must be an object`);
        }
        const id = readId(vertex.id, `topology.vertices[${index}].id`);
        const position = readVector(vertex.position, `topology.vertices[${index}].position`);
        return { id, position };
    });
    const vertexMap = makeUniqueMap(vertices, 'vertex');

    const faces = topology.faces.map((face, index) => {
        if (!face || typeof face !== 'object') {
            throw new TypeError(`topology.faces[${index}] must be an object`);
        }
        const id = readId(face.id, `topology.faces[${index}].id`);
        const vertexIds = readIdArray(face.vertexIds, `topology.faces[${index}].vertexIds`, 3);
        assertUniqueIds(vertexIds, `topology.faces[${index}].vertexIds`);
        vertexIds.forEach((vertexId) => {
            if (!vertexMap.has(vertexId)) {
                throw new RangeError(`Face ${String(id)} references unknown vertex ${String(vertexId)}`);
            }
        });
        const normal = readVector(face.normal, `topology.faces[${index}].normal`);
        const normalMagnitude = Math.hypot(normal.x, normal.y, normal.z);
        if (!Number.isFinite(normalMagnitude) || normalMagnitude <= VIEW_EPSILON) {
            throw new RangeError(`topology.faces[${index}].normal must have non-zero magnitude`);
        }
        return {
            id,
            vertexIds,
            normal: {
                x: normal.x / normalMagnitude,
                y: normal.y / normalMagnitude,
                z: normal.z / normalMagnitude,
            },
        };
    });
    const faceMap = makeUniqueMap(faces, 'face');

    const edges = topology.edges.map((edge, index) => {
        if (!edge || typeof edge !== 'object') {
            throw new TypeError(`topology.edges[${index}] must be an object`);
        }
        const id = readId(edge.id, `topology.edges[${index}].id`);
        const endpointIds = edge.vertexIds ?? edge.endpoints ?? [edge.a, edge.b];
        const vertexIds = readIdArray(endpointIds, `topology.edges[${index}].vertexIds`, 2);
        if (vertexIds.length !== 2) {
            throw new RangeError(`topology.edges[${index}].vertexIds must contain exactly two ids`);
        }
        vertexIds.forEach((vertexId) => {
            if (!vertexMap.has(vertexId)) {
                throw new RangeError(`Edge ${String(id)} references unknown vertex ${String(vertexId)}`);
            }
        });

        const actualAdjacentFaceIds = faces
            .filter((face) => face.vertexIds.some((firstVertexId, vertexIndex) => {
                const secondVertexId = face.vertexIds[(vertexIndex + 1) % face.vertexIds.length];
                return (
                    (firstVertexId === vertexIds[0] && secondVertexId === vertexIds[1])
                    || (firstVertexId === vertexIds[1] && secondVertexId === vertexIds[0])
                );
            }))
            .map((face) => face.id);
        if (actualAdjacentFaceIds.length === 0) {
            throw new RangeError(`Edge ${String(id)} is not incident to any face`);
        }

        // Older topology producers only carried edge endpoints. Derive their
        // adjacent faces from the ordered face loops so those topologies remain
        // consumable. When explicit adjacency is present, verify it against
        // the actual incidence rather than trusting stale metadata.
        const adjacencyKeys = ['adjacentFaceIds', 'faceIds', 'adjacentFaces', 'faces']
            .filter((key) => Object.prototype.hasOwnProperty.call(edge, key));
        let adjacentFaceIds = actualAdjacentFaceIds;
        for (const key of adjacencyKeys) {
            const suppliedFaceIds = readIdArray(edge[key], `topology.edges[${index}].${key}`, 0);
            assertUniqueIds(suppliedFaceIds, `topology.edges[${index}].${key}`);
            suppliedFaceIds.forEach((faceId) => {
                if (!faceMap.has(faceId)) {
                    throw new RangeError(`Edge ${String(id)} references unknown face ${String(faceId)}`);
                }
            });
            if (
                suppliedFaceIds.length !== actualAdjacentFaceIds.length
                || suppliedFaceIds.some((faceId) => !actualAdjacentFaceIds.includes(faceId))
            ) {
                throw new RangeError(`Edge ${String(id)} adjacent face IDs do not match its face-loop incidence`);
            }
            adjacentFaceIds = suppliedFaceIds;
        }
        return { id, vertexIds, adjacentFaceIds };
    });
    makeUniqueMap(edges, 'edge');

    return { vertices, vertexMap, faces, faceMap, edges };
}

/**
 * Project one 3D point into a view's right/up/depth basis.
 *
 * The result deliberately uses plain objects so it can be passed directly to
 * SVG/canvas renderers or serialized without a THREE dependency.
 */
export function projectPointToView(point, viewId) {
    const definition = resolveViewDefinition(viewId);
    const vector = readVector(point, 'point');
    return {
        x: vector.x * definition.right.x + vector.y * definition.right.y + vector.z * definition.right.z,
        y: vector.x * definition.up.x + vector.y * definition.up.y + vector.z * definition.up.z,
        depth:
            vector.x * definition.cameraDirection.x
            + vector.y * definition.cameraDirection.y
            + vector.z * definition.cameraDirection.z,
    };
}

function averageDepth(points) {
    return points.reduce((sum, point) => sum + point.depth, 0) / points.length;
}

function nearlyEqual(a, b, epsilon = VIEW_EPSILON) {
    return Math.abs(a - b) <= epsilon;
}

function dot3(first, second) {
    return first.x * second.x + first.y * second.y + first.z * second.z;
}

function cross2(first, second) {
    return first.x * second.y - first.y * second.x;
}

function subtract2(first, second) {
    return { x: first.x - second.x, y: first.y - second.y };
}

function polygonSignedAreaTwice(points) {
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
        const first = points[index];
        const second = points[(index + 1) % points.length];
        area += first.x * second.y - second.x * first.y;
    }
    return area;
}

function polygonPerimeter(points) {
    let perimeter = 0;
    for (let index = 0; index < points.length; index += 1) {
        const first = points[index];
        const second = points[(index + 1) % points.length];
        perimeter += Math.hypot(second.x - first.x, second.y - first.y);
    }
    return perimeter;
}

/**
 * Tolerances are derived from the projected extent rather than from a fixed
 * world-unit epsilon. This keeps clipping stable for millimetre-scale models
 * and for large translated scenes while retaining exact canonical coordinates.
 */
function makeProjectionTolerances(projectedPositions) {
    const points = [...projectedPositions.values()];
    if (points.length === 0) {
        return {
            coordinate: Number.MIN_VALUE,
            depth: Number.MIN_VALUE,
            area: Number.MIN_VALUE,
            parameter: Number.EPSILON * 256,
        };
    }

    let minX = points[0].x;
    let minY = points[0].y;
    let minDepth = points[0].depth;
    let maxX = points[0].x;
    let maxY = points[0].y;
    let maxDepth = points[0].depth;
    points.slice(1).forEach((point) => {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        minDepth = Math.min(minDepth, point.depth);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
        maxDepth = Math.max(maxDepth, point.depth);
    });

    // Extents, rather than absolute coordinates, avoid making translation a
    // source of tolerance inflation. The minimum keeps zero-span projections
    // and subnormal test fixtures finite.
    const screenExtent = Math.max(maxX - minX, maxY - minY, Number.MIN_VALUE);
    const depthExtent = Math.max(maxDepth - minDepth, Number.MIN_VALUE);
    const coordinate = Math.max(
        screenExtent * 1e-10,
        screenExtent * Number.EPSILON * 256,
        Number.MIN_VALUE
    );
    const depth = Math.max(
        depthExtent * 1e-10,
        depthExtent * Number.EPSILON * 256,
        Number.MIN_VALUE
    );
    return {
        coordinate,
        depth,
        parameter: Math.max(Number.EPSILON * 256, coordinate / screenExtent),
    };
}

function addParameter(parameters, value, tolerance) {
    if (!Number.isFinite(value) || value < -tolerance || value > 1 + tolerance) return;
    parameters.push(Math.max(0, Math.min(1, value)));
}

function dedupeParameters(parameters, tolerance) {
    return [...parameters]
        .filter((value) => Number.isFinite(value))
        .sort((first, second) => first - second)
        .reduce((deduped, value) => {
            if (deduped.length === 0 || value - deduped[deduped.length - 1] > tolerance) {
                deduped.push(value);
            } else if (value > deduped[deduped.length - 1]) {
                // Prefer the value furthest toward the interior when two
                // independently computed intersections land within tolerance.
                deduped[deduped.length - 1] = value;
            }
            return deduped;
        }, []);
}

function pointOnProjectedSegment(point, first, second, tolerance) {
    const direction = subtract2(second, first);
    const length = Math.hypot(direction.x, direction.y);
    if (length <= tolerance) {
        return Math.hypot(point.x - first.x, point.y - first.y) <= tolerance;
    }
    const offset = subtract2(point, first);
    if (Math.abs(cross2(offset, direction)) > tolerance * length) return false;
    const projection = offset.x * direction.x + offset.y * direction.y;
    const lengthSquared = length * length;
    return projection >= -tolerance * length
        && projection <= lengthSquared + tolerance * length;
}

function pointInProjectedPolygon(point, polygon, tolerance) {
    if (polygon.length < 3) return false;
    let inside = false;
    for (let index = 0; index < polygon.length; index += 1) {
        const first = polygon[index];
        const second = polygon[(index + 1) % polygon.length];
        if (pointOnProjectedSegment(point, first, second, tolerance)) return true;

        const crossesScanline = (first.y > point.y) !== (second.y > point.y);
        if (!crossesScanline) continue;
        const xAtScanline = first.x
            + ((point.y - first.y) * (second.x - first.x)) / (second.y - first.y);
        if (xAtScanline >= point.x - tolerance) inside = !inside;
    }
    return inside;
}

function collectProjectedPolygonIntersections(start, end, polygon, parameters, tolerance) {
    const edgeDirection = subtract2(end, start);
    const edgeLength = Math.hypot(edgeDirection.x, edgeDirection.y);
    if (edgeLength <= tolerance.coordinate) return;
    const edgeLengthSquared = edgeLength * edgeLength;

    for (let index = 0; index < polygon.length; index += 1) {
        const first = polygon[index];
        const second = polygon[(index + 1) % polygon.length];
        const boundaryDirection = subtract2(second, first);
        const boundaryLength = Math.hypot(boundaryDirection.x, boundaryDirection.y);
        if (boundaryLength <= tolerance.coordinate) continue;

        const offset = subtract2(first, start);
        const denominator = cross2(edgeDirection, boundaryDirection);
        const crossTolerance = tolerance.coordinate * Math.max(edgeLength, boundaryLength);
        if (Math.abs(denominator) > crossTolerance) {
            const edgeParameter = cross2(offset, boundaryDirection) / denominator;
            const boundaryParameter = cross2(offset, edgeDirection) / denominator;
            if (boundaryParameter >= -tolerance.parameter && boundaryParameter <= 1 + tolerance.parameter) {
                addParameter(parameters, edgeParameter, tolerance.parameter);
            }
            continue;
        }

        // Parallel projected edges can overlap (for example a rear edge on a
        // cuboid's silhouette). Split at the overlap endpoints so depth tests
        // remain deterministic instead of relying on a midpoint at a vertex.
        if (Math.abs(cross2(offset, edgeDirection)) <= crossTolerance) {
            addParameter(
                parameters,
                ((first.x - start.x) * edgeDirection.x + (first.y - start.y) * edgeDirection.y)
                    / edgeLengthSquared,
                tolerance.parameter
            );
            addParameter(
                parameters,
                ((second.x - start.x) * edgeDirection.x + (second.y - start.y) * edgeDirection.y)
                    / edgeLengthSquared,
                tolerance.parameter
            );
        }
    }
}

function interpolateProjectedPoint(first, second, parameter) {
    if (parameter === 0) return { ...first };
    if (parameter === 1) return { ...second };
    return {
        x: first.x + (second.x - first.x) * parameter,
        y: first.y + (second.y - first.y) * parameter,
        depth: first.depth + (second.depth - first.depth) * parameter,
    };
}

function buildProjectedFaceData(face, projectedFace, normalized, definition, tolerance) {
    const sourcePosition = normalized.vertexMap.get(face.vertexIds[0]).position;
    const normalDotCamera = dot3(face.normal, definition.cameraDirection);
    const planeConstant = -dot3(face.normal, sourcePosition);
    const signedAreaTwice = polygonSignedAreaTwice(projectedFace.points);
    const perimeter = polygonPerimeter(projectedFace.points);
    const projectedArea = Math.abs(signedAreaTwice);
    const hasProjectedArea = projectedArea > tolerance.coordinate * Math.max(perimeter, tolerance.coordinate);
    const hasDepthEquation = Math.abs(normalDotCamera) > VIEW_EPSILON;
    return {
        id: face.id,
        points: projectedFace.points,
        frontFacing: projectedFace.frontFacing,
        hasProjectedArea,
        hasDepthEquation,
        planeX: dot3(face.normal, definition.right),
        planeY: dot3(face.normal, definition.up),
        planeConstant,
        normalDotCamera,
    };
}

function depthOnProjectedFace(faceData, point) {
    if (!faceData.hasDepthEquation) return Number.NaN;
    return -(
        faceData.planeX * point.x
        + faceData.planeY * point.y
        + faceData.planeConstant
    ) / faceData.normalDotCamera;
}

function collectProjectedDepthEquality(
    first,
    second,
    face,
    parameters,
    tolerance
) {
    const firstFaceDepth = depthOnProjectedFace(face, first);
    const secondFaceDepth = depthOnProjectedFace(face, second);
    if (!Number.isFinite(firstFaceDepth) || !Number.isFinite(secondFaceDepth)) return;
    const firstDifference = firstFaceDepth - first.depth;
    const secondDifference = secondFaceDepth - second.depth;
    const differenceChange = secondDifference - firstDifference;
    if (Math.abs(differenceChange) <= tolerance.depth) return;

    const parameter = -firstDifference / differenceChange;
    if (parameter <= tolerance.parameter || parameter >= 1 - tolerance.parameter) return;
    const point = interpolateProjectedPoint(first, second, parameter);
    if (!pointInProjectedPolygon(point, face.points, tolerance.coordinate)) return;
    addParameter(parameters, parameter, tolerance.parameter);
}

function classifyProjectedEdgeSegments(
    first,
    second,
    adjacentFaceIds,
    adjacentFaceFrontFacing,
    faceData,
    tolerance
) {
    // Preserve the established edge rule as the baseline: an edge whose
    // incident faces all face away from the camera remains hidden. For edges
    // that can be drawn, refine that state against every other projected face.
    const candidateVisible = adjacentFaceFrontFacing;
    const parameters = [0, 1];
    const incidentFaceIds = new Set(adjacentFaceIds);
    if (candidateVisible) {
        faceData.forEach((face) => {
            if (!face.hasProjectedArea || !face.hasDepthEquation || incidentFaceIds.has(face.id)) return;
            collectProjectedPolygonIntersections(first, second, face.points, parameters, tolerance);
            // A sloped face can pass from behind the edge to in front without
            // crossing the face's projected perimeter. Split at that ray-depth
            // equality as well, then classify the two intervals independently.
            collectProjectedDepthEquality(first, second, face, parameters, tolerance);
        });
    }

    const orderedParameters = dedupeParameters(parameters, tolerance.parameter);
    const segments = [];
    for (let index = 0; index + 1 < orderedParameters.length; index += 1) {
        const startParameter = orderedParameters[index];
        const endParameter = orderedParameters[index + 1];
        if (endParameter - startParameter <= tolerance.parameter) continue;
        const midpointParameter = (startParameter + endParameter) / 2;
        const midpoint = interpolateProjectedPoint(first, second, midpointParameter);
        let occluded = false;

        if (candidateVisible) {
            for (const face of faceData) {
                if (!face.hasProjectedArea || !face.hasDepthEquation || incidentFaceIds.has(face.id)) continue;
                if (!pointInProjectedPolygon(midpoint, face.points, tolerance.coordinate)) continue;
                const faceDepth = depthOnProjectedFace(face, midpoint);
                // A depth tie is intentionally visible. This covers coplanar
                // overlays and tangent contacts without creating false seams.
                if (Number.isFinite(faceDepth) && faceDepth > midpoint.depth + tolerance.depth) {
                    occluded = true;
                    break;
                }
            }
        }

        const visibility = candidateVisible && !occluded ? 'visible' : 'hidden';
        const previous = segments[segments.length - 1];
        if (previous && previous.visibility === visibility
                && Math.abs(previous.endParameter - startParameter) <= tolerance.parameter) {
            previous.endParameter = endParameter;
        } else {
            segments.push({ visibility, startParameter, endParameter });
        }
    }
    return segments;
}

/**
 * Project the faces and drawable edges of a solid topology into one of the
 * three fixed views. Hidden edges are omitted unless showHiddenEdges is true.
 */
export function projectTopologyToView(topology, viewId, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('options must be an object');
    }
    const showHiddenEdges = options.showHiddenEdges === true;
    const definition = resolveViewDefinition(viewId);
    const normalized = normalizeTopology(topology);
    const projectedPositions = new Map(
        normalized.vertices.map((vertex) => [vertex.id, projectPointToView(vertex.position, definition)])
    );

    const projectedFaces = normalized.faces.map((face) => {
        const points = face.vertexIds.map((vertexId) => ({ ...projectedPositions.get(vertexId) }));
        const frontFacing =
            face.normal.x * definition.cameraDirection.x
            + face.normal.y * definition.cameraDirection.y
            + face.normal.z * definition.cameraDirection.z
            > VIEW_EPSILON;
        return {
            id: face.id,
            points,
            depth: averageDepth(points),
            frontFacing,
        };
    });
    const frontFacingByFaceId = new Map(projectedFaces.map((face) => [face.id, face.frontFacing]));
    const projectionTolerance = makeProjectionTolerances(projectedPositions);
    const projectedFaceData = normalized.faces.map((face, index) => (
        buildProjectedFaceData(face, projectedFaces[index], normalized, definition, projectionTolerance)
    ));

    const projectedEdges = [];
    normalized.edges.forEach((edge) => {
        const first = projectedPositions.get(edge.vertexIds[0]);
        const second = projectedPositions.get(edge.vertexIds[1]);
        if (nearlyEqual(first.x, second.x, projectionTolerance.coordinate)
                && nearlyEqual(first.y, second.y, projectionTolerance.coordinate)) {
            return;
        }
        const adjacentFaceFrontFacing = edge.adjacentFaceIds
            .some((faceId) => frontFacingByFaceId.get(faceId) === true);
        const segments = classifyProjectedEdgeSegments(
            first,
            second,
            edge.adjacentFaceIds,
            adjacentFaceFrontFacing,
            projectedFaceData,
            projectionTolerance
        );
        const split = segments.length > 1;
        segments.forEach((segment, segmentIndex) => {
            if (segment.visibility === 'hidden' && !showHiddenEdges) return;
            const points = [
                interpolateProjectedPoint(first, second, segment.startParameter),
                interpolateProjectedPoint(first, second, segment.endParameter),
            ];
            const projectedEdge = {
                id: split ? `${String(edge.id)}#${segmentIndex + 1}` : edge.id,
                a: edge.vertexIds[0],
                b: edge.vertexIds[1],
                points,
                depth: averageDepth(points),
                visibility: segment.visibility,
                adjacentFaceIds: [...edge.adjacentFaceIds],
            };
            if (split) {
                projectedEdge.segmentId = projectedEdge.id;
                projectedEdge.sourceEdgeId = edge.id;
                projectedEdge.segmentIndex = segmentIndex;
                projectedEdge.segmentCount = segments.length;
                projectedEdge.tStart = segment.startParameter;
                projectedEdge.tEnd = segment.endParameter;
            }
            projectedEdges.push(projectedEdge);
        });
    });

    const result = {
        viewId: definition.id,
        definition,
        faces: projectedFaces,
        edges: projectedEdges,
    };
    result.bounds = getProjectedBounds(result);
    return result;
}

function addPointIfFinite(points, point) {
    if (!point || typeof point !== 'object') return;
    if (typeof point.x !== 'number' || typeof point.y !== 'number') return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    points.push(point);
}

function collectProjectedPoints(value, points) {
    if (!value) return;
    if (Array.isArray(value)) {
        if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
            addPointIfFinite(points, { x: value[0], y: value[1] });
            return;
        }
        value.forEach((item) => collectProjectedPoints(item, points));
        return;
    }
    if (typeof value !== 'object') return;
    if (typeof value.x === 'number' && typeof value.y === 'number') {
        addPointIfFinite(points, value);
        return;
    }
    if (Array.isArray(value.points)) {
        collectProjectedPoints(value.points, points);
    }
    if (Array.isArray(value.faces)) {
        collectProjectedPoints(value.faces, points);
    }
    if (Array.isArray(value.edges)) {
        collectProjectedPoints(value.edges, points);
    }
}

/** Compute finite min/max/size values for a projected topology or point list. */
export function getProjectedBounds(projected) {
    const points = [];
    collectProjectedPoints(projected, points);
    if (points.length === 0) {
        return {
            minX: 0,
            minY: 0,
            maxX: 0,
            maxY: 0,
            width: 0,
            height: 0,
            centerX: 0,
            centerY: 0,
            min: { x: 0, y: 0 },
            max: { x: 0, y: 0 },
            center: { x: 0, y: 0 },
            size: { x: 0, y: 0 },
        };
    }

    let minX = points[0].x;
    let minY = points[0].y;
    let maxX = points[0].x;
    let maxY = points[0].y;
    for (let index = 1; index < points.length; index += 1) {
        const point = points[index];
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
    }
    const width = maxX - minX;
    const height = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return {
        minX,
        minY,
        maxX,
        maxY,
        width,
        height,
        centerX,
        centerY,
        min: { x: minX, y: minY },
        max: { x: maxX, y: maxY },
        center: { x: centerX, y: centerY },
        size: { x: width, y: height },
    };
}

function normalizeBounds(boundsOrProjected) {
    if (!boundsOrProjected || typeof boundsOrProjected !== 'object') {
        throw new TypeError('bounds must be a projected topology or bounds object');
    }
    const hasScalarBounds =
        Number.isFinite(boundsOrProjected.minX)
        && Number.isFinite(boundsOrProjected.minY)
        && Number.isFinite(boundsOrProjected.maxX)
        && Number.isFinite(boundsOrProjected.maxY);
    const hasNestedBounds =
        boundsOrProjected.min
        && boundsOrProjected.max
        && Number.isFinite(boundsOrProjected.min.x)
        && Number.isFinite(boundsOrProjected.min.y)
        && Number.isFinite(boundsOrProjected.max.x)
        && Number.isFinite(boundsOrProjected.max.y);
    const source = hasScalarBounds
        ? boundsOrProjected
        : hasNestedBounds
            ? {
                minX: boundsOrProjected.min.x,
                minY: boundsOrProjected.min.y,
                maxX: boundsOrProjected.max.x,
                maxY: boundsOrProjected.max.y,
            }
            : getProjectedBounds(boundsOrProjected);
    const minX = finiteNumber(source.minX, 'bounds.minX');
    const minY = finiteNumber(source.minY, 'bounds.minY');
    const maxX = finiteNumber(source.maxX, 'bounds.maxX');
    const maxY = finiteNumber(source.maxY, 'bounds.maxY');
    if (maxX < minX || maxY < minY) {
        throw new RangeError('bounds max values must be greater than or equal to min values');
    }
    const width = maxX - minX;
    const height = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return {
        minX,
        minY,
        maxX,
        maxY,
        width,
        height,
        centerX,
        centerY,
        min: { x: minX, y: minY },
        max: { x: maxX, y: maxY },
        center: { x: centerX, y: centerY },
        size: { x: width, y: height },
    };
}

function readViewport(viewportOrWidth, maybeHeight, maybeOptions) {
    let width;
    let height;
    let padding = 0;
    if (typeof viewportOrWidth === 'number') {
        width = viewportOrWidth;
        height = maybeHeight;
        if (typeof maybeOptions === 'number') {
            padding = maybeOptions;
        } else if (maybeOptions && typeof maybeOptions === 'object') {
            padding = maybeOptions.padding ?? 0;
        }
    } else if (viewportOrWidth && typeof viewportOrWidth === 'object') {
        width = viewportOrWidth.width;
        height = viewportOrWidth.height;
        padding = viewportOrWidth.padding ?? 0;
        if (typeof maybeHeight === 'number') padding = maybeHeight;
        if (maybeOptions && typeof maybeOptions === 'object') {
            padding = maybeOptions.padding ?? padding;
        }
    } else {
        throw new TypeError('viewport must contain finite width and height values');
    }
    width = finiteNumber(width, 'viewport.width');
    height = finiteNumber(height, 'viewport.height');
    padding = finiteNumber(padding, 'viewport.padding');
    if (width <= 0 || height <= 0) {
        throw new RangeError('viewport width and height must be greater than zero');
    }
    if (padding < 0 || padding * 2 >= width || padding * 2 >= height) {
        throw new RangeError('viewport.padding must be non-negative and leave drawable space');
    }
    return { width, height, padding };
}

/**
 * Return a uniform scale and translation that centers bounds in a viewport.
 * Projected coordinates are mathematical screen-up coordinates, while a
 * viewport uses pixel rows that increase downward. `scale` is the positive
 * uniform magnitude; `scaleX`/`scaleY` carry the signed pixel transform.
 */
export function fitProjectedBounds(boundsOrProjected, viewportOrWidth, maybeHeight, maybeOptions) {
    const bounds = normalizeBounds(boundsOrProjected);
    const viewport = readViewport(viewportOrWidth, maybeHeight, maybeOptions);
    const availableWidth = viewport.width - viewport.padding * 2;
    const availableHeight = viewport.height - viewport.padding * 2;
    const widthScale = bounds.width > 0 ? availableWidth / bounds.width : Number.POSITIVE_INFINITY;
    const heightScale = bounds.height > 0 ? availableHeight / bounds.height : Number.POSITIVE_INFINITY;
    let scale = Math.min(widthScale, heightScale);
    if (!Number.isFinite(scale)) scale = 1;
    const offsetX = viewport.width / 2 - bounds.centerX * scale;
    const offsetY = viewport.height / 2 + bounds.centerY * scale;
    return {
        scale,
        scaleX: scale,
        scaleY: -scale,
        offsetX,
        offsetY,
        offset: { x: offsetX, y: offsetY },
        translateX: offsetX,
        translateY: offsetY,
        bounds,
        viewport,
    };
}

/** Map one projected screen-up point into pixel viewport coordinates. */
export function mapProjectedPointToViewport(point, fit) {
    if (!point || typeof point !== 'object') {
        throw new TypeError('point must be an object with finite x and y values');
    }
    const x = finiteNumber(point.x, 'point.x');
    const y = finiteNumber(point.y, 'point.y');
    if (!fit || typeof fit !== 'object') {
        throw new TypeError('fit must be the result of fitProjectedBounds');
    }
    const scaleX = finiteNumber(fit.scaleX ?? fit.scale, 'fit.scaleX');
    const scaleY = finiteNumber(fit.scaleY ?? -fit.scale, 'fit.scaleY');
    const offsetX = finiteNumber(fit.offsetX, 'fit.offsetX');
    const offsetY = finiteNumber(fit.offsetY, 'fit.offsetY');
    return {
        x: x * scaleX + offsetX,
        y: y * scaleY + offsetY,
    };
}
