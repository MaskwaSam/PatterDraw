// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 MaskwaSam <136355328+MaskwaSam@users.noreply.github.com>

/**
 * Dependency-free composition helpers for world-space convex polyhedra.
 *
 * A composite is made by gluing two or three closed convex slot topologies
 * across complete, coincident faces. Source solids are never moved or
 * mutated. Output face winding is retained from each source, rather than
 * being re-oriented from a global centroid, because a glued solid can be
 * non-convex.
 */

const DEFAULT_TOLERANCE = 1e-8;
const MACHINE_EPSILON = Number.EPSILON * 64;
const MIN_VALUE = Number.MIN_VALUE;

export class CompositeTopologyError extends Error {
    constructor(code, message, details = undefined) {
        super(`${code}: ${message}`);
        this.name = 'CompositeTopologyError';
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

function expectedEdgeMap(faces) {
    const map = new Map();
    const tupleById = new Map();
    faces.forEach((face) => {
        for (let index = 0; index < face.vertexIds.length; index += 1) {
            const first = face.vertexIds[index];
            const second = face.vertexIds[(index + 1) % face.vertexIds.length];
            if (first === second) fail('INVALID_EDGE', `face "${face.id}" has a self-edge`);
            const id = edgeKey(first, second);
            const tuple = JSON.stringify([first, second].sort(compareIds));
            if (tupleById.has(id) && tupleById.get(id) !== tuple) {
                fail('ID_COLLISION', `edge namespace is ambiguous for "${id}"`);
            }
            tupleById.set(id, tuple);
            if (!map.has(id)) map.set(id, { id, vertexIds: [first, second].sort(compareIds), faceIds: [], orientations: [] });
            const edge = map.get(id);
            edge.faceIds.push(face.id);
            edge.orientations.push({ faceId: face.id, pair: [first, second] });
        }
    });
    map.forEach((edge) => {
        if (edge.faceIds.length !== 2 || new Set(edge.faceIds).size !== 2) {
            fail('NON_MANIFOLD_EDGE', `edge "${edge.id}" must have exactly two incident faces`, { faceIds: edge.faceIds.slice() });
        }
        edge.faceIds.sort(compareIds);
    });
    return map;
}

function assertOppositeIncidence(edgeMap, code = 'NON_ORIENTABLE_EDGE') {
    edgeMap.forEach((edge) => {
        if (!Array.isArray(edge.orientations) || edge.orientations.length !== 2) return;
        const first = edge.orientations[0].pair;
        const second = edge.orientations[1].pair;
        if (first[0] === second[0] && first[1] === second[1]) {
            fail(code, `edge "${edge.id}" has identically oriented incident faces`);
        }
    });
}

function validateProvidedEdges(topology, expected) {
    if (!Array.isArray(topology.edges)) return Array.from(expected.values());
    const seen = new Set();
    topology.edges.forEach((edge) => {
        if (!isRecord(edge) || typeof edge.id !== 'string' || !Array.isArray(edge.vertexIds) || edge.vertexIds.length !== 2 || !Array.isArray(edge.faceIds)) {
            fail('INVALID_SLOT_TOPOLOGY', 'each topology edge must contain id, vertexIds, and faceIds');
        }
        if (seen.has(edge.id)) fail('INVALID_SLOT_TOPOLOGY', `duplicate edge "${edge.id}"`);
        seen.add(edge.id);
        const expectedEdge = expected.get(edgeKey(edge.vertexIds[0], edge.vertexIds[1]));
        if (!expectedEdge || edge.id !== expectedEdge.id) fail('INVALID_SLOT_TOPOLOGY', `edge "${edge.id}" does not match its face loops`);
        const actualFaces = edge.faceIds.slice().sort(compareIds);
        if (JSON.stringify(actualFaces) !== JSON.stringify(expectedEdge.faceIds)) {
            fail('INVALID_SLOT_TOPOLOGY', `edge "${edge.id}" face incidence does not match its face loops`);
        }
    });
    if (seen.size !== expected.size) fail('INVALID_SLOT_TOPOLOGY', 'topology.edges must contain every face-loop edge');
    return Array.from(expected.values());
}

function validateSourceTopology(slot, options) {
    if (!isRecord(slot.topology)) fail('INVALID_SLOT_TOPOLOGY', `slot "${slot.slotId}" topology must be a plain object`);
    const topology = slot.topology;
    if (!Array.isArray(topology.vertices) || topology.vertices.length < 4) fail('INVALID_SLOT_TOPOLOGY', `slot "${slot.slotId}" topology.vertices must contain at least four vertices`);
    if (!Array.isArray(topology.faces) || topology.faces.length < 4) fail('INVALID_SLOT_TOPOLOGY', `slot "${slot.slotId}" topology.faces must contain at least four faces`);
    const vertices = new Map();
    topology.vertices.forEach((vertex) => {
        if (!isRecord(vertex) || typeof vertex.id !== 'string' || vertex.id.length === 0) fail('INVALID_SLOT_TOPOLOGY', `slot "${slot.slotId}" has an invalid vertex id`);
        if (vertices.has(vertex.id)) fail('INVALID_SLOT_TOPOLOGY', `slot "${slot.slotId}" repeats vertex "${vertex.id}"`);
        vertices.set(vertex.id, readPoint(vertex, `slot "${slot.slotId}" vertex "${vertex.id}"`));
    });
    const faces = [];
    const faceIds = new Set();
    topology.faces.forEach((face) => {
        if (faceIds.has(face?.id)) fail('INVALID_SLOT_TOPOLOGY', `slot "${slot.slotId}" repeats face "${face.id}"`);
        const geometry = faceGeometry(face, vertices, options, `slot "${slot.slotId}" face "${face?.id}"`);
        faceIds.add(geometry.id);
        faces.push(geometry);
    });
    const expected = expectedEdgeMap(faces);
    assertOppositeIncidence(expected);
    const edges = validateProvidedEdges(topology, expected);
    // Every face plane must contain the complete vertex set on its inward
    // side. This is a deterministic convex-halfspace test for a closed solid.
    faces.forEach((face) => {
        const origin = face.points[0];
        const planeTolerance = coordinateTolerance(face.scale, options.tolerance);
        vertices.forEach((point) => {
            const signedDistance = dot(face.normal, vectorBetween(origin, point));
            if (signedDistance > planeTolerance) {
                fail('NON_CONVEX_SOLID', `slot "${slot.slotId}" is not convex at face "${face.id}"`, { faceId: face.id, signedDistance });
            }
        });
    });
    const solidScale = scaleOfPoints(Array.from(vertices.values()));
    if (Math.abs(signedVolume6(faces, vertices)) <= MACHINE_EPSILON * solidScale ** 3) {
        fail('DEGENERATE_SOLID', `slot "${slot.slotId}" has zero volume`);
    }
    const faceNeighbors = new Map(faces.map((face) => [face.id, new Set()]));
    edges.forEach((edge) => {
        const [first, second] = edge.faceIds;
        faceNeighbors.get(first).add(second);
        faceNeighbors.get(second).add(first);
    });
    const reached = new Set();
    const pending = [faces[0].id];
    while (pending.length > 0) {
        const current = pending.pop();
        if (reached.has(current)) continue;
        reached.add(current);
        faceNeighbors.get(current).forEach((neighbor) => pending.push(neighbor));
    }
    if (reached.size !== faces.length) fail('INVALID_SLOT_TOPOLOGY', `slot "${slot.slotId}" faces are disconnected`);
    const sortedFaces = faces.slice().sort((first, second) => compareIds(first.id, second.id));
    const sortedVertices = Array.from(vertices.entries()).sort(([first], [second]) => compareIds(first, second));
    return {
        slotId: slot.slotId,
        primitiveKey: slot.primitiveKey ?? topology.primitiveKey ?? null,
        topology,
        vertices,
        sortedVertices,
        faces: sortedFaces,
        faceById: new Map(sortedFaces.map((face) => [face.id, face])),
        edges: edges.slice().sort((first, second) => compareIds(first.id, second.id)),
        edgeById: new Map(edges.map((edge) => [edge.id, edge])),
    };
}

function normalizeSlots(input) {
    if (!Array.isArray(input)) fail('INVALID_SLOTS', 'slots must be an array');
    if (input.length !== 2 && input.length !== 3) fail('INVALID_SLOTS', 'a composite requires exactly two or three slots');
    const ids = new Set();
    return input.map((slot) => {
        if (!isRecord(slot) || typeof slot.slotId !== 'string' || slot.slotId.length === 0) fail('INVALID_SLOT_ID', 'each slot requires a non-empty string slotId');
        if (ids.has(slot.slotId)) fail('DUPLICATE_SLOT', `slot "${slot.slotId}" appears more than once`);
        ids.add(slot.slotId);
        return slot;
    }).sort((first, second) => compareIds(first.slotId, second.slotId));
}

function validateAttachmentGraph(attachments, slots) {
    if (!Array.isArray(attachments)) fail('INVALID_ATTACHMENTS', 'attachments must be an array');
    const slotIds = new Set(slots.map((slot) => slot.slotId));
    const neighbors = new Map(slots.map((slot) => [slot.slotId, new Set()]));
    const usedFaces = new Set();
    const pairKeys = new Set();
    const normalized = attachments.map((attachment, index) => {
        if (!isRecord(attachment)) fail('INVALID_ATTACHMENTS', `attachment ${index} must be an object`);
        const { guestSlotId, hostSlotId, hostFaceId, guestFaceId } = attachment;
        if (![guestSlotId, hostSlotId].every((id) => typeof id === 'string' && id.length > 0)) fail('INVALID_ATTACHMENTS', `attachment ${index} requires hostSlotId and guestSlotId`);
        if (guestSlotId === hostSlotId) fail('ATTACHMENT_CYCLE', `attachment ${index} cannot join a slot to itself`);
        if (!slotIds.has(guestSlotId) || !slotIds.has(hostSlotId)) fail('MISSING_SLOT', `attachment ${index} references an unknown slot`);
        if (![hostFaceId, guestFaceId].every((id) => typeof id === 'string' && id.length > 0)) fail('INVALID_ATTACHMENTS', `attachment ${index} requires hostFaceId and guestFaceId`);
        const hostFaceKey = sourceKey(hostSlotId, hostFaceId);
        const guestFaceKey = sourceKey(guestSlotId, guestFaceId);
        if (usedFaces.has(hostFaceKey) || usedFaces.has(guestFaceKey)) fail('DUPLICATE_ATTACHMENT_FACE', `attachment ${index} reuses an attachment face`);
        usedFaces.add(hostFaceKey);
        usedFaces.add(guestFaceKey);
        // Encode the unordered slot pair as a JSON tuple. A delimiter-based
        // key would be ambiguous when a caller legitimately uses that
        // delimiter (or NUL) inside an identifier.
        const pairKey = JSON.stringify([guestSlotId, hostSlotId].sort(compareIds));
        if (pairKeys.has(pairKey)) fail('ATTACHMENT_CYCLE', `attachment ${index} duplicates a slot pair`);
        pairKeys.add(pairKey);
        neighbors.get(guestSlotId).add(hostSlotId);
        neighbors.get(hostSlotId).add(guestSlotId);
        return { guestSlotId, hostSlotId, hostFaceId, guestFaceId };
    });
    const parent = new Map(slots.map((slot) => [slot.slotId, slot.slotId]));
    const find = (id) => {
        let current = id;
        while (parent.get(current) !== current) {
            parent.set(current, parent.get(parent.get(current)));
            current = parent.get(current);
        }
        return current;
    };
    normalized.slice().sort((first, second) => (
        compareIds(first.hostSlotId, second.hostSlotId)
        || compareIds(first.guestSlotId, second.guestSlotId)
        || compareIds(first.hostFaceId, second.hostFaceId)
        || compareIds(first.guestFaceId, second.guestFaceId)
    )).forEach((attachment) => {
        const first = find(attachment.hostSlotId);
        const second = find(attachment.guestSlotId);
        if (first === second) fail('ATTACHMENT_CYCLE', 'attachment graph must be acyclic');
        parent.set(first, second);
    });
    if (attachments.length !== slots.length - 1) fail('ATTACHMENT_GRAPH', `a connected tree of ${slots.length} slots requires ${slots.length - 1} attachments`);
    const reached = new Set();
    const pending = [slots[0].slotId];
    while (pending.length > 0) {
        const current = pending.pop();
        if (reached.has(current)) continue;
        reached.add(current);
        neighbors.get(current).forEach((neighbor) => pending.push(neighbor));
    }
    if (reached.size !== slots.length) fail('DISCONNECTED_ATTACHMENTS', 'attachment graph must connect every slot');
    return normalized;
}

function faceLoopMapping(hostFace, guestFace, options) {
    if (hostFace.vertexIds.length !== guestFace.vertexIds.length) fail('FACE_VERTEX_COUNT_MISMATCH', `faces "${hostFace.id}" and "${guestFace.id}" have different vertex counts`);
    const count = hostFace.vertexIds.length;
    const scale = Math.max(hostFace.scale, guestFace.scale, MIN_VALUE);
    const pointTolerance = coordinateTolerance(scale, options.tolerance);
    const candidates = [];
    for (const sign of [1, -1]) {
        for (let shift = 0; shift < count; shift += 1) {
            const pairs = [];
            let maxPointDistance = 0;
            let sumPointDistanceSquared = 0;
            let maxEdgeDifference = 0;
            let sumEdgeDifference = 0;
            let valid = true;
            for (let index = 0; index < count; index += 1) {
                const guestIndex = (shift + sign * index + count * 2) % count;
                const hostPoint = hostFace.points[index];
                const guestPoint = guestFace.points[guestIndex];
                const pointDifference = pointDistance(hostPoint, guestPoint);
                maxPointDistance = Math.max(maxPointDistance, pointDifference);
                sumPointDistanceSquared += pointDifference ** 2;
                const nextIndex = (index + 1) % count;
                const guestNextIndex = (shift + sign * nextIndex + count * 2) % count;
                const hostLength = pointDistance(hostFace.points[index], hostFace.points[nextIndex]);
                const guestLength = pointDistance(guestFace.points[guestIndex], guestFace.points[guestNextIndex]);
                const difference = Math.abs(hostLength - guestLength);
                maxEdgeDifference = Math.max(maxEdgeDifference, difference);
                sumEdgeDifference += difference;
                pairs.push({ hostVertexId: hostFace.vertexIds[index], guestVertexId: guestFace.vertexIds[guestIndex] });
            }
            valid = maxPointDistance <= pointTolerance && maxEdgeDifference <= pointTolerance;
            if (valid) candidates.push({ sign, shift, pairs, maxPointDistance, sumPointDistanceSquared, maxEdgeDifference, sumEdgeDifference });
        }
    }
    candidates.sort((first, second) => (
        compareNumbers(first.maxPointDistance, second.maxPointDistance)
        || compareNumbers(first.sumPointDistanceSquared, second.sumPointDistanceSquared)
        || compareNumbers(first.maxEdgeDifference, second.maxEdgeDifference)
        || compareNumbers(first.sumEdgeDifference, second.sumEdgeDifference)
        || compareNumbers(first.sign === -1 ? 0 : 1, second.sign === -1 ? 0 : 1)
        || compareNumbers(first.shift, second.shift)
    ));
    const best = candidates[0];
    if (!best) fail('FACE_PERIMETER_MISMATCH', `faces "${hostFace.id}" and "${guestFace.id}" do not match as a full cyclic perimeter`);
    const areaDifference = Math.abs(hostFace.area - guestFace.area);
    if (areaDifference > areaTolerance(scale, options.tolerance)) {
        fail('FACE_AREA_MISMATCH', `faces "${hostFace.id}" and "${guestFace.id}" have different areas`, { hostArea: hostFace.area, guestArea: guestFace.area });
    }
    const normalDot = dot(hostFace.normal, guestFace.normal);
    if (normalDot > -1 + options.normalTolerance) fail('FACE_NORMAL_MISMATCH', `faces "${hostFace.id}" and "${guestFace.id}" normals must oppose`, { normalDot });
    return { ...best, normalDot, areaDifference, scale };
}

class UnionFind {
    constructor(values) {
        this.parent = new Map(values.map((value) => [value, value]));
        this.rank = new Map(values.map((value) => [value, 0]));
    }

    find(value) {
        const parent = this.parent.get(value);
        if (parent === undefined) return undefined;
        if (parent === value) return value;
        const root = this.find(parent);
        this.parent.set(value, root);
        return root;
    }

    union(first, second) {
        let firstRoot = this.find(first);
        let secondRoot = this.find(second);
        if (firstRoot === undefined || secondRoot === undefined) fail('MERGE_CONFLICT', 'attachment references an unknown source vertex');
        if (firstRoot === secondRoot) return;
        const firstRank = this.rank.get(firstRoot);
        const secondRank = this.rank.get(secondRoot);
        if (firstRank < secondRank || (firstRank === secondRank && compareIds(firstRoot, secondRoot) > 0)) [firstRoot, secondRoot] = [secondRoot, firstRoot];
        this.parent.set(secondRoot, firstRoot);
        if (firstRank === secondRank) this.rank.set(firstRoot, firstRank + 1);
    }
}

function sourceEdgeVectors(slotData) {
    return slotData.edges.map((edge) => vectorBetween(slotData.vertices.get(edge.vertexIds[0]), slotData.vertices.get(edge.vertexIds[1])));
}

function canonicalAxis(axis) {
    const unit = normalize(axis);
    if (!unit) return null;
    const values = [unit.x, unit.y, unit.z];
    const firstNonZero = values.find((value) => Math.abs(value) > 1e-14);
    return firstNonZero < 0 ? { x: -unit.x, y: -unit.y, z: -unit.z } : unit;
}

function uniqueAxes(first, second) {
    const axes = [];
    const append = (axis) => {
        const canonical = canonicalAxis(axis);
        if (!canonical) return;
        if (axes.some((existing) => Math.abs(dot(existing, canonical)) > 1 - 1e-12)) return;
        axes.push(canonical);
    };
    first.faces.forEach((face) => append(face.normal));
    second.faces.forEach((face) => append(face.normal));
    const firstEdges = sourceEdgeVectors(first);
    const secondEdges = sourceEdgeVectors(second);
    firstEdges.forEach((a) => secondEdges.forEach((b) => append(cross(a, b))));
    firstEdges.forEach((a, index) => firstEdges.slice(index + 1).forEach((b) => append(cross(a, b))));
    secondEdges.forEach((a, index) => secondEdges.slice(index + 1).forEach((b) => append(cross(a, b))));
    return axes;
}

function projectVertices(vertices, axis, origin = { x: 0, y: 0, z: 0 }) {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const point of vertices) {
        const value = dot(vectorBetween(origin, point), axis);
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
    }
    return { minimum, maximum };
}

function vertexScale(first, second) {
    return Math.max(scaleOfPoints([...first.vertices.values()]), scaleOfPoints([...second.vertices.values()]), MIN_VALUE);
}

function hasPositiveVolumeOverlap(first, second, options) {
    const projectionTolerance = coordinateTolerance(vertexScale(first, second), options.tolerance);
    let touchingAxis = false;
    const origin = first.vertices.values().next().value || { x: 0, y: 0, z: 0 };
    for (const axis of uniqueAxes(first, second)) {
        const firstProjection = projectVertices(first.vertices.values(), axis, origin);
        const secondProjection = projectVertices(second.vertices.values(), axis, origin);
        const overlap = Math.min(firstProjection.maximum, secondProjection.maximum) - Math.max(firstProjection.minimum, secondProjection.minimum);
        if (overlap < -projectionTolerance) return false;
        if (overlap <= projectionTolerance) touchingAxis = true;
    }
    return !touchingAxis;
}

function validateAttachmentsAndCollect(slots, attachments, options) {
    const byId = new Map(slots.map((slot) => [slot.slotId, slot]));
    const usedFaceKeys = new Set();
    return attachments.map((attachment) => {
        const host = byId.get(attachment.hostSlotId);
        const guest = byId.get(attachment.guestSlotId);
        const hostFace = host.faceById.get(attachment.hostFaceId);
        const guestFace = guest.faceById.get(attachment.guestFaceId);
        if (!hostFace || !guestFace) fail('MISSING_FACE', 'attachment references a face that does not exist', { attachment });
        const hostFaceKey = sourceKey(host.slotId, hostFace.id);
        const guestFaceKey = sourceKey(guest.slotId, guestFace.id);
        if (usedFaceKeys.has(hostFaceKey) || usedFaceKeys.has(guestFaceKey)) fail('DUPLICATE_ATTACHMENT_FACE', 'every attachment face may be used only once');
        usedFaceKeys.add(hostFaceKey);
        usedFaceKeys.add(guestFaceKey);
        const mapping = faceLoopMapping(hostFace, guestFace, options);
        return { ...attachment, host, guest, hostFace, guestFace, mapping };
    }).sort((first, second) => (
        compareIds(first.hostSlotId, second.hostSlotId)
        || compareIds(first.guestSlotId, second.guestSlotId)
        || compareIds(first.hostFaceId, second.hostFaceId)
        || compareIds(first.guestFaceId, second.guestFaceId)
    ));
}

function mergeVertices(slots, attachments, options) {
    const sourceKeys = [];
    const sourcePoints = new Map();
    const sourceSlots = new Map();
    const sourceScaleBySlot = new Map(slots.map((slot) => [slot.slotId, scaleOfPoints(Array.from(slot.vertices.values()))]));
    slots.forEach((slot) => slot.sortedVertices.forEach(([vertexId, point]) => {
        const key = sourceKey(slot.slotId, vertexId);
        sourceKeys.push(key);
        sourcePoints.set(key, point);
        sourceSlots.set(key, { slotId: slot.slotId, vertexId });
    }));
    sourceKeys.sort(compareIds);
    const unionFind = new UnionFind(sourceKeys);
    attachments.forEach((attachment) => attachment.mapping.pairs.forEach(({ hostVertexId, guestVertexId }) => {
        unionFind.union(sourceKey(attachment.hostSlotId, hostVertexId), sourceKey(attachment.guestSlotId, guestVertexId));
    }));
    const classes = new Map();
    sourceKeys.forEach((key) => {
        const root = unionFind.find(key);
        if (!classes.has(root)) classes.set(root, []);
        classes.get(root).push(key);
    });
    const keyToOutput = new Map();
    const outputVertices = [];
    const provenanceVertices = {};
    const usedOutputIds = new Map();
    Array.from(classes.values()).sort((first, second) => compareIds(first[0], second[0])).forEach((members) => {
        members.sort(compareIds);
        const bySlot = new Map();
        members.forEach((key) => {
            const source = sourceSlots.get(key);
            if (!bySlot.has(source.slotId)) bySlot.set(source.slotId, []);
            bySlot.get(source.slotId).push(source.vertexId);
        });
        for (const [slotId, vertexIds] of bySlot.entries()) {
            if (vertexIds.length > 1) fail('MERGE_CONFLICT', `attachment correspondences merge distinct vertices in slot "${slotId}"`, { vertexIds });
        }
        const points = members.map((key) => sourcePoints.get(key));
        // Scale the merge tolerance from the source solids, not from the
        // tiny discrepancy between already-matched points. Otherwise a
        // world-space transform can produce a 1e-15 residual whose local
        // scale is also 1e-15, causing a false MERGE_CONFLICT.
        const scale = Math.max(...members.map((key) => sourceScaleBySlot.get(sourceSlots.get(key).slotId) || MIN_VALUE), MIN_VALUE);
        let maximumDistance = 0;
        for (let first = 0; first < points.length; first += 1) {
            for (let second = first + 1; second < points.length; second += 1) maximumDistance = Math.max(maximumDistance, pointDistance(points[first], points[second]));
        }
        if (maximumDistance > coordinateTolerance(scale, options.tolerance)) fail('MERGE_CONFLICT', 'attachment vertex coordinates exceed tolerance', { members, maximumDistance });
        const representativeSource = sourceSlots.get(members[0]);
        const outputId = allocateNamespaceId(
            namespaceVertex(representativeSource.slotId, representativeSource.vertexId),
            members[0],
            usedOutputIds,
        );
        const outputPoint = addPoints(points);
        outputVertices.push({ id: outputId, position: outputPoint });
        const sources = members.map((key) => sourceSlots.get(key)).sort((first, second) => compareIds(first.slotId, second.slotId) || compareIds(first.vertexId, second.vertexId));
        provenanceVertices[outputId] = { sources, merged: sources.length > 1 };
        members.forEach((key) => keyToOutput.set(key, outputId));
    });
    outputVertices.sort((first, second) => compareIds(first.id, second.id));
    return { outputVertices, provenanceVertices, keyToOutput };
}

function buildExteriorFaces(slots, attachments, merged, options) {
    const internalFaceKeys = new Set();
    attachments.forEach((attachment) => {
        internalFaceKeys.add(sourceKey(attachment.hostSlotId, attachment.hostFaceId));
        internalFaceKeys.add(sourceKey(attachment.guestSlotId, attachment.guestFaceId));
    });
    const faces = [];
    const mergedMap = new Map(merged.outputVertices.map((vertex) => [vertex.id, vertex.position]));
    const usedFaceIds = new Map();
    slots.forEach((slot) => slot.faces.forEach((sourceFace) => {
        if (internalFaceKeys.has(sourceKey(slot.slotId, sourceFace.id))) return;
        const vertexIds = sourceFace.vertexIds.map((vertexId) => merged.keyToOutput.get(sourceKey(slot.slotId, vertexId)));
        if (vertexIds.some((id) => !id) || new Set(vertexIds).size !== vertexIds.length) fail('DEGENERATE_COMPOSITE_FACE', `face "${sourceFace.id}" collapsed after attachment vertex merging`);
        const outputFaceId = allocateNamespaceId(
            namespaceFace(slot.slotId, sourceFace.id),
            sourceKey(slot.slotId, sourceFace.id),
            usedFaceIds,
        );
        const geometry = faceGeometry({ id: outputFaceId, vertexIds, normal: sourceFace.normal, label: sourceFace.label, type: sourceFace.type }, mergedMap, options, `composite face "${outputFaceId}"`);
        const outputFace = {
            id: geometry.id,
            label: sourceFace.label,
            type: sourceFace.type,
            vertexIds: geometry.vertexIds,
            centroid: geometry.centroid,
            normal: geometry.normal,
            slotId: slot.slotId,
            sourceFaceId: sourceFace.id,
            sourceFaces: [{ slotId: slot.slotId, sourceFaceId: sourceFace.id }],
        };
        faces.push(outputFace);
    }));
    faces.sort((first, second) => compareIds(first.id, second.id));
    const mergedFaces = mergeCoplanarExteriorFaces(faces, mergedMap, options);
    const provenanceFaces = Object.fromEntries(mergedFaces.map((face) => {
        const sources = face.sourceFaces.slice().sort((first, second) => compareIds(first.slotId, second.slotId) || compareIds(first.sourceFaceId, second.sourceFaceId));
        return [face.id, {
            slotId: sources.length === 1 ? sources[0].slotId : null,
            sourceFaceId: sources.length === 1 ? sources[0].sourceFaceId : null,
            sources,
        }];
    }));
    return { faces: mergedFaces, provenanceFaces, internalFaceKeys };
}

function removeCollinearVertices(vertexIds, vertices, options) {
    let current = vertexIds.slice();
    let changed = true;
    while (changed && current.length > 3) {
        changed = false;
        for (let index = 0; index < current.length; index += 1) {
            const previous = vertices.get(current[(index + current.length - 1) % current.length]);
            const point = vertices.get(current[index]);
            const next = vertices.get(current[(index + 1) % current.length]);
            const first = vectorBetween(previous, point);
            const second = vectorBetween(point, next);
            const scale = Math.max(length(first), length(second), MIN_VALUE);
            if (length(cross(first, second)) <= coordinateTolerance(scale, options.tolerance) * scale
                && dot(first, second) > 0) {
                current.splice(index, 1);
                changed = true;
                break;
            }
        }
    }
    return current;
}

function faceOrientedPair(face, first, second) {
    for (let index = 0; index < face.vertexIds.length; index += 1) {
        const current = face.vertexIds[index];
        const next = face.vertexIds[(index + 1) % face.vertexIds.length];
        if (current === first && next === second) return [current, next];
    }
    return null;
}

function pathWithoutSharedEdge(face, pair) {
    const startIndex = face.vertexIds.findIndex((id, index) => (
        id === pair[0] && face.vertexIds[(index + 1) % face.vertexIds.length] === pair[1]
    ));
    if (startIndex < 0) return null;
    const path = [];
    let index = (startIndex + 1) % face.vertexIds.length;
    path.push(face.vertexIds[index]);
    while (index !== startIndex) {
        index = (index + 1) % face.vertexIds.length;
        path.push(face.vertexIds[index]);
    }
    return path;
}

function mergeCoplanarFacePair(first, second, sharedEdge, vertices, options) {
    const firstPair = faceOrientedPair(first, sharedEdge.vertexIds[0], sharedEdge.vertexIds[1])
        || faceOrientedPair(first, sharedEdge.vertexIds[1], sharedEdge.vertexIds[0]);
    const secondPair = faceOrientedPair(second, sharedEdge.vertexIds[0], sharedEdge.vertexIds[1])
        || faceOrientedPair(second, sharedEdge.vertexIds[1], sharedEdge.vertexIds[0]);
    if (!firstPair || !secondPair || firstPair[0] !== secondPair[1] || firstPair[1] !== secondPair[0]) {
        fail('NON_CONVEX_COPLANAR_UNION', `coplanar faces "${first.id}" and "${second.id}" do not share an oppositely oriented edge`);
    }
    const firstPath = pathWithoutSharedEdge(first, firstPair);
    const secondPath = pathWithoutSharedEdge(second, secondPair);
    if (!firstPath || !secondPath) fail('NON_CONVEX_COPLANAR_UNION', 'coplanar face union has no complete perimeter path');
    const unionIds = firstPath.concat(secondPath.slice(1, -1));
    const cleanedIds = removeCollinearVertices(unionIds, vertices, options);
    if (new Set(cleanedIds).size !== cleanedIds.length || cleanedIds.length < 3) fail('NON_CONVEX_COPLANAR_UNION', 'coplanar face union perimeter is degenerate');
    let geometry;
    try {
        geometry = faceGeometry({
            id: first.id,
            vertexIds: cleanedIds,
            normal: first.normal,
            label: first.label,
            type: first.type,
        }, vertices, options, `coplanar union "${first.id}"`);
    } catch (error) {
        if (error instanceof CompositeTopologyError && ['NON_CONVEX_FACE', 'NON_PLANAR_FACE', 'DEGENERATE_FACE', 'INVALID_FACE'].includes(error.code)) {
            fail('NON_CONVEX_COPLANAR_UNION', `coplanar face union "${first.id}"/"${second.id}" is not a simple convex perimeter`, { cause: error.code });
        }
        throw error;
    }
    const sourceFaces = first.sourceFaces.concat(second.sourceFaces).sort((a, b) => compareIds(a.slotId, b.slotId) || compareIds(a.sourceFaceId, b.sourceFaceId));
    return {
        id: first.id,
        label: [first, second].sort((a, b) => compareIds(a.id, b.id)).map((face) => face.label).join(' / '),
        type: first.type === second.type ? first.type : 'polygon',
        vertexIds: geometry.vertexIds,
        centroid: geometry.centroid,
        normal: geometry.normal,
        slotId: null,
        sourceFaceId: null,
        sourceFaces,
    };
}

function partialCoplanarEdgeOverlap(firstStart, firstEnd, secondStart, secondEnd, options) {
    const firstVector = vectorBetween(firstStart, firstEnd);
    const secondVector = vectorBetween(secondStart, secondEnd);
    const firstLength = length(firstVector);
    const secondLength = length(secondVector);
    const scale = Math.max(firstLength, secondLength, MIN_VALUE);
    if (length(cross(firstVector, secondVector)) > coordinateTolerance(scale, options.tolerance) * scale) return false;
    if (length(cross(firstVector, vectorBetween(firstStart, secondStart))) > coordinateTolerance(scale, options.tolerance) * scale) return false;
    const axis = normalize(firstVector);
    if (!axis) return false;
    const project = (point) => dot(vectorBetween(firstStart, point), axis);
    const firstInterval = [0, firstLength];
    const secondInterval = [project(secondStart), project(secondEnd)].sort((a, b) => a - b);
    const overlap = Math.min(firstInterval[1], secondInterval[1]) - Math.max(firstInterval[0], secondInterval[0]);
    return overlap > coordinateTolerance(scale, options.tolerance) && (
        pointDistance(firstStart, secondStart) > coordinateTolerance(scale, options.tolerance)
        || pointDistance(firstEnd, secondEnd) > coordinateTolerance(scale, options.tolerance)
    );
}

function rejectPartialCoplanarEdges(faces, vertices, options) {
    for (let firstIndex = 0; firstIndex < faces.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < faces.length; secondIndex += 1) {
            const firstFace = faces[firstIndex];
            const secondFace = faces[secondIndex];
            if (dot(firstFace.normal, secondFace.normal) <= 1 - options.normalTolerance) continue;
            for (let firstEdge = 0; firstEdge < firstFace.vertexIds.length; firstEdge += 1) {
                const firstStart = vertices.get(firstFace.vertexIds[firstEdge]);
                const firstEnd = vertices.get(firstFace.vertexIds[(firstEdge + 1) % firstFace.vertexIds.length]);
                for (let secondEdge = 0; secondEdge < secondFace.vertexIds.length; secondEdge += 1) {
                    const secondStart = vertices.get(secondFace.vertexIds[secondEdge]);
                    const secondEnd = vertices.get(secondFace.vertexIds[(secondEdge + 1) % secondFace.vertexIds.length]);
                    if (partialCoplanarEdgeOverlap(firstStart, firstEnd, secondStart, secondEnd, options)) {
                        fail('NON_CONVEX_COPLANAR_UNION', `coplanar faces "${firstFace.id}" and "${secondFace.id}" have a partial shared perimeter`);
                    }
                }
            }
        }
    }
}

function mergeCoplanarExteriorFaces(faces, vertices, options) {
    const result = faces.slice().sort((first, second) => compareIds(first.id, second.id));
    while (true) {
        const edgeMap = new Map();
        const tupleById = new Map();
        result.forEach((face) => {
            face.vertexIds.forEach((first, index) => {
                const second = face.vertexIds[(index + 1) % face.vertexIds.length];
                const id = edgeKey(first, second);
                const tuple = JSON.stringify([first, second].sort(compareIds));
                if (tupleById.has(id) && tupleById.get(id) !== tuple) fail('ID_COLLISION', `edge namespace is ambiguous for "${id}"`);
                tupleById.set(id, tuple);
                if (!edgeMap.has(id)) edgeMap.set(id, { id, vertexIds: [first, second].sort(compareIds), incidents: [] });
                edgeMap.get(id).incidents.push({ face, pair: [first, second] });
            });
        });
        const candidates = [];
        edgeMap.forEach((edge) => {
            if (edge.incidents.length !== 2) return;
            const [first, second] = edge.incidents;
            if (dot(first.face.normal, second.face.normal) > 1 - options.normalTolerance) {
                candidates.push({ edge, first: first.face, second: second.face });
            }
        });
        candidates.sort((a, b) => compareIds(a.edge.id, b.edge.id) || compareIds(a.first.id, b.first.id) || compareIds(a.second.id, b.second.id));
        const candidate = candidates[0];
        if (!candidate) break;
        const first = [candidate.first, candidate.second].sort((a, b) => compareIds(a.id, b.id))[0];
        const second = first === candidate.first ? candidate.second : candidate.first;
        const merged = mergeCoplanarFacePair(first, second, candidate.edge, vertices, options);
        const retained = result.filter((face) => face !== first && face !== second);
        retained.push(merged);
        retained.sort((a, b) => compareIds(a.id, b.id));
        result.splice(0, result.length, ...retained);
    }
    rejectPartialCoplanarEdges(result, vertices, options);
    return result.sort((first, second) => compareIds(first.id, second.id));
}

function buildExteriorEdges(faces) {
    const edgeMap = new Map();
    const tupleById = new Map();
    faces.forEach((face) => {
        for (let index = 0; index < face.vertexIds.length; index += 1) {
            const first = face.vertexIds[index];
            const second = face.vertexIds[(index + 1) % face.vertexIds.length];
            const id = edgeKey(first, second);
            const tuple = JSON.stringify([first, second].sort(compareIds));
            if (tupleById.has(id) && tupleById.get(id) !== tuple) fail('ID_COLLISION', `edge namespace is ambiguous for "${id}"`);
            tupleById.set(id, tuple);
            if (!edgeMap.has(id)) edgeMap.set(id, { id, vertexIds: [first, second].sort(compareIds), faceIds: [], orientations: [] });
            const edge = edgeMap.get(id);
            edge.faceIds.push(face.id);
            edge.orientations.push([first, second]);
        }
    });
    edgeMap.forEach((edge) => {
        if (edge.faceIds.length !== 2 || new Set(edge.faceIds).size !== 2) fail('NON_MANIFOLD_EDGE', `exterior edge "${edge.id}" must have exactly two incident faces`, { faceIds: edge.faceIds.slice() });
        const first = edge.orientations[0];
        const second = edge.orientations[1];
        if (first[0] === second[0] && first[1] === second[1]) fail('NON_ORIENTABLE_EDGE', `exterior edge "${edge.id}" has identically oriented incident faces`);
        edge.faceIds.sort(compareIds);
        delete edge.orientations;
    });
    return Array.from(edgeMap.values()).sort((first, second) => compareIds(first.id, second.id));
}

function buildSourceProvenance(slots) {
    const sourceVertices = {};
    const sourceFaces = {};
    slots.forEach((slot) => {
        slot.sortedVertices.forEach(([vertexId, position]) => {
            sourceVertices[sourceKey(slot.slotId, vertexId)] = {
                slotId: slot.slotId,
                vertexId,
                position: clonePoint(position),
            };
        });
        slot.faces.forEach((face) => {
            sourceFaces[sourceKey(slot.slotId, face.id)] = {
                slotId: slot.slotId,
                sourceFaceId: face.id,
                vertexIds: face.vertexIds.slice(),
                normal: clonePoint(face.normal),
                centroid: clonePoint(face.centroid),
                area: face.area,
            };
        });
    });
    return { sourceVertices, sourceFaces };
}

function buildAdjacency(vertices, faces, edges) {
    const adjacencySets = new Map(vertices.map((vertex) => [vertex.id, new Set()]));
    edges.forEach((edge) => {
        adjacencySets.get(edge.vertexIds[0])?.add(edge.vertexIds[1]);
        adjacencySets.get(edge.vertexIds[1])?.add(edge.vertexIds[0]);
    });
    const adjacency = Object.fromEntries(vertices.slice().sort((first, second) => compareIds(first.id, second.id)).map((vertex) => [vertex.id, Array.from(adjacencySets.get(vertex.id) || []).sort(compareIds)]));
    const faceAdjacencySets = new Map(faces.map((face) => [face.id, new Set()]));
    edges.forEach((edge) => {
        faceAdjacencySets.get(edge.faceIds[0])?.add(edge.faceIds[1]);
        faceAdjacencySets.get(edge.faceIds[1])?.add(edge.faceIds[0]);
    });
    const faceAdjacency = Object.fromEntries(faces.slice().sort((first, second) => compareIds(first.id, second.id)).map((face) => [face.id, Array.from(faceAdjacencySets.get(face.id) || []).sort(compareIds)]));
    return { adjacency, faceAdjacency };
}

function validateAdjacency(topology) {
    const vertexIds = topology.vertices.map((vertex) => vertex.id);
    const faceIds = topology.faces.map((face) => face.id);
    if (!isRecord(topology.adjacency) || Object.keys(topology.adjacency).length !== vertexIds.length) fail('INVALID_COMPOSITE_TOPOLOGY', 'adjacency must contain one entry per vertex');
    const vertexSet = new Set(vertexIds);
    const expectedVertexAdjacency = new Map(vertexIds.map((id) => [id, new Set()]));
    topology.edges.forEach((edge) => {
        if (Array.isArray(edge.vertexIds) && edge.vertexIds.length === 2) {
            expectedVertexAdjacency.get(edge.vertexIds[0])?.add(edge.vertexIds[1]);
            expectedVertexAdjacency.get(edge.vertexIds[1])?.add(edge.vertexIds[0]);
        }
    });
    vertexIds.forEach((id) => {
        const neighbors = topology.adjacency[id];
        if (!Array.isArray(neighbors) || new Set(neighbors).size !== neighbors.length || neighbors.some((neighbor) => !vertexSet.has(neighbor) || neighbor === id)) fail('INVALID_COMPOSITE_TOPOLOGY', `adjacency[${id}] is invalid`);
        if (JSON.stringify(neighbors.slice().sort(compareIds)) !== JSON.stringify(neighbors)) fail('INVALID_COMPOSITE_TOPOLOGY', `adjacency[${id}] must be sorted`);
        const expected = Array.from(expectedVertexAdjacency.get(id) || []).sort(compareIds);
        if (JSON.stringify(neighbors) !== JSON.stringify(expected)) fail('INVALID_COMPOSITE_TOPOLOGY', `adjacency[${id}] does not match exterior edges`);
    });
    if (!isRecord(topology.faceAdjacency) || Object.keys(topology.faceAdjacency).length !== faceIds.length) fail('INVALID_COMPOSITE_TOPOLOGY', 'faceAdjacency must contain one entry per face');
    const faceSet = new Set(faceIds);
    const expectedFaceAdjacency = new Map(faceIds.map((id) => [id, new Set()]));
    topology.edges.forEach((edge) => {
        if (Array.isArray(edge.faceIds) && edge.faceIds.length === 2) {
            expectedFaceAdjacency.get(edge.faceIds[0])?.add(edge.faceIds[1]);
            expectedFaceAdjacency.get(edge.faceIds[1])?.add(edge.faceIds[0]);
        }
    });
    faceIds.forEach((id) => {
        const neighbors = topology.faceAdjacency[id];
        if (!Array.isArray(neighbors) || new Set(neighbors).size !== neighbors.length || neighbors.some((neighbor) => !faceSet.has(neighbor) || neighbor === id)) fail('INVALID_COMPOSITE_TOPOLOGY', `faceAdjacency[${id}] is invalid`);
        if (JSON.stringify(neighbors.slice().sort(compareIds)) !== JSON.stringify(neighbors)) fail('INVALID_COMPOSITE_TOPOLOGY', `faceAdjacency[${id}] must be sorted`);
        const expected = Array.from(expectedFaceAdjacency.get(id) || []).sort(compareIds);
        if (JSON.stringify(neighbors) !== JSON.stringify(expected)) fail('INVALID_COMPOSITE_TOPOLOGY', `faceAdjacency[${id}] does not match exterior edges`);
    });
}

function validateCompositeMetadata(result, vertexIds, faceIds, edgeIds, options, outputVertexPositions) {
    if (!Array.isArray(result.slotIds) || (result.slotIds.length !== 2 && result.slotIds.length !== 3)) fail('INVALID_COMPOSITE_TOPOLOGY', 'slotIds must list two or three slots');
    const slotIds = result.slotIds;
    if (new Set(slotIds).size !== slotIds.length || slotIds.some((id) => typeof id !== 'string' || id.length === 0) || JSON.stringify(slotIds.slice().sort(compareIds)) !== JSON.stringify(slotIds)) fail('INVALID_COMPOSITE_TOPOLOGY', 'slotIds must be unique sorted non-empty strings');
    const provenance = result.provenance;
    if (!isRecord(provenance) || !isRecord(provenance.vertices) || !isRecord(provenance.faces)
        || !isRecord(provenance.edges) || !isRecord(provenance.sourceVertices) || !isRecord(provenance.sourceFaces)
        || !Array.isArray(provenance.attachments)) fail('INVALID_COMPOSITE_TOPOLOGY', 'result.provenance is incomplete');

    const sourceVertexIds = Object.keys(provenance.sourceVertices).sort(compareIds);
    const sourceVertexEntries = new Map();
    sourceVertexIds.forEach((id) => {
        const entry = provenance.sourceVertices[id];
        if (!isRecord(entry) || typeof entry.slotId !== 'string' || typeof entry.vertexId !== 'string'
            || !slotIds.includes(entry.slotId) || sourceKey(entry.slotId, entry.vertexId) !== id
            || !isRecord(entry.position) || !finiteNumber(entry.position.x) || !finiteNumber(entry.position.y) || !finiteNumber(entry.position.z)) {
            fail('INVALID_COMPOSITE_TOPOLOGY', `source vertex provenance for "${id}" is invalid`);
        }
        sourceVertexEntries.set(id, entry);
    });

    const sourceFaceIds = Object.keys(provenance.sourceFaces).sort(compareIds);
    const sourceFaceEntries = new Map();
    sourceFaceIds.forEach((id) => {
        const entry = provenance.sourceFaces[id];
        const normal = isRecord(entry?.normal) && finiteNumber(entry.normal.x) && finiteNumber(entry.normal.y) && finiteNumber(entry.normal.z)
            ? normalize(entry.normal)
            : null;
        if (!isRecord(entry) || typeof entry.slotId !== 'string' || typeof entry.sourceFaceId !== 'string'
            || !slotIds.includes(entry.slotId) || sourceKey(entry.slotId, entry.sourceFaceId) !== id
            || !Array.isArray(entry.vertexIds) || entry.vertexIds.length < 3 || new Set(entry.vertexIds).size !== entry.vertexIds.length
            || entry.vertexIds.some((vertexId) => typeof vertexId !== 'string' || !sourceVertexEntries.has(sourceKey(entry.slotId, vertexId)))
            || !normal || Math.abs(length(normal) - 1) > options.normalTolerance
            || !finiteNumber(entry.area) || entry.area <= 0
            || !isRecord(entry.centroid) || !finiteNumber(entry.centroid.x) || !finiteNumber(entry.centroid.y) || !finiteNumber(entry.centroid.z)) {
            fail('INVALID_COMPOSITE_TOPOLOGY', `source face provenance for "${id}" is invalid`);
        }
        let geometry;
        try {
            geometry = faceGeometry(
                { id: entry.sourceFaceId, vertexIds: entry.vertexIds, normal: entry.normal },
                new Map(entry.vertexIds.map((vertexId) => [vertexId, sourceVertexEntries.get(sourceKey(entry.slotId, vertexId)).position])),
                options,
                `source face provenance "${id}"`,
            );
        } catch (error) {
            if (error instanceof CompositeTopologyError) fail('INVALID_COMPOSITE_TOPOLOGY', `source face provenance for "${id}" is not valid geometry`, { cause: error.code });
            throw error;
        }
        if (Math.abs(geometry.area - entry.area) > areaTolerance(geometry.scale, options.tolerance)
            || pointDistance(geometry.centroid, entry.centroid) > coordinateTolerance(geometry.scale, options.tolerance)
            || dot(geometry.normal, normal) < 1 - options.normalTolerance) {
            fail('INVALID_COMPOSITE_TOPOLOGY', `source face provenance for "${id}" does not match its derived geometry`);
        }
        sourceFaceEntries.set(id, entry);
    });
    const sourceVerticesFromFaces = new Set(sourceFaceIds.flatMap((id) => {
        const entry = sourceFaceEntries.get(id);
        return entry.vertexIds.map((vertexId) => sourceKey(entry.slotId, vertexId));
    }));
    if (JSON.stringify(sourceVertexIds) !== JSON.stringify(Array.from(sourceVerticesFromFaces).sort(compareIds))) {
        fail('INVALID_COMPOSITE_TOPOLOGY', 'source vertex provenance must exactly match source face loops');
    }
    const sourceScaleBySlot = new Map(slotIds.map((slotId) => [slotId, scaleOfPoints(sourceVertexIds
        .map((id) => sourceVertexEntries.get(id))
        .filter((entry) => entry.slotId === slotId)
        .map((entry) => entry.position))]));

    const provenanceVertexIds = Object.keys(provenance.vertices).sort(compareIds);
    const exteriorVertexIds = vertexIds.slice().sort(compareIds);
    if (exteriorVertexIds.some((id) => !provenanceVertexIds.includes(id))) fail('INVALID_COMPOSITE_TOPOLOGY', 'vertex provenance is missing an output vertex');
    const outputSourceKeys = new Set();
    provenanceVertexIds.forEach((id) => {
        const entry = provenance.vertices[id];
        if (!isRecord(entry) || !Array.isArray(entry.sources) || entry.sources.length < 1 || typeof entry.merged !== 'boolean' || entry.merged !== (entry.sources.length > 1)) fail('INVALID_COMPOSITE_TOPOLOGY', `vertex provenance for "${id}" is invalid`);
        const sortedSources = entry.sources.slice().sort((a, b) => compareIds(a?.slotId, b?.slotId) || compareIds(a?.vertexId, b?.vertexId));
        if (JSON.stringify(sortedSources) !== JSON.stringify(entry.sources) || new Set(entry.sources.map((source) => sourceKey(source?.slotId, source?.vertexId))).size !== entry.sources.length) fail('INVALID_COMPOSITE_TOPOLOGY', `vertex provenance for "${id}" must be sorted and unique`);
        entry.sources.forEach((source) => {
            const sourceId = isRecord(source) && typeof source.slotId === 'string' && typeof source.vertexId === 'string'
                ? sourceKey(source.slotId, source.vertexId)
                : null;
            if (!sourceId || !slotIds.includes(source.slotId) || !sourceVertexEntries.has(sourceId)) fail('INVALID_COMPOSITE_TOPOLOGY', `vertex provenance for "${id}" references an unknown source`);
            outputSourceKeys.add(sourceId);
        });
        const outputPoint = outputVertexPositions.get(id);
        if (outputPoint) {
            const sourcePoints = entry.sources.map((source) => sourceVertexEntries.get(sourceKey(source.slotId, source.vertexId)).position);
            const sourceScale = Math.max(...entry.sources.map((source) => sourceScaleBySlot.get(source.slotId) || MIN_VALUE), MIN_VALUE);
            if (sourcePoints.some((sourcePoint) => pointDistance(outputPoint, sourcePoint) > coordinateTolerance(sourceScale, options.tolerance))) {
                fail('INVALID_COMPOSITE_TOPOLOGY', `vertex provenance for "${id}" is not anchored to its output position`);
            }
        }
    });
    if (JSON.stringify(Array.from(outputSourceKeys).sort(compareIds)) !== JSON.stringify(sourceVertexIds)) fail('INVALID_COMPOSITE_TOPOLOGY', 'vertex provenance must cover every source vertex exactly');

    const coveredSourceFaces = new Set();
    const provenanceFaceIds = Object.keys(provenance.faces).sort(compareIds);
    if (JSON.stringify(provenanceFaceIds) !== JSON.stringify(faceIds.slice().sort(compareIds))) fail('INVALID_COMPOSITE_TOPOLOGY', 'face provenance keys do not match faces');
    result.faces.forEach((face) => {
        if (!slotIds.includes(face.slotId) && face.slotId !== null) fail('INVALID_COMPOSITE_TOPOLOGY', `face "${face.id}" has an unknown slotId`);
        if (face.slotId !== null && (typeof face.sourceFaceId !== 'string' || face.sourceFaceId.length === 0)) fail('INVALID_COMPOSITE_TOPOLOGY', `face "${face.id}" has an invalid sourceFaceId`);
        const entry = provenance.faces[face.id];
        if (!isRecord(entry) || !Array.isArray(entry.sources) || entry.sources.length < 1) fail('INVALID_COMPOSITE_TOPOLOGY', `face provenance for "${face.id}" is invalid`);
        if (entry.slotId !== face.slotId || entry.sourceFaceId !== face.sourceFaceId) fail('INVALID_COMPOSITE_TOPOLOGY', `face provenance for "${face.id}" does not match the face`);
        const sortedSources = entry.sources.slice().sort((a, b) => compareIds(a?.slotId, b?.slotId) || compareIds(a?.sourceFaceId, b?.sourceFaceId));
        if (JSON.stringify(sortedSources) !== JSON.stringify(entry.sources) || new Set(entry.sources.map((source) => sourceKey(source?.slotId, source?.sourceFaceId))).size !== entry.sources.length) fail('INVALID_COMPOSITE_TOPOLOGY', `face provenance for "${face.id}" must be sorted and unique`);
        entry.sources.forEach((source) => {
            const sourceId = isRecord(source) && typeof source.slotId === 'string' && typeof source.sourceFaceId === 'string'
                ? sourceKey(source.slotId, source.sourceFaceId)
                : null;
            if (!sourceId || !slotIds.includes(source.slotId) || !sourceFaceEntries.has(sourceId)) fail('INVALID_COMPOSITE_TOPOLOGY', `face provenance for "${face.id}" references an unknown source`);
            coveredSourceFaces.add(sourceId);
        });
    });

    const provenanceEdgeIds = Object.keys(provenance.edges).sort(compareIds);
    if (JSON.stringify(provenanceEdgeIds) !== JSON.stringify(edgeIds.slice().sort(compareIds))) fail('INVALID_COMPOSITE_TOPOLOGY', 'edge provenance keys do not match edges');
    result.edges.forEach((edge) => {
        const entry = provenance.edges[edge.id];
        if (!isRecord(entry) || !Array.isArray(entry.faceIds) || !Array.isArray(entry.vertexIds)
            || JSON.stringify(entry.faceIds) !== JSON.stringify(edge.faceIds)
            || JSON.stringify(entry.vertexIds) !== JSON.stringify(edge.vertexIds)) fail('INVALID_COMPOSITE_TOPOLOGY', `edge provenance for "${edge.id}" does not match the edge`);
    });

    if (provenance.attachments.length !== slotIds.length - 1) fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance count does not match slotIds');
    try {
        validateAttachmentGraph(provenance.attachments, slotIds.map((slotId) => ({ slotId })));
    } catch (error) {
        if (error instanceof CompositeTopologyError) fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance graph is invalid', { cause: error.code });
        throw error;
    }
    const usedAttachmentFaces = new Set();
    const attachmentVertexIds = new Set();
    provenance.attachments.forEach((attachment) => {
        if (!isRecord(attachment) || !slotIds.includes(attachment.hostSlotId) || !slotIds.includes(attachment.guestSlotId)
            || attachment.hostSlotId === attachment.guestSlotId || typeof attachment.hostFaceId !== 'string' || attachment.hostFaceId.length === 0
            || typeof attachment.guestFaceId !== 'string' || attachment.guestFaceId.length === 0 || !Array.isArray(attachment.vertexPairs)
            || !finiteNumber(attachment.normalDot) || attachment.normalDot < -1 - options.normalTolerance || attachment.normalDot > -1 + options.normalTolerance) {
            fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance is invalid');
        }
        const hostKey = sourceKey(attachment.hostSlotId, attachment.hostFaceId);
        const guestKey = sourceKey(attachment.guestSlotId, attachment.guestFaceId);
        const hostFace = sourceFaceEntries.get(hostKey);
        const guestFace = sourceFaceEntries.get(guestKey);
        if (!hostFace || !guestFace) fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance references an unknown source face');
        if (usedAttachmentFaces.has(hostKey) || usedAttachmentFaces.has(guestKey)) fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance reuses a face');
        usedAttachmentFaces.add(hostKey);
        usedAttachmentFaces.add(guestKey);
        const expectedNormalDot = dot(hostFace.normal, guestFace.normal);
        if (!finiteNumber(expectedNormalDot) || Math.abs(expectedNormalDot - attachment.normalDot) > options.normalTolerance
            || expectedNormalDot > -1 + options.normalTolerance) fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance normals are not opposing');
        if (hostFace.vertexIds.length !== guestFace.vertexIds.length || attachment.vertexPairs.length !== hostFace.vertexIds.length) fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance vertex pair count does not match source faces');
        const hostPairIds = new Set();
        const guestPairIds = new Set();
        const pairOutputIds = new Set();
        attachment.vertexPairs.forEach((pair) => {
            if (!isRecord(pair) || typeof pair.hostVertexId !== 'string' || typeof pair.guestVertexId !== 'string' || typeof pair.outputVertexId !== 'string') fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance has an invalid vertex pair');
            const hostVertexKey = sourceKey(attachment.hostSlotId, pair.hostVertexId);
            const guestVertexKey = sourceKey(attachment.guestSlotId, pair.guestVertexId);
            if (!sourceVertexEntries.has(hostVertexKey) || !sourceVertexEntries.has(guestVertexKey)
                || !hostFace.vertexIds.includes(pair.hostVertexId) || !guestFace.vertexIds.includes(pair.guestVertexId)) fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance references a vertex outside its source face');
            if (!Object.prototype.hasOwnProperty.call(provenance.vertices, pair.outputVertexId)) fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance references an unknown output vertex class');
            const outputEntry = provenance.vertices[pair.outputVertexId];
            const hasHost = outputEntry.sources.some((source) => source.slotId === attachment.hostSlotId && source.vertexId === pair.hostVertexId);
            const hasGuest = outputEntry.sources.some((source) => source.slotId === attachment.guestSlotId && source.vertexId === pair.guestVertexId);
            if (!hasHost || !hasGuest) fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance output vertex class does not contain both source vertices');
            const hostPoint = sourceVertexEntries.get(hostVertexKey).position;
            const guestPoint = sourceVertexEntries.get(guestVertexKey).position;
            const joinScale = Math.max(sourceScaleBySlot.get(attachment.hostSlotId) || MIN_VALUE, sourceScaleBySlot.get(attachment.guestSlotId) || MIN_VALUE);
            if (pointDistance(hostPoint, guestPoint) > coordinateTolerance(joinScale, options.tolerance)) {
                fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance source vertices are not coincident');
            }
            const outputPoint = outputVertexPositions.get(pair.outputVertexId);
            const outputScale = Math.max(sourceScaleBySlot.get(attachment.hostSlotId) || MIN_VALUE, sourceScaleBySlot.get(attachment.guestSlotId) || MIN_VALUE);
            if (outputPoint && (pointDistance(outputPoint, hostPoint) > coordinateTolerance(outputScale, options.tolerance)
                || pointDistance(outputPoint, guestPoint) > coordinateTolerance(outputScale, options.tolerance))) {
                fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance output vertex is not anchored to its source positions');
            }
            hostPairIds.add(pair.hostVertexId);
            guestPairIds.add(pair.guestVertexId);
            pairOutputIds.add(pair.outputVertexId);
            attachmentVertexIds.add(pair.outputVertexId);
        });
        if (hostPairIds.size !== hostFace.vertexIds.length || guestPairIds.size !== guestFace.vertexIds.length
            || hostFace.vertexIds.some((id) => !hostPairIds.has(id)) || guestFace.vertexIds.some((id) => !guestPairIds.has(id))
            || pairOutputIds.size !== attachment.vertexPairs.length) fail('INVALID_COMPOSITE_TOPOLOGY', 'attachment provenance does not cover each source-face vertex exactly once');
    });
    const requiredVertexIds = new Set([...vertexIds, ...attachmentVertexIds]);
    if (JSON.stringify(provenanceVertexIds) !== JSON.stringify(Array.from(requiredVertexIds).sort(compareIds))) fail('INVALID_COMPOSITE_TOPOLOGY', 'vertex provenance keys contain an arbitrary or unreferenced class');
    if (Array.from(usedAttachmentFaces).some((id) => coveredSourceFaces.has(id))
        || JSON.stringify(Array.from(new Set([...coveredSourceFaces, ...usedAttachmentFaces])).sort(compareIds)) !== JSON.stringify(sourceFaceIds)) {
        fail('INVALID_COMPOSITE_TOPOLOGY', 'source face provenance must partition exterior and attachment faces');
    }
    if (!isRecord(result.diagnostics) || result.diagnostics.slotCount !== slotIds.length || result.diagnostics.attachmentCount !== provenance.attachments.length
        || result.diagnostics.exteriorFaceCount !== faceIds.length || result.diagnostics.exteriorEdgeCount !== edgeIds.length
        || !Number.isInteger(result.diagnostics.mergedVertexCount) || result.diagnostics.mergedVertexCount < 0
        || result.diagnostics.mergedVertexCount !== provenanceVertexIds.filter((id) => provenance.vertices[id].merged).length
        || result.diagnostics.internalFaceCount !== usedAttachmentFaces.size
        || !finiteNumber(result.diagnostics.tolerance) || result.diagnostics.tolerance < 0 || !Array.isArray(result.diagnostics.overlapChecks)) fail('INVALID_COMPOSITE_TOPOLOGY', 'diagnostics are incomplete');
    const expectedOverlapCount = slotIds.length * (slotIds.length - 1) / 2;
    const overlapKeys = new Set();
    if (result.diagnostics.overlapChecks.length !== expectedOverlapCount || result.diagnostics.overlapChecks.some((check) => {
        if (!isRecord(check) || !Array.isArray(check.slotIds) || check.slotIds.length !== 2 || check.slotIds.some((id) => !slotIds.includes(id)) || check.positiveVolumeOverlap !== false) return true;
        const sortedIds = check.slotIds.slice().sort(compareIds);
        if (JSON.stringify(sortedIds) !== JSON.stringify(check.slotIds)) return true;
        const key = JSON.stringify(sortedIds);
        if (overlapKeys.has(key)) return true;
        overlapKeys.add(key);
        return false;
    }) || overlapKeys.size !== expectedOverlapCount) fail('INVALID_COMPOSITE_TOPOLOGY', 'diagnostics overlap checks are invalid');
}

/** Validate an already-built composite without a global-centroid rule. */
export function validateCompositeExteriorTopology(result, options = {}) {
    const normalized = normalizeOptions(options);
    if (!isRecord(result) || result.primitiveKey !== 'composite') fail('INVALID_COMPOSITE_TOPOLOGY', 'result.primitiveKey must be "composite"');
    if (!Array.isArray(result.vertices) || !Array.isArray(result.faces) || !Array.isArray(result.edges)) fail('INVALID_COMPOSITE_TOPOLOGY', 'result must contain vertices, faces, and edges arrays');
    const vertices = new Map();
    result.vertices.forEach((vertex) => {
        if (!isRecord(vertex) || typeof vertex.id !== 'string' || vertex.id.length === 0 || vertices.has(vertex.id)) fail('INVALID_COMPOSITE_TOPOLOGY', 'vertices must have unique non-empty IDs');
        vertices.set(vertex.id, readPoint(vertex, `vertex "${vertex.id}"`));
    });
    const faces = [];
    const faceIds = new Set();
    result.faces.forEach((face) => {
        if (faceIds.has(face?.id)) fail('INVALID_COMPOSITE_TOPOLOGY', `duplicate face "${face.id}"`);
        const geometry = faceGeometry(face, vertices, normalized, `face "${face?.id}"`);
        faceIds.add(geometry.id);
        if (!isRecord(face.centroid) || !finiteNumber(face.centroid.x) || !finiteNumber(face.centroid.y) || !finiteNumber(face.centroid.z) || pointDistance(face.centroid, geometry.centroid) > coordinateTolerance(geometry.scale, normalized.tolerance)) fail('INVALID_COMPOSITE_TOPOLOGY', `face "${face.id}" centroid does not match its vertices`);
        const suppliedNormal = isRecord(face.normal) && finiteNumber(face.normal.x) && finiteNumber(face.normal.y) && finiteNumber(face.normal.z)
            ? normalize(face.normal)
            : null;
        if (!suppliedNormal || dot(suppliedNormal, geometry.normal) < 1 - normalized.normalTolerance) fail('INVALID_COMPOSITE_TOPOLOGY', `face "${face.id}" normal does not match its winding`);
        faces.push(geometry);
    });
    const expected = expectedEdgeMap(faces);
    assertOppositeIncidence(expected);
    if (result.edges.length !== expected.size) fail('INVALID_COMPOSITE_TOPOLOGY', 'edges must be the unique face-loop edges');
    const edgeIds = result.edges.map((edge) => edge?.id);
    const seenEdges = new Set();
    result.edges.forEach((edge) => {
        if (!isRecord(edge) || typeof edge.id !== 'string' || !Array.isArray(edge.vertexIds) || edge.vertexIds.length !== 2 || !Array.isArray(edge.faceIds)) fail('INVALID_COMPOSITE_TOPOLOGY', 'each edge must contain id, vertexIds, and faceIds');
        if (seenEdges.has(edge.id) || edge.id !== edgeKey(edge.vertexIds[0], edge.vertexIds[1]) || JSON.stringify(edge.vertexIds.slice().sort(compareIds)) !== JSON.stringify(edge.vertexIds)) fail('INVALID_COMPOSITE_TOPOLOGY', `edge "${edge.id}" has a non-canonical ID`);
        seenEdges.add(edge.id);
        const expectedEdge = expected.get(edge.id);
        if (!expectedEdge || JSON.stringify(edge.faceIds.slice().sort(compareIds)) !== JSON.stringify(expectedEdge.faceIds)) fail('INVALID_COMPOSITE_TOPOLOGY', `edge "${edge.id}" face incidence does not match its loops`);
        if (edge.faceIds.length !== 2 || new Set(edge.faceIds).size !== 2) fail('NON_MANIFOLD_EDGE', `edge "${edge.id}" must have exactly two incident faces`);
    });
    validateAdjacency(result);
    const resultVertexIds = result.vertices.map((vertex) => vertex.id);
    const resultFaceIds = result.faces.map((face) => face.id);
    validateCompositeMetadata(result, resultVertexIds, resultFaceIds, edgeIds, normalized, vertices);
    return true;
}

/** Build a deeply frozen, JSON-friendly exterior topology for a two- or three-slot tree. */
export function buildCompositeExteriorTopology(input = {}, options = {}) {
    if (!isRecord(input)) fail('INVALID_INPUT', 'buildCompositeExteriorTopology expects an input object');
    const normalizedOptions = normalizeOptions(options);
    const rawSlots = normalizeSlots(input.slots);
    const rawAttachments = validateAttachmentGraph(input.attachments, rawSlots);
    const slots = rawSlots.map((slot) => validateSourceTopology(slot, normalizedOptions));
    const attachments = validateAttachmentsAndCollect(slots, rawAttachments, normalizedOptions);

    // Run SAT after complete face joins have been checked, so a malformed join
    // reports its face mismatch before a secondary collision diagnostic.
    const overlapChecks = [];
    for (let first = 0; first < slots.length; first += 1) {
        for (let second = first + 1; second < slots.length; second += 1) {
            const positiveVolumeOverlap = hasPositiveVolumeOverlap(slots[first], slots[second], normalizedOptions);
            overlapChecks.push({ slotIds: [slots[first].slotId, slots[second].slotId], positiveVolumeOverlap });
            if (positiveVolumeOverlap) fail('POSITIVE_VOLUME_OVERLAP', `slots "${slots[first].slotId}" and "${slots[second].slotId}" overlap with positive volume`, { slotIds: [slots[first].slotId, slots[second].slotId] });
        }
    }

    const merged = mergeVertices(slots, attachments, normalizedOptions);
    const exterior = buildExteriorFaces(slots, attachments, merged, normalizedOptions);
    const sourceProvenance = buildSourceProvenance(slots);
    const usedVertexIds = new Set(exterior.faces.flatMap((face) => face.vertexIds));
    const outputVertices = merged.outputVertices.filter((vertex) => usedVertexIds.has(vertex.id));
    const edges = buildExteriorEdges(exterior.faces);
    const adjacency = buildAdjacency(outputVertices, exterior.faces, edges);
    const provenanceEdges = Object.fromEntries(edges.map((edge) => [edge.id, { faceIds: edge.faceIds.slice(), vertexIds: edge.vertexIds.slice() }]));
    const output = {
        primitiveKey: 'composite',
        slotIds: slots.map((slot) => slot.slotId),
        vertices: outputVertices,
        faces: exterior.faces,
        edges,
        adjacency: adjacency.adjacency,
        faceAdjacency: adjacency.faceAdjacency,
        provenance: {
            vertices: merged.provenanceVertices,
            faces: exterior.provenanceFaces,
            edges: provenanceEdges,
            sourceVertices: sourceProvenance.sourceVertices,
            sourceFaces: sourceProvenance.sourceFaces,
            attachments: attachments.map((attachment) => ({
                hostSlotId: attachment.hostSlotId,
                guestSlotId: attachment.guestSlotId,
                hostFaceId: attachment.hostFaceId,
                guestFaceId: attachment.guestFaceId,
                normalDot: attachment.mapping.normalDot,
                vertexPairs: attachment.mapping.pairs.map((pair) => ({
                    hostVertexId: pair.hostVertexId,
                    guestVertexId: pair.guestVertexId,
                    outputVertexId: merged.keyToOutput.get(sourceKey(attachment.hostSlotId, pair.hostVertexId)),
                })),
            })),
        },
        diagnostics: {
            tolerance: normalizedOptions.tolerance,
            slotCount: slots.length,
            attachmentCount: attachments.length,
            mergedVertexCount: Object.values(merged.provenanceVertices).filter((entry) => entry.merged).length,
            internalFaceCount: exterior.internalFaceKeys.size,
            exteriorFaceCount: exterior.faces.length,
            exteriorEdgeCount: edges.length,
            overlapChecks,
        },
    };
    validateCompositeExteriorTopology(output, normalizedOptions);
    return deepFreeze(output);
}




function fail(code, message, details = undefined) {
    throw new CompositeTopologyError(code, message, details);
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

function compareNumbers(first, second) {
    return first < second ? -1 : (first > second ? 1 : 0);
}

function cleanNumber(value) {
    return Object.is(value, -0) ? 0 : value;
}

function clonePoint(point) {
    return { x: cleanNumber(point.x), y: cleanNumber(point.y), z: cleanNumber(point.z) };
}

function pointDistance(first, second) {
    return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
}

function vectorBetween(first, second) {
    return {
        x: second.x - first.x,
        y: second.y - first.y,
        z: second.z - first.z,
    };
}

function dot(first, second) {
    return first.x * second.x + first.y * second.y + first.z * second.z;
}

function cross(first, second) {
    return {
        x: first.y * second.z - first.z * second.y,
        y: first.z * second.x - first.x * second.z,
        z: first.x * second.y - first.y * second.x,
    };
}

function length(vector) {
    return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector) {
    const magnitude = length(vector);
    if (!finiteNumber(magnitude) || magnitude <= MACHINE_EPSILON * MIN_VALUE) return null;
    return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

function addPoints(points) {
    const result = { x: 0, y: 0, z: 0 };
    points.forEach((point) => {
        result.x += point.x;
        result.y += point.y;
        result.z += point.z;
    });
    result.x /= points.length;
    result.y /= points.length;
    result.z /= points.length;
    return result;
}

function newellNormal(points) {
    const normal = { x: 0, y: 0, z: 0 };
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        normal.x += (current.y - next.y) * (current.z + next.z);
        normal.y += (current.z - next.z) * (current.x + next.x);
        normal.z += (current.x - next.x) * (current.y + next.y);
    }
    return normal;
}

function polygonArea3(points) {
    return length(newellNormal(points)) / 2;
}

function scaleOfPoints(points) {
    let scale = 0;
    for (let first = 0; first < points.length; first += 1) {
        for (let second = first + 1; second < points.length; second += 1) {
            scale = Math.max(scale, pointDistance(points[first], points[second]));
        }
    }
    return Math.max(scale, MIN_VALUE);
}

function coordinateTolerance(scale, relativeTolerance) {
    const safeScale = Math.max(scale, MIN_VALUE);
    return Math.max(MACHINE_EPSILON * safeScale, relativeTolerance * safeScale);
}

function areaTolerance(scale, relativeTolerance) {
    const safeScale = Math.max(scale, MIN_VALUE);
    return Math.max(MACHINE_EPSILON * safeScale * safeScale, relativeTolerance * safeScale * safeScale);
}

function normalTolerance(relativeTolerance) {
    return Math.max(1e-8, relativeTolerance * 10);
}

function edgeKey(firstId, secondId) {
    const ordered = [firstId, secondId].sort(compareIds);
    return `${ordered[0]}-${ordered[1]}`;
}

function sourceKey(slotId, vertexId) {
    // JSON tuple encoding is injective for arbitrary JavaScript strings,
    // including strings containing NULs and quote/backslash characters.
    return JSON.stringify([String(slotId), String(vertexId)]);
}

function namespaceVertex(slotId, vertexId) {
    return `s${slotId}_${vertexId}`;
}

function namespaceFace(slotId, faceId) {
    return `s${slotId}_${faceId}`;
}

function encodeIdentifier(value) {
    // Fixed-width code points keep collision suffixes injective as well (a
    // variable-width hexadecimal concatenation can otherwise be ambiguous).
    return Array.from(String(value)).map((character) => character.codePointAt(0).toString(16).padStart(6, '0')).join('');
}

function allocateNamespaceId(base, source, used) {
    let candidate = base;
    if (used.has(candidate) && used.get(candidate) !== source) {
        candidate = `${base}__${encodeIdentifier(source)}`;
        let suffix = 2;
        while (used.has(candidate) && used.get(candidate) !== source) {
            candidate = `${base}__${encodeIdentifier(source)}_${suffix}`;
            suffix += 1;
        }
    }
    used.set(candidate, source);
    return candidate;
}

function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    Object.values(value).forEach((child) => deepFreeze(child, seen));
    return Object.freeze(value);
}

function normalizeOptions(options = {}) {
    if (!isRecord(options)) fail('INVALID_OPTIONS', 'options must be a plain object');
    const candidate = options.tolerance ?? options.epsilon;
    if (candidate !== undefined && (!finiteNumber(candidate) || candidate < 0)) {
        fail('INVALID_OPTIONS', 'tolerance must be a finite non-negative number');
    }
    const tolerance = candidate === undefined ? DEFAULT_TOLERANCE : candidate;
    return {
        tolerance,
        normalTolerance: finiteNumber(options.normalTolerance) && options.normalTolerance >= 0
            ? options.normalTolerance
            : normalTolerance(tolerance),
    };
}

function readPoint(vertex, label) {
    const point = isRecord(vertex?.position) ? vertex.position : vertex;
    if (!isRecord(point) || !finiteNumber(point.x) || !finiteNumber(point.y) || !finiteNumber(point.z)) {
        fail('INVALID_SLOT_TOPOLOGY', `${label} must have finite x, y, and z coordinates`);
    }
    return clonePoint(point);
}

function readNormal(face, fallback) {
    const candidate = isRecord(face?.normal) ? face.normal : fallback;
    if (!isRecord(candidate) || !finiteNumber(candidate.x) || !finiteNumber(candidate.y) || !finiteNumber(candidate.z)) return fallback;
    const result = normalize(candidate);
    if (!result) fail('INVALID_FACE_NORMAL', `face "${face.id}" has a zero-length normal`);
    return result;
}

function facePlaneBasis(points, normal) {
    let axis = normalize(vectorBetween(points[0], points[1]));
    if (!axis) fail('DEGENERATE_FACE', 'face has a zero-length perimeter edge');
    let perpendicular = normalize(cross(normal, axis));
    if (!perpendicular) {
        axis = normalize(vectorBetween(points[0], points[2]));
        perpendicular = axis ? normalize(cross(normal, axis)) : null;
    }
    if (!axis || !perpendicular) fail('DEGENERATE_FACE', 'face is collinear or has no stable plane basis');
    return { axis, perpendicular };
}

function area2(points) {
    let result = 0;
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        result += current.x * next.y - next.x * current.y;
    }
    return result;
}

function cross2(first, second) {
    return first.x * second.y - first.y * second.x;
}

function subtract2(first, second) {
    return { x: first.x - second.x, y: first.y - second.y };
}

function distance2(first, second) {
    return Math.hypot(first.x - second.x, first.y - second.y);
}

function validateConvexProjectedFace(points, label) {
    const perimeterScale = Math.max(
        ...points.map((point, index) => distance2(point, points[(index + 1) % points.length])),
        MIN_VALUE,
    );
    if (Math.abs(area2(points)) <= MACHINE_EPSILON * perimeterScale * perimeterScale) fail('DEGENERATE_FACE', `${label} has zero area`);
    const winding = Math.sign(area2(points));
    for (let index = 0; index < points.length; index += 1) {
        const previous = points[(index + points.length - 1) % points.length];
        const current = points[index];
        const next = points[(index + 1) % points.length];
        const incoming = subtract2(current, previous);
        const outgoing = subtract2(next, current);
        if (distance2(current, next) <= MACHINE_EPSILON * Math.max(perimeterScale, MIN_VALUE)) {
            fail('DEGENERATE_FACE', `${label} has a zero-length perimeter edge`);
        }
        const turn = cross2(incoming, outgoing);
        const threshold = MACHINE_EPSILON * Math.max(MIN_VALUE, Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y));
        if (Math.abs(turn) <= threshold || Math.sign(turn) !== winding) fail('NON_CONVEX_FACE', `${label} must be a simple convex polygon`);
    }
}

function faceGeometry(face, vertices, options, label = `face "${face.id}"`) {
    if (!isRecord(face) || typeof face.id !== 'string' || face.id.length === 0) fail('INVALID_SLOT_TOPOLOGY', `${label} must have a non-empty string id`);
    if (!Array.isArray(face.vertexIds) || face.vertexIds.length < 3) fail('INVALID_FACE', `${label} must reference at least three vertices`);
    if (new Set(face.vertexIds).size !== face.vertexIds.length) fail('INVALID_FACE', `${label} repeats a vertex`);
    const points = face.vertexIds.map((id) => {
        const point = vertices.get(id);
        if (!point) fail('INVALID_SLOT_TOPOLOGY', `${label} references unknown vertex "${id}"`);
        return point;
    });
    const computedNormal = normalize(newellNormal(points));
    if (!computedNormal) fail('DEGENERATE_FACE', `${label} is collinear or coincident`);
    const scale = scaleOfPoints(points);
    const planeTolerance = coordinateTolerance(scale, options.tolerance);
    const origin = points[0];
    points.forEach((point) => {
        if (Math.abs(dot(computedNormal, vectorBetween(origin, point))) > planeTolerance) fail('NON_PLANAR_FACE', `${label} is not planar`);
    });
    const basis = facePlaneBasis(points, computedNormal);
    const projected = points.map((point) => {
        const relative = vectorBetween(origin, point);
        return { x: dot(relative, basis.axis), y: dot(relative, basis.perpendicular) };
    });
    validateConvexProjectedFace(projected, label);
    const suppliedNormal = readNormal(face, computedNormal);
    if (dot(suppliedNormal, computedNormal) < 1 - options.normalTolerance) fail('FACE_NORMAL_WINDING', `${label} normal does not match its vertex winding`);
    return {
        id: face.id,
        vertexIds: face.vertexIds.slice(),
        points,
        normal: computedNormal,
        centroid: addPoints(points),
        area: polygonArea3(points),
        scale,
        label: typeof face.label === 'string' && face.label.length > 0 ? face.label : face.id,
        type: typeof face.type === 'string' && face.type.length > 0 ? face.type : 'polygon',
    };
}

function signedVolume6(faces, vertices) {
    const origin = vertices.values().next().value;
    if (!origin) return 0;
    let volume6 = 0;
    faces.forEach((face) => {
        const points = face.vertexIds.map((id) => vertices.get(id));
        const base = vectorBetween(origin, points[0]);
        for (let index = 1; index < points.length - 1; index += 1) {
            volume6 += dot(base, cross(vectorBetween(origin, points[index]), vectorBetween(origin, points[index + 1])));
        }
    });
    return volume6;
}
