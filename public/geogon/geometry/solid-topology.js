// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 MaskwaSam <136355328+MaskwaSam@users.noreply.github.com>

/**
 * Small, dependency-free topology helpers for the polyhedral primitives used
 * by 3DGeoGon.  The caller supplies the points that the renderer actually
 * created; no dimensions, modes, or Three.js objects are reconstructed here.
 *
 * `buildPolyhedralTopology({ primitiveKey, points, sides })` returns a deeply
 * frozen plain object containing only structural vertices.  Centre, apothem,
 * and other guide points are deliberately ignored.  Edges carry their sorted
 * incident `faceIds`, while `faceAdjacency` maps each face to faces sharing an
 * edge.
 */

const EPSILON = 1e-10;
const POLYGON_SIDES = Object.freeze([5, 6, 7, 8]);
const CURVED_PRIMITIVES = new Set(['sphere', 'cylinder', 'cone', 'hemisphere']);

const NUMBER_NAMES = Object.freeze({
    5: 'Pentagonal',
    6: 'Hexagonal',
    7: 'Septagonal',
    8: 'Octagonal',
});

const STATIC_POLYGONAL_PRIMITIVES = Object.freeze({
    'pentagonal-prism': Object.freeze({ sides: 5, kind: 'prism', label: 'Pentagonal Prism' }),
    'pentagonal-pyramid': Object.freeze({ sides: 5, kind: 'pyramid', label: 'Pentagonal Pyramid' }),
    'hexagonal-prism': Object.freeze({ sides: 6, kind: 'prism', label: 'Hexagonal Prism' }),
    'hexagonal-pyramid': Object.freeze({ sides: 6, kind: 'pyramid', label: 'Hexagonal Pyramid' }),
    'septagonal-prism': Object.freeze({ sides: 7, kind: 'prism', label: 'Septagonal Prism' }),
    'septagonal-pyramid': Object.freeze({ sides: 7, kind: 'pyramid', label: 'Septagonal Pyramid' }),
    'octagonal-prism': Object.freeze({ sides: 8, kind: 'prism', label: 'Octagonal Prism' }),
    'octagonal-pyramid': Object.freeze({ sides: 8, kind: 'pyramid', label: 'Octagonal Pyramid' }),
});

const STATIC_PRIMITIVES = new Set([
    'cuboid',
    'right-triangle-prism',
    'tetrahedron',
    'rectangular-pyramid',
]);

/** Error thrown for malformed point data or unsupported primitives. */
export class PolyhedralTopologyError extends Error {
    constructor(code, message, details = undefined) {
        super(`${code}: ${message}`);
        this.name = 'PolyhedralTopologyError';
        this.code = code;
        if (details !== undefined) {
            this.details = details;
        }
    }
}

function fail(code, message, details = undefined) {
    throw new PolyhedralTopologyError(code, message, details);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function clonePoint(position) {
    return { x: position.x, y: position.y, z: position.z };
}

function pointFromVertex(vertex) {
    if (vertex && isRecord(vertex.position)) {
        return vertex.position;
    }
    if (vertex && finiteNumber(vertex.x) && finiteNumber(vertex.y) && finiteNumber(vertex.z)) {
        return vertex;
    }
    return null;
}

function vectorBetween(a, b) {
    return {
        x: b.x - a.x,
        y: b.y - a.y,
        z: b.z - a.z,
    };
}

function cross(a, b) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}

function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(vector) {
    return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector) {
    const magnitude = length(vector);
    if (!Number.isFinite(magnitude) || magnitude <= EPSILON) {
        return null;
    }
    return {
        x: vector.x / magnitude,
        y: vector.y / magnitude,
        z: vector.z / magnitude,
    };
}

function addInto(target, point) {
    target.x += point.x;
    target.y += point.y;
    target.z += point.z;
}

function freezeDeep(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
        return value;
    }
    seen.add(value);
    Object.values(value).forEach((child) => freezeDeep(child, seen));
    return Object.freeze(value);
}

function letterAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= 26) {
        fail('INVALID_PRIMITIVE_SIDES', `Cannot assign a structural label at index ${index}`);
    }
    return String.fromCharCode(65 + index);
}

function polygonKeyFromSides(kind, sides) {
    const name = NUMBER_NAMES[sides];
    return name ? `${name.toLowerCase()}-${kind}` : null;
}

function normalizePolygonSides(sides) {
    if (!Number.isInteger(sides) || !POLYGON_SIDES.includes(sides)) {
        fail('INVALID_PRIMITIVE_SIDES', `Supported polygonal solids use ${POLYGON_SIDES.join(', ')} sides; received ${String(sides)}`);
    }
    return sides;
}

/**
 * Return metadata for a supported regular prism/pyramid key.
 *
 * `sides` is useful with the aliases `polygonal-prism`, `regular-prism`,
 * `polygonal-pyramid`, and `regular-pyramid`; the named five-to-eight-sided
 * keys do not need it.
 */
export function getPolygonalPrimitiveInfo(primitiveKey, sides = undefined) {
    if (isRecord(primitiveKey)) {
        sides = primitiveKey.sides;
        primitiveKey = primitiveKey.primitiveKey;
    }
    if (typeof primitiveKey !== 'string') {
        return null;
    }

    const staticInfo = STATIC_POLYGONAL_PRIMITIVES[primitiveKey];
    if (staticInfo) {
        if (sides !== undefined && sides !== staticInfo.sides) {
            fail('INVALID_PRIMITIVE_SIDES', `${primitiveKey} requires ${staticInfo.sides} sides; received ${String(sides)}`);
        }
        return {
            primitiveKey,
            sides: staticInfo.sides,
            kind: staticInfo.kind,
            label: staticInfo.label,
        };
    }

    const aliasKinds = {
        'polygonal-prism': 'prism',
        'regular-prism': 'prism',
        prism: 'prism',
        'polygonal-pyramid': 'pyramid',
        'regular-pyramid': 'pyramid',
        pyramid: 'pyramid',
    };
    if (Object.prototype.hasOwnProperty.call(aliasKinds, primitiveKey)) {
        const normalizedSides = normalizePolygonSides(sides);
        const kind = aliasKinds[primitiveKey];
        const canonicalKey = polygonKeyFromSides(kind, normalizedSides);
        return {
            primitiveKey,
            canonicalKey,
            sides: normalizedSides,
            kind,
            label: `${NUMBER_NAMES[normalizedSides]} ${kind[0].toUpperCase()}${kind.slice(1)}`,
        };
    }

    return null;
}

function primitiveInfo(primitiveKey, sides) {
    const polygonal = getPolygonalPrimitiveInfo(primitiveKey, sides);
    if (polygonal) {
        return polygonal;
    }
    if (STATIC_PRIMITIVES.has(primitiveKey)) {
        return { primitiveKey, kind: 'polyhedron', sides: null, label: primitiveKey };
    }
    if (CURVED_PRIMITIVES.has(primitiveKey)) {
        fail('UNSUPPORTED_PRIMITIVE', `Curved primitive "${primitiveKey}" is not a polyhedral solid`);
    }
    if (typeof primitiveKey === 'string') {
        fail('UNSUPPORTED_PRIMITIVE', `Unsupported primitive "${primitiveKey}"`);
    }
    fail('INVALID_PRIMITIVE_KEY', 'primitiveKey must be a supported primitive string');
}

/** Return a direction-independent, deterministic key for an edge. */
export function edgeKey(firstId, secondId) {
    if (typeof firstId !== 'string' || firstId.length === 0 || typeof secondId !== 'string' || secondId.length === 0) {
        fail('INVALID_EDGE', 'edge endpoints must be non-empty vertex IDs');
    }
    if (firstId === secondId) {
        fail('INVALID_EDGE', `An edge cannot connect vertex ${firstId} to itself`);
    }
    return [firstId, secondId].sort().join('-');
}

function structuralVertexIds(primitiveKey, info) {
    if (primitiveKey === 'cuboid') {
        return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    }
    if (primitiveKey === 'right-triangle-prism') {
        return ['A', 'B', 'C', 'D', 'E', 'F'];
    }
    if (primitiveKey === 'tetrahedron') {
        return ['A', 'B', 'C', 'D'];
    }
    if (primitiveKey === 'rectangular-pyramid') {
        return ['A', 'B', 'C', 'D', 'E'];
    }
    if (info.kind === 'prism') {
        return Array.from({ length: info.sides * 2 }, (_, index) => letterAt(index));
    }
    return Array.from({ length: info.sides + 1 }, (_, index) => letterAt(index));
}

function faceDefinition(id, label, type, vertexIds) {
    return { id, label, type, vertexIds };
}

function regularPolygonDefinitions(info) {
    const { sides, kind } = info;
    const bottom = Array.from({ length: sides }, (_, index) => letterAt(index));
    const top = Array.from({ length: sides }, (_, index) => letterAt(index + sides));
    const definitions = [];
    const sideLabel = (index) => `${letterAt(index)}${letterAt((index + 1) % sides)}`;

    if (kind === 'prism') {
        definitions.push(faceDefinition('top', 'Top', `regular-${sides}-gon`, top));
        definitions.push(faceDefinition('bottom', 'Bottom', `regular-${sides}-gon`, bottom));
        for (let index = 0; index < sides; index += 1) {
            const next = (index + 1) % sides;
            definitions.push(faceDefinition(
                `side-${index}`,
                `Side Face ${sideLabel(index)}`,
                'rectangle',
                [bottom[index], bottom[next], top[next], top[index]],
            ));
        }
    } else {
        const apex = letterAt(sides);
        definitions.push(faceDefinition('base', 'Base', `regular-${sides}-gon`, bottom));
        for (let index = 0; index < sides; index += 1) {
            const next = (index + 1) % sides;
            definitions.push(faceDefinition(
                `side-${index}`,
                `Side Face ${sideLabel(index)}`,
                'triangle',
                [bottom[index], bottom[next], apex],
            ));
        }
    }
    return definitions;
}

function faceDefinitions(primitiveKey, info) {
    if (info.kind === 'prism' || info.kind === 'pyramid') {
        return regularPolygonDefinitions(info);
    }
    switch (primitiveKey) {
        case 'cuboid':
            return [
                faceDefinition('top', 'Top', 'rectangle', ['E', 'F', 'G', 'H']),
                faceDefinition('bottom', 'Bottom', 'rectangle', ['A', 'D', 'C', 'B']),
                faceDefinition('front', 'Front', 'rectangle', ['A', 'B', 'F', 'E']),
                faceDefinition('back', 'Back', 'rectangle', ['D', 'H', 'G', 'C']),
                faceDefinition('right', 'Right', 'rectangle', ['B', 'C', 'G', 'F']),
                faceDefinition('left', 'Left', 'rectangle', ['A', 'E', 'H', 'D']),
            ];
        case 'right-triangle-prism':
            return [
                faceDefinition('base-rectangle', 'Rectangular Face AB', 'rectangle', ['A', 'B', 'E', 'D']),
                faceDefinition('side-rectangle', 'Rectangular Face AC', 'rectangle', ['A', 'D', 'F', 'C']),
                faceDefinition('hypotenuse-rectangle', 'Rectangular Face BC', 'rectangle', ['B', 'C', 'F', 'E']),
                faceDefinition('front-triangle', 'Triangular Face ABC', 'triangle', ['A', 'B', 'C']),
                faceDefinition('back-triangle', 'Triangular Face DEF', 'triangle', ['D', 'F', 'E']),
            ];
        case 'tetrahedron':
            return [
                faceDefinition('base-triangle', 'Base Triangle', 'triangle', ['A', 'B', 'C']),
                faceDefinition('face-abd', 'Side Face ABD', 'triangle', ['A', 'D', 'B']),
                faceDefinition('face-bcd', 'Side Face BCD', 'triangle', ['B', 'D', 'C']),
                faceDefinition('face-cad', 'Side Face CAD', 'triangle', ['C', 'D', 'A']),
            ];
        case 'rectangular-pyramid':
            return [
                faceDefinition('base', 'Base', 'rectangle', ['A', 'B', 'C', 'D']),
                faceDefinition('front', 'Front Triangle', 'triangle', ['A', 'B', 'E']),
                faceDefinition('right', 'Right Triangle', 'triangle', ['B', 'C', 'E']),
                faceDefinition('back', 'Back Triangle', 'triangle', ['C', 'D', 'E']),
                faceDefinition('left', 'Left Triangle', 'triangle', ['D', 'A', 'E']),
            ];
        default:
            fail('UNSUPPORTED_PRIMITIVE', `No face template exists for "${primitiveKey}"`);
    }
}

function lookupVertices(vertices) {
    const byId = new Map();
    if (vertices instanceof Map) {
        vertices.forEach((vertex, id) => {
            const point = pointFromVertex(vertex) || (isRecord(vertex) ? vertex : null);
            if (typeof id === 'string' && point && finiteNumber(point.x) && finiteNumber(point.y) && finiteNumber(point.z)) {
                byId.set(id, point);
            }
        });
    } else if (Array.isArray(vertices)) {
        vertices.forEach((vertex) => {
            if (vertex && typeof vertex.id === 'string') {
                const point = pointFromVertex(vertex);
                if (point) {
                    byId.set(vertex.id, point);
                }
            }
        });
    } else if (isRecord(vertices)) {
        Object.entries(vertices).forEach(([id, vertex]) => {
            const point = pointFromVertex(vertex) || (isRecord(vertex) ? vertex : null);
            if (point && finiteNumber(point.x) && finiteNumber(point.y) && finiteNumber(point.z)) {
                byId.set(id, point);
            }
        });
    }
    return byId;
}

function faceVertexPoints(faceOrVertexIds, vertices) {
    const vertexIds = Array.isArray(faceOrVertexIds)
        ? faceOrVertexIds
        : faceOrVertexIds?.vertexIds;
    if (!Array.isArray(vertexIds) || vertexIds.length < 3) {
        fail('INVALID_FACE', 'A face requires at least three vertex IDs');
    }
    const byId = lookupVertices(vertices);
    return vertexIds.map((id) => {
        const point = byId.get(id);
        if (!point) {
            fail('MISSING_STRUCTURAL_VERTEX', `Face references missing vertex "${id}"`);
        }
        return point;
    });
}

/** Compute the arithmetic centroid of a face from its actual vertex positions. */
export function faceCentroid(faceOrVertexIds, vertices) {
    const points = faceVertexPoints(faceOrVertexIds, vertices);
    const centroid = { x: 0, y: 0, z: 0 };
    points.forEach((point) => addInto(centroid, point));
    centroid.x /= points.length;
    centroid.y /= points.length;
    centroid.z /= points.length;
    return centroid;
}

/** Compute a unit Newell normal from a face's ordered actual vertex positions. */
export function faceNormal(faceOrVertexIds, vertices) {
    const points = faceVertexPoints(faceOrVertexIds, vertices);
    const normal = { x: 0, y: 0, z: 0 };
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        normal.x += (current.y - next.y) * (current.z + next.z);
        normal.y += (current.z - next.z) * (current.x + next.x);
        normal.z += (current.x - next.x) * (current.y + next.y);
    }
    const unit = normalize(normal);
    if (!unit) {
        fail('DEGENERATE_FACE', 'Face vertices are collinear or coincident');
    }
    return unit;
}

function orientFace(definition, verticesById, solidCentroid) {
    let vertexIds = definition.vertexIds.slice();
    let centroid = faceCentroid(vertexIds, verticesById);
    let normal = faceNormal(vertexIds, verticesById);
    const outwardHint = vectorBetween(solidCentroid, centroid);
    if (dot(normal, outwardHint) < -EPSILON) {
        vertexIds.reverse();
        centroid = faceCentroid(vertexIds, verticesById);
        normal = faceNormal(vertexIds, verticesById);
    }
    if (Math.abs(dot(normal, outwardHint)) <= EPSILON) {
        fail('INVALID_TOPOLOGY', `Cannot determine an outward orientation for face "${definition.id}"`);
    }
    return {
        id: definition.id,
        label: definition.label,
        type: definition.type,
        vertexIds,
        centroid,
        normal,
    };
}

function canonicalVertexOrder(ids) {
    const rank = new Map(ids.map((id, index) => [id, index]));
    return (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER);
}

function collectEdges(faces, vertexIds) {
    const edgeMap = new Map();
    faces.forEach((face) => {
        for (let index = 0; index < face.vertexIds.length; index += 1) {
            const first = face.vertexIds[index];
            const second = face.vertexIds[(index + 1) % face.vertexIds.length];
            const id = edgeKey(first, second);
            if (!edgeMap.has(id)) {
                edgeMap.set(id, {
                    id,
                    vertexIds: [first, second].sort(canonicalVertexOrder(vertexIds)),
                    faceIds: [face.id],
                });
            } else {
                edgeMap.get(id).faceIds.push(face.id);
            }
        }
    });
    return Array.from(edgeMap.values(), (edge) => ({
        ...edge,
        faceIds: edge.faceIds.slice().sort(),
    }));
}

function collectAdjacency(edges, vertexIds) {
    const neighbors = new Map(vertexIds.map((id) => [id, new Set()]));
    edges.forEach((edge) => {
        const [first, second] = edge.vertexIds;
        neighbors.get(first)?.add(second);
        neighbors.get(second)?.add(first);
    });
    const rank = canonicalVertexOrder(vertexIds);
    return Object.fromEntries(vertexIds.map((id) => [
        id,
        Array.from(neighbors.get(id) || []).sort(rank),
    ]));
}

function collectFaceAdjacency(faces, edges) {
    const neighbors = new Map(faces.map((face) => [face.id, new Set()]));
    edges.forEach((edge) => {
        for (let firstIndex = 0; firstIndex < edge.faceIds.length; firstIndex += 1) {
            for (let secondIndex = firstIndex + 1; secondIndex < edge.faceIds.length; secondIndex += 1) {
                const first = edge.faceIds[firstIndex];
                const second = edge.faceIds[secondIndex];
                neighbors.get(first)?.add(second);
                neighbors.get(second)?.add(first);
            }
        }
    });
    return Object.fromEntries(faces.map((face) => [
        face.id,
        Array.from(neighbors.get(face.id) || []).sort(),
    ]));
}

function readStructuralPoints(points, structuralIds) {
    if (!Array.isArray(points)) {
        fail('INVALID_POINTS', 'points must be an array of {id, position} records');
    }

    const expected = new Set(structuralIds);
    const structural = new Map();
    points.forEach((point) => {
        if (!isRecord(point) || typeof point.id !== 'string' || !expected.has(point.id)) {
            return;
        }
        if (structural.has(point.id)) {
            fail('DUPLICATE_STRUCTURAL_VERTEX', `Structural vertex "${point.id}" appears more than once`);
        }
        const position = point.position;
        if (!isRecord(position) || !finiteNumber(position.x) || !finiteNumber(position.y) || !finiteNumber(position.z)) {
            fail('NONFINITE_STRUCTURAL_VERTEX', `Structural vertex "${point.id}" must have finite x, y, and z coordinates`);
        }
        structural.set(point.id, clonePoint(position));
    });

    const missing = structuralIds.filter((id) => !structural.has(id));
    if (missing.length > 0) {
        fail('MISSING_STRUCTURAL_VERTEX', `Missing structural vertex${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`, { missing });
    }
    return structural;
}

function buildSolidCentroid(verticesById, vertexIds) {
    const centroid = { x: 0, y: 0, z: 0 };
    vertexIds.forEach((id) => addInto(centroid, verticesById.get(id)));
    centroid.x /= vertexIds.length;
    centroid.y /= vertexIds.length;
    centroid.z /= vertexIds.length;
    return centroid;
}

/**
 * Build immutable structural topology from the renderer's local point data.
 *
 * The returned shape is:
 * `{ primitiveKey, vertices, faces, edges, adjacency, faceAdjacency }`.
 * Vertices are `{ id, position }`; faces are `{ id, label, type, vertexIds,
 * centroid, normal }`; edges are `{ id, vertexIds, faceIds }`; adjacency maps
 * each structural vertex ID to its sorted neighboring vertex IDs; and
 * `faceAdjacency` maps a face ID to sorted face IDs sharing an edge.
 */
export function buildPolyhedralTopology(input = {}) {
    if (!isRecord(input)) {
        fail('INVALID_INPUT', 'buildPolyhedralTopology expects an options object');
    }
    const { primitiveKey, points, sides = undefined } = input;
    const info = primitiveInfo(primitiveKey, sides);
    const structuralIds = structuralVertexIds(primitiveKey, info);
    const pointMap = readStructuralPoints(points, structuralIds);
    const verticesById = new Map(structuralIds.map((id) => [id, pointMap.get(id)]));
    const solidCentroid = buildSolidCentroid(verticesById, structuralIds);
    const rawDefinitions = faceDefinitions(primitiveKey, info);
    const faces = rawDefinitions.map((definition) => orientFace(definition, verticesById, solidCentroid));
    const vertices = structuralIds.map((id) => ({ id, position: clonePoint(verticesById.get(id)) }));
    const edges = collectEdges(faces, structuralIds);
    const adjacency = collectAdjacency(edges, structuralIds);
    const faceAdjacency = collectFaceAdjacency(faces, edges);
    const topology = {
        primitiveKey,
        vertices,
        faces,
        edges,
        adjacency,
        faceAdjacency,
    };
    validatePolyhedralTopology(topology);
    return freezeDeep(topology);
}

function topologyError(message, details) {
    return new PolyhedralTopologyError('INVALID_TOPOLOGY', message, details);
}

function assertTopology(condition, message, details = undefined) {
    if (!condition) {
        throw topologyError(message, details);
    }
}

const CLOSED_PRIMITIVE_KEYS = new Set([
    ...STATIC_PRIMITIVES,
    ...Object.keys(STATIC_POLYGONAL_PRIMITIVES),
    'polygonal-prism',
    'regular-prism',
    'prism',
    'polygonal-pyramid',
    'regular-pyramid',
    'pyramid',
]);

/**
 * Validate a topology object.  Returns `true` for a valid object and throws a
 * `PolyhedralTopologyError` with code `INVALID_TOPOLOGY` otherwise.
 */
export function validatePolyhedralTopology(topology) {
    assertTopology(isRecord(topology), 'topology must be a plain object');
    assertTopology(typeof topology.primitiveKey === 'string', 'topology.primitiveKey must be a string');
    assertTopology(Array.isArray(topology.vertices), 'topology.vertices must be an array');
    assertTopology(Array.isArray(topology.faces), 'topology.faces must be an array');
    assertTopology(Array.isArray(topology.edges), 'topology.edges must be an array');
    assertTopology(isRecord(topology.adjacency), 'topology.adjacency must be an object');
    assertTopology(isRecord(topology.faceAdjacency), 'topology.faceAdjacency must be an object');

    const vertexIds = topology.vertices.map((vertex) => vertex?.id);
    assertTopology(vertexIds.every((id) => typeof id === 'string' && id.length > 0), 'vertices must have non-empty string IDs');
    assertTopology(new Set(vertexIds).size === vertexIds.length, 'vertices must have unique IDs');
    const verticesById = lookupVertices(topology.vertices);
    assertTopology(verticesById.size === vertexIds.length, 'vertices must have finite positions');
    const vertexSet = new Set(vertexIds);
    const rank = canonicalVertexOrder(vertexIds);
    const solidCentroid = buildSolidCentroid(verticesById, vertexIds);

    const faceIds = topology.faces.map((face) => face?.id);
    assertTopology(faceIds.every((id) => typeof id === 'string' && id.length > 0), 'faces must have non-empty string IDs');
    assertTopology(new Set(faceIds).size === faceIds.length, 'faces must have unique IDs');
    topology.faces.forEach((face) => {
        assertTopology(isRecord(face), 'each face must be an object');
        assertTopology(typeof face.label === 'string' && face.label.length > 0, `face "${face.id}" must have a label`);
        assertTopology(typeof face.type === 'string' && face.type.length > 0, `face "${face.id}" must have a type`);
        assertTopology(Array.isArray(face.vertexIds) && face.vertexIds.length >= 3, `face "${face.id}" must have at least three vertices`);
        assertTopology(face.vertexIds.every((id) => vertexSet.has(id)), `face "${face.id}" references an unknown vertex`);
        assertTopology(new Set(face.vertexIds).size === face.vertexIds.length, `face "${face.id}" repeats a vertex`);
        const expectedCentroid = faceCentroid(face.vertexIds, topology.vertices);
        const expectedNormal = faceNormal(face.vertexIds, topology.vertices);
        assertTopology(isRecord(face.centroid) && finiteNumber(face.centroid.x) && finiteNumber(face.centroid.y) && finiteNumber(face.centroid.z), `face "${face.id}" has an invalid centroid`);
        assertTopology(isRecord(face.normal) && finiteNumber(face.normal.x) && finiteNumber(face.normal.y) && finiteNumber(face.normal.z), `face "${face.id}" has an invalid normal`);
        assertTopology(Math.abs(face.centroid.x - expectedCentroid.x) < 1e-8 && Math.abs(face.centroid.y - expectedCentroid.y) < 1e-8 && Math.abs(face.centroid.z - expectedCentroid.z) < 1e-8, `face "${face.id}" centroid does not match its vertices`);
        assertTopology(Math.abs(length(face.normal) - 1) < 1e-8, `face "${face.id}" normal must be unit length`);
        assertTopology(dot(face.normal, expectedNormal) > 1 - 1e-8, `face "${face.id}" normal does not match its winding`);
        assertTopology(dot(face.normal, vectorBetween(solidCentroid, face.centroid)) > EPSILON, `face "${face.id}" normal is not outward`);
    });

    const expectedEdges = new Map();
    topology.faces.forEach((face) => {
        for (let index = 0; index < face.vertexIds.length; index += 1) {
            const first = face.vertexIds[index];
            const second = face.vertexIds[(index + 1) % face.vertexIds.length];
            const id = edgeKey(first, second);
            if (!expectedEdges.has(id)) {
                expectedEdges.set(id, { faceIds: [] });
            }
            expectedEdges.get(id).faceIds.push(face.id);
        }
    });
    const edgeIds = topology.edges.map((edge) => edge?.id);
    assertTopology(edgeIds.every((id) => typeof id === 'string' && id.length > 0), 'edges must have non-empty IDs');
    assertTopology(new Set(edgeIds).size === edgeIds.length, 'edges must have unique IDs');
    assertTopology(edgeIds.length === expectedEdges.size, 'edges must be the unique structural face edges');
    topology.edges.forEach((edge) => {
        assertTopology(isRecord(edge) && Array.isArray(edge.vertexIds) && edge.vertexIds.length === 2, `edge "${edge.id}" must contain two vertex IDs`);
        assertTopology(edge.vertexIds.every((id) => vertexSet.has(id)), `edge "${edge.id}" references an unknown vertex`);
        assertTopology(edgeKey(edge.vertexIds[0], edge.vertexIds[1]) === edge.id, `edge "${edge.id}" has a non-canonical ID`);
        assertTopology(expectedEdges.has(edge.id), `edge "${edge.id}" is not a face edge`);
        assertTopology(Array.isArray(edge.faceIds), `edge "${edge.id}" must list incident face IDs`);
        assertTopology(edge.faceIds.length === 1 || edge.faceIds.length === 2, `edge "${edge.id}" must have one or two incident faces`);
        assertTopology(new Set(edge.faceIds).size === edge.faceIds.length, `edge "${edge.id}" repeats an incident face`);
        assertTopology(edge.faceIds.every((faceId) => faceIds.includes(faceId)), `edge "${edge.id}" references an unknown incident face`);
        const sortedFaceIds = edge.faceIds.slice().sort();
        assertTopology(JSON.stringify(sortedFaceIds) === JSON.stringify(edge.faceIds), `edge "${edge.id}" faceIds must be sorted`);
        if (CLOSED_PRIMITIVE_KEYS.has(topology.primitiveKey)) {
            assertTopology(edge.faceIds.length === 2, `closed primitive edge "${edge.id}" must have exactly two incident faces`);
        }
        const expectedFaceIds = expectedEdges.get(edge.id).faceIds.slice().sort();
        assertTopology(JSON.stringify(expectedFaceIds) === JSON.stringify(edge.faceIds), `edge "${edge.id}" face incidence does not match its faces`);
    });

    const expectedFaceAdjacency = new Map(faceIds.map((id) => [id, new Set()]));
    expectedEdges.forEach(({ faceIds: incidentFaceIds }) => {
        for (let firstIndex = 0; firstIndex < incidentFaceIds.length; firstIndex += 1) {
            for (let secondIndex = firstIndex + 1; secondIndex < incidentFaceIds.length; secondIndex += 1) {
                const first = incidentFaceIds[firstIndex];
                const second = incidentFaceIds[secondIndex];
                expectedFaceAdjacency.get(first)?.add(second);
                expectedFaceAdjacency.get(second)?.add(first);
            }
        }
    });

    const adjacencyKeys = Object.keys(topology.adjacency);
    assertTopology(adjacencyKeys.length === vertexIds.length && adjacencyKeys.every((id) => vertexSet.has(id)), 'adjacency must have one entry for every vertex');
    topology.edges.forEach((edge) => {
        const [first, second] = edge.vertexIds;
        const firstNeighbors = topology.adjacency[first];
        const secondNeighbors = topology.adjacency[second];
        assertTopology(Array.isArray(firstNeighbors) && firstNeighbors.includes(second), `adjacency is missing ${first}-${second}`);
        assertTopology(Array.isArray(secondNeighbors) && secondNeighbors.includes(first), `adjacency is missing ${second}-${first}`);
    });
    vertexIds.forEach((id) => {
        const neighbors = topology.adjacency[id];
        assertTopology(Array.isArray(neighbors), `adjacency[${id}] must be an array`);
        assertTopology(new Set(neighbors).size === neighbors.length, `adjacency[${id}] contains duplicate neighbors`);
        assertTopology(neighbors.every((neighbor) => vertexSet.has(neighbor) && neighbor !== id), `adjacency[${id}] contains an invalid neighbor`);
        const sorted = neighbors.slice().sort(rank);
        assertTopology(JSON.stringify(sorted) === JSON.stringify(neighbors), `adjacency[${id}] must use structural vertex order`);
    });

    const faceAdjacencyKeys = Object.keys(topology.faceAdjacency);
    assertTopology(faceAdjacencyKeys.length === faceIds.length && faceAdjacencyKeys.every((id) => faceIds.includes(id)), 'faceAdjacency must have one entry for every face');
    faceIds.forEach((id) => {
        const neighbors = topology.faceAdjacency[id];
        assertTopology(Array.isArray(neighbors), `faceAdjacency[${id}] must be an array`);
        assertTopology(new Set(neighbors).size === neighbors.length, `faceAdjacency[${id}] contains duplicate faces`);
        assertTopology(neighbors.every((neighbor) => faceIds.includes(neighbor) && neighbor !== id), `faceAdjacency[${id}] contains an invalid neighbor`);
        const sorted = neighbors.slice().sort();
        assertTopology(JSON.stringify(sorted) === JSON.stringify(neighbors), `faceAdjacency[${id}] must be sorted`);
        const expected = Array.from(expectedFaceAdjacency.get(id) || []).sort();
        assertTopology(JSON.stringify(expected) === JSON.stringify(neighbors), `faceAdjacency[${id}] does not match shared edges`);
    });
    return true;
}
