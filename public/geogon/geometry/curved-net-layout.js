// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 MaskwaSam <136355328+MaskwaSam@users.noreply.github.com>

/**
 * Exact-development layouts for the curved primitives that can be unfolded
 * without stretching: cylinders and right circular cones.
 *
 * This module intentionally has no DOM or Three.js dependencies.  Components
 * are ordinary model-unit coordinates so an SVG, canvas, or other renderer can
 * consume the result later.  A sector's `path` is a deterministic set of
 * helper points; its exact radius and angular bounds remain authoritative.
 */

const TAU = Math.PI * 2;
const DEFAULT_GAP = 1;
const DEFAULT_PATH_SEGMENTS = 32;
const DEFAULT_TOLERANCE = 1e-10;
const MIN_MAGNITUDE = 1e-14;

const SUPPORTED_PRIMITIVES = new Set(['cylinder', 'cone']);
const UNSUPPORTED_EXACT_PRIMITIVES = new Set(['sphere', 'hemisphere']);

/** Error thrown for malformed parameters, impossible geometry, or invalid nets. */
export class CurvedNetLayoutError extends Error {
    constructor(code, message, details = undefined) {
        super(`${code}: ${message}`);
        this.name = 'CurvedNetLayoutError';
        this.code = code;
        if (details !== undefined) {
            this.details = details;
            if (isRecord(details) && details.diagnostic !== undefined) {
                this.diagnostic = details.diagnostic;
            }
        }
    }
}

function fail(code, message, details = undefined) {
    throw new CurvedNetLayoutError(code, message, details);
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

function normalizePrimitiveKey(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        fail('INVALID_PRIMITIVE', 'primitiveKey must be a non-empty string');
    }
    return value.trim().toLowerCase();
}

function readDimension(params, canonicalName, alias) {
    const hasCanonical = Object.prototype.hasOwnProperty.call(params, canonicalName);
    const hasAlias = Object.prototype.hasOwnProperty.call(params, alias);
    if (!hasCanonical && !hasAlias) {
        fail('INVALID_PARAMETER', `params.${canonicalName} is required`, { parameter: canonicalName });
    }
    const canonical = hasCanonical ? params[canonicalName] : undefined;
    const alternate = hasAlias ? params[alias] : undefined;
    if (hasCanonical && hasAlias) {
        positiveNumber(canonical, `params.${canonicalName}`);
        positiveNumber(alternate, `params.${alias}`);
        if (!numbersClose(canonical, alternate, DEFAULT_TOLERANCE)) {
            fail('CONFLICTING_PARAMETER', `params.${canonicalName} and params.${alias} disagree`, {
                canonicalName,
                canonical,
                alias,
                alternate,
            });
        }
    }
    return positiveNumber(hasCanonical ? canonical : alternate, `params.${canonicalName}`);
}

function readOptionalNumber(params, names, label) {
    const present = names.filter((name) => Object.prototype.hasOwnProperty.call(params, name));
    if (present.length === 0) return undefined;
    const value = params[present[0]];
    finiteNumber(value, `params.${present[0]}`);
    for (const name of present.slice(1)) {
        finiteNumber(params[name], `params.${name}`);
        if (!numbersClose(value, params[name], DEFAULT_TOLERANCE)) {
            fail('CONFLICTING_PARAMETER', `${label} aliases disagree`, { names: present });
        }
    }
    return value;
}

function normalizeParams(params, primitiveKey) {
    if (!isRecord(params)) {
        fail('INVALID_PARAMETERS', 'params must be an object containing radius and height');
    }
    const radius = readDimension(params, 'radius', 'r');
    const height = readDimension(params, 'height', 'h');

    const suppliedCircumference = readOptionalNumber(params, ['circumference', 'circumferenceLength'], 'circumference');
    const expectedCircumference = TAU * radius;
    if (!Number.isFinite(expectedCircumference)) {
        fail('DERIVED_DIMENSION_OVERFLOW', '2*pi*radius is not finite', { radius });
    }
    if (suppliedCircumference !== undefined && !numbersClose(suppliedCircumference, expectedCircumference, DEFAULT_TOLERANCE)) {
        fail('IMPOSSIBLE_DIMENSION_IDENTITY', 'supplied circumference does not equal 2*pi*radius', {
            suppliedCircumference,
            expectedCircumference,
        });
    }

    if (primitiveKey === 'cone') {
        const suppliedSlant = readOptionalNumber(params, ['slantHeight', 'slant'], 'slantHeight');
        const slantHeight = Math.hypot(radius, height);
        if (!Number.isFinite(slantHeight) || slantHeight <= 0) {
            fail('DERIVED_DIMENSION_OVERFLOW', 'sqrt(radius^2 + height^2) is not finite', { radius, height });
        }
        if (suppliedSlant !== undefined && !numbersClose(suppliedSlant, slantHeight, DEFAULT_TOLERANCE)) {
            fail('IMPOSSIBLE_DIMENSION_IDENTITY', 'supplied slantHeight does not equal sqrt(radius^2 + height^2)', {
                suppliedSlant,
                slantHeight,
            });
        }
        const centralAngle = expectedCircumference / slantHeight;
        const suppliedAngle = readOptionalNumber(
            params,
            ['centralAngleRadians', 'centralAngle', 'theta'],
            'central angle'
        );
        const suppliedAngleDegrees = readOptionalNumber(
            params,
            ['centralAngleDegrees', 'angleDegrees'],
            'central angle degrees'
        );
        if (!Number.isFinite(centralAngle) || centralAngle <= 0 || centralAngle > TAU + DEFAULT_TOLERANCE) {
            fail('IMPOSSIBLE_ANGLE', 'cone central angle must be in (0, 2*pi]', {
                centralAngle,
                circumference: expectedCircumference,
                slantHeight,
            });
        }
        if (suppliedAngle !== undefined && !numbersClose(suppliedAngle, centralAngle, DEFAULT_TOLERANCE)) {
            fail('IMPOSSIBLE_ANGLE_DRIFT', 'supplied central angle does not equal arcLength/slantHeight', {
                suppliedAngle,
                centralAngle,
            });
        }
        if (suppliedAngleDegrees !== undefined
            && !numbersClose(suppliedAngleDegrees, centralAngle * 180 / Math.PI, DEFAULT_TOLERANCE)) {
            fail('IMPOSSIBLE_ANGLE_DRIFT', 'supplied central angle degrees do not equal arcLength/slantHeight', {
                suppliedAngleDegrees,
                expectedAngleDegrees: centralAngle * 180 / Math.PI,
            });
        }
        return Object.freeze({ radius, height, circumference: expectedCircumference, slantHeight, centralAngle });
    }

    return Object.freeze({ radius, height, circumference: expectedCircumference });
}

function normalizeOptions(options) {
    if (options === undefined) options = {};
    if (!isRecord(options)) {
        fail('INVALID_OPTIONS', 'options must be an object');
    }
    const gapValue = options.gap ?? options.layoutGap ?? DEFAULT_GAP;
    finiteNumber(gapValue, 'options.gap');
    if (gapValue < 0) {
        fail('INVALID_OPTIONS', 'options.gap must not be negative', { gap: gapValue });
    }
    const pathSegmentsValue = options.pathSegments ?? options.arcSegments ?? DEFAULT_PATH_SEGMENTS;
    if (!Number.isInteger(pathSegmentsValue) || pathSegmentsValue < 4 || pathSegmentsValue > 4096) {
        fail('INVALID_OPTIONS', 'options.pathSegments must be an integer from 4 through 4096', {
            pathSegments: pathSegmentsValue,
        });
    }
    const toleranceValue = options.tolerance ?? options.epsilon ?? DEFAULT_TOLERANCE;
    finiteNumber(toleranceValue, 'options.tolerance');
    if (toleranceValue < 0) {
        fail('INVALID_OPTIONS', 'options.tolerance must not be negative', { tolerance: toleranceValue });
    }
    return Object.freeze({ gap: gapValue, pathSegments: pathSegmentsValue, tolerance: toleranceValue });
}

function numbersClose(actual, expected, tolerance = DEFAULT_TOLERANCE) {
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
    const scale = Math.max(MIN_MAGNITUDE, Math.abs(actual), Math.abs(expected));
    return Math.abs(actual - expected) <= tolerance * scale;
}

function numbersCloseWithCoordinateRoundoff(actual, expected, coordinateScale, tolerance) {
    if (numbersClose(actual, expected, tolerance)) return true;
    // Bounds are formed by subtracting centre +/- radius.  When a very small
    // component is deliberately placed beside a model-unit gap, that
    // subtraction can lose a few ulps even though the source radius is exact.
    // Account only for machine roundoff (not a broad absolute tolerance), so
    // genuinely drifted dimensions still fail validation.
    const roundoff = Number.EPSILON * 32 * Math.max(1, Math.abs(coordinateScale));
    return Math.abs(actual - expected) <= roundoff;
}

function freezeDeep(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
        return value;
    }
    seen.add(value);
    Object.values(value).forEach((child) => freezeDeep(child, seen));
    return Object.freeze(value);
}

function point(x, y) {
    return { x: cleanZero(x), y: cleanZero(y) };
}

function cleanZero(value) {
    return Object.is(value, -0) ? 0 : value;
}

function stablePlacementGap(requestedGap, scale) {
    if (requestedGap === 0) return 0;
    // Preserve a visibly positive separation even when a model is large
    // enough that a model-unit gap disappears in the ulp of its coordinates.
    return Math.max(requestedGap, Number.EPSILON * 64 * Math.max(1, Math.abs(scale)));
}

function minimumPlacementGap(scale) {
    return Number.EPSILON * 64 * Math.max(1, Math.abs(scale));
}

function positiveBoundsOverlap(first, second) {
    const overlapWidth = Math.min(first.maxX, second.maxX) - Math.max(first.minX, second.minX);
    const overlapHeight = Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY);
    return overlapWidth > 0 && overlapHeight > 0;
}

function boundsFromExtents(minX, minY, maxX, maxY) {
    if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX < minX || maxY < minY) {
        fail('INVALID_BOUNDS', 'component bounds must be finite and ordered');
    }
    const width = maxX - minX;
    const height = maxY - minY;
    if (![width, height].every(Number.isFinite)) {
        fail('DERIVED_LAYOUT_OVERFLOW', 'component bounds dimensions are not finite');
    }
    const centerX = midpoint(minX, maxX);
    const centerY = midpoint(minY, maxY);
    if (![centerX, centerY].every(Number.isFinite)) {
        fail('DERIVED_LAYOUT_OVERFLOW', 'component bounds centers are not finite');
    }
    return {
        minX,
        minY,
        maxX,
        maxY,
        width,
        height,
        centerX,
        centerY,
        min: point(minX, minY),
        max: point(maxX, maxY),
        size: point(width, height),
        center: point(centerX, centerY),
    };
}

function midpoint(first, second) {
    // `(first + second) / 2` overflows when both coordinates are close to the
    // largest finite number.  Halving first preserves a finite deterministic
    // midpoint for large printable layouts.
    return first / 2 + second / 2;
}

function boundsFromPoints(points) {
    if (!Array.isArray(points) || points.length === 0) {
        fail('INVALID_GEOMETRY', 'a component needs at least one point');
    }
    const xs = points.map(({ x }) => x);
    const ys = points.map(({ y }) => y);
    return boundsFromExtents(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

function rectangleComponent(id, role, width, height, originX = 0, originY = 0) {
    const points = [
        point(originX, originY),
        point(originX + width, originY),
        point(originX + width, originY + height),
        point(originX, originY + height),
    ];
    const polygon = { points };
    return {
        id,
        type: 'rectangle',
        kind: 'rectangle',
        role,
        width,
        height,
        origin: point(originX, originY),
        points,
        polygon,
        bounds: boundsFromPoints(points),
    };
}

function circleComponent(id, role, centerX, centerY, radius) {
    const center = point(centerX, centerY);
    const circumference = TAU * radius;
    if (!Number.isFinite(circumference)) {
        fail('DERIVED_DIMENSION_OVERFLOW', `${id} circumference is not finite`);
    }
    return {
        id,
        type: 'circle',
        kind: 'circle',
        role,
        center,
        radius,
        circumference,
        bounds: boundsFromExtents(centerX - radius, centerY - radius, centerX + radius, centerY + radius),
    };
}

function angleOnSweep(angle, startAngle, span, tolerance) {
    const normalized = ((angle - startAngle) % TAU + TAU) % TAU;
    return normalized <= span + tolerance || numbersClose(normalized, TAU, tolerance);
}

function sectorBounds(centerX, centerY, radius, startAngle, endAngle, tolerance) {
    const span = endAngle - startAngle;
    const angles = [startAngle, endAngle, 0, Math.PI / 2, Math.PI, Math.PI * 1.5];
    const points = [point(centerX, centerY)];
    for (const angle of angles) {
        if (angleOnSweep(angle, startAngle, span, tolerance)) {
            points.push(point(centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)));
        }
    }
    return boundsFromPoints(points);
}

function sectorPath(centerX, centerY, radius, startAngle, endAngle, segments) {
    const points = [];
    for (let index = 0; index <= segments; index += 1) {
        const angle = startAngle + ((endAngle - startAngle) * index) / segments;
        points.push(point(centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)));
    }
    // Arc start -> arc end -> centre -> arc start is a closed development
    // path.  The exact curve is represented by radius/start/endAngle above;
    // these points are deterministic rendering helpers only.
    points.push(point(centerX, centerY), points[0]);
    return points;
}

function sectorComponent(id, role, centerX, centerY, radius, startAngle, endAngle, pathSegments, tolerance) {
    const center = point(centerX, centerY);
    const path = sectorPath(centerX, centerY, radius, startAngle, endAngle, pathSegments);
    const bounds = sectorBounds(centerX, centerY, radius, startAngle, endAngle, tolerance);
    const centralAngleRadians = endAngle - startAngle;
    const arcLength = radius * centralAngleRadians;
    if (!Number.isFinite(arcLength)) {
        fail('DERIVED_DIMENSION_OVERFLOW', `${id} arc length is not finite`);
    }
    return {
        id,
        type: 'sector',
        kind: 'sector',
        role,
        center,
        radius,
        startAngle,
        endAngle,
        centralAngle: centralAngleRadians,
        centralAngleRadians,
        centralAngleDegrees: centralAngleRadians * 180 / Math.PI,
        angle: centralAngleRadians,
        angleRadians: centralAngleRadians,
        angleDegrees: centralAngleRadians * 180 / Math.PI,
        arcLength,
        path,
        pathPoints: path,
        closedPath: path,
        closed: true,
        bounds,
    };
}

function boundary(id, componentId, type, edge, length, extra = {}) {
    return {
        id,
        componentId,
        type,
        boundaryType: type,
        kind: type,
        edge,
        boundary: edge,
        length,
        ...extra,
    };
}

function correspondence(source, target, length, extra = {}) {
    return {
        source,
        target,
        sourceLength: length,
        targetLength: length,
        length,
        exact: true,
        geometricBoundaryTypesDiffer: source.type !== target.type,
        ...extra,
    };
}

function cylinderNet(params, layoutOptions) {
    const { radius, height, circumference } = params;
    const gap = stablePlacementGap(layoutOptions.gap, circumference);
    const effectiveLayoutOptions = { ...layoutOptions, effectiveGap: gap };
    const lateral = rectangleComponent('lateral', 'lateral-surface', circumference, height);
    const circleY = -(radius + gap);
    // C/4 and 3C/4 keep both discs beneath the rectangle for every radius;
    // the vertical gap prevents positive-area contact with the lateral panel.
    const baseOne = circleComponent('base-1', 'base', circumference / 4, circleY, radius);
    const baseTwo = circleComponent('base-2', 'base', circumference / 4 * 3, circleY, radius);
    const components = [lateral, baseOne, baseTwo];

    const bottomEdge = boundary('lateral-bottom-edge', 'lateral', 'rectangle-edge', 'bottom-long-edge', circumference);
    const topEdge = boundary('lateral-top-edge', 'lateral', 'rectangle-edge', 'top-long-edge', circumference);
    const baseOneCircumference = boundary(
        'base-1-circumference',
        'base-1',
        'circle-circumference',
        'circumference',
        circumference,
        { radius }
    );
    const baseTwoCircumference = boundary(
        'base-2-circumference',
        'base-2',
        'circle-circumference',
        'circumference',
        circumference,
        { radius }
    );
    const joins = [
        {
            id: 'base-1-to-lateral-bottom',
            type: 'assembly-join',
            kind: 'assembly-join',
            from: baseOneCircumference,
            to: bottomEdge,
            sourceBoundary: baseOneCircumference,
            targetBoundary: bottomEdge,
            correspondence: correspondence(baseOneCircumference, bottomEdge, circumference, {
                sourceBoundary: 'curved-circle-circumference',
                targetBoundary: 'straight-rectangle-edge',
            }),
        },
        {
            id: 'base-2-to-lateral-top',
            type: 'assembly-join',
            kind: 'assembly-join',
            from: baseTwoCircumference,
            to: topEdge,
            sourceBoundary: baseTwoCircumference,
            targetBoundary: topEdge,
            correspondence: correspondence(baseTwoCircumference, topEdge, circumference, {
                sourceBoundary: 'curved-circle-circumference',
                targetBoundary: 'straight-rectangle-edge',
            }),
        },
    ];
    // The components are separate printable pieces; these are assembly
    // correspondences, not coincident planar creases.  Keep foldBoundaries
    // empty rather than implying that a detached base is already folded.
    const foldBoundaries = [];
    const cutBoundaries = [
        boundary('lateral-cut-seam', 'lateral', 'cut', 'left-short-edge', height, {
            seam: true,
            purpose: 'open the lateral rectangle along one generator',
            sides: [
                boundary('lateral-cut-seam-left-side', 'lateral', 'rectangle-edge', 'left-short-edge', height),
                boundary('lateral-cut-seam-right-side', 'lateral', 'rectangle-edge', 'right-short-edge', height),
            ],
        }),
    ];
    const bounds = combineComponentBounds(components);
    const dimensions = {
        radius,
        height,
        circumference,
        lateralWidth: circumference,
        lateralHeight: height,
    };
    return {
        primitiveKey: 'cylinder',
        params: { radius, height },
        dimensions,
        metrics: dimensions,
        layoutOptions: effectiveLayoutOptions,
        components,
        bounds,
        joins,
        joinBoundaries: joins,
        foldBoundaries,
        folds: foldBoundaries,
        cutBoundaries,
        seamBoundaries: cutBoundaries,
        cuts: cutBoundaries,
        seams: cutBoundaries,
        cutSeams: cutBoundaries,
        diagnostics: [
            {
                code: 'EXACT_DEVELOPMENT',
                severity: 'info',
                message: 'Cylinder lateral surface is unfolded to an exact circumference-by-height rectangle.',
            },
        ],
    };
}

function coneNet(params, layoutOptions) {
    const { radius, height, circumference, slantHeight, centralAngle } = params;
    const { pathSegments, tolerance } = layoutOptions;
    const sector = sectorComponent(
        'lateral-sector',
        'lateral-surface',
        0,
        0,
        slantHeight,
        0,
        centralAngle,
        pathSegments,
        tolerance
    );
    let gap = stablePlacementGap(layoutOptions.gap, slantHeight);
    const baseCenterY = sector.bounds.centerY;
    const makeBase = (placementGap) => {
        const circleBoundsGap = sector.bounds.maxX + radius + placementGap;
        if (!Number.isFinite(circleBoundsGap)) {
            fail('DERIVED_LAYOUT_OVERFLOW', 'cone base placement is not finite');
        }
        return circleComponent('base', 'base', circleBoundsGap, baseCenterY, radius);
    };
    let base = makeBase(gap);
    // At very large coordinates, exact zero-gap arithmetic can round a circle
    // min-X just inside the sector max-X.  Preserve requested zero whenever it
    // is numerically clean; otherwise expose the smallest deterministic
    // effective gap that repairs the positive-area overlap.
    if (gap === 0 && positiveBoundsOverlap(sector.bounds, base.bounds)) {
        gap = minimumPlacementGap(slantHeight);
        base = makeBase(gap);
    }
    const effectiveLayoutOptions = { ...layoutOptions, effectiveGap: gap };
    const components = [sector, base];
    const arcBoundary = boundary('sector-outer-arc', 'lateral-sector', 'sector-arc', 'outer-arc', circumference, {
        radius: slantHeight,
        startAngle: 0,
        endAngle: centralAngle,
    });
    const baseCircumference = boundary('base-circumference', 'base', 'circle-circumference', 'circumference', circumference, {
        radius,
    });
    const joins = [{
        id: 'base-to-sector-arc',
        type: 'assembly-join',
        kind: 'assembly-join',
        from: baseCircumference,
        to: arcBoundary,
        sourceBoundary: baseCircumference,
        targetBoundary: arcBoundary,
        correspondence: correspondence(baseCircumference, arcBoundary, circumference, {
            sourceBoundary: 'curved-circle-circumference',
            targetBoundary: 'curved-sector-arc',
        }),
    }];
    const foldBoundaries = [];
    const cutBoundaries = [
        boundary('sector-radial-seam', 'lateral-sector', 'cut', 'paired-radial-edges', slantHeight, {
            seam: true,
            matchingSides: true,
            purpose: 'open the sector along both radial generator sides',
            sides: [
                boundary('sector-radial-seam-start-side', 'lateral-sector', 'sector-radial-edge', 'start-radial-edge', slantHeight, {
                    angle: 0,
                }),
                boundary('sector-radial-seam-end-side', 'lateral-sector', 'sector-radial-edge', 'end-radial-edge', slantHeight, {
                    angle: centralAngle,
                }),
            ],
        }),
    ];
    const bounds = combineComponentBounds(components);
    const dimensions = {
        radius,
        height,
        circumference,
        arcLength: circumference,
        slantHeight,
        slant: slantHeight,
        centralAngle,
        centralAngleRadians: centralAngle,
        centralAngleDegrees: centralAngle * 180 / Math.PI,
        angleRadians: centralAngle,
        angleDegrees: centralAngle * 180 / Math.PI,
    };
    return {
        primitiveKey: 'cone',
        params: { radius, height },
        dimensions,
        metrics: dimensions,
        layoutOptions: effectiveLayoutOptions,
        components,
        bounds,
        joins,
        joinBoundaries: joins,
        foldBoundaries,
        folds: foldBoundaries,
        cutBoundaries,
        seamBoundaries: cutBoundaries,
        cuts: cutBoundaries,
        seams: cutBoundaries,
        cutSeams: cutBoundaries,
        diagnostics: [
            {
                code: 'EXACT_DEVELOPMENT',
                severity: 'info',
                message: 'Cone lateral surface is unfolded to an exact circular sector with arc length 2*pi*radius.',
            },
        ],
    };
}

function combineComponentBounds(components) {
    const minX = Math.min(...components.map((component) => component.bounds.minX));
    const minY = Math.min(...components.map((component) => component.bounds.minY));
    const maxX = Math.max(...components.map((component) => component.bounds.maxX));
    const maxY = Math.max(...components.map((component) => component.bounds.maxY));
    return boundsFromExtents(minX, minY, maxX, maxY);
}

function isJsonFriendly(value, active = new Set()) {
    if (value === null) return true;
    if (typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object') return false;
    // Shared references are JSON-friendly (JSON.stringify repeats their
    // values); only an active recursion edge is a cycle that JSON cannot
    // represent.
    if (active.has(value)) return false;
    active.add(value);
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    const plainObject = prototype === Object.prototype || prototype === null;
    const result = (isArray || plainObject)
        && (isArray
            ? value.every((child) => isJsonFriendly(child, active))
            : Object.entries(value).every(([key, child]) => key !== '__proto__' && child !== undefined && isJsonFriendly(child, active)));
    active.delete(value);
    return result;
}

function componentById(net, id) {
    return net.components.find((component) => component.id === id);
}

function validateBounds(bounds, label, tolerance) {
    if (!isRecord(bounds)) fail('INVALID_NET', `${label} bounds must be an object`);
    for (const key of ['minX', 'minY', 'maxX', 'maxY', 'width', 'height']) finiteNumber(bounds[key], `${label}.${key}`);
    if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) {
        fail('INVALID_NET', `${label} bounds must be ordered`);
    }
    if (!numbersClose(bounds.width, bounds.maxX - bounds.minX, tolerance)
        || !numbersClose(bounds.height, bounds.maxY - bounds.minY, tolerance)) {
        fail('INVALID_NET', `${label} bounds dimensions are inconsistent`);
    }
    for (const [key, expected] of [
        ['min', { x: bounds.minX, y: bounds.minY }],
        ['max', { x: bounds.maxX, y: bounds.maxY }],
        ['size', { x: bounds.width, y: bounds.height }],
        ['center', { x: midpoint(bounds.minX, bounds.maxX), y: midpoint(bounds.minY, bounds.maxY) }],
    ]) {
        if (!isRecord(bounds[key])) fail('INVALID_NET', `${label}.${key} must be a point object`);
        if (!numbersClose(bounds[key].x, expected.x, tolerance) || !numbersClose(bounds[key].y, expected.y, tolerance)) {
            fail('INVALID_NET', `${label}.${key} is inconsistent`);
        }
    }
    if (!numbersClose(bounds.centerX, midpoint(bounds.minX, bounds.maxX), tolerance)
        || !numbersClose(bounds.centerY, midpoint(bounds.minY, bounds.maxY), tolerance)) {
        fail('INVALID_NET', `${label} center is inconsistent`);
    }
}

function validatePoint(pointValue, label) {
    if (!isRecord(pointValue)) fail('INVALID_NET', `${label} must be a point object`);
    finiteNumber(pointValue.x, `${label}.x`);
    finiteNumber(pointValue.y, `${label}.y`);
}

function structurallyEqual(first, second, seen = new Map()) {
    if (Object.is(first, second)) return true;
    if (typeof first !== typeof second || first === null || second === null) return false;
    if (typeof first !== 'object') return false;
    if (seen.get(first) === second) return true;
    seen.set(first, second);
    if (Array.isArray(first) !== Array.isArray(second)) return false;
    if (Array.isArray(first)) {
        return first.length === second.length && first.every((item, index) => structurallyEqual(item, second[index], seen));
    }
    const firstKeys = Object.keys(first).sort();
    const secondKeys = Object.keys(second).sort();
    return firstKeys.length === secondKeys.length
        && firstKeys.every((key, index) => key === secondKeys[index] && structurallyEqual(first[key], second[key], seen));
}

function requireAliasMatch(container, aliasKey, canonicalKey, label) {
    if (!Object.prototype.hasOwnProperty.call(container, aliasKey)) return;
    if (!structurallyEqual(container[aliasKey], container[canonicalKey])) {
        fail('INVALID_NET', `${label} must match ${canonicalKey}`);
    }
}

function compareBounds(actual, expected, label, tolerance) {
    validateBounds(actual, label, tolerance);
    const coordinateScale = Math.max(
        1,
        ...['minX', 'minY', 'maxX', 'maxY'].flatMap((key) => [Math.abs(actual[key]), Math.abs(expected[key])])
    );
    for (const key of ['minX', 'minY', 'maxX', 'maxY', 'width', 'height']) {
        if (!numbersCloseWithCoordinateRoundoff(actual[key], expected[key], coordinateScale, tolerance)) {
            fail('INVALID_NET', `${label}.${key} does not match recomputed geometry`);
        }
    }
}

function assertPointClose(actual, expected, label, tolerance, coordinateScale = 1) {
    validatePoint(actual, label);
    if (!numbersCloseWithCoordinateRoundoff(actual.x, expected.x, coordinateScale, tolerance)
        || !numbersCloseWithCoordinateRoundoff(actual.y, expected.y, coordinateScale, tolerance)) {
        fail('INVALID_NET', `${label} does not match authoritative geometry`);
    }
}

function validateComponentGeometry(component, tolerance) {
    if (!isRecord(component) || typeof component.id !== 'string' || typeof component.type !== 'string') {
        fail('INVALID_NET', 'each component needs a string id and type');
    }
    if (component.type === 'rectangle') {
        if (!Array.isArray(component.points) || component.points.length !== 4) {
            fail('INVALID_NET', `${component.id} rectangle must have four polygon points`);
        }
        if (!isRecord(component.origin)) fail('INVALID_NET', `${component.id} rectangle needs an origin`);
        validatePoint(component.origin, `${component.id}.origin`);
        positiveNumber(component.width, `${component.id}.width`);
        positiveNumber(component.height, `${component.id}.height`);
        const expectedPoints = [
            point(component.origin.x, component.origin.y),
            point(component.origin.x + component.width, component.origin.y),
            point(component.origin.x + component.width, component.origin.y + component.height),
            point(component.origin.x, component.origin.y + component.height),
        ];
        const coordinateScale = Math.max(1, ...expectedPoints.flatMap((item) => [Math.abs(item.x), Math.abs(item.y)]));
        component.points.forEach((item, index) => assertPointClose(
            item,
            expectedPoints[index],
            `${component.id}.points[${index}]`,
            tolerance,
            coordinateScale
        ));
        if (!isRecord(component.polygon) || !Array.isArray(component.polygon.points)
            || !structurallyEqual(component.polygon.points, component.points)) {
            fail('INVALID_NET', `${component.id}.polygon.points must match rectangle points`);
        }
        compareBounds(component.bounds, boundsFromPoints(component.points), `component ${component.id}`, tolerance);
    } else if (component.type === 'circle') {
        validatePoint(component.center, `${component.id}.center`);
        positiveNumber(component.radius, `${component.id}.radius`);
        const circumference = TAU * component.radius;
        if (!Number.isFinite(circumference)) fail('DERIVED_DIMENSION_OVERFLOW', `${component.id} circumference is not finite`);
        const expectedBounds = boundsFromExtents(
            component.center.x - component.radius,
            component.center.y - component.radius,
            component.center.x + component.radius,
            component.center.y + component.radius
        );
        compareBounds(component.bounds, expectedBounds, `component ${component.id}`, tolerance);
        if (!numbersClose(component.circumference, circumference, tolerance)) {
            fail('INVALID_NET', `${component.id} circumference identity failed`);
        }
    } else if (component.type === 'sector') {
        validatePoint(component.center, `${component.id}.center`);
        positiveNumber(component.radius, `${component.id}.radius`);
        finiteNumber(component.startAngle, `${component.id}.startAngle`);
        finiteNumber(component.endAngle, `${component.id}.endAngle`);
        const span = component.endAngle - component.startAngle;
        if (span <= 0 || span > TAU + tolerance) fail('INVALID_NET', `${component.id} central angle is impossible`);
        for (const [key, expected] of [
            ['centralAngle', span],
            ['angle', span],
            ['angleRadians', span],
            ['angleDegrees', span * 180 / Math.PI],
        ]) {
            if (component[key] !== undefined && !numbersClose(component[key], expected, tolerance)) {
                fail('INVALID_NET', `${component.id}.${key} drifted from the central angle`);
            }
        }
        if (!Array.isArray(component.path) || component.path.length < 5) {
            fail('INVALID_NET', `${component.id} sector path must be a deterministic closed path`);
        }
        component.path.forEach((item, index) => validatePoint(item, `${component.id}.path[${index}]`));
        requireAliasMatch(component, 'pathPoints', 'path', `${component.id}.pathPoints`);
        requireAliasMatch(component, 'closedPath', 'path', `${component.id}.closedPath`);
        const centerIndex = component.path.length - 2;
        const closureIndex = component.path.length - 1;
        assertPointClose(component.path[centerIndex], component.center, `${component.id}.path center`, tolerance);
        assertPointClose(component.path[closureIndex], component.path[0], `${component.id}.path closure`, tolerance);
        const arcPointCount = centerIndex;
        if (arcPointCount < 2) fail('INVALID_NET', `${component.id} sector path needs start and end arc points`);
        const coordinateScale = Math.max(1, Math.abs(component.center.x), Math.abs(component.center.y), Math.abs(component.radius));
        for (let index = 0; index < arcPointCount; index += 1) {
            const angle = component.startAngle + (span * index) / (arcPointCount - 1);
            const expected = point(
                component.center.x + component.radius * Math.cos(angle),
                component.center.y + component.radius * Math.sin(angle)
            );
            assertPointClose(component.path[index], expected, `${component.id}.path[${index}]`, tolerance, coordinateScale);
            const distance = Math.hypot(
                component.path[index].x - component.center.x,
                component.path[index].y - component.center.y
            );
            if (!numbersCloseWithCoordinateRoundoff(distance, component.radius, coordinateScale, tolerance)) {
                fail('INVALID_NET', `${component.id}.path[${index}] is not on the exact arc`);
            }
        }
        const expectedBounds = sectorBounds(
            component.center.x,
            component.center.y,
            component.radius,
            component.startAngle,
            component.endAngle,
            tolerance
        );
        compareBounds(component.bounds, expectedBounds, `component ${component.id}`, tolerance);
        const pathBoundsSlack = Number.EPSILON * 64 * Math.max(
            1,
            Math.abs(expectedBounds.minX),
            Math.abs(expectedBounds.minY),
            Math.abs(expectedBounds.maxX),
            Math.abs(expectedBounds.maxY)
        ) + tolerance * Math.max(1, component.radius);
        for (const [index, item] of component.path.entries()) {
            if (item.x < expectedBounds.minX - pathBoundsSlack || item.x > expectedBounds.maxX + pathBoundsSlack
                || item.y < expectedBounds.minY - pathBoundsSlack || item.y > expectedBounds.maxY + pathBoundsSlack) {
                fail('INVALID_NET', `${component.id}.path[${index}] lies outside exact sector bounds`);
            }
        }
        const arcLength = component.radius * span;
        if (!Number.isFinite(arcLength)
            || !numbersClose(component.centralAngleRadians, span, tolerance)
            || !numbersClose(component.arcLength, arcLength, tolerance)) {
            fail('INVALID_NET', `${component.id} sector arc identity failed`);
        }
    } else {
        fail('INVALID_NET', `unsupported component type ${component.type}`);
    }
}

function validateNoPositiveAreaOverlap(components) {
    for (let firstIndex = 0; firstIndex < components.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < components.length; secondIndex += 1) {
            const first = components[firstIndex].bounds;
            const second = components[secondIndex].bounds;
            const overlapWidth = Math.min(first.maxX, second.maxX) - Math.max(first.minX, second.minX);
            const overlapHeight = Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY);
            if (overlapWidth > 0 && overlapHeight > 0) {
                fail('OVERLAPPING_COMPONENTS', `components ${components[firstIndex].id} and ${components[secondIndex].id} overlap with positive area`, {
                    first: components[firstIndex].id,
                    second: components[secondIndex].id,
                });
            }
        }
    }
}

function validateBoundaryList(net, key, tolerance) {
    if (!Array.isArray(net[key])) fail('INVALID_NET', `${key} must be an array`);
    const ids = new Set();
    const validateBoundary = (item, label) => {
        if (!isRecord(item) || typeof item.id !== 'string' || ids.has(item.id)) {
            fail('INVALID_NET', `${label} needs a unique string id`);
        }
        ids.add(item.id);
        if (typeof item.componentId !== 'string' || !componentById(net, item.componentId)) {
            fail('INVALID_NET', `${label} references an unknown component`);
        }
        if (item.length !== undefined) {
            positiveNumber(item.length, `${label}.length`);
        }
        if (item.radius !== undefined) positiveNumber(item.radius, `${label}.radius`);
        if (item.startAngle !== undefined) finiteNumber(item.startAngle, `${label}.startAngle`);
        if (item.endAngle !== undefined) finiteNumber(item.endAngle, `${label}.endAngle`);
        if (item.sides !== undefined) {
            if (!Array.isArray(item.sides) || item.sides.length !== 2) {
                fail('INVALID_NET', `${label}.sides must contain the paired seam sides`);
            }
            item.sides.forEach((side, sideIndex) => validateBoundary(side, `${label}.sides[${sideIndex}]`));
        }
    };
    net[key].forEach((item, index) => validateBoundary(item, `${key}[${index}]`));
    void tolerance;
}

function validateJoins(net, params, primitiveKey, tolerance) {
    const expectedCircumference = params.circumference;
    if (!Array.isArray(net.joins) || net.joins.length !== (primitiveKey === 'cylinder' ? 2 : 1)) {
        fail('INVALID_NET', `${primitiveKey} must have its expected assembly joins`);
    }
    requireAliasMatch(net, 'joinBoundaries', 'joins', 'joinBoundaries');
    const seen = new Set();
    net.joins.forEach((join, index) => {
        if (!isRecord(join) || !isRecord(join.from) || !isRecord(join.to) || !isRecord(join.correspondence)) {
            fail('INVALID_NET', `joins[${index}] must describe both boundaries and their correspondence`);
        }
        if (typeof join.id !== 'string') fail('INVALID_NET', `joins[${index}] needs a string id`);
        if (join.type !== 'assembly-join' || join.kind !== 'assembly-join') {
            fail('INVALID_NET', `joins[${index}] must be an assembly correspondence, not a planar fold`);
        }
        if (typeof join.from.componentId !== 'string' || typeof join.to.componentId !== 'string'
            || !componentById(net, join.from.componentId) || !componentById(net, join.to.componentId)) {
            fail('INVALID_NET', `joins[${index}] references an unknown component`);
        }
        if (join.from.componentId === join.to.componentId) fail('INVALID_NET', `joins[${index}] must connect separate components`);
        if (seen.has(join.id)) fail('INVALID_NET', `joins[${index}] has a duplicate id`);
        seen.add(join.id);
        if (!structurallyEqual(join.sourceBoundary, join.from) || !structurallyEqual(join.targetBoundary, join.to)) {
            fail('INVALID_NET', `joins[${index}] source/target boundary aliases drifted`);
        }
        const { correspondence: match } = join;
        if (!structurallyEqual(match.source, join.from) || !structurallyEqual(match.target, join.to)) {
            fail('INVALID_NET', `joins[${index}] correspondence boundary aliases drifted`);
        }
        if (!numbersClose(match.sourceLength, expectedCircumference, tolerance)
            || !numbersClose(match.targetLength, expectedCircumference, tolerance)
            || !numbersClose(match.length, expectedCircumference, tolerance)
            || match.exact !== true) {
            fail('INVALID_NET', `joins[${index}] must preserve the exact circumference/arc length`);
        }
        if (primitiveKey === 'cylinder') {
            const from = componentById(net, join.from.componentId);
            const to = componentById(net, join.to.componentId);
            if (from.type !== 'circle' || to.type !== 'rectangle'
                || join.from.type !== 'circle-circumference' || join.to.type !== 'rectangle-edge'
                || join.from.edge !== 'circumference' || join.to.edge === undefined
                || !['bottom-long-edge', 'top-long-edge'].includes(join.to.edge)) {
                fail('INVALID_NET', 'cylinder joins must distinguish curved circumferences from straight rectangle edges');
            }
            if (!numbersClose(join.from.radius, from.radius, tolerance)
                || !numbersClose(join.from.length, expectedCircumference, tolerance)
                || !numbersClose(join.to.length, expectedCircumference, tolerance)) {
                fail('INVALID_NET', `joins[${index}] cylinder boundary lengths drifted`);
            }
        } else if (componentById(net, join.from.componentId).type !== 'circle'
            || componentById(net, join.to.componentId).type !== 'sector'
            || join.from.type !== 'circle-circumference'
            || join.to.type !== 'sector-arc'
            || join.from.edge !== 'circumference'
            || join.to.edge !== 'outer-arc') {
            fail('INVALID_NET', 'cone join must distinguish the base circumference from the sector arc');
        } else if (!numbersClose(join.from.length, expectedCircumference, tolerance)
            || !numbersClose(join.to.length, expectedCircumference, tolerance)) {
            fail('INVALID_NET', `joins[${index}] cone boundary lengths drifted`);
        } else if (!numbersClose(join.from.radius, params.radius, tolerance)
            || !numbersClose(join.to.radius, params.slantHeight, tolerance)
            || !numbersClose(join.to.startAngle, 0, tolerance)
            || !numbersClose(join.to.endAngle, params.centralAngle, tolerance)) {
            fail('INVALID_NET', `joins[${index}] cone boundary geometry drifted`);
        }
    });
}

function validatePrimitiveAssemblyTopology(net, params, primitiveKey, tolerance) {
    const expectedComponents = primitiveKey === 'cylinder'
        ? [
            ['lateral', 'rectangle', 'lateral-surface'],
            ['base-1', 'circle', 'base'],
            ['base-2', 'circle', 'base'],
        ]
        : [
            ['lateral-sector', 'sector', 'lateral-surface'],
            ['base', 'circle', 'base'],
        ];
    const byId = new Map(net.components.map((component) => [component.id, component]));
    expectedComponents.forEach(([id, type, role]) => {
        const component = byId.get(id);
        if (!component || component.type !== type || component.role !== role) {
            fail('INVALID_NET', `${primitiveKey} component ${id} has incorrect type or role`);
        }
    });
    if (byId.size !== expectedComponents.length) fail('INVALID_NET', `${primitiveKey} has unexpected component IDs`);

    const joinSources = new Set();
    const joinTargets = new Set();
    net.joins.forEach((join, index) => {
        if (joinSources.has(join.from.componentId)) fail('INVALID_NET', `joins[${index}] reuses a base component`);
        joinSources.add(join.from.componentId);
        if (joinTargets.has(join.to.edge)) fail('INVALID_NET', `joins[${index}] reuses a target boundary`);
        joinTargets.add(join.to.edge);
        if (join.to.componentId !== (primitiveKey === 'cylinder' ? 'lateral' : 'lateral-sector')) {
            fail('INVALID_NET', `joins[${index}] must target the lateral component`);
        }
        if (primitiveKey === 'cylinder') {
            if (!['base-1', 'base-2'].includes(join.from.componentId)
                || !['bottom-long-edge', 'top-long-edge'].includes(join.to.edge)
                || (join.from.componentId === 'base-1' && join.to.edge !== 'bottom-long-edge')
                || (join.from.componentId === 'base-2' && join.to.edge !== 'top-long-edge')) {
                fail('INVALID_NET', `joins[${index}] cylinder base/edge pairing drifted`);
            }
            if (!numbersClose(join.from.length, params.circumference, tolerance)
                || !numbersClose(join.to.length, params.circumference, tolerance)) {
                fail('INVALID_NET', `joins[${index}] cylinder circumference pairing drifted`);
            }
        } else if (join.from.componentId !== 'base' || join.to.edge !== 'outer-arc'
            || !numbersClose(join.from.length, params.circumference, tolerance)
            || !numbersClose(join.to.length, params.circumference, tolerance)) {
            fail('INVALID_NET', `joins[${index}] cone base/arc pairing drifted`);
        }
    });
    const expectedSources = primitiveKey === 'cylinder' ? ['base-1', 'base-2'] : ['base'];
    if (joinSources.size !== expectedSources.length || expectedSources.some((id) => !joinSources.has(id))) {
        fail('INVALID_NET', `${primitiveKey} assembly joins do not use each base exactly once`);
    }

    const seam = net.cutBoundaries[0];
    const lateralId = primitiveKey === 'cylinder' ? 'lateral' : 'lateral-sector';
    if (seam.componentId !== lateralId || seam.sides.some((side) => side.componentId !== lateralId)) {
        fail('INVALID_NET', `${primitiveKey} seam must belong to the lateral component`);
    }
    if (primitiveKey === 'cylinder') {
        const sideEdges = seam.sides.map((side) => side.edge).sort();
        if (sideEdges.join('|') !== 'left-short-edge|right-short-edge'
            || seam.sides.some((side) => side.type !== 'rectangle-edge'
                || !numbersClose(side.length, params.height, tolerance))) {
            fail('INVALID_NET', 'cylinder seam sides must be the two lateral short edges');
        }
    } else {
        const sideEdges = seam.sides.map((side) => side.edge).sort();
        if (sideEdges.join('|') !== 'end-radial-edge|start-radial-edge'
            || seam.sides.some((side) => side.type !== 'sector-radial-edge'
                || !numbersClose(side.length, params.slantHeight, tolerance))) {
            fail('INVALID_NET', 'cone seam sides must be the two sector radial edges');
        }
    }
}

function validateDimensions(net, primitiveKey, tolerance) {
    if (!isRecord(net.params) || !isRecord(net.dimensions)) fail('INVALID_NET', 'params and dimensions are required');
    requireAliasMatch(net, 'metrics', 'dimensions', 'metrics');
    const params = normalizeParams(net.params, primitiveKey);
    const dimensions = net.dimensions;
    if (!numbersClose(dimensions.radius, params.radius, tolerance)
        || !numbersClose(dimensions.height, params.height, tolerance)
        || !numbersClose(dimensions.circumference, params.circumference, tolerance)) {
        fail('INVALID_NET', 'stored dimensions do not match radius/height identities');
    }
    if (primitiveKey === 'cylinder') {
        if (!numbersClose(dimensions.lateralWidth, params.circumference, tolerance)
            || !numbersClose(dimensions.lateralHeight, params.height, tolerance)) {
            fail('INVALID_NET', 'cylinder lateral rectangle identity failed');
        }
    } else {
        if (!numbersClose(dimensions.slantHeight, params.slantHeight, tolerance)
            || !numbersClose(dimensions.slant, params.slantHeight, tolerance)
            || !numbersClose(dimensions.arcLength, params.circumference, tolerance)
            || !numbersClose(dimensions.centralAngle, params.centralAngle, tolerance)
            || !numbersClose(dimensions.centralAngleRadians, params.centralAngle, tolerance)
            || !numbersClose(dimensions.centralAngleRadians, dimensions.arcLength / dimensions.slantHeight, tolerance)
            || !numbersClose(dimensions.centralAngleDegrees, dimensions.centralAngleRadians * 180 / Math.PI, tolerance)
            || !numbersClose(dimensions.angleRadians, dimensions.centralAngleRadians, tolerance)
            || !numbersClose(dimensions.angleDegrees, dimensions.centralAngleDegrees, tolerance)) {
            fail('INVALID_NET', 'cone slant/arc/central-angle identities failed');
        }
        if (dimensions.centralAngleRadians <= 0 || dimensions.centralAngleRadians > TAU + tolerance) {
            fail('INVALID_NET', 'cone central angle drifted outside (0, 2*pi]');
        }
    }
    return params;
}

/**
 * Validate a generated net.  The function returns true on success and throws
 * CurvedNetLayoutError with a stable code on malformed or drifted layouts.
 */
export function validateCurvedPrimitiveNet(net, options = {}) {
    const layoutOptions = normalizeOptions(options);
    if (!isRecord(net)) fail('INVALID_NET', 'net must be an object');
    const primitiveKey = normalizePrimitiveKey(net.primitiveKey);
    if (UNSUPPORTED_EXACT_PRIMITIVES.has(primitiveKey)) {
        fail(
            'UNSUPPORTED_EXACT_NET',
            `${primitiveKey} has no exact finite planar net: its curved surface cannot be flattened without distortion; cuts alone do not make it developable`,
            { primitiveKey, diagnostic: 'No exact finite planar net exists because a sphere or hemisphere cannot be flattened without distortion; cuts alone do not make this curved surface developable.' }
        );
    }
    if (!SUPPORTED_PRIMITIVES.has(primitiveKey)) fail('UNSUPPORTED_PRIMITIVE', `unsupported curved primitive ${primitiveKey}`);
    if (!isJsonFriendly(net)) fail('NON_JSON_NET', 'net must contain only JSON-friendly values');
    const params = validateDimensions(net, primitiveKey, layoutOptions.tolerance);
    if (isRecord(net.layoutOptions)) {
        const storedLayoutOptions = normalizeOptions(net.layoutOptions);
        const placementScale = primitiveKey === 'cylinder' ? params.circumference : params.slantHeight;
        const expectedEffectiveGap = stablePlacementGap(storedLayoutOptions.gap, placementScale);
        const effectiveGapMatches = numbersClose(net.layoutOptions.effectiveGap, expectedEffectiveGap, layoutOptions.tolerance)
            || (storedLayoutOptions.gap === 0
                && numbersClose(net.layoutOptions.effectiveGap, minimumPlacementGap(placementScale), layoutOptions.tolerance));
        if (net.layoutOptions.effectiveGap === undefined || !effectiveGapMatches) {
            fail('INVALID_NET', 'layoutOptions.effectiveGap does not match the requested gap and model scale');
        }
    }
    if (!Array.isArray(net.components) || net.components.length !== (primitiveKey === 'cylinder' ? 3 : 2)) {
        fail('INVALID_NET', `${primitiveKey} has an unexpected component count`);
    }
    const componentIds = new Set();
    net.components.forEach((component) => {
        if (componentIds.has(component.id)) fail('INVALID_NET', `duplicate component id ${component.id}`);
        componentIds.add(component.id);
        validateComponentGeometry(component, layoutOptions.tolerance);
    });
    validateNoPositiveAreaOverlap(net.components);
    validateBounds(net.bounds, 'net', layoutOptions.tolerance);
    const combined = combineComponentBounds(net.components);
    for (const key of ['minX', 'minY', 'maxX', 'maxY', 'width', 'height']) {
        if (!numbersClose(net.bounds[key], combined[key], layoutOptions.tolerance)) {
            fail('INVALID_NET', 'net bounds do not cover all components');
        }
    }
    validateJoins(net, params, primitiveKey, layoutOptions.tolerance);
    validateBoundaryList(net, 'foldBoundaries', layoutOptions.tolerance);
    requireAliasMatch(net, 'folds', 'foldBoundaries', 'folds');
    if (net.foldBoundaries.length !== 0) {
        fail('INVALID_NET', 'detached components cannot be represented as planar fold boundaries');
    }
    validateBoundaryList(net, 'cutBoundaries', layoutOptions.tolerance);
    requireAliasMatch(net, 'seamBoundaries', 'cutBoundaries', 'seamBoundaries');
    requireAliasMatch(net, 'cuts', 'cutBoundaries', 'cuts');
    requireAliasMatch(net, 'seams', 'cutBoundaries', 'seams');
    requireAliasMatch(net, 'cutSeams', 'cutBoundaries', 'cutSeams');
    if (net.cutBoundaries.length !== 1) fail('INVALID_NET', `${primitiveKey} must have one paired cut seam record`);
    const seam = net.cutBoundaries[0];
    if (seam.seam !== true || !Array.isArray(seam.sides) || seam.sides.length !== 2) {
        fail('INVALID_NET', `${primitiveKey} seam must explicitly contain two matching sides`);
    }
    const expectedSeamLength = primitiveKey === 'cylinder' ? params.height : params.slantHeight;
    if (!numbersClose(seam.length, expectedSeamLength, layoutOptions.tolerance)
        || seam.sides.some((side) => !numbersClose(side.length, expectedSeamLength, layoutOptions.tolerance))) {
        fail('INVALID_NET', `${primitiveKey} seam side lengths drifted`);
    }
    if (primitiveKey === 'cylinder') {
        if (seam.edge !== 'left-short-edge'
            || seam.sides.map((side) => side.edge).sort().join('|') !== 'left-short-edge|right-short-edge'
            || seam.sides.some((side) => side.type !== 'rectangle-edge')) {
            fail('INVALID_NET', 'cylinder seam must pair the two rectangle short edges');
        }
    } else if (seam.edge !== 'paired-radial-edges'
        || seam.sides.map((side) => side.edge).sort().join('|') !== 'end-radial-edge|start-radial-edge'
        || seam.sides.some((side) => side.type !== 'sector-radial-edge')) {
        fail('INVALID_NET', 'cone seam must pair the two sector radial edges');
    }
    validatePrimitiveAssemblyTopology(net, params, primitiveKey, layoutOptions.tolerance);
    return true;
}

/**
 * Build a deterministic, deeply frozen exact development for a cylinder or
 * cone.  `params` accepts radius/height (or r/h aliases); all coordinates are
 * model units and no renderer objects are created.
 */
export function buildCurvedPrimitiveNet(input, options = {}) {
    if (!isRecord(input)) fail('INVALID_INPUT', 'input must be an object with primitiveKey and params');
    const primitiveKey = normalizePrimitiveKey(input.primitiveKey);
    if (UNSUPPORTED_EXACT_PRIMITIVES.has(primitiveKey)) {
        fail(
            'UNSUPPORTED_EXACT_NET',
            `${primitiveKey} has no exact finite planar net: its curved surface cannot be flattened without distortion; cuts alone do not make it developable`,
            {
                primitiveKey,
                diagnostic: 'No exact finite planar net exists because a sphere or hemisphere cannot be flattened without distortion; cuts alone do not make this curved surface developable.',
            }
        );
    }
    if (!SUPPORTED_PRIMITIVES.has(primitiveKey)) {
        fail('UNSUPPORTED_PRIMITIVE', `unsupported curved primitive ${primitiveKey}`);
    }
    const normalizedOptions = normalizeOptions(options);
    const params = normalizeParams(input.params, primitiveKey);
    const net = primitiveKey === 'cylinder'
        ? cylinderNet(params, normalizedOptions)
        : coneNet(params, normalizedOptions);
    freezeDeep(net);
    // Validate the generated result before handing it to consumers.  The
    // generated object is already frozen, so the validator also proves bounds,
    // identities, and non-overlap at construction time.
    validateCurvedPrimitiveNet(net, normalizedOptions);
    return net;
}

export const CURVED_NET_CONSTANTS = Object.freeze({
    TAU,
    DEFAULT_GAP,
    DEFAULT_PATH_SEGMENTS,
    DEFAULT_TOLERANCE,
});
