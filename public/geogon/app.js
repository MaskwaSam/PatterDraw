// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 MaskwaSam <136355328+MaskwaSam@users.noreply.github.com>

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
    buildPolyhedralTopology,
    PolyhedralTopologyError
} from './geometry/solid-topology.js';
import {
    fitProjectedBounds,
    getProjectedBounds,
    mapProjectedPointToViewport,
    projectTopologyToView
} from './geometry/orthographic-views.js';
import {
    CurvedOrthographicError,
    projectCurvedPrimitiveToView
} from './geometry/curved-orthographic.js';
import { buildPolyhedralNet } from './geometry/net-layout.js';
import { buildCurvedPrimitiveNet, CurvedNetLayoutError } from './geometry/curved-net-layout.js';
import { buildCompositeExteriorTopology, CompositeTopologyError } from './geometry/composite-topology.js';

const APP_NAME = '3DGeoGon';
const EMBED_QUERY_KEY = 'embed';
const EMBED_AUTOFIT_QUERY_KEY = 'autofit';
const EMBED_TITLE_QUERY_KEY = 'title';
const EMBED_ZOOM_QUERY_KEY = 'zoom';
const EXPORT_FORMAT_VERSION = 1;
const LABEL_BADGE_BACKGROUND_COLOR = '#4FC3D7';
const EDGE_LABEL_BACKGROUND_COLOR = '#FFCA3A';
const AUTO_TURN_RIGHT_SPEED = -2.4;
const EMBED_FIT_PADDING_NDC = 0.1;
const EMBED_MIN_HEIGHT = 180;
const EMBED_MAX_HEIGHT = 900;
const EMBED_MIN_WIDTH = 320;
const EMBED_DEFAULT_TITLE = `${APP_NAME} diagram`;
const EMBED_MAX_TITLE_LENGTH = 120;
const EMBED_MAX_VARS_LENGTH = 2000;
const EMBED_MAX_VAR_VALUE_LENGTH = 120;
const SHARE_MAX_PAYLOAD_LENGTH = 12000;
const SHARE_MAX_ENCODED_BYTES = 12000;
const SHARE_MAX_DECODED_BYTES = 250000;
const SHARE_MAX_DECOMPRESSED_BYTES = 500000;
const MAX_SCENE_OBJECTS = 1000;
const MAX_SCENE_OBJECT_ID = Number.MAX_SAFE_INTEGER - 1;
const MAX_SLOT_ID = Number.MAX_SAFE_INTEGER;
const MAX_JSON_IMPORT_BYTES = 5 * 1024 * 1024;
const DERIVED_POINT_PROXIMITY_THRESHOLD = 0.02;
const DOWNLOAD_RESOURCE_CLEANUP_DELAY_MS = 60_000;
const SCENE_OBJECT_KINDS_BY_TYPE = Object.freeze({
    segment: new Set(['segment']),
    triangle: new Set(['triangle']),
    angle: new Set(['angle']),
    plane: new Set(['plane', 'base-highlight']),
    label: new Set([
        'edge-label',
        'length-label',
        'point-label',
        'shape-label',
        'midpoint-point',
        'ratio-point'
    ])
});

const titleScreen = document.getElementById('title-screen');
const mainApp = document.getElementById('main-app');
const startBtn = document.getElementById('start-btn');
const helpOverlay = document.getElementById('help-overlay');
const helpButton = document.getElementById('help-button');
const closeHelpBtn = document.getElementById('close-help-btn');
const helpSection = helpOverlay?.querySelector('.help-section');
const startupErrorOverlay = document.getElementById('startup-error-overlay');
const startupErrorMessage = document.getElementById('startup-error-message');
const startupErrorRetry = document.getElementById('startup-error-retry');
let appInitialized = false;
let threeDGeoGonApp = null;
let helpReturnFocus = null;
let activeCustomModalDismiss = null;

function getFocusableElements(container) {
    if (!container) return [];
    const selector = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    return [...container.querySelectorAll(selector)].filter((element) => (
        !element.hidden
        && element.getAttribute('aria-hidden') !== 'true'
        && element.getClientRects().length > 0
    ));
}

function trapFocusWithin(event, container) {
    if (event.key !== 'Tab') return false;
    const focusable = getFocusableElements(container);
    if (focusable.length === 0) {
        event.preventDefault();
        return true;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!container.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
        return true;
    }
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return true;
    }
    if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
        return true;
    }
    return false;
}

function restoreFocus(element) {
    if (element instanceof HTMLElement && element.isConnected) {
        element.focus({ preventScroll: true });
    }
}

function openHelp() {
    helpReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : helpButton;
    threeDGeoGonApp?._keysHeld?.clear();
    helpOverlay.classList.add('show');
    helpOverlay.setAttribute('aria-hidden', 'false');
    mainApp.inert = true;
    window.requestAnimationFrame(() => {
        if (helpOverlay.classList.contains('show')) {
            closeHelpBtn?.focus();
        }
    });
}

function closeHelp({ restore = true } = {}) {
    if (!helpOverlay.classList.contains('show')) return;
    helpOverlay.classList.remove('show');
    helpOverlay.setAttribute('aria-hidden', 'true');
    mainApp.inert = false;
    if (restore) {
        restoreFocus(helpReturnFocus || helpButton);
    }
    helpReturnFocus = null;
}

function setActualVH() {
    document.documentElement.style.setProperty('--actual-vh', `${window.innerHeight}px`);
}

function supportsWebGL2() {
    try {
        const probeCanvas = document.createElement('canvas');
        const context = probeCanvas.getContext('webgl2');
        if (!context) return false;
        return true;
    } catch {
        return false;
    }
}

function hideStartupError() {
    startupErrorOverlay.hidden = true;
    startupErrorMessage.textContent = '';
    document.documentElement.classList.remove('startup-failed');
    titleScreen.inert = false;
    mainApp.inert = false;
}

function showStartupError(message) {
    startupErrorMessage.textContent = message;
    startupErrorOverlay.hidden = false;
    document.documentElement.classList.add('startup-failed');
    titleScreen.classList.remove('hidden');
    mainApp.style.display = 'none';
    titleScreen.inert = true;
    mainApp.inert = true;
    window.requestAnimationFrame(() => startupErrorRetry.focus());
}

function startApp() {
    hideStartupError();
    document.documentElement.classList.toggle('embed-mode', isEmbedMode());

    if (!appInitialized && !supportsWebGL2()) {
        showStartupError('3DGeoGon requires WebGL 2, but this browser or device does not provide it. Try an updated browser or a newer device.');
        return;
    }

    titleScreen.classList.add('hidden');
    mainApp.style.display = 'block';

    if (!appInitialized) {
        let candidate = null;
        try {
            candidate = new ThreeDGeoGonApp({ deferInitialize: true });
            candidate.initialize();
            threeDGeoGonApp = candidate;
            window.threeDGeoGonApp = threeDGeoGonApp;
            appInitialized = true;
        } catch (error) {
            console.error('Failed to start the 3D renderer:', error);
            try {
                candidate?.cleanup();
            } catch (cleanupError) {
                console.error('Failed to clean up the incomplete 3D renderer:', cleanupError);
            }
            threeDGeoGonApp = null;
            window.threeDGeoGonApp = null;
            appInitialized = false;
            showStartupError('3DGeoGon could not start its 3D renderer. Reload the page or try an updated browser.');
        }
    }
}

function hasSharedStateInUrl() {
    const hash = window.location.hash || '';
    if (!hash.startsWith('#')) return false;
    const params = new URLSearchParams(hash.slice(1));
    return !!params.get(SHARE_HASH_KEY);
}

function isEmbedMode() {
    const params = new URLSearchParams(window.location.search || '');
    const value = params.get(EMBED_QUERY_KEY);
    return value === '1' || value === 'true';
}

function isEmbedAutoFitEnabled() {
    const params = new URLSearchParams(window.location.search || '');
    const value = params.get(EMBED_AUTOFIT_QUERY_KEY);
    return value == null || value === '' || value === '1' || value === 'true';
}

function isEmbedZoomEnabled() {
    const params = new URLSearchParams(window.location.search || '');
    const value = params.get(EMBED_ZOOM_QUERY_KEY);
    return value == null || value === '' || value === '1' || value === 'true';
}

function getEmbedTitleFromUrl() {
    const params = new URLSearchParams(window.location.search || '');
    const title = (params.get(EMBED_TITLE_QUERY_KEY) || EMBED_DEFAULT_TITLE).trim();
    return title.slice(0, EMBED_MAX_TITLE_LENGTH) || EMBED_DEFAULT_TITLE;
}

function syncEmbedModeClass() {
    document.documentElement.classList.toggle('embed-mode', isEmbedMode());
}

function restartTitleAnimation() {
    const titleGoodie = titleScreen.querySelector('.title-goodie');
    if (!titleGoodie) return;

    const resetGoodie = titleGoodie.cloneNode(true);
    titleGoodie.replaceWith(resetGoodie);
}

function returnToTitleScreen() {
    hideStartupError();
    closeHelp({ restore: false });
    titleScreen.classList.remove('hidden');
    restartTitleAnimation();
    mainApp.style.display = 'none';
    if (threeDGeoGonApp) {
        threeDGeoGonApp.closeAddDropdown();
        threeDGeoGonApp.cleanup();
        threeDGeoGonApp = null;
        window.threeDGeoGonApp = null;
    }
    appInitialized = false;
}

syncEmbedModeClass();
setActualVH();
window.addEventListener('resize', setActualVH);
window.addEventListener('orientationchange', () => window.setTimeout(setActualVH, 100));
window.addEventListener('pageshow', () => window.setTimeout(setActualVH, 0));

startBtn.addEventListener('click', startApp);
startupErrorRetry.addEventListener('click', startApp);
startupErrorOverlay.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
        event.preventDefault();
        startupErrorRetry.focus();
    }
});
document.getElementById('return-to-title')?.addEventListener('click', returnToTitleScreen);
helpButton?.addEventListener('click', openHelp);
closeHelpBtn?.addEventListener('click', () => closeHelp());
helpOverlay.addEventListener('click', (event) => {
    if (event.target === helpOverlay) {
        closeHelp();
    }
});
helpOverlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeHelp();
        return;
    }
    const scrollAmounts = {
        ArrowDown: 48,
        ArrowUp: -48,
        PageDown: Math.max(120, (helpSection?.clientHeight || 0) * 0.8),
        PageUp: -Math.max(120, (helpSection?.clientHeight || 0) * 0.8),
    };
    if (helpSection && Object.prototype.hasOwnProperty.call(scrollAmounts, event.key)) {
        event.preventDefault();
        event.stopPropagation();
        helpSection.scrollBy({ top: scrollAmounts[event.key], behavior: 'smooth' });
        return;
    }
    if (helpSection && (event.key === 'Home' || event.key === 'End')) {
        event.preventDefault();
        event.stopPropagation();
        helpSection.scrollTo({ top: event.key === 'Home' ? 0 : helpSection.scrollHeight, behavior: 'smooth' });
        return;
    }
    trapFocusWithin(event, helpOverlay);
});

document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.code === 'Space' && !appInitialized) {
        event.preventDefault();
        startApp();
    } else if (event.code === 'Escape') {
        if (activeCustomModalDismiss) {
            event.preventDefault();
            event.stopPropagation();
            activeCustomModalDismiss();
            return;
        }

        if (threeDGeoGonApp?.isCrashReportOpen?.()) {
            threeDGeoGonApp.closeCrashReport();
            return;
        }

        if (threeDGeoGonApp?.isTwoDViewsOpen?.()) {
            threeDGeoGonApp.closeTwoDViews();
            return;
        }

        if (threeDGeoGonApp?.isTriangleExtractionOpen?.()) {
            threeDGeoGonApp.closeTriangleExtraction();
            return;
        }

        if (helpOverlay.classList.contains('show')) {
            closeHelp();
            return;
        }

        if (threeDGeoGonApp?.addDropdown?.style.display === 'block') {
            threeDGeoGonApp.closeAddDropdown({ restoreFocus: true });
            return;
        }

        if (appInitialized) {
            returnToTitleScreen();
        }
    }
});

window.addEventListener('load', () => {
    if (!appInitialized && (hasSharedStateInUrl() || isEmbedMode())) {
        startApp();
    }
});

function normalizeTriangularPrismMode(mode) {
    return mode === 'equilateral' ? 'isosceles' : (mode || 'isosceles');
}

function getTriangularPrismProfilePoints(params, zPos) {
    const { legA, legB } = params;
    const mode = normalizeTriangularPrismMode(params.triangleMode);

    if (mode === 'isosceles') {
        return [
            new THREE.Vector3(-legA / 2, -legB / 2, zPos),
            new THREE.Vector3(legA / 2, -legB / 2, zPos),
            new THREE.Vector3(0, legB / 2, zPos)
        ];
    }

    if (mode === 'right-above-B') {
        return [
            new THREE.Vector3(0, -legB / 2, zPos),
            new THREE.Vector3(legA, -legB / 2, zPos),
            new THREE.Vector3(legA, legB / 2, zPos)
        ];
    }

    return [
        new THREE.Vector3(0, -legB / 2, zPos),
        new THREE.Vector3(legA, -legB / 2, zPos),
        new THREE.Vector3(0, legB / 2, zPos)
    ];
}

function getTriangleCentroid(a, b, c) {
    return new THREE.Vector3(
        (a.x + b.x + c.x) / 3,
        (a.y + b.y + c.y) / 3,
        (a.z + b.z + c.z) / 3
    );
}

function normalizeTetrahedronBaseMode(mode) {
    return mode || 'isosceles';
}

function getEquilateralTriangleHeight(base) {
    return (Math.sqrt(3) / 2) * base;
}

function getTetrahedronBaseTriangleHeight(params) {
    return normalizeTetrahedronBaseMode(params.baseTriangleMode) === 'equilateral'
        ? getEquilateralTriangleHeight(params.base)
        : params.triangleHeight;
}

function getTetrahedronBasePoints(params, yPos) {
    const { base } = params;
    const triangleHeight = getTetrahedronBaseTriangleHeight(params);
    const mode = normalizeTetrahedronBaseMode(params.baseTriangleMode);

    if (mode === 'right-angled') {
        if (params.baseMirror) {
            return [
                new THREE.Vector3(base / 3, yPos, -triangleHeight / 3),
                new THREE.Vector3((-2 * base) / 3, yPos, -triangleHeight / 3),
                new THREE.Vector3(base / 3, yPos, (2 * triangleHeight) / 3)
            ];
        }

        return [
            new THREE.Vector3(-base / 3, yPos, -triangleHeight / 3),
            new THREE.Vector3((2 * base) / 3, yPos, -triangleHeight / 3),
            new THREE.Vector3(-base / 3, yPos, (2 * triangleHeight) / 3)
        ];
    }

    return [
        new THREE.Vector3(-base / 2, yPos, -triangleHeight / 3),
        new THREE.Vector3(base / 2, yPos, -triangleHeight / 3),
        new THREE.Vector3(0, yPos, (2 * triangleHeight) / 3)
    ];
}

function getTetrahedronPointMap(params) {
    const yBase = -params.height / 2;
    const yApex = params.height / 2;
    const [baseA, baseB, baseC] = getTetrahedronBasePoints(params, yBase);
    const apexTargetKey = params.apexPosition || 'A';
    const apexTargets = {
        A: baseA,
        B: baseB,
        C: baseC,
        center: getTriangleCentroid(baseA, baseB, baseC)
    };
    const apexAnchor = apexTargets[apexTargetKey] || baseA;

    return {
        A: baseA,
        B: baseB,
        C: baseC,
        D: new THREE.Vector3(apexAnchor.x, yApex, apexAnchor.z)
    };
}

const POINT_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const APOTHEM_LINE_COLOR = 0xffb000;

const POLYGONAL_PRIMITIVES = {
    'pentagonal-prism': { sides: 5, kind: 'prism', label: 'Pentagonal Prism' },
    'pentagonal-pyramid': { sides: 5, kind: 'pyramid', label: 'Pentagonal Pyramid' },
    'hexagonal-prism': { sides: 6, kind: 'prism', label: 'Hexagonal Prism' },
    'hexagonal-pyramid': { sides: 6, kind: 'pyramid', label: 'Hexagonal Pyramid' },
    'septagonal-prism': { sides: 7, kind: 'prism', label: 'Septagonal Prism' },
    'septagonal-pyramid': { sides: 7, kind: 'pyramid', label: 'Septagonal Pyramid' },
    'octagonal-prism': { sides: 8, kind: 'prism', label: 'Octagonal Prism' },
    'octagonal-pyramid': { sides: 8, kind: 'pyramid', label: 'Octagonal Pyramid' }
};

const PRISM_PRIMITIVE_KEYS = [
    'right-triangle-prism',
    'pentagonal-prism',
    'hexagonal-prism',
    'septagonal-prism',
    'octagonal-prism'
];

const PYRAMID_PRIMITIVE_KEYS = [
    'rectangular-pyramid',
    'pentagonal-pyramid',
    'hexagonal-pyramid',
    'septagonal-pyramid',
    'octagonal-pyramid'
];

function getPolygonalPrimitiveConfig(primitiveKey) {
    return POLYGONAL_PRIMITIVES[primitiveKey] || null;
}

function getRegularPolygonFaceType(sides) {
    return `regular-${sides}-gon`;
}

function getRegularPolygonRadiusFromSide(sideLength, sides) {
    return sideLength / (2 * Math.sin(Math.PI / sides));
}

function getRegularPolygonLocalPoints(sides, sideLength, yPos) {
    const radius = getRegularPolygonRadiusFromSide(sideLength, sides);
    return Array.from({ length: sides }, (_, index) => {
        const angle = (Math.PI / 2) - (index * Math.PI * 2 / sides);
        return new THREE.Vector3(
            radius * Math.cos(angle),
            yPos,
            radius * Math.sin(angle)
        );
    });
}

function getRegularPolygonSideLabel(index, sides) {
    return `${POINT_LABELS[index]}${POINT_LABELS[(index + 1) % sides]}`;
}

function makeRegularPolygonBaseFace(sides, id, normalY, yAccessor, label) {
    return {
        id,
        type: getRegularPolygonFaceType(sides),
        normal: new THREE.Vector3(0, normalY, 0),
        uAxis: new THREE.Vector3(1, 0, 0),
        center: (p) => new THREE.Vector3(0, yAccessor(p), 0),
        dims: ['sideLength'],
        label
    };
}

function makeRegularPolygonPrismSideFace(sides, index) {
    const nextIndex = (index + 1) % sides;
    return {
        id: `side-${index}`,
        type: 'rectangle',
        normal: (p) => {
            const points = getRegularPolygonLocalPoints(sides, p.sideLength, 0);
            const midpoint = points[index].clone().add(points[nextIndex]).multiplyScalar(0.5);
            return new THREE.Vector3(midpoint.x, 0, midpoint.z).normalize();
        },
        uAxis: (p) => {
            const points = getRegularPolygonLocalPoints(sides, p.sideLength, 0);
            return points[nextIndex].clone().sub(points[index]).normalize();
        },
        center: (p) => {
            const points = getRegularPolygonLocalPoints(sides, p.sideLength, 0);
            return points[index].clone().add(points[nextIndex]).multiplyScalar(0.5);
        },
        dims: ['sideLength', 'height'],
        label: `Side Face ${getRegularPolygonSideLabel(index, sides)}`
    };
}

function makeRegularPolygonPrismAttachmentFaces(sides) {
    return [
        makeRegularPolygonBaseFace(sides, 'top', 1, (p) => p.height / 2, 'Top'),
        makeRegularPolygonBaseFace(sides, 'bottom', -1, (p) => -p.height / 2, 'Bottom'),
        ...Array.from({ length: sides }, (_, index) => makeRegularPolygonPrismSideFace(sides, index))
    ];
}

function makeRegularPolygonPyramidAttachmentFaces(sides) {
    return [
        makeRegularPolygonBaseFace(sides, 'base', -1, (p) => -p.height / 2, 'Base')
    ];
}

function buildRegularPolygonPrismDefinition(sides, params) {
    const { sideLength, height } = params;
    const showApothem = params.showApothem !== false;
    const showBaseCenters = params.showBaseCenters !== false;
    const yBottom = -height / 2;
    const yTop = height / 2;
    const bottom = getRegularPolygonLocalPoints(sides, sideLength, yBottom);
    const top = getRegularPolygonLocalPoints(sides, sideLength, yTop);
    const vertices = [];
    [...bottom, ...top].forEach((point) => vertices.push(point.x, point.y, point.z));

    const indices = [];
    for (let index = 1; index < sides - 1; index += 1) {
        indices.push(0, index + 1, index);
        indices.push(sides, sides + index, sides + index + 1);
    }
    for (let index = 0; index < sides; index += 1) {
        const nextIndex = (index + 1) % sides;
        indices.push(index, nextIndex, sides + nextIndex);
        indices.push(index, sides + nextIndex, sides + index);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const bottomLabels = POINT_LABELS.slice(0, sides);
    const topLabels = POINT_LABELS.slice(sides, sides * 2);
    const bottomCenter = new THREE.Vector3(0, yBottom, 0);
    const topCenter = new THREE.Vector3(0, yTop, 0);
    const bottomApothemFoot = bottom[0].clone().add(bottom[1]).multiplyScalar(0.5);
    const topApothemFoot = top[0].clone().add(top[1]).multiplyScalar(0.5);
    const points = [
        ...bottom.map((position, index) => ({
            id: bottomLabels[index],
            label: bottomLabels[index],
            description: `bottom vertex ${bottomLabels[index]}`,
            position
        })),
        ...top.map((position, index) => ({
            id: topLabels[index],
            label: topLabels[index],
            description: `top vertex ${topLabels[index]}`,
            position
        })),
        ...(showBaseCenters ? [
            { id: 'O1', label: 'O1', description: 'bottom base centre', position: bottomCenter },
            { id: 'O2', label: 'O2', description: 'top base centre', position: topCenter }
        ] : []),
        ...(showApothem ? [
            { id: 'M1', label: 'M1', description: 'bottom apothem midpoint', position: bottomApothemFoot },
            { id: 'M2', label: 'M2', description: 'top apothem midpoint', position: topApothemFoot }
        ] : [])
    ];

    return {
        geometry,
        points,
        guideSegments: showApothem
            ? [
                [bottomCenter, bottomApothemFoot],
                [topCenter, topApothemFoot]
            ]
            : [],
        boundsRadius: Math.max(getRegularPolygonRadiusFromSide(sideLength, sides) * 2, height) * 1.2
    };
}

function buildRegularPolygonPyramidDefinition(sides, params) {
    const { sideLength, height } = params;
    const showApothem = params.showApothem !== false;
    const yBase = -height / 2;
    const yApex = height / 2;
    const base = getRegularPolygonLocalPoints(sides, sideLength, yBase);
    const apex = new THREE.Vector3(0, yApex, 0);
    const baseCenter = new THREE.Vector3(0, yBase, 0);
    const apothemFoot = base[0].clone().add(base[1]).multiplyScalar(0.5);
    const vertices = [];
    [...base, apex].forEach((point) => vertices.push(point.x, point.y, point.z));

    const apexIndex = sides;
    const indices = [];
    for (let index = 1; index < sides - 1; index += 1) {
        indices.push(0, index + 1, index);
    }
    for (let index = 0; index < sides; index += 1) {
        const nextIndex = (index + 1) % sides;
        indices.push(index, nextIndex, apexIndex);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const baseLabels = POINT_LABELS.slice(0, sides);
    const apexLabel = POINT_LABELS[sides];
    const points = [
        ...base.map((position, index) => ({
            id: baseLabels[index],
            label: baseLabels[index],
            description: `base vertex ${baseLabels[index]}`,
            position
        })),
        { id: apexLabel, label: apexLabel, description: 'apex', position: apex },
        ...(showApothem ? [
            { id: 'O', label: 'O', description: 'base centre', position: baseCenter },
            { id: 'M', label: 'M', description: 'base apothem midpoint', position: apothemFoot }
        ] : [])
    ];

    return {
        geometry,
        points,
        guideSegments: [],
        boundsRadius: Math.max(getRegularPolygonRadiusFromSide(sideLength, sides) * 2, height) * 1.2
    };
}

const SHARE_STATE_VERSION = 1;
const SHARE_HASH_KEY = 'state';
const MAX_SHARE_URL_LENGTH = 7000;
const LOCAL_STATE_KEY = '3DGeoGon-local-state-v1';
const LOCAL_STATE_SUPPRESS_SIGNATURE_KEY = '3DGeoGon-local-state-suppress-signature-v1';
const LEGACY_LOCAL_STATE_KEY = 'tripatterson-local-state-v1';
const LEGACY_LOCAL_STATE_SUPPRESS_SIGNATURE_KEY = 'tripatterson-local-state-suppress-signature-v1';
const LOCAL_STATE_SAVE_DEBOUNCE_MS = 450;

const BUILT_IN_EXAMPLES = [
    {
        name: 'Roofed Block',
        payload: 'g.H4sIAAAAAAACE5WSyW4bMQyG34VnBfCkbRL42BQFfCiyOLciB1piZlRoREGL48Dwu5eSnMVALrlJP7f_E7WHLcVk2cNyUFAsLPcQ0JO7CSRajoUOCjTOFLHFONnc0v8OC3WlhvNHBRnjSFmkhRrU4lEKHG7IpVqwwUQSkSxD0W7J1ItkBLY-t4zJGkN-zSVqWpnUk7v4q5es7egxl0jHYO15zY5jOun8LlXLPDevVEd42uW147yS6d8UJDnWvD1Y07hDtLNgbSUZdNmwyAo4WvIZOy2kjN5grIGAEedm_dmaPMHysloI9fRdnJMdJ3mMHwqs164Y-o2arqWVPPQfNnUGPz2BeJw4vdnyxbmu1PR3BXNGPX2m3XM3d1cwSu-HEr2YWhxUxzo_xYqkhWAsDuNZeBGATxgx0O6shBNER348Mh5pPzBeqFZz-_YpQDdO6ZAmfv5Z99SF15_0EXk45YXMdfTXgeu6efNPANPrsm_a9ThEs08yXtfa9kdW3tBOKmVDmeb-Yw7_AWErv4IKAwAA',
    },
    {
        name: 'Cylinder and Cone',
        payload: 'g.H4sIAAAAAAACE5VSTU9CMRD8Lz1Xw8NIIlfUhBNRvBkOS7vh1fR1m34ghvDf3baIAT1o3qWdnc7O7L692GKIhpyYdlJkI6Z74cGhXXhkLIWMBykUDBig1iiaVOmvd3Iiu_FKigRhg4mRkeRvxXwLa7Sx8NcQkSvM0hjMFnW5MMOTcakyeqM1uiXloHCuYyM38L49WZqNg5QDHotFc0aWQjxT_oaKYxqqVSwtHO7S0lKac_cbKSIfC28vjK6xfTADp9oyWagPaxwrCikoGHQJWtwyp2QUWC54CDBU8wG0yXwaX9-yaTSbnucw4RY9vc_4MevUGTbkwekGxtNke4onay5b25BHKLP4QiAlUP1v2DM1e08ZAsu-5OBYenSQLdr4Iho5_BELPO6usv9Dqgu33blVkaiI_N9r2Rat31C136HsalGvxybsOvKwVHlbVzzn9ez4pRS83qEt_PAJe1LsScgCAAA',
    },
];
const ATTACHMENT_FACES = {
    cuboid: [
        { id: 'top',    type: 'rectangle', normal: new THREE.Vector3(0, 1, 0),   uAxis: new THREE.Vector3(1, 0, 0), center: (p) => new THREE.Vector3(0, p.height / 2, 0),   dims: ['width', 'depth'],  label: 'Top' },
        { id: 'bottom', type: 'rectangle', normal: new THREE.Vector3(0, -1, 0),  uAxis: new THREE.Vector3(1, 0, 0), center: (p) => new THREE.Vector3(0, -p.height / 2, 0),  dims: ['width', 'depth'],  label: 'Bottom' },
        { id: 'front',  type: 'rectangle', normal: new THREE.Vector3(0, 0, 1),   uAxis: new THREE.Vector3(1, 0, 0), center: (p) => new THREE.Vector3(0, 0, p.depth / 2),     dims: ['width', 'height'], label: 'Front' },
        { id: 'back',   type: 'rectangle', normal: new THREE.Vector3(0, 0, -1),  uAxis: new THREE.Vector3(1, 0, 0), center: (p) => new THREE.Vector3(0, 0, -p.depth / 2),    dims: ['width', 'height'], label: 'Back' },
        { id: 'right',  type: 'rectangle', normal: new THREE.Vector3(1, 0, 0),   uAxis: new THREE.Vector3(0, 0, 1), center: (p) => new THREE.Vector3(p.width / 2, 0, 0),     dims: ['depth', 'height'], label: 'Right' },
        { id: 'left',   type: 'rectangle', normal: new THREE.Vector3(-1, 0, 0),  uAxis: new THREE.Vector3(0, 0, 1), center: (p) => new THREE.Vector3(-p.width / 2, 0, 0),    dims: ['depth', 'height'], label: 'Left' },
    ],
    'rectangular-pyramid': [
        { id: 'base',   type: 'rectangle', normal: new THREE.Vector3(0, -1, 0),  uAxis: new THREE.Vector3(1, 0, 0), center: (p) => new THREE.Vector3(0, -p.height / 2, 0),  dims: ['length', 'width'], label: 'Base' },
    ],
    cylinder: [
        { id: 'top',    type: 'circle',    normal: new THREE.Vector3(0, 1, 0),   center: (p) => new THREE.Vector3(0, p.height / 2, 0),   dims: ['radius'],          label: 'Top' },
        { id: 'bottom', type: 'circle',    normal: new THREE.Vector3(0, -1, 0),  center: (p) => new THREE.Vector3(0, -p.height / 2, 0),  dims: ['radius'],          label: 'Bottom' },
    ],
    cone: [
        { id: 'base',   type: 'circle',    normal: new THREE.Vector3(0, -1, 0),  center: (p) => new THREE.Vector3(0, -p.height / 2, 0),  dims: ['radius'],          label: 'Base' },
    ],
    hemisphere: [
        { id: 'flat',   type: 'circle',    normal: new THREE.Vector3(0, -1, 0),  center: (p) => new THREE.Vector3(0, -p.radius / 2, 0),  dims: ['radius'],          label: 'Flat Circular Face' },
    ],
    sphere: [],
    'right-triangle-prism': [
        {
            id: 'base-rectangle',
            type: 'rectangle',
            normal: (p) => {
                const mode = p.triangleMode === 'equilateral' ? 'isosceles' : (p.triangleMode || 'isosceles');
                if (mode === 'isosceles') {
                    return new THREE.Vector3(0, -1, 0);
                } else if (mode === 'right-above-B') {
                    return new THREE.Vector3(0, -1, 0);
                } else {
                    return new THREE.Vector3(0, -1, 0);
                }
            },
            uAxis: (p) => {
                const mode = p.triangleMode === 'equilateral' ? 'isosceles' : (p.triangleMode || 'isosceles');
                if (mode === 'isosceles') {
                    return new THREE.Vector3(1, 0, 0);
                } else if (mode === 'right-above-B') {
                    return new THREE.Vector3(1, 0, 0);
                } else {
                    return new THREE.Vector3(1, 0, 0);
                }
            },
            center: (p) => {
                const mode = p.triangleMode === 'equilateral' ? 'isosceles' : (p.triangleMode || 'isosceles');
                if (mode === 'isosceles') {
                    return new THREE.Vector3(0, -p.legB / 2, 0);
                } else if (mode === 'right-above-B') {
                    return new THREE.Vector3(p.legA / 2, -p.legB / 2, 0);
                } else {
                    return new THREE.Vector3(p.legA / 2, -p.legB / 2, 0);
                }
            },
            dims: (p) => {
                const mode = p.triangleMode === 'equilateral' ? 'isosceles' : (p.triangleMode || 'isosceles');
                if (mode === 'isosceles') {
                    return ['legA', 'length'];
                } else {
                    return ['legA', 'length'];
                }
            },
            label: 'Rectangular Face AB'
        },
        {
            id: 'side-rectangle',
            type: 'rectangle',
            normal: (p) => {
                const mode = p.triangleMode === 'equilateral' ? 'isosceles' : (p.triangleMode || 'isosceles');
                if (mode === 'isosceles') {
                    return new THREE.Vector3(-p.legB, p.legA / 2, 0).normalize();
                } else if (mode === 'right-above-B') {
                    return new THREE.Vector3(1, 0, 0);
                } else {
                    return new THREE.Vector3(-1, 0, 0);
                }
            },
            uAxis: new THREE.Vector3(0, 0, 1),
            center: (p) => {
                const mode = p.triangleMode === 'equilateral' ? 'isosceles' : (p.triangleMode || 'isosceles');
                if (mode === 'isosceles') {
                    return new THREE.Vector3(-p.legA / 4, 0, 0);
                } else if (mode === 'right-above-B') {
                    return new THREE.Vector3(p.legA, 0, 0);
                } else {
                    return new THREE.Vector3(0, 0, 0);
                }
            },
            dims: (p) => {
                const mode = p.triangleMode === 'equilateral' ? 'isosceles' : (p.triangleMode || 'isosceles');
                if (mode === 'isosceles') {
                    return ['length', 'isoscelesSide'];
                } else {
                    return ['length', 'legB'];
                }
            },
            label: 'Rectangular Face AC'
        },
        {
            id: 'hypotenuse-rectangle',
            type: 'rectangle',
            normal: (p) => {
                const mode = p.triangleMode === 'equilateral' ? 'isosceles' : (p.triangleMode || 'isosceles');
                if (mode === 'isosceles') {
                    return new THREE.Vector3(p.legB, p.legA / 2, 0).normalize();
                } else if (mode === 'right-above-B') {
                    return new THREE.Vector3(-p.legB, p.legA, 0).normalize();
                } else {
                    return new THREE.Vector3(p.legB, p.legA, 0).normalize();
                }
            },
            uAxis: new THREE.Vector3(0, 0, 1),
            center: (p) => {
                const mode = p.triangleMode === 'equilateral' ? 'isosceles' : (p.triangleMode || 'isosceles');
                if (mode === 'isosceles') {
                    return new THREE.Vector3(p.legA / 4, 0, 0);
                } else {
                    return new THREE.Vector3(p.legA / 2, 0, 0);
                }
            },
            dims: (p) => {
                const mode = p.triangleMode === 'equilateral' ? 'isosceles' : (p.triangleMode || 'isosceles');
                if (mode === 'isosceles') {
                    return ['length', 'isoscelesSide'];
                } else {
                    return ['length', 'hypotenuse'];
                }
            },
            label: 'Rectangular Face BC'
        },
        {
            id: 'front-triangle',
            type: 'triangle',
            normal: new THREE.Vector3(0, 0, 1),
            vertexIds: ['A', 'B', 'C'],
            uAxis: (p) => {
                const [a, b, c] = getTriangularPrismProfilePoints(p, p.length / 2);
                const centroid = getTriangleCentroid(a, b, c);
                return c.clone().sub(centroid).normalize();
            },
            center: (p) => {
                const [a, b, c] = getTriangularPrismProfilePoints(p, p.length / 2);
                return getTriangleCentroid(a, b, c);
            },
            dims: ['legA', 'legB'],
            label: 'Triangular Face ABC'
        },
        {
            id: 'back-triangle',
            type: 'triangle',
            normal: new THREE.Vector3(0, 0, -1),
            vertexIds: ['D', 'E', 'F'],
            uAxis: (p) => {
                const [a, b, c] = getTriangularPrismProfilePoints(p, -p.length / 2);
                const centroid = getTriangleCentroid(a, b, c);
                return c.clone().sub(centroid).normalize();
            },
            center: (p) => {
                const [a, b, c] = getTriangularPrismProfilePoints(p, -p.length / 2);
                return getTriangleCentroid(a, b, c);
            },
            dims: ['legA', 'legB'],
            label: 'Triangular Face DEF'
        },
    ],
    tetrahedron: [
        {
            id: 'base-triangle',
            type: 'triangle',
            normal: new THREE.Vector3(0, -1, 0),
            vertexIds: ['A', 'B', 'C'],
            uAxis: (p) => {
                const [baseA, baseB, baseC] = getTetrahedronBasePoints(p, -p.height / 2);
                const centroid = getTriangleCentroid(baseA, baseB, baseC);
                return baseC.clone().sub(centroid).normalize();
            },
            center: (p) => {
                const [baseA, baseB, baseC] = getTetrahedronBasePoints(p, -p.height / 2);
                return getTriangleCentroid(baseA, baseB, baseC);
            },
            dims: (p) => normalizeTetrahedronBaseMode(p.baseTriangleMode) === 'equilateral'
                ? ['base']
                : ['base', 'triangleHeight'],
            label: 'Base Triangle'
        },
    ],
    ...Object.fromEntries(Object.entries(POLYGONAL_PRIMITIVES).map(([primitiveKey, config]) => [
        primitiveKey,
        config.kind === 'prism'
            ? makeRegularPolygonPrismAttachmentFaces(config.sides)
            : makeRegularPolygonPyramidAttachmentFaces(config.sides)
    ]))
};

class ThreeDGeoGonApp {
    constructor({ deferInitialize = false } = {}) {
        this.canvas = document.getElementById('three-canvas');
        this.canvasContainer = this.canvas?.closest('.canvas-container') || this.canvas?.parentElement || null;
        this.canvasEmptyStateEl = null;
        if (this.canvasContainer) {
            const emptyState = document.createElement('div');
            emptyState.className = 'canvas-empty-state';
            emptyState.innerHTML = 'Use the <span class="inline-add-button" aria-hidden="true">+ Add</span> button to add up to 3 shapes to the diagram or choose an example diagram';
            this.canvasContainer.appendChild(emptyState);
            this.canvasEmptyStateEl = emptyState;
        }
        this.panelToggleBtn = document.getElementById('panel-toggle-btn');
        this.controlPanel = document.querySelector('.control-panel');
        this.pointsListEl = document.getElementById('points-list');
        this.selectionSummaryEl = document.getElementById('selection-summary');
        this.actionsListEl = document.getElementById('actions-list');
        this.objectSections = {
            triangles: { header: document.getElementById('triangles-section-header'), content: document.getElementById('triangles-section-content'), arrow: document.getElementById('triangles-section-arrow'), list: document.getElementById('triangles-list') },
            segments:  { header: document.getElementById('segments-section-header'),  content: document.getElementById('segments-section-content'),  arrow: document.getElementById('segments-section-arrow'),  list: document.getElementById('segments-list')  },
            angles:    { header: document.getElementById('angles-section-header'),    content: document.getElementById('angles-section-content'),    arrow: document.getElementById('angles-section-arrow'),    list: document.getElementById('angles-list')    },
            planes:    { header: document.getElementById('planes-section-header'),    content: document.getElementById('planes-section-content'),    arrow: document.getElementById('planes-section-arrow'),    list: document.getElementById('planes-list')    },
            baseHighlights: { header: document.getElementById('base-highlights-section-header'), content: document.getElementById('base-highlights-section-content'), arrow: document.getElementById('base-highlights-section-arrow'), list: document.getElementById('base-highlights-list') },
            labels:    { header: document.getElementById('labels-section-header'),    content: document.getElementById('labels-section-content'),    arrow: document.getElementById('labels-section-arrow'),    list: document.getElementById('labels-list')    },
        };
        Object.values(this.objectSections).forEach((section) => {
            section.title = section.header?.querySelector('h3') || null;
            section.baseTitle = section.title?.textContent || '';
        });
        this.primitiveSelect = document.getElementById('primitive-select');
        this.primitiveCardsListEl = document.getElementById('primitive-cards-list');
        this.primitiveChip = document.getElementById('primitive-chip');
        this.orientationChip = document.getElementById('orientation-chip');
        this.ghostToggleBtn = document.getElementById('ghost-toggle-btn');
        this.ghostWireIcon = document.getElementById('ghost-wire-icon');
        this.ghostSolidIcon = document.getElementById('ghost-solid-icon');
        this.labelBadgeToggleBtn = document.getElementById('label-badge-toggle-btn');
        this.labelPlainIcon = document.getElementById('label-plain-icon');
        this.labelBadgeIcon = document.getElementById('label-badge-icon');
        this.labelOffIcon = document.getElementById('label-off-icon');
        this.pointMarkerToggleBtn = document.getElementById('point-marker-toggle-btn');
        this.pointFilledIcon = document.getElementById('point-filled-icon');
        this.pointHollowIcon = document.getElementById('point-hollow-icon');
        this.gridToggleBtn = document.getElementById('grid-toggle-btn');
        this.gridIcon = document.getElementById('grid-icon');
        this.displaySizeToggleBtn = document.getElementById('display-size-toggle-btn');
        this.sizeSmallOption = document.getElementById('size-small');
        this.sizeLargeOption = document.getElementById('size-large');
        this.sizeXlargeOption = document.getElementById('size-xlarge');
        this.themeToggleBtn = document.getElementById('theme-toggle');
        this.lightIcon = document.getElementById('light-icon');
        this.darkIcon = document.getElementById('dark-icon');
        this.shareBtn = document.getElementById('share-button');
        this.exportJsonBtn = document.getElementById('export-json-btn');
        this.importJsonBtn = document.getElementById('import-json-btn');
        this.importJsonInput = document.getElementById('import-json-input');
        this.embedScriptBtn = document.getElementById('embed-script-btn');
        this.shareLinkBtn = document.getElementById('share-link-btn');
        this.copyJsonBtn = document.getElementById('copy-json-btn');
        this.exportPngBtn = document.getElementById('export-png-btn');
        this.exportSvgBtn = document.getElementById('export-svg-btn');
        this.copySvgHtmlBtn = document.getElementById('copy-svg-html-btn');
        this.openTwoDViewsBtn = document.getElementById('open-2d-views-btn');
        this.twoDViewsOverlay = document.getElementById('two-d-views-overlay');
        this.twoDViewsDialog = document.getElementById('two-d-views-dialog');
        this.twoDViewsTitle = document.getElementById('two-d-views-title');
        this.twoDViewsTabs = document.getElementById('two-d-views-tabs');
        this.twoDViewTabButtons = [...(this.twoDViewsTabs?.querySelectorAll('[data-view][role="tab"]') || [])];
        this.twoDViewsStage = document.getElementById('two-d-views-stage');
        this.twoDViewSvg = document.getElementById('two-d-view-svg');
        this.twoDViewsStatus = document.getElementById('two-d-views-status');
        this.twoDShowHiddenEdges = document.getElementById('two-d-show-hidden-edges');
        this.twoDShowHiddenEdgesLabel = this.twoDShowHiddenEdges?.closest('label') || null;
        this.twoDViewsCloseBtn = document.getElementById('two-d-views-close');
        this.twoDViewExportCurrentBtn = document.getElementById('two-d-view-export-current');
        this.twoDViewExportSheetBtn = document.getElementById('two-d-view-export-sheet');
        this.addBtn = document.getElementById('add-btn');
        this.addDropdown = document.getElementById('add-dropdown');
        this.primitiveSectionHeader = document.getElementById('primitive-section-header');
        this.primitiveSectionContent = document.getElementById('primitive-section-content');
        this.primitiveSectionArrow = document.getElementById('primitive-section-arrow');
        this.primitiveSectionTitle = this.primitiveSectionHeader?.querySelector('h3') || null;
        this.primitiveSectionBaseTitle = this.primitiveSectionTitle?.textContent || '';
        this.pointsSectionHeader = document.getElementById('points-section-header');
        this.pointsSectionContent = document.getElementById('points-section-content');
        this.pointsSectionArrow = document.getElementById('points-section-arrow');
        this.pointsSectionTitle = this.pointsSectionHeader?.querySelector('h3') || null;
        this.pointsSectionBaseTitle = this.pointsSectionTitle?.textContent || '';
        this.triangleExtractOverlay = document.getElementById('triangle-extract-overlay');
        this.triangleExtractModal = document.getElementById('triangle-extract-modal');
        this.triangleExtractTitle = document.getElementById('triangle-extract-title');
        this.triangleExtractSubtitle = document.getElementById('triangle-extract-subtitle');
        this.triangleExtractFlightSvg = document.getElementById('triangle-extract-flight-svg');
        this.triangleExtractFlightPolygon = document.getElementById('triangle-extract-flight-polygon');
        this.triangleExtractFlightOutline = document.getElementById('triangle-extract-flight-outline');
        this.triangleExtractSvg = document.getElementById('triangle-extract-svg');
        this.triangleExtractStage = document.getElementById('triangle-extract-stage');
        this.triangleExtractPolygon = document.getElementById('triangle-extract-polygon');
        this.triangleExtractOutline = document.getElementById('triangle-extract-outline');
        this.triangleExtractRightAngle = document.getElementById('triangle-extract-right-angle');
        this.triangleExtractRotateBtn = document.getElementById('triangle-extract-rotate');
        this.triangleExtractFlipBtn = document.getElementById('triangle-extract-flip');
        this.triangleExtractCloseBtn = document.getElementById('triangle-extract-close');
        this.triangleExtractLabelEls = {
            A: document.getElementById('triangle-extract-label-a'),
            B: document.getElementById('triangle-extract-label-b'),
            C: document.getElementById('triangle-extract-label-c'),
            D: document.getElementById('triangle-extract-label-d')
        };
        this.triangleExtractSideEls = {
            AB: document.getElementById('triangle-extract-side-ab'),
            BC: document.getElementById('triangle-extract-side-bc'),
            CA: document.getElementById('triangle-extract-side-ca'),
            CD: document.getElementById('triangle-extract-side-cd'),
            DA: document.getElementById('triangle-extract-side-da')
        };
        this.triangleExtractDynamicLabelsGroup = document.getElementById('triangle-extract-dynamic-labels-group');
        this.triangleExtractDynamicSideLabelsGroup = document.getElementById('triangle-extract-dynamic-side-labels-group');
        this.triangleExtractDynamicMarkersGroup = document.getElementById('triangle-extract-dynamic-markers-group');
        this.triangleExtractAnglesGroup = document.getElementById('triangle-extract-angles-group');

        this.embedMode = isEmbedMode();
        this.embedAutoFit = isEmbedAutoFitEnabled();
        this.embedZoomEnabled = !this.embedMode || isEmbedZoomEnabled();
        this.embedTitle = getEmbedTitleFromUrl();
        this.embedVariableValues = new Map();
        this.panelOpen = !this.embedMode;
        this.ghostFaces = true;
        this.pointMarkersVisible = true;
        this.labelMode = 'badge';
        this.gridVisible = true;
        this.displaySizeMode = this.getInitialDisplaySizeMode();
        this.themeMode = 'light';
        this.examplesAccordionCollapsed = true;
        this.primitiveGroupAccordionCollapsed = {
            prisms: true,
            pyramids: true
        };
        this.nextObjectId = 1;
        this.sceneObjects = [];
        this.selectedPoints = [];
        this.hiddenPointSourceIds = new Set();
        this.hiddenDerivedPointSignatures = new Set();
        this.pointDefinitions = [];
        this.derivedPoints = [];
        this.pointsHintDismissed = false;
        this.isRestoringSharedState = false;
        this.localStateReady = false;
        this.localStateSaveTimer = null;
        this.localStateViewOnlySaveBlocked = false;
        this.localStateSaveFailureNotified = false;
        this.pendingDownloadResources = new Map();
        this.isShuttingDown = false;
        this.localDeletedBaselineSignature = null;
        this.baseLabelOverrides = new Map();
        this.derivedLabelOverrides = new Map();
        this.basePointColorOverrides = new Map();
        this.derivedPointColorOverrides = new Map();
        this.pointMarkers = new Map();
        this.pointSprites = [];
        this.labelSprites = [];
        this.constructionLineMaterials = new Set();
        this.constructionPalette = [
            0xff595e,
            0xff924c,
            0xffca3a,
            0x8ac926,
            0x1982c4,
            0x6a4c93,
            0x00a878,
            0xe76f51,
            0x4fc3d7,
            0xf15bb5
        ];
        this.constructionColorIndex = 0;
        this.openSegmentColorPickerId = null;
        this.openLabelColorPickerId = null;
        this.openPointColorPickerId = null;
        this.autoTurnRightActive = false;
        this.embedViewportFitTimer = null;
        this.embedViewportFitInProgress = false;
        this.embedFrameAutoSizeDone = false;
        this.embedLastRequestedHeight = 0;
        this.objectGroupCollapsed = {
            triangles: true,
            segments: true,
            angles: true,
            planes: true,
            baseHighlights: true,
            labels: true
        };
        this.primitiveSectionCollapsed = false;
        this.pointsSectionCollapsed = false;
        this.activeTriangleExtraction = null;
        this.triangleExtractTransitionState = 'closed';
        this.lastFocusedElementBeforeTriangleExtract = null;
        this.triangleExtractSettleTimer = null;
        this.triangleExtractAnimationFrame = null;
        this.isIOSWebKit = this.detectIOSWebKit();
        this.triangleExtractRepaintNonce = 0;
        this.activeTwoDView = 'front';
        this.lastFocusedElementBeforeTwoDViews = null;
        this.controlsEnabledBeforeTwoDViews = true;
        this.autoTurnRightWasActiveBeforeTwoDViews = false;
        this.cameraStateBeforeTwoDViews = null;
        this.cameraAnimationBeforeTwoDViews = null;
        this.crashReportOverlay = document.getElementById('crash-report-overlay');
        this.crashReportPre = document.getElementById('crash-report-content');
        this.crashReportRefreshBtn = document.getElementById('crash-report-refresh');
        this.crashReportCopyBtn = document.getElementById('crash-report-copy');
        this.crashReportCloseBtn = document.getElementById('crash-report-close');
        this.crashReportEntries = [];
        this.maxCrashReportEntries = 140;
        this.crashReportOpenedAt = null;
        this.crashReportShortcut = 'Ctrl+Alt+Shift+K';
        this._crashListenersBound = false;
        this.crashWatchdogIntervalMs = 30000;
        this.crashWatchdogIntervalId = null;
        this.wasDiscardedAtLoad = document.wasDiscarded === true;
        this.lastIntegrityDigest = null;

        this.defaultParams = {
            cuboid: { width: 7, depth: 4, height: 5, includeFaceCentersMode: 'off' },
            'right-triangle-prism': { legA: 5, legB: 4, length: 7, triangleMode: 'isosceles' },
            'rectangular-pyramid': { length: 7, width: 5, height: 6, apexPosition: 'center', showBaseCenter: true },
            'pentagonal-prism': { sideLength: 3.5, height: 6, showApothem: true, showBaseCenters: true },
            'pentagonal-pyramid': { sideLength: 3.5, height: 6, showApothem: true },
            'hexagonal-prism': { sideLength: 3.2, height: 6, showApothem: true, showBaseCenters: true },
            'hexagonal-pyramid': { sideLength: 3.2, height: 6, showApothem: true },
            'septagonal-prism': { sideLength: 3, height: 6, showApothem: true, showBaseCenters: true },
            'septagonal-pyramid': { sideLength: 3, height: 6, showApothem: true },
            'octagonal-prism': { sideLength: 2.8, height: 6, showApothem: true, showBaseCenters: true },
            'octagonal-pyramid': { sideLength: 2.8, height: 6, showApothem: true },
            tetrahedron: { base: 6, triangleHeight: 4.5, height: 6, baseTriangleMode: 'isosceles', apexPosition: 'A', baseMirror: false },
            sphere: { radius: 3 },
            hemisphere: { radius: 3 },
            cylinder: { radius: 2.5, height: 6, showCenter: true, showEndCenters: true },
            cone: { radius: 2.5, height: 6 }
        };

        // compositeSlots: array of { id, primitive, orientation, params, hostSlotId, hostFaceId, attachFaceId, attachRotationQuarterTurns }
        this.compositeSlots = [];
        this.nextSlotId = 1;
        this.compositeGroup = null;
        this.slotGroupMap = new Map();   // slotId -> Three.js Group
        this.slotTopologyMap = new Map(); // slotId -> immutable world-space polyhedral topology
        this.slotCurvedDescriptorMap = new Map(); // slotId -> immutable world-space analytic curved-solid descriptor
        this.slotTopologyErrors = new Map(); // slotId -> unsupported/invalid topology diagnostic
        this.slotAttachmentFaceMap = new Map(); // guest slotId -> resolved host/guest attachment face IDs
        this.primitiveMeshes = [];       // one mesh per slot
        this.slotLinkages = [];          // { fromSlotId, fromParam, toSlotId, toParam }

        this.orientations = {
            cuboid: [
                { value: 'standard', label: 'Standard' }
            ],
            'right-triangle-prism': [
                { value: 'standard', label: 'Standard' }
            ],
            tetrahedron: [
                { value: 'standard', label: 'Standard' }
            ],
            sphere: [
                { value: 'standard', label: 'Standard' }
            ],
            hemisphere: [
                { value: 'standard', label: 'Standard' }
            ],
            cylinder: [
                { value: 'vertical', label: 'Vertical', chipLabel: 'Vert' },
                { value: 'horizontal', label: 'Horizontal', chipLabel: 'Horiz' }
            ],
            cone: [
                { value: 'apex-up', label: 'Apex Up', chipLabel: 'Apex Up' },
                { value: 'apex-down', label: 'Apex Down', chipLabel: 'Apex Dn' },
                { value: 'sideways-right', label: 'Sideways Right', chipLabel: 'Side' }
            ],
            'rectangular-pyramid': [
                { value: 'apex-up', label: 'Apex Up', chipLabel: 'Apex Up' },
                { value: 'apex-down', label: 'Apex Down', chipLabel: 'Apex Dn' }
            ],
            'pentagonal-prism': [
                { value: 'standard', label: 'Standard' }
            ],
            'pentagonal-pyramid': [
                { value: 'standard', label: 'Standard' }
            ],
            'hexagonal-prism': [
                { value: 'standard', label: 'Standard' }
            ],
            'hexagonal-pyramid': [
                { value: 'standard', label: 'Standard' }
            ],
            'septagonal-prism': [
                { value: 'standard', label: 'Standard' }
            ],
            'septagonal-pyramid': [
                { value: 'standard', label: 'Standard' }
            ],
            'octagonal-prism': [
                { value: 'standard', label: 'Standard' }
            ],
            'octagonal-pyramid': [
                { value: 'standard', label: 'Standard' }
            ]
        };

        this.rectangularPyramidApexPositions = [
            { value: 'center', label: 'Centre' },
            { value: 'A', label: 'Above A' },
            { value: 'B', label: 'Above B' },
            { value: 'C', label: 'Above C' },
            { value: 'D', label: 'Above D' }
        ];

        this.triangularPrismModes = [
            { value: 'isosceles', label: 'Isosceles' },
            { value: 'right-above-A', label: 'Right Angle at A' },
            { value: 'right-above-B', label: 'Right Angle at B' }
        ];

        this.tetrahedronTriangleModes = [
            { value: 'isosceles', label: 'Isosceles' },
            { value: 'right-angled', label: 'Right-Angled' },
            { value: 'equilateral', label: 'Equilateral' }
        ];

        this.tetrahedronApexPositions = [
            { value: 'A', label: 'Above A' },
            { value: 'B', label: 'Above B' },
            { value: 'C', label: 'Above C' },
            { value: 'center', label: 'Above Centre' }
        ];

        this.primitiveMeta = {
            cuboid: {
                label: 'Right Rectangular Prism',
                params: [
                    { key: 'width', label: 'Length', min: 2, max: 10, step: 0.5 },
                    { key: 'depth', label: 'Width', min: 2, max: 10, step: 0.5 },
                    { key: 'height', label: 'Height', min: 2, max: 10, step: 0.5 }
                ]
            },
            'right-triangle-prism': {
                label: 'Triangular Prism',
                params: [
                    { key: 'legA', label: 'Width', min: 2, max: 10, step: 0.5 },
                    { key: 'legB', label: 'Height', min: 2, max: 10, step: 0.5 },
                    { key: 'length', label: 'Length', min: 2, max: 12, step: 0.5 }
                ]
            },
            'rectangular-pyramid': {
                label: 'Rectangular Pyramid',
                params: [
                    { key: 'length', label: 'Length', min: 2, max: 12, step: 0.5 },
                    { key: 'width', label: 'Width', min: 2, max: 12, step: 0.5 },
                    { key: 'height', label: 'Height', min: 2, max: 10, step: 0.5 }
                ]
            },
            'pentagonal-prism': {
                label: 'Pentagonal Prism',
                params: [
                    { key: 'sideLength', label: 'Side Length', min: 1.5, max: 8, step: 0.25 },
                    { key: 'height', label: 'Height', min: 2, max: 12, step: 0.5 }
                ]
            },
            'pentagonal-pyramid': {
                label: 'Pentagonal Pyramid',
                params: [
                    { key: 'sideLength', label: 'Side Length', min: 1.5, max: 8, step: 0.25 },
                    { key: 'height', label: 'Height', min: 2, max: 12, step: 0.5 }
                ]
            },
            'hexagonal-prism': {
                label: 'Hexagonal Prism',
                params: [
                    { key: 'sideLength', label: 'Side Length', min: 1.5, max: 8, step: 0.25 },
                    { key: 'height', label: 'Height', min: 2, max: 12, step: 0.5 }
                ]
            },
            'hexagonal-pyramid': {
                label: 'Hexagonal Pyramid',
                params: [
                    { key: 'sideLength', label: 'Side Length', min: 1.5, max: 8, step: 0.25 },
                    { key: 'height', label: 'Height', min: 2, max: 12, step: 0.5 }
                ]
            },
            'septagonal-prism': {
                label: 'Septagonal Prism',
                params: [
                    { key: 'sideLength', label: 'Side Length', min: 1.5, max: 8, step: 0.25 },
                    { key: 'height', label: 'Height', min: 2, max: 12, step: 0.5 }
                ]
            },
            'septagonal-pyramid': {
                label: 'Septagonal Pyramid',
                params: [
                    { key: 'sideLength', label: 'Side Length', min: 1.5, max: 8, step: 0.25 },
                    { key: 'height', label: 'Height', min: 2, max: 12, step: 0.5 }
                ]
            },
            'octagonal-prism': {
                label: 'Octagonal Prism',
                params: [
                    { key: 'sideLength', label: 'Side Length', min: 1.5, max: 8, step: 0.25 },
                    { key: 'height', label: 'Height', min: 2, max: 12, step: 0.5 }
                ]
            },
            'octagonal-pyramid': {
                label: 'Octagonal Pyramid',
                params: [
                    { key: 'sideLength', label: 'Side Length', min: 1.5, max: 8, step: 0.25 },
                    { key: 'height', label: 'Height', min: 2, max: 12, step: 0.5 }
                ]
            },
            tetrahedron: {
                label: 'Tetrahedron (Triangular Pyramid)',
                params: [
                    { key: 'base', label: 'BASE', accessibleLabel: 'Base side length', min: 2, max: 10, step: 0.5 },
                    { key: 'triangleHeight', label: 'HEIGHT', accessibleLabel: 'Base triangle height', min: 2, max: 10, step: 0.5 },
                    { key: 'height', label: 'APEX', accessibleLabel: 'Perpendicular apex height', min: 2, max: 10, step: 0.5 }
                ]
            },
            sphere: {
                label: 'Sphere',
                params: [
                    { key: 'radius', label: 'Radius', min: 1, max: 6, step: 0.25 }
                ]
            },
            hemisphere: {
                label: 'Hemisphere (Half-Sphere)',
                params: [
                    { key: 'radius', label: 'Radius', min: 1, max: 6, step: 0.25 }
                ]
            },
            cylinder: {
                label: 'Cylinder',
                params: [
                    { key: 'radius', label: 'Radius', min: 1, max: 5, step: 0.25 },
                    { key: 'height', label: 'Height', min: 2, max: 10, step: 0.5 }
                ]
            },
            cone: {
                label: 'Cone',
                params: [
                    { key: 'radius', label: 'Radius', min: 1, max: 5, step: 0.25 },
                    { key: 'height', label: 'Height', min: 2, max: 10, step: 0.5 }
                ]
            }
        };

        this.actionsByCount = {
            1: [
                { key: 'change-point-label', label: 'Change Label' }
            ],
            2: [
                { key: 'segment', label: 'Add Segment' }
            ],
            3: [
                { key: 'triangle', label: 'Add Triangle' },
                { key: 'angle', label: 'Add Angle' }
            ],
            4: [
                { key: 'plane', label: 'Add Quadrilateral' }
            ]
        };

        this.handleWindowResize = this.onWindowResize.bind(this);
        this.handleCanvasPointerDown = this.handleCanvasPointerDown.bind(this);

        // Ensure startup collapse state and arrows are consistent
        this.primitiveSectionContent.classList.toggle('collapsed', this.primitiveSectionCollapsed);
        this.primitiveSectionHeader.setAttribute('aria-expanded', this.primitiveSectionCollapsed ? 'false' : 'true');
        this.primitiveSectionArrow.textContent = this.primitiveSectionCollapsed ? '\u25B6\uFE0E' : '\u25BC\uFE0E';

        this.pointsSectionContent.classList.toggle('collapsed', this.pointsSectionCollapsed);
        this.pointsSectionHeader.setAttribute('aria-expanded', this.pointsSectionCollapsed ? 'false' : 'true');
        this.pointsSectionArrow.textContent = this.pointsSectionCollapsed ? '\u25B6\uFE0E' : '\u25BC\uFE0E';

        Object.entries(this.objectSections).forEach(([key, sec]) => {
            const collapsed = this.objectGroupCollapsed[key];
            sec.content.classList.toggle('collapsed', collapsed);
            sec.header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            sec.arrow.textContent = collapsed ? '\u25B6\uFE0E' : '\u25BC\uFE0E';
        });

        this._managedEventListeners = [];
        this._initialized = false;
        if (!deferInitialize) {
            this.initialize();
        }
    }

    initialize() {
        if (this._initialized) return;

        this.enforceEmbedMode();
        this.initThree();
        this.setupCrashDiagnostics();
        this.bindEvents();
        this.buildComposite();
        this.renderCompositeCards();
        this.restoreStateFromUrlIfPresent();
        this.animate();
        this._initialized = true;
    }

    addManagedEventListener(target, type, listener, options) {
        if (!target?.addEventListener || typeof listener !== 'function') return;
        target.addEventListener(type, listener, options);
        this._managedEventListeners.push({ target, type, listener, options });
    }

    removeManagedEventListeners() {
        for (const { target, type, listener, options } of this._managedEventListeners.splice(0)) {
            target?.removeEventListener?.(type, listener, options);
        }
    }

    enforceEmbedMode() {
        if (!this.embedMode) return;

        document.documentElement.classList.add('embed-mode');
        document.title = this.embedTitle;
        if (this.canvas) {
            this.canvas.setAttribute('role', 'img');
            this.canvas.setAttribute('aria-label', this.embedTitle);
        }
        this.panelOpen = false;
        this.controlPanel?.classList.add('closed');
        this.panelToggleBtn?.classList.remove('active');
        this.setupEmbedFullViewerButton();
    }

    getFullViewerUrl() {
        const url = new URL(window.location.href);
        url.searchParams.delete(EMBED_QUERY_KEY);
        url.searchParams.delete(EMBED_AUTOFIT_QUERY_KEY);
        url.searchParams.delete(EMBED_ZOOM_QUERY_KEY);
        if (!url.searchParams.get(EMBED_TITLE_QUERY_KEY) && this.embedTitle) {
            url.searchParams.set(EMBED_TITLE_QUERY_KEY, this.embedTitle);
        }
        return url.toString();
    }

    setupEmbedFullViewerButton() {
        if (!this.embedMode || !this.canvasContainer) return;

        if (!this.embedFullViewerButton) {
            const button = document.createElement('a');
            button.className = 'embed-full-viewer-button';
            button.target = '_blank';
            button.rel = 'noopener noreferrer';
            button.title = 'Open full 3DGeoGon viewer';
            button.setAttribute('aria-label', 'Open full 3DGeoGon viewer');
            button.innerHTML = [
                '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
                '<path d="M9 5H5v14h14v-4"></path>',
                '<path d="M14 5h5v5"></path>',
                '<path d="M11 13 19 5"></path>',
                '</svg>'
            ].join('');
            this.canvasContainer.appendChild(button);
            this.embedFullViewerButton = button;
        }

        this.embedFullViewerButton.href = this.getFullViewerUrl();
    }

    async restoreStateFromUrlIfPresent() {
        let restoringSharePayload = false;
        try {
            if (this.isShuttingDown) return;
            this.embedVariableValues = this.getEmbedVariablesFromHash();
            const payload = this.getSharePayloadFromHash();
            if (payload) {
                restoringSharePayload = true;
                // Protect any existing local diagram before decoding. A malformed
                // standalone share hash must not turn a passive pagehide into an
                // empty autosave that erases recoverable local work.
                this.localStateViewOnlySaveBlocked = !this.embedMode;
                const snapshot = await this.decodeShareState(payload);
                if (this.isShuttingDown) return;
                if (!snapshot || snapshot.version !== SHARE_STATE_VERSION || !this.applySharedStateSnapshot(snapshot)) {
                    throw new Error('Unsupported or invalid shared state');
                }
                // A shared link is a view of someone else's diagram until the user
                // makes a content change. Camera and display-only interactions must
                // not overwrite an unrelated local diagram already saved here.
                this.applySharedUrlDefaultSectionState();
                this.enforceEmbedMode();
                this.showToast('Loaded');
                return;
            }

            if (this.embedMode) {
                this.enforceEmbedMode();
                return;
            }

            await this.restoreLocalStateIfPresent();
            if (this.isShuttingDown) return;
        } catch (error) {
            if (this.isShuttingDown) return;
            if (restoringSharePayload) {
                console.warn('Unable to load shared diagram state:', error);
            } else {
                console.error('Failed to restore local state:', error);
            }
            this.showAlertModal('Unable to load saved diagram state.');
        } finally {
            if (!this.isShuttingDown) {
                this.localStateReady = true;
                this.scheduleEmbedViewportFit(80);
            }
        }
    }

    async loadBuiltInExample(index) {
        const example = BUILT_IN_EXAMPLES[index];
        if (!example) return;
        try {
            const snapshot = await this.decodeShareState(example.payload);
            if (!snapshot || snapshot.version !== SHARE_STATE_VERSION || !this.applySharedStateSnapshot(snapshot)) {
                throw new Error('Invalid example snapshot');
            }
            this.applyBuiltInExampleSectionState();
            this.scheduleLocalStateSave();
            this.showToast(`Loaded: ${example.name}`);
        } catch (error) {
            console.error('Failed to load built-in example:', error);
            this.showAlertModal(`Unable to load example: ${example.name}`);
        }
    }

    initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);
        document.documentElement.setAttribute('data-theme', this.themeMode);
        this.scene.background.set(this.themeMode === 'dark' ? 0x606060 : 0xffffff);

        this.camera = new THREE.PerspectiveCamera(55, this.canvas.clientWidth / this.canvas.clientHeight, 0.01, 500);
        this.camera.position.set(10, 8, 11);

        const userAgent = navigator.userAgent || '';
        const isIPhoneOrIPod = /iPhone|iPod/.test(userAgent);
        const isAndroid = /Android/.test(userAgent);
        const isiPadOSDesktopUA = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
        const isIPad = /iPad/.test(userAgent) || isiPadOSDesktopUA;
        const isAndroidTablet = isAndroid && !/Mobile/.test(userAgent);
        const isTablet = isIPad || /tablet/i.test(userAgent) || isAndroidTablet;
        const isMobilePhone = (isIPhoneOrIPod || (isAndroid && /Mobile/.test(userAgent))) && !isTablet;

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: false,
            logarithmicDepthBuffer: true,
            preserveDrawingBuffer: true
        });
        const pixelRatio = isMobilePhone
            ? Math.min(window.devicePixelRatio || 1, 2)
            : (window.devicePixelRatio || 1);
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight, false);

        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = true;
        this.controls.enableZoom = this.embedZoomEnabled;
        this.controls.dampingFactor = 0.08;
        this.controls.target.set(0, 0, 0);
        this.controls.minDistance = isMobilePhone ? 2 : 1;
        this.controls.maxDistance = 100;
        this.controls.touches = {
            ONE: THREE.TOUCH.ROTATE,
            TWO: THREE.TOUCH.DOLLY_PAN
        };

        const ambient = new THREE.AmbientLight(0xffffff, 1.1);
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
        keyLight.position.set(8, 14, 10);
        const fillLight = new THREE.DirectionalLight(0x9cc4ff, 0.5);
        fillLight.position.set(-8, 4, -6);
        this.scene.add(ambient, keyLight, fillLight);

        this.grid = new THREE.GridHelper(26, 26, 0xd9d9d9, 0xebebeb);
        this.grid.position.y = -4.5;
        this.grid.visible = this.getEffectiveGridVisible();
        this.scene.add(this.grid);
        this.updateGridThemeAppearance();

        this.addManagedEventListener(window, 'resize', this.handleWindowResize);
    }

    closeAddDropdown({ restoreFocus: shouldRestoreFocus = false } = {}) {
        if (!this.addDropdown || !this.addBtn) return;
        this.addDropdown.style.display = 'none';
        this.addBtn.setAttribute('aria-expanded', 'false');
        if (shouldRestoreFocus) {
            restoreFocus(this.addBtn);
        }
    }

    bindEvents() {
        this.addManagedEventListener(this.panelToggleBtn, 'click', () => {
            this.panelOpen = !this.panelOpen;
            this.controlPanel.classList.toggle('closed', !this.panelOpen);
            this.panelToggleBtn.classList.toggle('active', this.panelOpen);
            this.scheduleLocalStateSave({ viewOnly: true });
        });

        this.addManagedEventListener(this.canvas, 'pointerdown', this.handleCanvasPointerDown, { passive: true });
        this._handleOrbitControlsStart = () => this.stopAutoTurnRight();
        this.addManagedEventListener(this.controls, 'start', this._handleOrbitControlsStart);
        this._handleOrbitControlsEnd = () => this.scheduleLocalStateSave({ viewOnly: true });
        this.addManagedEventListener(this.controls, 'end', this._handleOrbitControlsEnd);

        this._keysHeld = new Set();
        const cameraControlCodes = new Set([
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            'Equal',
            'NumpadAdd',
            'Minus',
            'NumpadSubtract'
        ]);
        this._handleKeyDown = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            if (helpOverlay.classList.contains('show') || activeCustomModalDismiss) {
                this._keysHeld.clear();
                return;
            }
            const isCrashReportShortcut = e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyK';
            const isAutoTurnShortcut = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.code === 'KeyR';
            if (isCrashReportShortcut) {
                e.preventDefault();
                this.toggleCrashReport();
                return;
            }

            if (this.isCrashReportOpen()) {
                if (isAutoTurnShortcut) {
                    e.preventDefault();
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.closeCrashReport();
                }
                return;
            }

            if (this.isTwoDViewsOpen()) {
                if (isAutoTurnShortcut) {
                    e.preventDefault();
                }
                this._keysHeld.clear();
                return;
            }

            if (this.triangleExtractOverlay?.classList.contains('show')) {
                if (isAutoTurnShortcut) {
                    e.preventDefault();
                }
                return;
            }
            if (isAutoTurnShortcut) {
                e.preventDefault();
                if (!e.repeat) {
                    this.toggleAutoTurnRight();
                }
                return;
            }
            const nav = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
            const zoomKeys = ['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract'];
            if (nav.includes(e.key) || zoomKeys.includes(e.code)) {
                e.preventDefault();
                this.stopAutoTurnRight();
            }
            this._keysHeld.add(e.code);
        };
        this._handleKeyUp = (e) => {
            const wasHeld = this._keysHeld.delete(e.code);
            if (wasHeld && cameraControlCodes.has(e.code)) {
                this.scheduleLocalStateSave({ viewOnly: true });
            }
        };
        this.addManagedEventListener(window, 'keydown', this._handleKeyDown);
        this.addManagedEventListener(window, 'keyup', this._handleKeyUp);

        if (this.triangleExtractCloseBtn) {
            this.addManagedEventListener(this.triangleExtractCloseBtn, 'click', () => {
                if (this.triangleExtractTransitionState === 'open') {
                    this.closeTriangleExtraction();
                }
            });
        }

        if (this.triangleExtractRotateBtn) {
            this.addManagedEventListener(this.triangleExtractRotateBtn, 'click', () => this.rotateTriangleExtractionLayout());
        }

        if (this.triangleExtractFlipBtn) {
            this.addManagedEventListener(this.triangleExtractFlipBtn, 'click', () => this.flipTriangleExtractionLayout());
        }

        if (this.triangleExtractOverlay) {
            this.addManagedEventListener(this.triangleExtractOverlay, 'click', (event) => {
                if (event.target === this.triangleExtractOverlay && this.triangleExtractTransitionState === 'open') {
                    this.closeTriangleExtraction();
                }
            });
        }

        if (this.crashReportCopyBtn) {
            this._handleCrashReportCopyClick = () => this.copyCrashReport();
            this.addManagedEventListener(this.crashReportCopyBtn, 'click', this._handleCrashReportCopyClick);
        }

        if (this.crashReportRefreshBtn) {
            this._handleCrashReportRefreshClick = () => this.refreshCrashReport();
            this.addManagedEventListener(this.crashReportRefreshBtn, 'click', this._handleCrashReportRefreshClick);
        }

        if (this.crashReportCloseBtn) {
            this._handleCrashReportCloseClick = () => this.closeCrashReport();
            this.addManagedEventListener(this.crashReportCloseBtn, 'click', this._handleCrashReportCloseClick);
        }

        if (this.crashReportOverlay) {
            this._handleCrashReportOverlayClick = (event) => {
                if (event.target === this.crashReportOverlay) {
                    this.closeCrashReport();
                }
            };
            this.addManagedEventListener(this.crashReportOverlay, 'click', this._handleCrashReportOverlayClick);
        }

        if (this._handleAddBtnClick) {
            this.addBtn.removeEventListener('click', this._handleAddBtnClick);
        }
        this._handleAddBtnClick = (event) => {
            const eventStamp = String(event.timeStamp);
            if (this.addBtn?.dataset?.lastHandledClickTs === eventStamp) {
                return;
            }
            if (this.addBtn) {
                this.addBtn.dataset.lastHandledClickTs = eventStamp;
            }

            event.stopPropagation();
            this.examplesAccordionCollapsed = true;
            this.primitiveGroupAccordionCollapsed = {
                prisms: true,
                pyramids: true
            };
            // Populate dropdown dynamically based on current composite state
            const isFirst = this.compositeSlots.length === 0;
            const defaultParamKeys = this.defaultParams && typeof this.defaultParams === 'object'
                ? Object.keys(this.defaultParams)
                : [];

            if (defaultParamKeys.length === 0) {
                this.recordCrashEvent('add.dropdown.failed', {
                    reason: 'defaultParams-empty',
                    compositeSlots: this.compositeSlots.length,
                    primitiveMetaKeys: this.primitiveMeta && typeof this.primitiveMeta === 'object'
                        ? Object.keys(this.primitiveMeta).length
                        : 0,
                    orientationsKeys: this.orientations && typeof this.orientations === 'object'
                        ? Object.keys(this.orientations).length
                        : 0
                });
                return;
            }

            const compatible = isFirst
                ? defaultParamKeys
                : this.getCompatiblePrimitives();

            this.recordCrashEvent('add.dropdown.opened', {
                isFirst,
                compositeSlots: this.compositeSlots.length,
                compatibleCount: compatible.length,
                defaultParamsKeys: defaultParamKeys.length
            });

            this.addDropdown.innerHTML = '';

            const createPrimitiveItem = (primKey) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'dropdown-item';
                item.dataset.primitive = primKey;
                item.innerHTML = `<strong>+</strong> ${this.primitiveMeta[primKey].label}`;
                return item;
            };

            const createAccordion = (groupKey, label, items, options = {}) => {
                if (items.length === 0) return;
                const collapsed = groupKey === 'examples'
                    ? this.examplesAccordionCollapsed
                    : this.primitiveGroupAccordionCollapsed[groupKey] !== false;

                const header = document.createElement('button');
                header.type = 'button';
                header.className = 'dropdown-accordion-header';
                header.dataset.dropdownAccordion = groupKey;
                header.setAttribute('aria-expanded', String(!collapsed));
                header.innerHTML = `<span class="dropdown-accordion-arrow">&#9654;&#xFE0E;</span><span class="dropdown-accordion-label">${label}</span>`;
                this.addDropdown.appendChild(header);

                const content = document.createElement('div');
                content.className = 'dropdown-accordion-content' + (collapsed ? ' collapsed' : '');
                content.dataset.dropdownAccordionContent = groupKey;
                if (options.examples) {
                    items.forEach((example, idx) => {
                        const item = document.createElement('button');
                        item.type = 'button';
                        item.className = 'dropdown-item dropdown-item-example';
                        item.dataset.example = String(idx);
                        item.textContent = example.name;
                        content.appendChild(item);
                    });
                } else {
                    items.forEach((primKey) => content.appendChild(createPrimitiveItem(primKey)));
                }
                this.addDropdown.appendChild(content);
            };

            if (!isFirst && (this.compositeSlots.length >= 3 || compatible.length === 0)) {
                const msg = document.createElement('div');
                msg.className = 'dropdown-item dropdown-item-disabled';
                msg.textContent = this.compositeSlots.length >= 3 ? 'Maximum 3 primitives' : 'No compatible additions';
                this.addDropdown.appendChild(msg);
            } else {
                const prismSet = new Set(PRISM_PRIMITIVE_KEYS);
                const pyramidSet = new Set(PYRAMID_PRIMITIVE_KEYS);
                const directPrimitives = compatible.filter((primKey) => !prismSet.has(primKey) && !pyramidSet.has(primKey));
                const prismPrimitives = PRISM_PRIMITIVE_KEYS.filter((primKey) => compatible.includes(primKey));
                const pyramidPrimitives = PYRAMID_PRIMITIVE_KEYS.filter((primKey) => compatible.includes(primKey));

                directPrimitives.forEach((primKey) => this.addDropdown.appendChild(createPrimitiveItem(primKey)));
                createAccordion('prisms', 'Prisms', prismPrimitives);
                createAccordion('pyramids', 'Pyramids', pyramidPrimitives);
            }

            const divider = document.createElement('div');
            divider.className = 'dropdown-divider';
            this.addDropdown.appendChild(divider);
            createAccordion('examples', 'Examples', BUILT_IN_EXAMPLES, { examples: true });

            const isOpening = this.addDropdown.style.display === 'none';
            this.addDropdown.style.display = isOpening ? 'block' : 'none';
            this.addBtn.setAttribute('aria-expanded', isOpening ? 'true' : 'false');
            if (isOpening && event.detail === 0) {
                window.requestAnimationFrame(() => {
                    const firstVisibleButton = [...this.addDropdown.querySelectorAll('button:not([disabled])')]
                        .find((button) => {
                            const styles = window.getComputedStyle(button);
                            return styles.display !== 'none'
                                && styles.visibility !== 'hidden'
                                && button.getClientRects().length > 0;
                        });
                    firstVisibleButton?.focus();
                });
            }
        };
        this.addManagedEventListener(this.addBtn, 'click', this._handleAddBtnClick);

        if (this._handleAddDropdownClick) {
            this.addDropdown.removeEventListener('click', this._handleAddDropdownClick);
        }
        this._handleAddDropdownClick = (event) => {
            const eventStamp = String(event.timeStamp);
            if (this.addDropdown?.dataset?.lastHandledClickTs === eventStamp) {
                return;
            }
            if (this.addDropdown) {
                this.addDropdown.dataset.lastHandledClickTs = eventStamp;
            }

            event.stopPropagation();
            const accordionHeader = event.target.closest('[data-dropdown-accordion]');
            if (accordionHeader) {
                const groupKey = accordionHeader.dataset.dropdownAccordion;
                if (groupKey === 'examples') {
                    this.examplesAccordionCollapsed = !this.examplesAccordionCollapsed;
                } else if (groupKey) {
                    this.primitiveGroupAccordionCollapsed[groupKey] = !this.primitiveGroupAccordionCollapsed[groupKey];
                }
                const collapsed = groupKey === 'examples'
                    ? this.examplesAccordionCollapsed
                    : this.primitiveGroupAccordionCollapsed[groupKey] !== false;
                accordionHeader.setAttribute('aria-expanded', String(!collapsed));
                const content = this.addDropdown.querySelector(`[data-dropdown-accordion-content="${groupKey}"]`);
                if (content) { content.classList.toggle('collapsed', collapsed); }
                return;
            }
            const primitiveItem = event.target.closest('[data-primitive]');
            if (primitiveItem) {
                this.recordCrashEvent('add.primitive.selected', {
                    primitiveKey: primitiveItem.dataset.primitive,
                    compositeSlotsBefore: this.compositeSlots.length
                });
                this.addSlot(primitiveItem.dataset.primitive);
                this.expandPrimarySections();
                this.closeAddDropdown({ restoreFocus: true });
                return;
            }
            const exampleItem = event.target.closest('[data-example]');
            if (exampleItem) {
                this.closeAddDropdown({ restoreFocus: true });
                this.loadBuiltInExample(Number(exampleItem.dataset.example));
            }
        };
        this.addManagedEventListener(this.addDropdown, 'click', this._handleAddDropdownClick);

        if (this._handleDocumentClickCloseAddDropdown) {
            document.removeEventListener('click', this._handleDocumentClickCloseAddDropdown);
        }
        this._handleDocumentClickCloseAddDropdown = (event) => {
            if (event.target.closest('#add-btn') || event.target.closest('#add-dropdown')) return;
            this.closeAddDropdown();
        };
        this.addManagedEventListener(document, 'click', this._handleDocumentClickCloseAddDropdown);

        // Card-level delegation: orientation chips, cycle face, remove slot
        this.addManagedEventListener(this.primitiveCardsListEl, 'click', (event) => {
            const chip = event.target.closest('[data-orientation-value]');
            if (chip) {
                const card = chip.closest('[data-slot-id]');
                if (!card) return;
                const slot = this.compositeSlots.find((s) => s.id === Number(card.dataset.slotId));
                if (!slot || chip.dataset.orientationValue === slot.orientation) return;
                slot.orientation = chip.dataset.orientationValue;
                card.querySelectorAll('[data-orientation-value]').forEach((btn) => {
                    btn.classList.toggle('is-active', btn.dataset.orientationValue === slot.orientation);
                    btn.setAttribute('aria-checked', btn.dataset.orientationValue === slot.orientation ? 'true' : 'false');
                });
                this.resetSceneObjects();
                this.buildComposite();
                return;
            }

            const cycleBtn = event.target.closest('[data-cycle-slot-id]');
            if (cycleBtn) {
                this.cycleSlotFace(Number(cycleBtn.dataset.cycleSlotId));
                return;
            }

            const prismAttachFaceBtn = event.target.closest('[data-cycle-prism-attach-face-slot-id]');
            if (prismAttachFaceBtn) {
                this.cyclePrismAttachFace(Number(prismAttachFaceBtn.dataset.cyclePrismAttachFaceSlotId));
                return;
            }

            const prismAttachRotationBtn = event.target.closest('[data-cycle-prism-attach-rotation-slot-id]');
            if (prismAttachRotationBtn) {
                this.cyclePrismAttachRotation(Number(prismAttachRotationBtn.dataset.cyclePrismAttachRotationSlotId));
                return;
            }

            const triangleModeBtn = event.target.closest('[data-cycle-triangle-mode-slot-id]');
            if (triangleModeBtn) {
                this.cycleTriangularPrismMode(Number(triangleModeBtn.dataset.cycleTriangleModeSlotId));
                return;
            }

            const cuboidFaceCentersBtn = event.target.closest('[data-toggle-cuboid-face-centers-slot-id]');
            if (cuboidFaceCentersBtn) {
                this.toggleCuboidFaceCenters(Number(cuboidFaceCentersBtn.dataset.toggleCuboidFaceCentersSlotId));
                return;
            }

            const rectangularPyramidBaseCenterBtn = event.target.closest('[data-toggle-rectangular-pyramid-base-center-slot-id]');
            if (rectangularPyramidBaseCenterBtn) {
                this.toggleRectangularPyramidBaseCenter(Number(rectangularPyramidBaseCenterBtn.dataset.toggleRectangularPyramidBaseCenterSlotId));
                return;
            }

            const polygonalApothemBtn = event.target.closest('[data-toggle-polygonal-apothem-slot-id]');
            if (polygonalApothemBtn) {
                this.togglePolygonalApothem(Number(polygonalApothemBtn.dataset.togglePolygonalApothemSlotId));
                return;
            }

            const polygonalPrismBaseCentersBtn = event.target.closest('[data-toggle-polygonal-prism-base-centers-slot-id]');
            if (polygonalPrismBaseCentersBtn) {
                this.togglePolygonalPrismBaseCenters(Number(polygonalPrismBaseCentersBtn.dataset.togglePolygonalPrismBaseCentersSlotId));
                return;
            }

            const cylinderCenterBtn = event.target.closest('[data-toggle-cylinder-center-slot-id]');
            if (cylinderCenterBtn) {
                this.toggleCylinderCenter(Number(cylinderCenterBtn.dataset.toggleCylinderCenterSlotId));
                return;
            }

            const cylinderEndCentersBtn = event.target.closest('[data-toggle-cylinder-end-centers-slot-id]');
            if (cylinderEndCentersBtn) {
                this.toggleCylinderEndCenters(Number(cylinderEndCentersBtn.dataset.toggleCylinderEndCentersSlotId));
                return;
            }

            const tetrahedronModeBtn = event.target.closest('[data-cycle-tetrahedron-mode-slot-id]');
            if (tetrahedronModeBtn) {
                this.cycleTetrahedronTriangleMode(Number(tetrahedronModeBtn.dataset.cycleTetrahedronModeSlotId));
                return;
            }

            const tetrahedronApexBtn = event.target.closest('[data-cycle-tetrahedron-apex-slot-id]');
            if (tetrahedronApexBtn) {
                this.cycleTetrahedronApex(Number(tetrahedronApexBtn.dataset.cycleTetrahedronApexSlotId));
                return;
            }

            const apexCycleBtn = event.target.closest('[data-cycle-apex-slot-id]');
            if (apexCycleBtn) {
                this.cycleRectangularPyramidApex(Number(apexCycleBtn.dataset.cycleApexSlotId));
                return;
            }

            const removeBtn = event.target.closest('[data-remove-slot-id]');
            if (removeBtn) {
                this.removeSlot(Number(removeBtn.dataset.removeSlotId));
                return;
            }
        });

        this.addManagedEventListener(this.pointsListEl, 'click', (event) => {
            const button = event.target.closest('[data-point-id]');
            if (!button) return;

            this.togglePointSelection(button.dataset.pointId);
        });

        this.addManagedEventListener(this.actionsListEl, 'click', (event) => {
            const pointColorToggle = event.target.closest('[data-point-color-toggle-point-id]');
            if (pointColorToggle) {
                this.togglePointColorPicker(pointColorToggle.dataset.pointColorTogglePointId);
                return;
            }

            const pointColorButton = event.target.closest('[data-point-color]');
            if (pointColorButton) {
                this.changePointColor(
                    pointColorButton.dataset.pointColorPointId,
                    Number(pointColorButton.dataset.pointColor)
                );
                return;
            }

            const button = event.target.closest('[data-action-key]');
            if (!button) return;

            this.runAction(button.dataset.actionKey);
        });

        ['triangles', 'segments', 'angles', 'planes', 'baseHighlights', 'labels'].forEach((key) => {
            const sec = this.objectSections[key];
            this.addManagedEventListener(sec.list, 'click', (event) => {
                const extractButton = event.target.closest('[data-extract-object-id]');
                const editLabelButton = event.target.closest('[data-edit-label-object-id]');
                const editAngleButton = event.target.closest('[data-edit-angle-object-id]');
                const constructionColorToggle = event.target.closest('[data-construction-color-toggle-object-id]');
                const constructionColorButton = event.target.closest('[data-construction-color-object-id]');
                const segmentColorToggle = event.target.closest('[data-segment-color-toggle-object-id]');
                const segmentColorButton = event.target.closest('[data-segment-color-object-id]');
                const labelColorToggle = event.target.closest('[data-label-color-toggle-object-id]');
                const labelColorButton = event.target.closest('[data-label-color-object-id]');
                const toggleButton = event.target.closest('[data-toggle-object-id]');
                const deleteButton = event.target.closest('[data-delete-object-id]');
                if (extractButton) {
                    this.openTriangleExtraction(Number(extractButton.dataset.extractObjectId));
                    this.closePanelOnMobile();
                    return;
                }
                if (editLabelButton) {
                    this.editLabelFromObjectCard(Number(editLabelButton.dataset.editLabelObjectId));
                    return;
                }
                if (editAngleButton) {
                    this.editAngleFromObjectCard(Number(editAngleButton.dataset.editAngleObjectId));
                    return;
                }
                if (constructionColorToggle) {
                    this.toggleConstructionColorPicker(Number(constructionColorToggle.dataset.constructionColorToggleObjectId));
                    return;
                }
                if (segmentColorToggle) {
                    this.toggleSegmentColorPicker(Number(segmentColorToggle.dataset.segmentColorToggleObjectId));
                    return;
                }
                if (labelColorToggle) {
                    this.toggleLabelColorPicker(Number(labelColorToggle.dataset.labelColorToggleObjectId));
                    return;
                }
                if (constructionColorButton) {
                    this.changeConstructionColor(
                        Number(constructionColorButton.dataset.constructionColorObjectId),
                        Number(constructionColorButton.dataset.constructionColor)
                    );
                    return;
                }
                if (segmentColorButton) {
                    this.changeSegmentColor(
                        Number(segmentColorButton.dataset.segmentColorObjectId),
                        Number(segmentColorButton.dataset.segmentColor)
                    );
                    return;
                }
                if (labelColorButton) {
                    this.changeLabelColor(
                        Number(labelColorButton.dataset.labelColorObjectId),
                        Number(labelColorButton.dataset.labelColor)
                    );
                    return;
                }
                const shapeLabelButton = event.target.closest('[data-edit-shape-label-object-id]');
                if (shapeLabelButton) {
                    this.editShapeCenterLabelFromObjectCard(Number(shapeLabelButton.dataset.editShapeLabelObjectId));
                    return;
                }
                if (toggleButton) this.toggleObjectVisibility(Number(toggleButton.dataset.toggleObjectId));
                if (deleteButton) this.deleteObject(Number(deleteButton.dataset.deleteObjectId));
            });
            const toggleSection = () => {
                this.objectGroupCollapsed[key] = !this.objectGroupCollapsed[key];
                const collapsed = this.objectGroupCollapsed[key];
                sec.content.classList.toggle('collapsed', collapsed);
                sec.header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                sec.arrow.textContent = collapsed ? '\u25B6\uFE0E' : '\u25BC\uFE0E';
            };
            this.addManagedEventListener(sec.header, 'click', toggleSection);
            this.addManagedEventListener(sec.header, 'keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection(); }
            });
        });

        const clearObjectsBtn = document.getElementById('clear-objects-btn');
        if (clearObjectsBtn) {
            this.addManagedEventListener(clearObjectsBtn, 'click', () => this.clearAllObjects());
        }
        this.addManagedEventListener(document.getElementById('reset-view-btn'), 'click', () => {
            this.resetView();
            this.closePanelOnMobile();
        });
        this.addManagedEventListener(this.ghostToggleBtn, 'click', () => {
            this.ghostFaces = !this.ghostFaces;
            this.updatePrimitiveMaterial();
            this.updateGhostToggleUI();
            this.scheduleLocalStateSave({ viewOnly: true });
        });
        this.updateGhostToggleUI();

        if (this.labelBadgeToggleBtn) {
            this.addManagedEventListener(this.labelBadgeToggleBtn, 'click', () => this.toggleLabelBadgeMode());
            this.updateLabelBadgeToggleUI();
        }

        if (this.pointMarkerToggleBtn) {
            this.addManagedEventListener(this.pointMarkerToggleBtn, 'click', () => this.togglePointMarkers());
            this.updatePointMarkerToggleUI();
        }

        if (this.displaySizeToggleBtn) {
            this.addManagedEventListener(this.displaySizeToggleBtn, 'click', () => this.toggleDisplaySizeMode());
            this.updateDisplaySizeToggleUI();
        }

        if (this.themeToggleBtn) {
            this.addManagedEventListener(this.themeToggleBtn, 'click', () => this.toggleThemeMode());
            this.updateThemeToggleUI();
        }

        if (this.gridToggleBtn) {
            this.addManagedEventListener(this.gridToggleBtn, 'click', () => this.toggleGrid());
            this.updateGridToggleUI();
        }

        if (this.shareBtn) {
            this.addManagedEventListener(this.shareBtn, 'click', () => {
                this.handleShareButtonClick();
            });
        }

        if (this.exportJsonBtn) {
            this.addManagedEventListener(this.exportJsonBtn, 'click', () => this.handleExportJsonClick());
        }

        if (this.importJsonBtn && this.importJsonInput) {
            this.addManagedEventListener(this.importJsonBtn, 'click', () => this.importJsonInput.click());
            this.addManagedEventListener(this.importJsonInput, 'change', (event) => this.handleImportJsonFileSelected(event));
        }

        if (this.embedScriptBtn) {
            this.addManagedEventListener(this.embedScriptBtn, 'click', () => this.handleEmbedScriptClick());
        }

        if (this.shareLinkBtn) {
            this.addManagedEventListener(this.shareLinkBtn, 'click', () => this.handleShareButtonClick());
        }

        if (this.copyJsonBtn) {
            this.addManagedEventListener(this.copyJsonBtn, 'click', () => this.handleCopyJsonClick());
        }

        if (this.exportPngBtn) {
            this.addManagedEventListener(this.exportPngBtn, 'click', () => this.handleExportPngClick());
        }

        if (this.exportSvgBtn) {
            this.addManagedEventListener(this.exportSvgBtn, 'click', () => this.handleExportSvgClick());
        }

        if (this.copySvgHtmlBtn) {
            this.addManagedEventListener(this.copySvgHtmlBtn, 'click', () => this.handleCopySvgHtmlClick());
        }

        if (this.openTwoDViewsBtn) {
            this.addManagedEventListener(this.openTwoDViewsBtn, 'click', () => this.openTwoDViews());
        }
        if (this.twoDViewsCloseBtn) {
            this.addManagedEventListener(this.twoDViewsCloseBtn, 'click', () => this.closeTwoDViews());
        }
        if (this.twoDViewsOverlay) {
            this.addManagedEventListener(this.twoDViewsOverlay, 'click', (event) => {
                if (event.target === this.twoDViewsOverlay) this.closeTwoDViews();
            });
            this.addManagedEventListener(this.twoDViewsOverlay, 'keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.closeTwoDViews();
                    return;
                }
                trapFocusWithin(event, this.twoDViewsDialog);
            });
        }
        if (this.twoDViewsTabs) {
            this.addManagedEventListener(this.twoDViewsTabs, 'click', (event) => {
                const tab = event.target.closest('[data-view][role="tab"]');
                if (tab) this.setActiveTwoDView(tab.dataset.view, { focus: false });
            });
            this.addManagedEventListener(this.twoDViewsTabs, 'keydown', (event) => this.handleTwoDViewTabKeydown(event));
        }
        if (this.twoDShowHiddenEdges) {
            this.addManagedEventListener(this.twoDShowHiddenEdges, 'change', () => this.renderTwoDViews());
        }
        if (this.twoDViewExportCurrentBtn) {
            this.addManagedEventListener(this.twoDViewExportCurrentBtn, 'click', () => this.handleExportCurrentTwoDView());
        }
        if (this.twoDViewExportSheetBtn) {
            this.addManagedEventListener(this.twoDViewExportSheetBtn, 'click', () => this.handleExportTwoDViewSheet());
        }

        const togglePrimitiveSection = () => {
            this.primitiveSectionCollapsed = !this.primitiveSectionCollapsed;
            this.primitiveSectionContent.classList.toggle('collapsed', this.primitiveSectionCollapsed);
            this.primitiveSectionHeader.setAttribute('aria-expanded', this.primitiveSectionCollapsed ? 'false' : 'true');
            this.primitiveSectionArrow.textContent = this.primitiveSectionCollapsed ? '\u25B6\uFE0E' : '\u25BC\uFE0E';
        };
        this.addManagedEventListener(this.primitiveSectionHeader, 'click', togglePrimitiveSection);
        this.addManagedEventListener(this.primitiveSectionHeader, 'keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); togglePrimitiveSection(); }
        });

        const togglePointsSection = () => {
            this.pointsSectionCollapsed = !this.pointsSectionCollapsed;
            this.pointsSectionContent.classList.toggle('collapsed', this.pointsSectionCollapsed);
            this.pointsSectionHeader.setAttribute('aria-expanded', this.pointsSectionCollapsed ? 'false' : 'true');
            this.pointsSectionArrow.textContent = this.pointsSectionCollapsed ? '\u25B6\uFE0E' : '\u25BC\uFE0E';
        };

        this.addManagedEventListener(this.pointsSectionHeader, 'click', togglePointsSection);

        this.addManagedEventListener(this.pointsSectionHeader, 'keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                togglePointsSection();
            }
        });
    }

    expandPrimarySections() {
        this.primitiveSectionCollapsed = false;
        this.primitiveSectionContent.classList.remove('collapsed');
        this.primitiveSectionHeader.setAttribute('aria-expanded', 'true');
        this.primitiveSectionArrow.textContent = '\u25BC\uFE0E';

        this.pointsSectionCollapsed = false;
        this.pointsSectionContent.classList.remove('collapsed');
        this.pointsSectionHeader.setAttribute('aria-expanded', 'true');
        this.pointsSectionArrow.textContent = '\u25BC\uFE0E';
    }

    handleCanvasPointerDown(event) {
        if (event.target.closest('.control-panel')) {
            return;
        }

        if (this.shouldAutoClosePanelOnCanvasTap() && this.panelOpen) {
            this.closePanelOnMobile();
        }
    }

    shouldAutoClosePanelOnCanvasTap() {
        const isPhoneNarrow = window.innerWidth < 768;
        const userAgent = navigator.userAgent || '';
        const isiPadOSDesktopUA = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
        const isIPad = /iPad/.test(userAgent) || isiPadOSDesktopUA;
        const isIPadPortrait = isIPad && window.innerHeight > window.innerWidth;

        return isPhoneNarrow || isIPadPortrait;
    }

    getInitialDisplaySizeMode() {
        const userAgent = navigator.userAgent || '';
        const isMobileUA = /iPhone|iPod|Android.*Mobile|Windows Phone|webOS|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
        const isNarrowViewport = window.innerWidth < 768;

        return (isNarrowViewport || isMobileUA) ? 'large' : 'small';
    }

    getDisplaySizeModeValue(values) {
        if (this.displaySizeMode === 'xlarge') {
            return values.xlarge;
        }
        if (this.displaySizeMode === 'large') {
            return values.large;
        }
        return values.small;
    }

    getDisplayTextScale() {
        return this.getDisplaySizeModeValue({ small: 0.78, large: 1.14, xlarge: 1.5 });
    }

    getDisplaySvgLabelFontSize() {
        return this.getDisplaySizeModeValue({ small: 20, large: 26, xlarge: 34 });
    }

    getDisplaySvgPointFontSize() {
        return this.getDisplaySizeModeValue({ small: 21, large: 28, xlarge: 36 });
    }

    getDisplaySvgMarkerRadius() {
        return 4;
    }

    getDisplayWorldMarkerRadius() {
        return 0.075;
    }

    closePanelOnMobile() {
        if (!this.shouldAutoClosePanelOnCanvasTap() || !this.panelOpen) {
            return;
        }

        this.panelOpen = false;
        this.controlPanel.classList.add('closed');
        this.panelToggleBtn.classList.remove('active');
        this.scheduleLocalStateSave({ viewOnly: true });
    }

    base64UrlEncode(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) {
            binary += String.fromCharCode(bytes[i]);
        }

        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    base64UrlDecode(input) {
        const normalized = input
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
        const binary = atob(normalized + padding);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    async streamToUint8Array(stream, maxBytes = Infinity) {
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            if (!value) {
                continue;
            }
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw new Error('Stream payload is too large');
            }
            chunks.push(value);
        }

        const output = new Uint8Array(total);
        let offset = 0;
        chunks.forEach((chunk) => {
            output.set(chunk, offset);
            offset += chunk.byteLength;
        });
        return output;
    }

    async encodeShareState(snapshot) {
        const json = JSON.stringify(snapshot);
        const rawBytes = new TextEncoder().encode(json);

        if (typeof CompressionStream === 'function') {
            try {
                const compressed = await this.streamToUint8Array(
                    new Blob([rawBytes]).stream().pipeThrough(new CompressionStream('gzip'))
                );
                if (compressed.length < rawBytes.length) {
                    return `g.${this.base64UrlEncode(compressed)}`;
                }
            } catch {
                // Fallback to raw payload.
            }
        }

        return `r.${this.base64UrlEncode(rawBytes)}`;
    }

    async decodeShareState(payload) {
        if (typeof payload !== 'string' || !payload.includes('.')) {
            throw new Error('Invalid payload format');
        }
        if (payload.length > SHARE_MAX_PAYLOAD_LENGTH) {
            throw new Error('Shared payload is too large');
        }

        const separatorIndex = payload.indexOf('.');
        const encoding = payload.slice(0, separatorIndex);
        const data = payload.slice(separatorIndex + 1);
        if (!/^[A-Za-z0-9_-]+$/.test(data || '')) {
            throw new Error('Invalid shared payload characters');
        }
        if (data.length > SHARE_MAX_ENCODED_BYTES) {
            throw new Error('Encoded shared payload is too large');
        }

        const bytes = this.base64UrlDecode(data);
        if (bytes.length > SHARE_MAX_DECODED_BYTES) {
            throw new Error('Decoded shared payload is too large');
        }

        if (encoding === 'g') {
            if (typeof DecompressionStream !== 'function') {
                throw new Error('Compressed payload unsupported in this browser');
            }

            const decompressed = await this.streamToUint8Array(
                new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
                SHARE_MAX_DECOMPRESSED_BYTES
            );
            return JSON.parse(new TextDecoder().decode(decompressed));
        }

        if (encoding === 'r') {
            return JSON.parse(new TextDecoder().decode(bytes));
        }

        throw new Error('Unknown payload encoding');
    }

    getSharePayloadFromHash() {
        const hash = window.location.hash || '';
        if (!hash.startsWith('#')) return null;
        const hashBody = hash.slice(1);
        const params = new URLSearchParams(hashBody);
        return params.get(SHARE_HASH_KEY);
    }

    getEmbedVariablesFromHash() {
        const hash = window.location.hash || '';
        if (!hash.startsWith('#')) return new Map();
        const vars = new URLSearchParams(hash.slice(1)).get('vars') || '';
        return this.parseEmbedVariables(vars);
    }

    parseEmbedVariables(vars) {
        const values = new Map();
        const raw = String(vars || '').trim();
        if (!raw || raw.length > EMBED_MAX_VARS_LENGTH || /[<>&]/.test(raw)) {
            return values;
        }

        raw.split(';').forEach((entry) => {
            const text = entry.trim();
            if (!text) return;
            const equalsIndex = text.indexOf('=');
            if (equalsIndex <= 0) return;
            const key = text.slice(0, equalsIndex).trim();
            const value = text.slice(equalsIndex + 1).trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.length > EMBED_MAX_VAR_VALUE_LENGTH) {
                return;
            }
            values.set(key, value);
        });

        return values;
    }

    applyEmbedVariableSubstitutions(text) {
        const source = String(text ?? '');
        if (!source || !this.embedVariableValues?.size) {
            return source;
        }

        return source.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) => (
            this.embedVariableValues.has(key) ? this.embedVariableValues.get(key) : match
        ));
    }

    applySectionCollapseStateToUI() {
        this.primitiveSectionContent.classList.toggle('collapsed', this.primitiveSectionCollapsed);
        this.primitiveSectionHeader.setAttribute('aria-expanded', this.primitiveSectionCollapsed ? 'false' : 'true');
        this.primitiveSectionArrow.textContent = this.primitiveSectionCollapsed ? '\u25B6\uFE0E' : '\u25BC\uFE0E';

        this.pointsSectionContent.classList.toggle('collapsed', this.pointsSectionCollapsed);
        this.pointsSectionHeader.setAttribute('aria-expanded', this.pointsSectionCollapsed ? 'false' : 'true');
        this.pointsSectionArrow.textContent = this.pointsSectionCollapsed ? '\u25B6\uFE0E' : '\u25BC\uFE0E';

        Object.entries(this.objectSections).forEach(([key, sec]) => {
            const collapsed = !!this.objectGroupCollapsed[key];
            sec.content.classList.toggle('collapsed', collapsed);
            sec.header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            sec.arrow.textContent = collapsed ? '\u25B6\uFE0E' : '\u25BC\uFE0E';
        });
    }

    normalizePrimitiveParamsForRestore(primitive, rawParams = {}) {
        const defaults = this.defaultParams[primitive] || {};
        const source = rawParams && typeof rawParams === 'object' ? rawParams : {};
        const params = { ...defaults };
        const numericConfigs = new Map((this.primitiveMeta[primitive]?.params || []).map((config) => [config.key, config]));

        Object.keys(defaults).forEach((key) => {
            const value = source[key];
            const defaultValue = defaults[key];
            if (numericConfigs.has(key)) {
                const config = numericConfigs.get(key);
                const candidate = Number(value);
                if (Number.isFinite(candidate)) {
                    params[key] = THREE.MathUtils.clamp(candidate, config.min, config.max);
                }
                return;
            }

            if (typeof defaultValue === 'boolean') {
                if (typeof value === 'boolean') {
                    params[key] = value;
                } else if (value === 'true' || value === '1') {
                    params[key] = true;
                } else if (value === 'false' || value === '0') {
                    params[key] = false;
                }
                return;
            }

            if (typeof defaultValue === 'string' && typeof value === 'string') {
                const allowed = this.getAllowedParamValues(primitive, key);
                params[key] = allowed.includes(value) ? value : defaultValue;
            }
        });

        if (primitive === 'cuboid' && source.includeFaceCenters === true && source.includeFaceCentersMode == null) {
            params.includeFaceCentersMode = 'all';
        }

        return params;
    }

    getAllowedParamValues(primitive, key) {
        if (key === 'includeFaceCentersMode') {
            return ['off', 'top-bottom', 'left-right', 'front-back', 'all'];
        }
        if (key === 'triangleMode') {
            return this.triangularPrismModes.map((option) => option.value);
        }
        if (key === 'baseTriangleMode') {
            return this.tetrahedronTriangleModes.map((option) => option.value);
        }
        if (key === 'apexPosition' && primitive === 'tetrahedron') {
            return this.tetrahedronApexPositions.map((option) => option.value);
        }
        if (key === 'apexPosition' && primitive === 'rectangular-pyramid') {
            return this.rectangularPyramidApexPositions.map((option) => option.value);
        }
        return [this.defaultParams[primitive]?.[key]].filter((value) => typeof value === 'string');
    }

    isValidSlotId(value) {
        // Slot 0 was emitted by the original v1 fallback allocator when a legacy
        // snapshot omitted its ID. Keep it restorable; newly allocated IDs remain
        // positive and malformed negative/unsafe identities are rejected.
        return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SLOT_ID;
    }

    isValidNextSlotId(value) {
        return Number.isSafeInteger(value) && value > 0 && value <= MAX_SLOT_ID;
    }

    normalizeSlotIdForRestore(value) {
        return this.isValidSlotId(value) ? value : null;
    }

    normalizeSlotForRestore(slot) {
        if (!slot || typeof slot !== 'object') return null;
        if (typeof slot.primitive !== 'string' || !this.defaultParams[slot.primitive]) return null;

        const id = slot.id == null ? null : this.normalizeSlotIdForRestore(slot.id);
        const hostSlotId = slot.hostSlotId == null ? null : this.normalizeSlotIdForRestore(slot.hostSlotId);
        if ((slot.id != null && id == null) || (slot.hostSlotId != null && hostSlotId == null)) {
            return null;
        }

        const orientationOptions = this.orientations[slot.primitive] || [{ value: 'standard' }];
        const fallbackOrientation = orientationOptions[0]?.value || 'standard';
        const orientation = orientationOptions.some((opt) => opt.value === slot.orientation)
            ? slot.orientation
            : fallbackOrientation;

        const params = this.normalizePrimitiveParamsForRestore(slot.primitive, slot.params || {});
        const rotationQuarterTurns = Number(slot.attachRotationQuarterTurns);

        return {
            id,
            primitive: slot.primitive,
            orientation,
            params,
            hostSlotId,
            hostFaceId: typeof slot.hostFaceId === 'string' ? slot.hostFaceId : null,
            attachFaceId: typeof slot.attachFaceId === 'string' ? slot.attachFaceId : null,
            attachRotationQuarterTurns: Number.isFinite(rotationQuarterTurns)
                ? THREE.MathUtils.clamp(Math.round(rotationQuarterTurns), 0, 3)
                : 0
        };
    }

    validateCompositeAttachmentGraphForRestore(slots) {
        if (!Array.isArray(slots)) return false;

        const priorSlotsById = new Map();
        const occupiedFaceKeys = new Set();
        for (let index = 0; index < slots.length; index += 1) {
            const slot = slots[index];
            const hasHost = slot.hostSlotId != null;
            const hasHostFace = typeof slot.hostFaceId === 'string' && slot.hostFaceId.length > 0;

            // buildComposite treats the first array entry as the root. Accepting
            // host metadata here would preserve a forward/cyclic edge that the
            // renderer never resolves, then persist an unrestorable snapshot.
            if (index === 0) {
                if (hasHost || slot.hostFaceId != null) return false;
                priorSlotsById.set(slot.id, slot);
                continue;
            }

            // A disconnected later slot is recoverable and can arise when its
            // host is removed. A connected slot, however, must point backward
            // in array order so the attachment graph stays acyclic.
            if (!hasHost) {
                if (slot.hostFaceId != null) return false;
                priorSlotsById.set(slot.id, slot);
                continue;
            }

            const hostSlot = priorSlotsById.get(slot.hostSlotId);
            if (!hostSlot || !hasHostFace) return false;
            const hostFaceDef = this.getFaceDefById(hostSlot, slot.hostFaceId);
            if (!hostFaceDef) return false;

            const guestFaces = ATTACHMENT_FACES[slot.primitive] || [];
            const compatibleGuestFaces = guestFaces.filter((face) => face.type === hostFaceDef.type);
            if (compatibleGuestFaces.length === 0) return false;
            let explicitGuestFaceDef = null;
            if (slot.attachFaceId != null) {
                if (typeof slot.attachFaceId !== 'string' || slot.attachFaceId.length === 0) return false;
                explicitGuestFaceDef = guestFaces.find((face) => face.id === slot.attachFaceId) || null;
                if (!explicitGuestFaceDef || explicitGuestFaceDef.type !== hostFaceDef.type) return false;
            }

            const hostFaceKey = this.getHostFaceKey(hostSlot.id, hostFaceDef.id);
            if (occupiedFaceKeys.has(hostFaceKey)) return false;
            occupiedFaceKeys.add(hostFaceKey);
            // An implicit guest face depends on the host's accumulated world
            // orientation, which is resolved only while buildComposite walks the
            // graph. Defer that occupancy check to the resolved attachment map;
            // explicit faces are stable and can be rejected before mutation.
            if (explicitGuestFaceDef) {
                const guestFaceKey = this.getHostFaceKey(slot.id, explicitGuestFaceDef.id);
                if (occupiedFaceKeys.has(guestFaceKey)) return false;
                occupiedFaceKeys.add(guestFaceKey);
            }
            priorSlotsById.set(slot.id, slot);
        }
        return true;
    }

    applySharedUrlDefaultSectionState() {
        this.primitiveSectionCollapsed = false;
        this.pointsSectionCollapsed = false;
        this.objectGroupCollapsed = {
            triangles: true,
            segments: true,
            angles: true,
            planes: true,
            baseHighlights: true,
            labels: true
        };

        this.applySectionCollapseStateToUI();
    }

    applyBuiltInExampleSectionState() {
        this.panelOpen = true;
        this.primitiveSectionCollapsed = false;
        this.pointsSectionCollapsed = false;
        this.objectGroupCollapsed = {
            triangles: false,
            segments: true,
            angles: true,
            planes: true,
            baseHighlights: true,
            labels: true
        };

        this.panelToggleBtn.classList.add('active');
        this.controlPanel.classList.remove('closed');
        this.applySectionCollapseStateToUI();
    }

    getShareableStateSnapshot() {
        return {
            version: SHARE_STATE_VERSION,
            ui: {
                panelOpen: this.panelOpen,
                ghostFaces: this.ghostFaces,
                pointMarkersVisible: this.pointMarkersVisible,
                labelMode: this.labelMode,
                gridVisible: this.gridVisible,
                displaySizeMode: this.displaySizeMode,
                themeMode: this.themeMode
            },
            camera: {
                position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
                target: [this.controls.target.x, this.controls.target.y, this.controls.target.z]
            },
            labels: {
                base: Array.from(this.baseLabelOverrides.entries()),
                derived: Array.from(this.derivedLabelOverrides.entries())
            },
            points: {
                hiddenSourceIds: Array.from(this.hiddenPointSourceIds || []),
                hiddenDerivedSignatures: Array.from(this.hiddenDerivedPointSignatures || []),
                baseColors: Array.from(this.basePointColorOverrides || []),
                derivedColors: Array.from(this.derivedPointColorOverrides || [])
            },
            composite: {
                nextSlotId: this.nextSlotId,
                slots: this.compositeSlots.map((slot) => ({
                    id: slot.id,
                    primitive: slot.primitive,
                    orientation: slot.orientation,
                    params: { ...slot.params },
                    hostSlotId: slot.hostSlotId,
                    hostFaceId: slot.hostFaceId,
                    attachFaceId: slot.attachFaceId ?? null,
                    attachRotationQuarterTurns: slot.attachRotationQuarterTurns ?? 0
                }))
            },
            objects: {
                nextObjectId: this.nextObjectId,
                constructionColorIndex: this.constructionColorIndex,
                items: this.sceneObjects.map((item) => ({
                    id: item.id,
                    type: item.type,
                    name: item.name,
                    subtitle: item.subtitle,
                    visible: item.visible,
                    definition: item.definition ? JSON.parse(JSON.stringify(item.definition)) : null
                }))
            }
        };
    }

    normalizeLabelOverrideEntriesForRestore(entries) {
        if (entries == null) {
            return new Map();
        }
        if (!Array.isArray(entries)) {
            return null;
        }

        const normalized = [];
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length < 2
                || typeof entry[0] !== 'string' || !entry[0]
                || typeof entry[1] !== 'string' || !entry[1]) {
                return null;
            }
            normalized.push([entry[0], entry[1]]);
        }
        return new Map(normalized);
    }

    normalizePointStateSetForRestore(values) {
        if (values == null) {
            return new Set();
        }
        if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value)) {
            return null;
        }
        return new Set(values);
    }

    validatePointColorOverrideEntriesForRestore(entries) {
        if (entries == null) {
            return true;
        }
        if (!Array.isArray(entries)) {
            return false;
        }
        return entries.every((entry) => {
            if (!Array.isArray(entry) || entry.length < 2) {
                return false;
            }
            const key = typeof entry[0] === 'string' ? entry[0].trim() : '';
            const rawColor = entry[1];
            return !!key && (
                Number.isFinite(Number(rawColor))
                || (typeof rawColor === 'string' && /^#?[0-9a-f]{6}$/i.test(rawColor.trim()))
            );
        });
    }

    validateSavedSceneObjectsForRestore(items) {
        if (!Array.isArray(items) || items.length > MAX_SCENE_OBJECTS) {
            return false;
        }

        const objectIds = new Set();
        return items.every((saved) => {
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)
                || !Number.isSafeInteger(saved.id) || saved.id <= 0
                || saved.id > MAX_SCENE_OBJECT_ID || objectIds.has(saved.id)
                || typeof saved.type !== 'string'
                || !saved.definition || typeof saved.definition !== 'object'
                || Array.isArray(saved.definition)) {
                return false;
            }

            const allowedKinds = SCENE_OBJECT_KINDS_BY_TYPE[saved.type];
            if (!allowedKinds?.has(saved.definition.kind)) {
                return false;
            }

            objectIds.add(saved.id);
            return true;
        });
    }

    applySharedStateSnapshot(snapshot, { rollbackOnFailure = true } = {}) {
        if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== SHARE_STATE_VERSION) {
            return false;
        }

        const rawSlots = Array.isArray(snapshot.composite?.slots) ? snapshot.composite.slots : null;
        const rawSavedObjects = snapshot.objects?.items == null ? [] : snapshot.objects.items;
        if (!rawSlots || rawSlots.length > 3
            || !Array.isArray(rawSavedObjects)
            || !this.validateSavedSceneObjectsForRestore(rawSavedObjects)) {
            return false;
        }

        const normalizedSlotCandidates = rawSlots.map((slot) => this.normalizeSlotForRestore(slot));
        if (normalizedSlotCandidates.some((slot) => !slot)) {
            return false;
        }
        const normalizedSlots = normalizedSlotCandidates;
        const usedSlotIds = new Set();
        let nextFallbackSlotId = 1;
        for (const slot of normalizedSlots) {
            if (slot.id == null) {
                let fallbackAttempts = 0;
                while (usedSlotIds.has(nextFallbackSlotId)) {
                    nextFallbackSlotId = nextFallbackSlotId < MAX_SLOT_ID
                        ? nextFallbackSlotId + 1
                        : 1;
                    fallbackAttempts += 1;
                    if (fallbackAttempts > normalizedSlots.length) {
                        return false;
                    }
                }
                if (!this.isValidSlotId(nextFallbackSlotId)) {
                    return false;
                }
                slot.id = nextFallbackSlotId;
            } else if (usedSlotIds.has(slot.id)) {
                return false;
            }
            usedSlotIds.add(slot.id);
            if (slot.id < MAX_SLOT_ID) {
                nextFallbackSlotId = Math.max(nextFallbackSlotId, slot.id + 1);
            }
            if (nextFallbackSlotId > MAX_SLOT_ID) {
                nextFallbackSlotId = 1;
            }
        }

        for (const slot of normalizedSlots) {
            if (slot.hostSlotId != null
                && (slot.hostSlotId === slot.id || !usedSlotIds.has(slot.hostSlotId))) {
                return false;
            }
        }
        if (!this.validateCompositeAttachmentGraphForRestore(normalizedSlots)) {
            return false;
        }

        const rawNextSlotId = snapshot.composite?.nextSlotId;
        const candidateNextSlotId = rawNextSlotId == null
            ? null
            : (this.isValidNextSlotId(rawNextSlotId) ? rawNextSlotId : null);
        if (rawNextSlotId != null && candidateNextSlotId == null) {
            return false;
        }
        const baseLabelOverrides = this.normalizeLabelOverrideEntriesForRestore(snapshot.labels?.base);
        const derivedLabelOverrides = this.normalizeLabelOverrideEntriesForRestore(snapshot.labels?.derived);
        const hiddenPointSourceIds = this.normalizePointStateSetForRestore(snapshot.points?.hiddenSourceIds);
        const hiddenDerivedPointSignatures = this.normalizePointStateSetForRestore(snapshot.points?.hiddenDerivedSignatures);
        if (!baseLabelOverrides || !derivedLabelOverrides
            || !hiddenPointSourceIds || !hiddenDerivedPointSignatures
            || !this.validatePointColorOverrideEntriesForRestore(snapshot.points?.baseColors)
            || !this.validatePointColorOverrideEntriesForRestore(snapshot.points?.derivedColors)) {
            return false;
        }
        const basePointColorOverrides = this.normalizePointColorOverrideEntries(snapshot.points?.baseColors);
        const derivedPointColorOverrides = this.normalizePointColorOverrideEntries(snapshot.points?.derivedColors);
        const rollbackSnapshot = rollbackOnFailure ? this.getShareableStateSnapshot() : null;
        const rollbackSelectedPoints = rollbackOnFailure ? [...this.selectedPoints] : null;
        const previousRestoringState = this.isRestoringSharedState;
        this.isRestoringSharedState = true;

        try {

        this.embedFrameAutoSizeDone = false;
        this.embedLastRequestedHeight = 0;

        const ui = snapshot.ui || {};
        this.panelOpen = ui.panelOpen !== false;
        this.ghostFaces = typeof ui.ghostFaces === 'boolean' ? ui.ghostFaces : this.ghostFaces;
        this.pointMarkersVisible = typeof ui.pointMarkersVisible === 'boolean'
            ? ui.pointMarkersVisible
            : this.pointMarkersVisible;
        this.labelMode = ['badge', 'plain', 'off'].includes(ui.labelMode) ? ui.labelMode : this.labelMode;
        this.gridVisible = typeof ui.gridVisible === 'boolean' ? ui.gridVisible : this.gridVisible;
        this.displaySizeMode = ['small', 'large', 'xlarge'].includes(ui.displaySizeMode)
            ? ui.displaySizeMode
            : this.displaySizeMode;
        this.themeMode = ['light', 'dark'].includes(ui.themeMode) ? ui.themeMode : this.themeMode;

        this.panelToggleBtn.classList.toggle('active', this.panelOpen);
        this.controlPanel.classList.toggle('closed', !this.panelOpen);

        this.baseLabelOverrides = baseLabelOverrides;
        this.derivedLabelOverrides = derivedLabelOverrides;
        this.hiddenPointSourceIds = hiddenPointSourceIds;
        this.hiddenDerivedPointSignatures = hiddenDerivedPointSignatures;
        this.basePointColorOverrides = basePointColorOverrides;
        this.derivedPointColorOverrides = derivedPointColorOverrides;

        this.compositeSlots = normalizedSlots;
        const maxRestoredSlotId = normalizedSlots.reduce(
            (maxId, slot) => Math.max(maxId, slot.id || 0),
            0
        );
        const minimumNextSlotId = maxRestoredSlotId > 0 && maxRestoredSlotId < MAX_SLOT_ID
            ? maxRestoredSlotId + 1
            : 1;
        this.nextSlotId = Math.max(candidateNextSlotId || 1, minimumNextSlotId);

        this.resetSceneObjects();
        this.buildComposite({ fitCamera: false });
        if (!this.validateResolvedCompositeAttachmentFaces()) {
            throw new Error('Resolved composite attachment faces are invalid or reused');
        }
        this.renderCompositeCards();

        // Two-pass restore: non-labels first so derived points (midpoints, ratio points) exist
        // before labels try to resolve their point IDs and attachment checks.
        const NON_LABEL_ORDER = { segment: 0, triangle: 1, angle: 2, plane: 3 };
        const allSavedObjects = rawSavedObjects;
        const savedObjectOrder = new Map(allSavedObjects.map((saved, index) => [saved, index]));
        const isDeferredVisualLabel = (saved) => {
            const kind = saved?.definition?.kind;
            return kind === 'edge-label' || kind === 'length-label' || kind === 'point-label' || kind === 'shape-label';
        };
        const nonLabelObjects = allSavedObjects
            .filter((s) => !isDeferredVisualLabel(s))
            .sort((a, b) => (NON_LABEL_ORDER[a?.type] ?? 3) - (NON_LABEL_ORDER[b?.type] ?? 3));
        const derivedPointHelperObjects = nonLabelObjects.filter((s) => s?.definition?.kind === 'midpoint-point' || s?.definition?.kind === 'ratio-point');
        const otherNonLabelObjects = nonLabelObjects.filter((s) => s?.definition?.kind !== 'midpoint-point' && s?.definition?.kind !== 'ratio-point');
        const labelObjects = allSavedObjects.filter((s) => isDeferredVisualLabel(s));

        this.sceneObjects = [];
        let maxObjectId = 0;

        const restoreOne = (saved) => {
            if (!saved || !saved.definition) return false;
            const definition = JSON.parse(JSON.stringify(saved.definition));
            const object3D = this.createObjectFromDefinition(definition);
            if (!object3D) return false;

            const id = saved.id;
            const visible = saved.visible !== false;
            const type = saved.type;
            const name = typeof saved.name === 'string' ? saved.name : this.getSceneObjectDisplayName({ definition, name: type });
            const subtitle = typeof saved.subtitle === 'string' ? saved.subtitle : '';

            object3D.userData.sceneObjectId = id;
            object3D.visible = visible;
            this.scene.add(object3D);
            this.sceneObjects.push({
                id,
                type,
                name,
                subtitle,
                object3D,
                definition,
                visible,
                restoreOrder: savedObjectOrder.get(saved) ?? Number.MAX_SAFE_INTEGER
            });
            maxObjectId = Math.max(maxObjectId, id);
            return true;
        };

        const restorePendingObjects = (items, options = {}) => {
            let pending = items.slice();
            const maxPasses = 8;

            for (let pass = 0; pass < maxPasses && pending.length > 0; pass += 1) {
                let restoredThisPass = 0;
                const remaining = [];

                pending.forEach((saved) => {
                    if (restoreOne(saved)) {
                        restoredThisPass += 1;
                        return;
                    }
                    remaining.push(saved);
                });

                pending = remaining;
                if (restoredThisPass === 0) {
                    break;
                }

                if (options.refreshDerived !== false) {
                    this.refreshDerivedPoints();
                }
            }

            return pending;
        };

        // Pass 1: derived point helpers first so derived point IDs can materialise.
        const unresolvedObjects = restorePendingObjects(derivedPointHelperObjects);

        // Pass 2: geometry and other non-label objects.
        unresolvedObjects.push(...restorePendingObjects(otherNonLabelObjects));

        // Materialise derived points again after all geometry is restored.
        this.refreshDerivedPoints();

        // Pass 3: edge labels, point labels (now have backing geometry + derived points)
        unresolvedObjects.push(...restorePendingObjects(labelObjects, { refreshDerived: false }));
        if (unresolvedObjects.length > 0) {
            throw new Error('Snapshot contains an object that cannot be restored');
        }

        this.sceneObjects.sort((a, b) => a.restoreOrder - b.restoreOrder);
        this.sceneObjects.forEach((item) => {
            delete item.restoreOrder;
        });

        const nextObjectId = Number(snapshot.objects?.nextObjectId);
        this.nextObjectId = Number.isSafeInteger(nextObjectId)
            && nextObjectId > maxObjectId
            && nextObjectId <= MAX_SCENE_OBJECT_ID
            ? nextObjectId
            : (maxObjectId + 1);
        const constructionColorIndex = Number(snapshot.objects?.constructionColorIndex);
        if (Number.isFinite(constructionColorIndex)) {
            this.constructionColorIndex = Math.max(0, constructionColorIndex);
        }

        this.pruneOrphanedSceneObjects();
        if (this.sceneObjects.length !== allSavedObjects.length) {
            throw new Error('Snapshot contains an orphaned object');
        }
        this.refreshDerivedPoints();
        const materializedDerivedSignatures = new Set(this.derivedPoints.map((point) => point.signature).filter(Boolean));
        const hasUnmaterializedEdgeDivision = this.sceneObjects.some((item) => {
            const definition = item.definition;
            return (definition?.kind === 'midpoint-point' || definition?.kind === 'ratio-point')
                && (!definition.signature || !materializedDerivedSignatures.has(definition.signature));
        });
        if (hasUnmaterializedEdgeDivision) {
            throw new Error('Snapshot contains an unresolved derived point');
        }
        this.pruneHiddenPointState();
        this.buildPointMarkers();
        this.renderObjectsList();
        this.renderPointsList();
        this.renderSelectionSummary();
        this.renderActions();
        this.updatePrimitiveMaterial();
        this.updateGhostToggleUI();
        this.updatePointMarkerToggleUI();
        this.updateLabelBadgeToggleUI();
        this.updateDisplaySizeToggleUI();
        this.applyThemeMode();
        if (this.grid) {
            this.grid.visible = this.getEffectiveGridVisible();
        }
        this.updateGridToggleUI();

        const cameraPos = Array.isArray(snapshot.camera?.position) ? snapshot.camera.position : null;
        const cameraTarget = Array.isArray(snapshot.camera?.target) ? snapshot.camera.target : null;
        if (cameraPos?.length === 3 && cameraTarget?.length === 3
            && cameraPos.every(Number.isFinite) && cameraTarget.every(Number.isFinite)) {
            this.camera.position.set(cameraPos[0], cameraPos[1], cameraPos[2]);
            this.controls.target.set(cameraTarget[0], cameraTarget[1], cameraTarget[2]);
            this.controls.update();
        } else {
            this.fitCameraToObject(this.compositeGroup, 1.38, new THREE.Vector3(1, 0.72, 0.94));
        }

        this.enforceEmbedMode();
        return true;
        } catch (error) {
            if (rollbackSnapshot) {
                const rolledBack = this.applySharedStateSnapshot(rollbackSnapshot, { rollbackOnFailure: false });
                if (!rolledBack) {
                    console.error('Failed to roll back rejected diagram state:', error);
                } else if (rollbackSelectedPoints) {
                    this.selectedPoints = rollbackSelectedPoints.filter((pointId) => !!this.getPointById(pointId));
                    this.buildPointMarkers();
                    this.renderPointsList();
                    this.renderSelectionSummary();
                    this.renderActions();
                }
            }
            return false;
        } finally {
            this.isRestoringSharedState = previousRestoringState;
        }
    }

    async handleShareButtonClick() {
        try {
            const snapshot = this.getShareableStateSnapshot();
            const payload = await this.encodeShareState(snapshot);
            const shareUrl = `${window.location.origin}${window.location.pathname}${window.location.search}#${SHARE_HASH_KEY}=${payload}`;

            if (shareUrl.length > MAX_SHARE_URL_LENGTH) {
                await this.showAlertModal('This diagram is too large to share as a URL.');
                return;
            }

            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(shareUrl);
                await this.showAlertModal('Share link copied to clipboard.');
                return;
            }

            await this.showPromptModal('Copy this share URL', shareUrl);
        } catch (error) {
            console.error('Failed to create share URL:', error);
            await this.showAlertModal('Unable to generate share URL.');
        }
    }

    getExportFileName() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `3DGeoGon-diagram-${stamp}.json`;
    }

    getPngFileName() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `3DGeoGon-canvas-${stamp}.png`;
    }

    getSvgFileName() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `3DGeoGon-canvas-${stamp}.svg`;
    }

    buildJsonExportPayload() {
        return {
            app: APP_NAME,
            type: '3DGeoGon-diagram',
            formatVersion: EXPORT_FORMAT_VERSION,
            exportedAt: new Date().toISOString(),
            snapshot: this.getShareableStateSnapshot()
        };
    }

    releaseDownloadResource(url) {
        const resource = this.pendingDownloadResources.get(url);
        if (!resource) return;

        window.clearTimeout(resource.cleanupTimer);
        resource.link.remove();
        this.pendingDownloadResources.delete(url);
        URL.revokeObjectURL(url);
    }

    downloadBlobFile(filename, blob) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.rel = 'noopener';
        link.hidden = true;
        document.body.appendChild(link);
        const cleanupTimer = window.setTimeout(
            () => this.releaseDownloadResource(url),
            DOWNLOAD_RESOURCE_CLEANUP_DELAY_MS
        );
        this.pendingDownloadResources.set(url, { link, cleanupTimer });
        link.click();
    }

    downloadTextFile(filename, text, mimeType) {
        const blob = new Blob([text], { type: mimeType });
        this.downloadBlobFile(filename, blob);
    }

    async copyTextOrShowPrompt(text, copiedMessage, promptMessage) {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            await this.showAlertModal(copiedMessage);
            return;
        }

        await this.showPromptModal(promptMessage, text);
    }

    async handleExportJsonClick() {
        try {
            const payload = this.buildJsonExportPayload();
            const text = JSON.stringify(payload, null, 2);
            this.downloadTextFile(this.getExportFileName(), text, 'application/json;charset=utf-8');
            this.showToast('JSON exported.');
        } catch (error) {
            console.error('Failed to export JSON:', error);
            await this.showAlertModal('Unable to export JSON.');
        }
    }

    async handleCopyJsonClick() {
        try {
            const text = JSON.stringify(this.buildJsonExportPayload(), null, 2);
            await this.copyTextOrShowPrompt(
                text,
                'JSON copied to clipboard.',
                'Copy this diagram JSON'
            );
        } catch (error) {
            console.error('Failed to copy JSON:', error);
            await this.showAlertModal('Unable to copy JSON.');
        }
    }

    getCanvasPngBlob() {
        return new Promise((resolve, reject) => {
            if (!this.canvas || typeof this.canvas.toBlob !== 'function') {
                reject(new Error('Canvas PNG export is not supported in this browser'));
                return;
            }

            this.renderer.render(this.scene, this.camera);
            this.canvas.toBlob((blob) => {
                if (!blob || blob.size <= 0) {
                    reject(new Error('Canvas PNG export produced an empty image'));
                    return;
                }
                resolve(blob);
            }, 'image/png');
        });
    }

    escapeXmlText(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    getSceneBackgroundRgb() {
        const background = this.scene?.background;
        if (background?.isColor) {
            return {
                r: Math.round(background.r * 255),
                g: Math.round(background.g * 255),
                b: Math.round(background.b * 255)
            };
        }

        return { r: 255, g: 255, b: 255 };
    }

    isBackgroundPixel(r, g, b, a, backgroundRgb, threshold = 14) {
        if (a <= 0) return true;
        return (
            Math.abs(r - backgroundRgb.r) <= threshold
            && Math.abs(g - backgroundRgb.g) <= threshold
            && Math.abs(b - backgroundRgb.b) <= threshold
        );
    }

    captureVisibleObjectImageDataUrl() {
        const width = Math.max(1, Math.round(this.canvas.width || this.canvas.clientWidth || 1));
        const height = Math.max(1, Math.round(this.canvas.height || this.canvas.clientHeight || 1));
        const gl = this.renderer?.getContext?.();
        if (!gl) {
            throw new Error('WebGL context unavailable for SVG export');
        }

        const previousGridVisible = this.grid?.visible;
        if (this.grid) {
            this.grid.visible = false;
        }

        try {
            this.renderer.render(this.scene, this.camera);

            const pixels = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

            const bg = this.getSceneBackgroundRgb();
            let minX = width;
            let minY = height;
            let maxX = -1;
            let maxY = -1;

            for (let y = 0; y < height; y += 1) {
                for (let x = 0; x < width; x += 1) {
                    const sourceY = height - 1 - y;
                    const index = (sourceY * width + x) * 4;
                    const r = pixels[index];
                    const g = pixels[index + 1];
                    const b = pixels[index + 2];
                    const a = pixels[index + 3];
                    if (!this.isBackgroundPixel(r, g, b, a, bg)) {
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    }
                }
            }

            if (maxX < minX || maxY < minY) {
                throw new Error('No visible object found in the current view');
            }

            const padding = Math.max(8, Math.round(Math.min(width, height) * 0.025));
            const cropLeft = Math.max(0, minX - padding);
            const cropTop = Math.max(0, minY - padding);
            const cropRight = Math.min(width - 1, maxX + padding);
            const cropBottom = Math.min(height - 1, maxY + padding);
            const cropWidth = cropRight - cropLeft + 1;
            const cropHeight = cropBottom - cropTop + 1;

            const canvas = document.createElement('canvas');
            canvas.width = cropWidth;
            canvas.height = cropHeight;
            const context = canvas.getContext('2d');
            if (!context) {
                throw new Error('Unable to create SVG export canvas');
            }

            const imageData = context.createImageData(cropWidth, cropHeight);
            for (let y = 0; y < cropHeight; y += 1) {
                for (let x = 0; x < cropWidth; x += 1) {
                    const canvasX = cropLeft + x;
                    const canvasY = cropTop + y;
                    const sourceY = height - 1 - canvasY;
                    const sourceIndex = (sourceY * width + canvasX) * 4;
                    const destIndex = (y * cropWidth + x) * 4;
                    const r = pixels[sourceIndex];
                    const g = pixels[sourceIndex + 1];
                    const b = pixels[sourceIndex + 2];
                    const a = pixels[sourceIndex + 3];

                    imageData.data[destIndex] = r;
                    imageData.data[destIndex + 1] = g;
                    imageData.data[destIndex + 2] = b;
                    imageData.data[destIndex + 3] = this.isBackgroundPixel(r, g, b, a, bg) ? 0 : a;
                }
            }

            context.putImageData(imageData, 0, 0);
            return {
                dataUrl: canvas.toDataURL('image/png'),
                width: cropWidth,
                height: cropHeight
            };
        } finally {
            if (this.grid && typeof previousGridVisible === 'boolean') {
                this.grid.visible = previousGridVisible;
                this.renderer.render(this.scene, this.camera);
            }
        }
    }

    colorToSvgHex(colorLike, fallback = '#000000') {
        if (colorLike == null) return fallback;
        try {
            const color = colorLike?.isColor ? colorLike : new THREE.Color(colorLike);
            return `#${color.getHexString()}`;
        } catch {
            return fallback;
        }
    }

    getSvgMaterialStyle(material, fallbackColor = '#000000') {
        const source = Array.isArray(material) ? material[0] : material;
        return {
            color: this.colorToSvgHex(source?.color, fallbackColor),
            opacity: source?.transparent ? THREE.MathUtils.clamp(source.opacity ?? 1, 0, 1) : 1
        };
    }

    projectWorldPointToSvg(point, width, height) {
        const projected = point.clone().project(this.camera);
        return {
            x: ((projected.x + 1) / 2) * width,
            y: ((1 - projected.y) / 2) * height,
            z: projected.z,
            visibleDepth: projected.z >= -1 && projected.z <= 1
        };
    }

    worldDepthForSvg(point) {
        return point.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
    }

    isObjectVisibleInTree(object) {
        let cursor = object;
        while (cursor) {
            if (cursor.visible === false) return false;
            cursor = cursor.parent;
        }
        return true;
    }

    clipSvgLineToRect(start, end, width, height) {
        let x0 = start.x;
        let y0 = start.y;
        let x1 = end.x;
        let y1 = end.y;
        const dx = x1 - x0;
        const dy = y1 - y0;
        let t0 = 0;
        let t1 = 1;

        const clip = (p, q) => {
            if (Math.abs(p) < 1e-9) return q >= 0;
            const r = q / p;
            if (p < 0) {
                if (r > t1) return false;
                if (r > t0) t0 = r;
                return true;
            }
            if (r < t0) return false;
            if (r < t1) t1 = r;
            return true;
        };

        if (
            clip(-dx, x0)
            && clip(dx, width - x0)
            && clip(-dy, y0)
            && clip(dy, height - y0)
        ) {
            return [
                { x: x0 + t0 * dx, y: y0 + t0 * dy },
                { x: x0 + t1 * dx, y: y0 + t1 * dy }
            ];
        }

        return null;
    }

    clipSvgPolygonToRect(points, width, height) {
        const edges = [
            {
                inside: (p) => p.x >= 0,
                intersect: (a, b) => {
                    const t = (0 - a.x) / (b.x - a.x || 1e-9);
                    return { x: 0, y: a.y + (b.y - a.y) * t };
                }
            },
            {
                inside: (p) => p.x <= width,
                intersect: (a, b) => {
                    const t = (width - a.x) / (b.x - a.x || 1e-9);
                    return { x: width, y: a.y + (b.y - a.y) * t };
                }
            },
            {
                inside: (p) => p.y >= 0,
                intersect: (a, b) => {
                    const t = (0 - a.y) / (b.y - a.y || 1e-9);
                    return { x: a.x + (b.x - a.x) * t, y: 0 };
                }
            },
            {
                inside: (p) => p.y <= height,
                intersect: (a, b) => {
                    const t = (height - a.y) / (b.y - a.y || 1e-9);
                    return { x: a.x + (b.x - a.x) * t, y: height };
                }
            }
        ];

        let output = points.slice();
        for (const edge of edges) {
            if (output.length === 0) break;
            const input = output;
            output = [];
            for (let index = 0; index < input.length; index += 1) {
                const current = input[index];
                const previous = input[(index + input.length - 1) % input.length];
                const currentInside = edge.inside(current);
                const previousInside = edge.inside(previous);
                if (currentInside) {
                    if (!previousInside) output.push(edge.intersect(previous, current));
                    output.push(current);
                } else if (previousInside) {
                    output.push(edge.intersect(previous, current));
                }
            }
        }
        return output;
    }

    formatSvgNumber(value) {
        return Number(value).toFixed(2).replace(/\.?0+$/, '');
    }

    addSvgBounds(bounds, points) {
        points.forEach((point) => {
            bounds.minX = Math.min(bounds.minX, point.x);
            bounds.minY = Math.min(bounds.minY, point.y);
            bounds.maxX = Math.max(bounds.maxX, point.x);
            bounds.maxY = Math.max(bounds.maxY, point.y);
        });
    }

    getSvgVertexKey(point) {
        const scale = 100000;
        return [
            Math.round(point.x * scale),
            Math.round(point.y * scale),
            Math.round(point.z * scale)
        ].join(',');
    }

    getSvgTrianglePlane(a, b, c) {
        const ab = b.clone().sub(a);
        const ac = c.clone().sub(a);
        const normal = new THREE.Vector3().crossVectors(ab, ac);
        if (normal.lengthSq() <= 1e-12) {
            return null;
        }

        normal.normalize();
        let constant = normal.dot(a);
        const shouldFlip = normal.x < -1e-8
            || (Math.abs(normal.x) <= 1e-8 && normal.y < -1e-8)
            || (Math.abs(normal.x) <= 1e-8 && Math.abs(normal.y) <= 1e-8 && normal.z < -1e-8);

        if (shouldFlip) {
            normal.multiplyScalar(-1);
            constant *= -1;
        }

        const scale = 10000;
        return {
            normal,
            key: [
                Math.round(normal.x * scale),
                Math.round(normal.y * scale),
                Math.round(normal.z * scale),
                Math.round(constant * scale)
            ].join(',')
        };
    }

    orderSvgFaceBoundaryPoints(points, normal) {
        if (!Array.isArray(points) || points.length < 3) {
            return [];
        }

        const centroid = points.reduce((acc, point) => acc.add(point), new THREE.Vector3()).multiplyScalar(1 / points.length);
        let u = points[0].clone().sub(centroid);
        if (u.lengthSq() <= 1e-12) {
            return points;
        }

        u.normalize();
        let v = new THREE.Vector3().crossVectors(normal, u);
        if (v.lengthSq() <= 1e-12) {
            v = new THREE.Vector3(0, 1, 0).cross(u);
            if (v.lengthSq() <= 1e-12) {
                v = new THREE.Vector3(1, 0, 0).cross(u);
            }
        }
        v.normalize();

        return points
            .map((point) => {
                const rel = point.clone().sub(centroid);
                return {
                    point,
                    angle: Math.atan2(rel.dot(v), rel.dot(u))
                };
            })
            .sort((left, right) => left.angle - right.angle)
            .map((entry) => entry.point);
    }

    buildSvgCoplanarFaceGroups(mesh) {
        const geometry = mesh?.geometry;
        const position = geometry?.attributes?.position;
        if (!position) {
            return [];
        }

        const index = geometry.index?.array || null;
        const triangleCount = index ? Math.floor(index.length / 3) : Math.floor(position.count / 3);
        const groups = new Map();
        const local = new THREE.Vector3();
        const readWorldPoint = (vertexIndex) => local
            .fromBufferAttribute(position, vertexIndex)
            .clone()
            .applyMatrix4(mesh.matrixWorld);

        for (let tri = 0; tri < triangleCount; tri += 1) {
            const points = [0, 1, 2].map((corner) => {
                const vertexIndex = index ? index[tri * 3 + corner] : tri * 3 + corner;
                return readWorldPoint(vertexIndex);
            });
            const plane = this.getSvgTrianglePlane(points[0], points[1], points[2]);
            if (!plane) {
                continue;
            }

            if (!groups.has(plane.key)) {
                groups.set(plane.key, {
                    normal: plane.normal,
                    triangles: [],
                    edges: new Map(),
                    pointsByKey: new Map()
                });
            }

            const group = groups.get(plane.key);
            const keys = points.map((point) => {
                const key = this.getSvgVertexKey(point);
                if (!group.pointsByKey.has(key)) {
                    group.pointsByKey.set(key, point);
                }
                return key;
            });

            if (new Set(keys).size < 3) {
                continue;
            }

            group.triangles.push(points);
            [[0, 1], [1, 2], [2, 0]].forEach(([startIndex, endIndex]) => {
                const startKey = keys[startIndex];
                const endKey = keys[endIndex];
                const edgeKey = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
                if (group.edges.has(edgeKey)) {
                    group.edges.delete(edgeKey);
                } else {
                    group.edges.set(edgeKey, { startKey, endKey });
                }
            });
        }

        return Array.from(groups.values()).map((group) => {
            const boundaryKeys = new Set();
            group.edges.forEach((edge) => {
                boundaryKeys.add(edge.startKey);
                boundaryKeys.add(edge.endKey);
            });
            const boundaryPoints = Array.from(boundaryKeys)
                .map((key) => group.pointsByKey.get(key))
                .filter(Boolean);

            return {
                normal: group.normal,
                triangles: group.triangles,
                boundaryPoints: this.orderSvgFaceBoundaryPoints(boundaryPoints, group.normal)
            };
        });
    }

    makeSvgPolygon(points, attrs = {}) {
        return {
            type: 'polygon',
            depth: attrs.depth ?? 0,
            boundsPoints: points,
            render: (offset) => {
                const pointText = points
                    .map((point) => `${this.formatSvgNumber(point.x - offset.x)},${this.formatSvgNumber(point.y - offset.y)}`)
                    .join(' ');
                const fill = attrs.fill || 'none';
                const stroke = attrs.stroke || 'none';
                const fillOpacity = attrs.fillOpacity == null ? 1 : attrs.fillOpacity;
                const strokeOpacity = attrs.strokeOpacity == null ? 1 : attrs.strokeOpacity;
                return `    <polygon points="${pointText}" fill="${fill}" fill-opacity="${this.formatSvgNumber(fillOpacity)}" stroke="${stroke}" stroke-opacity="${this.formatSvgNumber(strokeOpacity)}" stroke-width="${this.formatSvgNumber(attrs.strokeWidth || 0)}"/>`;
            }
        };
    }

    makeSvgLine(start, end, attrs = {}) {
        return {
            type: 'line',
            depth: attrs.depth ?? 0,
            boundsPoints: [start, end],
            render: (offset) => `    <line x1="${this.formatSvgNumber(start.x - offset.x)}" y1="${this.formatSvgNumber(start.y - offset.y)}" x2="${this.formatSvgNumber(end.x - offset.x)}" y2="${this.formatSvgNumber(end.y - offset.y)}" stroke="${attrs.stroke || '#000000'}" stroke-opacity="${this.formatSvgNumber(attrs.opacity == null ? 1 : attrs.opacity)}" stroke-width="${this.formatSvgNumber(attrs.strokeWidth || 2)}" stroke-linecap="round"/>`
        };
    }

    makeSvgPath(points, attrs = {}) {
        return {
            type: 'path',
            depth: attrs.depth ?? 0,
            boundsPoints: points,
            render: (offset) => {
                const path = points.map((point, index) => {
                    const command = index === 0 ? 'M' : 'L';
                    return `${command}${this.formatSvgNumber(point.x - offset.x)} ${this.formatSvgNumber(point.y - offset.y)}`;
                }).join(' ');
                return `    <path d="${path}" fill="none" stroke="${attrs.stroke || '#000000'}" stroke-opacity="${this.formatSvgNumber(attrs.opacity == null ? 1 : attrs.opacity)}" stroke-width="${this.formatSvgNumber(attrs.strokeWidth || 2)}" stroke-linecap="round" stroke-linejoin="round"/>`;
            }
        };
    }

    makeSvgCircle(center, radius, attrs = {}) {
        const boundsPoints = [
            { x: center.x - radius, y: center.y - radius },
            { x: center.x + radius, y: center.y + radius }
        ];
        return {
            type: 'circle',
            depth: attrs.depth ?? 0,
            boundsPoints,
            render: (offset) => `    <circle cx="${this.formatSvgNumber(center.x - offset.x)}" cy="${this.formatSvgNumber(center.y - offset.y)}" r="${this.formatSvgNumber(radius)}" fill="${attrs.fill || '#000000'}" fill-opacity="${this.formatSvgNumber(attrs.opacity == null ? 1 : attrs.opacity)}"/>`
        };
    }

    makeSvgText(text, center, attrs = {}) {
        const fontSize = attrs.fontSize || 24;
        const paddingX = attrs.badge ? Math.round(fontSize * 0.55) : 0;
        const paddingY = attrs.badge ? Math.round(fontSize * 0.32) : 0;
        const estimatedWidth = Math.max(fontSize, String(text).length * fontSize * 0.62) + paddingX * 2;
        const estimatedHeight = fontSize * 1.22 + paddingY * 2;
        const boundsPoints = [
            { x: center.x - estimatedWidth / 2, y: center.y - estimatedHeight / 2 },
            { x: center.x + estimatedWidth / 2, y: center.y + estimatedHeight / 2 }
        ];
        const safeText = this.escapeXmlText(text);
        const rotate = this.normalizeReadableSvgTextRotation(Number.isFinite(attrs.rotate) ? attrs.rotate : 0);

        return {
            type: 'text',
            depth: attrs.depth ?? 0,
            boundsPoints,
            render: (offset) => {
                const x = center.x - offset.x;
                const y = center.y - offset.y;
                const transform = Math.abs(rotate) > 0.01
                    ? ` transform="rotate(${this.formatSvgNumber(rotate)} ${this.formatSvgNumber(x)} ${this.formatSvgNumber(y)})"`
                    : '';
                const rectX = x - estimatedWidth / 2;
                const rectY = y - estimatedHeight / 2;
                const pieces = [];
                if (attrs.badge) {
                    pieces.push(`    <rect x="${this.formatSvgNumber(rectX)}" y="${this.formatSvgNumber(rectY)}" width="${this.formatSvgNumber(estimatedWidth)}" height="${this.formatSvgNumber(estimatedHeight)}" rx="${this.formatSvgNumber(Math.max(4, fontSize * 0.28))}" fill="${attrs.background || LABEL_BADGE_BACKGROUND_COLOR}" stroke="${attrs.borderColor || '#000000'}" stroke-width="2"${transform}/>`);
                }
                pieces.push(`    <text x="${this.formatSvgNumber(x)}" y="${this.formatSvgNumber(y)}" fill="${attrs.fill || '#000000'}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="${this.formatSvgNumber(fontSize)}" font-weight="700" text-anchor="middle" dominant-baseline="central"${transform}>${safeText}</text>`);
                return pieces.join('\n');
            }
        };
    }

    normalizeReadableSvgTextRotation(angleDegrees) {
        let angle = Number.isFinite(angleDegrees) ? angleDegrees : 0;
        while (angle > 180) angle -= 360;
        while (angle <= -180) angle += 360;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        return angle;
    }

    addProjectedSvgLine(elements, bounds, a, b, options = {}) {
        const width = options.width;
        const height = options.height;
        const pa = this.projectWorldPointToSvg(a, width, height);
        const pb = this.projectWorldPointToSvg(b, width, height);
        if (!pa.visibleDepth && !pb.visibleDepth) return;
        const clipped = this.clipSvgLineToRect(pa, pb, width, height);
        if (!clipped) return;
        const depth = (this.worldDepthForSvg(a) + this.worldDepthForSvg(b)) / 2;
        const element = options.path
            ? this.makeSvgPath(clipped, { ...options, depth })
            : this.makeSvgLine(clipped[0], clipped[1], { ...options, depth });
        elements.push(element);
        this.addSvgBounds(bounds, element.boundsPoints);
    }

    addProjectedSvgPath(elements, bounds, points, options = {}) {
        const width = options.width;
        const height = options.height;
        const projected = points.map((point) => this.projectWorldPointToSvg(point, width, height));
        if (!projected.some((point) => point.visibleDepth)) return;
        const clipped = this.clipSvgPolygonToRect(projected, width, height);
        if (clipped.length < 2) return;
        const depth = points.reduce((sum, point) => sum + this.worldDepthForSvg(point), 0) / points.length;
        const element = this.makeSvgPath(clipped, { ...options, depth });
        elements.push(element);
        this.addSvgBounds(bounds, element.boundsPoints);
    }

    addProjectedSvgPolygon(elements, bounds, points, options = {}) {
        const width = options.width;
        const height = options.height;
        const projected = points.map((point) => this.projectWorldPointToSvg(point, width, height));
        if (!projected.some((point) => point.visibleDepth)) return;
        const clipped = this.clipSvgPolygonToRect(projected, width, height);
        if (clipped.length < 3) return;
        const depth = points.reduce((sum, point) => sum + this.worldDepthForSvg(point), 0) / points.length;
        const element = this.makeSvgPolygon(clipped, { ...options, depth });
        elements.push(element);
        this.addSvgBounds(bounds, element.boundsPoints);
    }

    addProjectedSvgSphereSilhouette(elements, bounds, mesh, width, height, materialStyle, options = {}) {
        const geometry = mesh?.geometry;
        const localCenter = options.localCenter
            || geometry?.boundingSphere?.center
            || new THREE.Vector3();
        let localRadius = options.radius;

        if (!Number.isFinite(localRadius) || localRadius <= 0) {
            geometry?.computeBoundingSphere?.();
            localRadius = geometry?.boundingSphere?.radius;
        }

        if (!Number.isFinite(localRadius) || localRadius <= 0) {
            return false;
        }

        const center = localCenter.clone().applyMatrix4(mesh.matrixWorld);
        const worldScale = new THREE.Vector3();
        mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
        const radius = localRadius * Math.max(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z), 1e-6);
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
        const points = [];
        const segments = 96;

        for (let index = 0; index < segments; index += 1) {
            const theta = (index / segments) * Math.PI * 2;
            points.push(center.clone()
                .add(right.clone().multiplyScalar(Math.cos(theta) * radius))
                .add(up.clone().multiplyScalar(Math.sin(theta) * radius)));
        }

        this.addProjectedSvgPolygon(elements, bounds, points, {
            width,
            height,
            fill: materialStyle.color,
            fillOpacity: materialStyle.opacity,
            stroke: 'none',
            strokeWidth: 0
        });
        return true;
    }

    addProjectedSvgText(elements, bounds, text, point, options = {}) {
        const displayText = this.applyEmbedVariableSubstitutions(text);
        if (!displayText || this.labelMode === 'off') return;
        const width = options.width;
        const height = options.height;
        const projected = this.projectWorldPointToSvg(point, width, height);
        if (!projected.visibleDepth || projected.x < 0 || projected.x > width || projected.y < 0 || projected.y > height) return;
        const element = this.makeSvgText(displayText, projected, {
            ...options,
            depth: this.worldDepthForSvg(options.depthPoint || point)
        });
        elements.push(element);
        this.addSvgBounds(bounds, element.boundsPoints);
    }

    addPrimitiveMeshSvg(elements, bounds, mesh, width, height) {
        if (!mesh || !this.isObjectVisibleInTree(mesh)) return;
        const materialStyle = this.getSvgMaterialStyle(mesh.material, '#7db3e8');
        const primitiveKey = mesh.userData?.primitiveKey;
        if (primitiveKey === 'sphere'
            && this.addProjectedSvgSphereSilhouette(elements, bounds, mesh, width, height, materialStyle)) {
            return;
        }

        if (primitiveKey === 'hemisphere') {
            const radius = mesh.geometry?.parameters?.radius;
            const localCenter = Number.isFinite(radius) ? new THREE.Vector3(0, -radius / 2, 0) : undefined;
            if (this.addProjectedSvgSphereSilhouette(elements, bounds, mesh, width, height, materialStyle, { localCenter, radius })) {
                return;
            }
        }

        const faceGroups = this.buildSvgCoplanarFaceGroups(mesh);

        faceGroups.forEach((faceGroup) => {
            if (faceGroup.boundaryPoints.length >= 3) {
                this.addProjectedSvgPolygon(elements, bounds, faceGroup.boundaryPoints, {
                    width,
                    height,
                    fill: materialStyle.color,
                    fillOpacity: materialStyle.opacity,
                    stroke: 'none',
                    strokeWidth: 0
                });
                return;
            }

            faceGroup.triangles.forEach((points) => {
                this.addProjectedSvgPolygon(elements, bounds, points, {
                    width,
                    height,
                    fill: materialStyle.color,
                    fillOpacity: materialStyle.opacity,
                    stroke: 'none',
                    strokeWidth: 0
                });
            });
        });
    }

    addLineObjectSvg(elements, bounds, object, width, height) {
        if (!object || !this.isObjectVisibleInTree(object) || !object.geometry?.attributes?.position) return;
        const position = object.geometry.attributes.position;
        const materialStyle = this.getSvgMaterialStyle(object.material, this.colorToSvgHex(this.getEdgeColor()));
        const worldPoints = [];
        const local = new THREE.Vector3();
        for (let index = 0; index < position.count; index += 1) {
            local.fromBufferAttribute(position, index);
            worldPoints.push(local.clone().applyMatrix4(object.matrixWorld));
        }

        if (object.isLineSegments) {
            for (let index = 0; index + 1 < worldPoints.length; index += 2) {
                this.addProjectedSvgLine(elements, bounds, worldPoints[index], worldPoints[index + 1], {
                    width,
                    height,
                    stroke: materialStyle.color,
                    opacity: materialStyle.opacity,
                    strokeWidth: 2
                });
            }
            return;
        }

        if (worldPoints.length < 2) return;
        const isLoop = object instanceof THREE.LineLoop;
        const pathPoints = isLoop ? [...worldPoints, worldPoints[0]] : worldPoints;
        this.addProjectedSvgPath(elements, bounds, pathPoints, {
            width,
            height,
            stroke: materialStyle.color,
            opacity: materialStyle.opacity,
            strokeWidth: 2
        });
    }

    collectPrimitiveSvgElements(elements, bounds, width, height) {
        const meshSet = new Set(this.primitiveMeshes || []);
        meshSet.forEach((mesh) => this.addPrimitiveMeshSvg(elements, bounds, mesh, width, height));

        if (!this.compositeGroup) return;
        this.compositeGroup.traverse((object) => {
            if (object === this.grid) return;
            if (meshSet.has(object)) return;
            if (object.isLine || object.isLineSegments || object instanceof THREE.LineLoop) {
                this.addLineObjectSvg(elements, bounds, object, width, height);
            }
        });
    }

    collectConstructionSvgElements(elements, bounds, width, height) {
        (this.sceneObjects || []).forEach((entry) => {
            if (!entry || entry.visible === false || entry.definition?.hidden) return;
            const def = entry.definition || {};
            const color = this.colorToSvgHex(def.color ?? 0xff595e);

            if (def.kind === 'segment') {
                const vectors = this.getVectorsByPointIds(def.pointIds || []);
                if (vectors?.length === 2) {
                    this.addProjectedSvgLine(elements, bounds, vectors[0], vectors[1], {
                        width,
                        height,
                        stroke: color,
                        strokeWidth: 5
                    });
                }
            }

            if (def.kind === 'triangle') {
                const vectors = this.getVectorsByPointIds(def.pointIds || []);
                if (vectors?.length === 3) {
                    this.addProjectedSvgPolygon(elements, bounds, vectors, {
                        width,
                        height,
                        fill: color,
                        fillOpacity: def.opacity || 0.28,
                        stroke: color,
                        strokeOpacity: 1,
                        strokeWidth: 2
                    });
                }
            }

            if (def.kind === 'plane') {
                const vectors = this.getVectorsByPointIds(def.pointIds || []);
                if (vectors?.length === 4) {
                    this.addProjectedSvgPolygon(elements, bounds, vectors, {
                        width,
                        height,
                        fill: color,
                        fillOpacity: def.opacity || 0.2,
                        stroke: color,
                        strokeOpacity: 1,
                        strokeWidth: 2
                    });
                }
            }

            if (def.kind === 'base-highlight') {
                if (def.shape === 'polygon') {
                    const boundaryPointIds = Array.isArray(def.boundaryPointIds) ? def.boundaryPointIds : def.pointIds;
                    const vectors = this.getVectorsByPointIds(boundaryPointIds || []);
                    if (vectors?.length >= 3) {
                        this.addProjectedSvgPolygon(elements, bounds, vectors, {
                            width,
                            height,
                            fill: color,
                            fillOpacity: def.opacity || 0.2,
                            stroke: color,
                            strokeOpacity: 1,
                            strokeWidth: 2
                        });
                    }
                }

                if (def.shape === 'circle') {
                    const sample = this.getCircleBaseSamplePoints(def);
                    if (sample?.ringPoints?.length >= 3) {
                        this.addProjectedSvgPolygon(elements, bounds, sample.ringPoints, {
                            width,
                            height,
                            fill: color,
                            fillOpacity: def.opacity || 0.2,
                            stroke: color,
                            strokeOpacity: 1,
                            strokeWidth: 2
                        });
                    }
                }
            }

            if (def.kind === 'angle') {
                const vectors = this.getVectorsByPointIds(def.pointIds || []);
                if (vectors?.length === 3) {
                    const [a, vertex, c] = vectors;
                    const radius = Math.min(a.distanceTo(vertex), c.distanceTo(vertex)) * 0.22;
                    const dir1 = a.clone().sub(vertex).normalize();
                    const dir2 = c.clone().sub(vertex).normalize();
                    const normal = new THREE.Vector3().crossVectors(dir1, dir2).normalize();
                    const tangent = new THREE.Vector3().crossVectors(normal, dir1).normalize();
                    const rawAngle = Math.acos(THREE.MathUtils.clamp(dir1.dot(dir2), -1, 1));
                    const arcPoints = [];
                    for (let step = 0; step <= 28; step += 1) {
                        const theta = (rawAngle * step) / 28;
                        arcPoints.push(vertex.clone()
                            .add(dir1.clone().multiplyScalar(Math.cos(theta) * radius))
                            .add(tangent.clone().multiplyScalar(Math.sin(theta) * radius)));
                    }
                    this.addProjectedSvgPath(elements, bounds, arcPoints, {
                        width,
                        height,
                        stroke: color,
                        strokeWidth: 5
                    });

                    const angleLabelText = this.getAngleLabelText(def);
                    if (angleLabelText) {
                        const labelRadius = radius * 0.6;
                        const labelPoint = vertex.clone()
                            .add(dir1.clone().multiplyScalar(Math.cos(rawAngle / 2) * labelRadius))
                            .add(tangent.clone().multiplyScalar(Math.sin(rawAngle / 2) * labelRadius));
                        this.addProjectedSvgText(elements, bounds, angleLabelText, labelPoint, {
                            width,
                            height,
                            fontSize: this.getDisplaySvgLabelFontSize(),
                            fill: this.getLabelTextColor(),
                            badge: this.labelMode === 'badge',
                            background: this.getAngleLabelColorHex(def),
                            borderColor: '#000000'
                        });
                    }
                }
            }

            if (def.kind === 'edge-label' || def.kind === 'length-label') {
                const vectors = this.getVectorsByPointIds(def.pointIds || []);
                if (vectors?.length === 2 && this.isEdgePairVisible(def.pointIds || [])) {
                    const midpoint = vectors[0].clone().lerp(vectors[1], 0.5).add(new THREE.Vector3(0.2, 0.2, 0.2));
                    const a = this.projectWorldPointToSvg(vectors[0], width, height);
                    const b = this.projectWorldPointToSvg(vectors[1], width, height);
                    const rotate = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
                    this.addProjectedSvgText(elements, bounds, def.text, midpoint, {
                        width,
                        height,
                        fontSize: this.getDisplaySvgLabelFontSize(),
                        fill: this.getLabelTextColor(),
                        badge: this.labelMode === 'badge',
                        background: this.getLabelDefinitionColorHex(def),
                        borderColor: '#000000',
                        rotate
                    });
                }
            }

            if (def.kind === 'shape-label' && this.isShapeLabelAnchorVisible(def)) {
                const labelPoint = this.getShapeLabelPosition(def.pointIds || []);
                if (labelPoint) {
                    this.addProjectedSvgText(elements, bounds, def.text, labelPoint, {
                        width,
                        height,
                        fontSize: this.getDisplaySvgLabelFontSize(),
                        fill: this.getLabelTextColor(),
                        badge: this.labelMode === 'badge',
                        background: this.getLabelDefinitionColorHex(def),
                        borderColor: '#000000'
                    });
                }
            }

            if (def.kind === 'point-label') {
                const point = this.getPointById(def.pointId);
                if (point && !this.isPointHidden(point)) {
                    this.addProjectedSvgText(elements, bounds, def.text, point.position.clone().add(new THREE.Vector3(0.34, 0.46, 0.18)), {
                        width,
                        height,
                        fontSize: this.getDisplaySvgLabelFontSize(),
                        fill: '#000000',
                        badge: this.labelMode === 'badge',
                        background: this.getLabelDefinitionColorHex(def),
                        borderColor: '#000000'
                    });
                }
            }
        });
    }

    collectPointSvgElements(elements, bounds, width, height) {
        const points = this.getAllPoints();
        const markerRadius = this.getDisplaySvgMarkerRadius();
        points.forEach((point) => {
            if (this.isPointHidden(point)) {
                return;
            }

            if (this.pointMarkersVisible) {
                const projected = this.projectWorldPointToSvg(point.position, width, height);
                if (projected.visibleDepth && projected.x >= 0 && projected.x <= width && projected.y >= 0 && projected.y <= height) {
                    const marker = this.makeSvgCircle(projected, markerRadius, {
                        fill: '#000000',
                        depth: this.worldDepthForSvg(point.position)
                    });
                    elements.push(marker);
                    this.addSvgBounds(bounds, marker.boundsPoints);
                }
            }

            this.addProjectedSvgText(elements, bounds, point.label, point.position.clone().add(new THREE.Vector3(0.18, 0.22, 0.18)), {
                width,
                height,
                depthPoint: point.position,
                fontSize: this.getDisplaySvgPointFontSize(),
                fill: this.getLabelTextColor(),
                badge: this.labelMode === 'badge',
                background: this.getPointColorHex(point),
                borderColor: '#000000'
            });
        });
    }

    buildVectorSvgElements() {
        const width = Math.max(1, Math.round(this.canvas.width || this.canvas.clientWidth || 1));
        const height = Math.max(1, Math.round(this.canvas.height || this.canvas.clientHeight || 1));
        const elements = [];
        const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

        this.scene.updateMatrixWorld(true);
        this.camera.updateMatrixWorld(true);
        this.camera.updateProjectionMatrix();
        this.updateIntrinsicRightAngleMarkerVisibility();

        this.collectPrimitiveSvgElements(elements, bounds, width, height);
        this.collectConstructionSvgElements(elements, bounds, width, height);
        this.collectPointSvgElements(elements, bounds, width, height);

        if (!elements.length || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)) {
            throw new Error('No visible vector content found in the current view');
        }

        const padding = Math.max(8, Math.round(Math.min(width, height) * 0.025));
        const cropLeft = Math.max(0, Math.floor(bounds.minX - padding));
        const cropTop = Math.max(0, Math.floor(bounds.minY - padding));
        const cropRight = Math.min(width, Math.ceil(bounds.maxX + padding));
        const cropBottom = Math.min(height, Math.ceil(bounds.maxY + padding));
        const cropWidth = Math.max(1, cropRight - cropLeft);
        const cropHeight = Math.max(1, cropBottom - cropTop);

        elements.sort((left, right) => {
            const leftIsText = left.type === 'text';
            const rightIsText = right.type === 'text';
            if (leftIsText !== rightIsText) {
                return leftIsText ? 1 : -1;
            }

            const leftDepth = Number.isFinite(left.depth) ? left.depth : 0;
            const rightDepth = Number.isFinite(right.depth) ? right.depth : 0;
            const depthDelta = leftDepth - rightDepth;
            if (Math.abs(depthDelta) > 1e-6) {
                return depthDelta;
            }

            const order = { polygon: 0, path: 1, line: 1, circle: 2, text: 3 };
            return (order[left.type] ?? 0) - (order[right.type] ?? 0);
        });

        return {
            width: cropWidth,
            height: cropHeight,
            offset: { x: cropLeft, y: cropTop },
            elements
        };
    }

    buildObjectSvgMarkup() {
        const { width, height, offset, elements } = this.buildVectorSvgElements();
        const label = this.escapeXmlText(`${APP_NAME} viewport image`);

        return [
            `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">`,
            '  <!-- Created with 3DGeoGon true vector SVG export -->',
            '  <g class="layer">',
            '    <title>Layer 1</title>',
            ...elements.map((element) => element.render(offset)),
            '  </g>',
            '</svg>'
        ].join('\n');
    }

    async handleExportPngClick() {
        try {
            const blob = await this.getCanvasPngBlob();
            this.downloadBlobFile(this.getPngFileName(), blob);
            this.showToast('PNG exported.');
        } catch (error) {
            console.error('Failed to export PNG:', error);
            await this.showAlertModal('Unable to export PNG.');
        }
    }

    async handleExportSvgClick() {
        try {
            const svg = this.buildObjectSvgMarkup();
            this.downloadTextFile(this.getSvgFileName(), svg, 'image/svg+xml;charset=utf-8');
            this.showToast('SVG exported.');
        } catch (error) {
            console.error('Failed to export SVG:', error);
            await this.showAlertModal('Unable to export SVG.');
        }
    }

    async handleCopySvgHtmlClick() {
        try {
            const svg = this.buildObjectSvgMarkup();
            await this.copyTextOrShowPrompt(
                svg,
                'SVG HTML copied to clipboard.',
                'Copy this SVG HTML'
            );
        } catch (error) {
            console.error('Failed to copy SVG HTML:', error);
            await this.showAlertModal('Unable to copy SVG HTML.');
        }
    }

    async getSnapshotFromImportedPayload(parsed) {
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        if (parsed.snapshot && typeof parsed.snapshot === 'object') {
            return parsed.snapshot;
        }

        if (typeof parsed.state === 'string') {
            return this.decodeShareState(parsed.state);
        }

        if (typeof parsed.sharePayload === 'string') {
            return this.decodeShareState(parsed.sharePayload);
        }

        if (parsed.version === SHARE_STATE_VERSION && parsed.composite && parsed.objects) {
            return parsed;
        }

        return null;
    }

    clearShareHashFromUrl() {
        try {
            const url = new URL(window.location.href);
            if (!url.hash) return;
            url.hash = '';
            window.history.replaceState(null, '', url.toString());
        } catch {
            // Import should not fail just because the browser disallows URL cleanup.
        }
    }

    async handleImportJsonFileSelected(event) {
        const file = event.target?.files?.[0];
        if (event.target) {
            event.target.value = '';
        }
        if (!file) return;

        try {
            if (Number.isFinite(file.size) && file.size > MAX_JSON_IMPORT_BYTES) {
                throw new Error('JSON diagram file exceeds the import size limit');
            }
            const parsed = JSON.parse(await file.text());
            const snapshot = await this.getSnapshotFromImportedPayload(parsed);
            if (!snapshot || snapshot.version !== SHARE_STATE_VERSION || !this.applySharedStateSnapshot(snapshot)) {
                throw new Error('Unsupported JSON diagram format');
            }

            this.clearShareHashFromUrl();
            this.localStateViewOnlySaveBlocked = false;
            const savedLocally = this.persistLocalStateNow({ notifyOnFailure: false });
            if (savedLocally) {
                this.showToast('JSON imported.');
            } else {
                this.notifyLocalStateSaveFailure(
                    'JSON imported, but browser storage is full. Export JSON now to protect your work.',
                    { force: true }
                );
            }
        } catch (error) {
            console.error('Failed to import JSON:', error);
            await this.showAlertModal('Unable to import that JSON file.');
        }
    }

    buildEmbedScriptSnippet(payload) {
        return [
            `<div class="threedgeogon-embed" data-state="${payload}" data-height="540" data-title="${APP_NAME} diagram" data-autofit="1" data-zoom="1"></div>`,
            '<script src="3DGeoGon-embed.js?v=2026080901" defer></script>'
        ].join('\n');
    }

    async handleEmbedScriptClick() {
        try {
            const snapshot = this.getShareableStateSnapshot();
            const payload = await this.encodeShareState(snapshot);
            const embedCode = this.buildEmbedScriptSnippet(payload);

            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(embedCode);
                await this.showPromptModal('Embed script copied. You can also copy it here:', embedCode);
                return;
            }

            await this.showPromptModal('Copy this embed script', embedCode);
        } catch (error) {
            console.error('Failed to create embed script:', error);
            await this.showAlertModal('Unable to generate embed script.');
        }
    }

    showPromptModal(message, defaultValue = '', options = {}) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('custom-modal-overlay');
            const msgEl   = document.getElementById('custom-modal-message');
            const input   = document.getElementById('custom-modal-input');
            const ratioFields = document.getElementById('custom-modal-ratio-fields');
            const symbols = document.getElementById('custom-modal-symbols');
            const colorPicker = document.getElementById('custom-modal-color-picker');
            const errorEl = document.getElementById('custom-modal-error');
            const confirm = document.getElementById('custom-modal-confirm');
            const cancel  = document.getElementById('custom-modal-cancel');
            const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const symbolByKey = {
                alpha: '\u03B1',
                beta: '\u03B2',
                gamma: '\u03B3',
                delta: '\u03B4',
                theta: '\u03B8',
                phi: '\u03C6',
                degree: '\u00B0'
            };
            const allowQuickSymbols = options.quickSymbols === true;
            const colorPickerOptions = options.colorPicker && typeof options.colorPicker === 'object'
                ? options.colorPicker
                : null;
            const colorChoices = colorPickerOptions
                ? (Array.isArray(colorPickerOptions.colors) ? colorPickerOptions.colors : this.getLabelColorPalette())
                    .map((color) => this.normalizeConstructionColor(color))
                    .filter((color, index, colors) => colors.indexOf(color) === index)
                : [];
            const hasColorPicker = !!colorPicker && colorChoices.length > 0;
            let selectedPromptColor = hasColorPicker
                ? this.normalizeConstructionColor(colorPickerOptions.value, colorChoices[0])
                : null;

            msgEl.textContent = message;
            input.value = defaultValue;
            input.hidden = false;
            errorEl.textContent = '';
            if (ratioFields) {
                ratioFields.hidden = true;
            }
            if (symbols) {
                symbols.hidden = !allowQuickSymbols;
            }
            if (colorPicker) {
                colorPicker.textContent = '';
                colorPicker.hidden = !hasColorPicker;
                if (hasColorPicker) {
                    colorChoices.forEach((paletteColor) => {
                        const normalizedColor = this.normalizeConstructionColor(paletteColor);
                        const hex = this.getConstructionColorHex(normalizedColor);
                        const swatch = document.createElement('button');
                        swatch.type = 'button';
                        swatch.className = 'custom-modal-color-swatch';
                        swatch.dataset.modalColor = String(normalizedColor);
                        swatch.style.backgroundColor = hex;
                        swatch.setAttribute('aria-label', `Set label color to ${hex}`);
                        swatch.setAttribute('aria-pressed', normalizedColor === selectedPromptColor ? 'true' : 'false');
                        swatch.title = `Set label color to ${hex}`;
                        colorPicker.appendChild(swatch);
                    });
                }
            }
            overlay.classList.add('show');
            overlay.setAttribute('aria-hidden', 'false');

            setTimeout(() => {
                if (overlay.classList.contains('show')) {
                    input.focus();
                    input.select();
                }
            }, 50);

            const close = (value) => {
                overlay.classList.remove('show');
                overlay.setAttribute('aria-hidden', 'true');
                confirm.removeEventListener('click', onConfirm);
                cancel.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onBackdrop);
                overlay.removeEventListener('keydown', onKey);
                input.hidden = false;
                if (ratioFields) {
                    ratioFields.hidden = true;
                }
                if (symbols) {
                    symbols.removeEventListener('click', onSymbolClick);
                    symbols.hidden = true;
                }
                if (colorPicker) {
                    colorPicker.removeEventListener('click', onColorClick);
                    colorPicker.textContent = '';
                    colorPicker.hidden = true;
                }
                if (activeCustomModalDismiss === dismiss) {
                    activeCustomModalDismiss = null;
                }
                restoreFocus(previousFocus);
                resolve(value);
            };

            const dismiss = () => close(null);
            activeCustomModalDismiss = dismiss;

            const readPromptValue = () => (
                hasColorPicker
                    ? { value: input.value, color: selectedPromptColor }
                    : input.value
            );
            const onConfirm = () => close(readPromptValue());
            const onCancel  = () => close(null);
            const onBackdrop = (e) => { if (e.target === overlay) close(null); };
            const onSymbolClick = (e) => {
                const btn = e.target.closest('button[data-symbol-key]');
                if (!btn) {
                    return;
                }

                const symbol = symbolByKey[btn.dataset.symbolKey];
                if (!symbol) {
                    return;
                }

                const start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
                const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : input.value.length;
                input.focus();
                input.setRangeText(symbol, start, end, 'end');
            };
            const onColorClick = (e) => {
                const btn = e.target.closest('button[data-modal-color]');
                if (!btn || !colorPicker) {
                    return;
                }

                selectedPromptColor = this.normalizeConstructionColor(btn.dataset.modalColor, selectedPromptColor);
                colorPicker.querySelectorAll('button[data-modal-color]').forEach((swatch) => {
                    swatch.setAttribute('aria-pressed', swatch === btn ? 'true' : 'false');
                });
            };
            const onKey = (e) => {
                if (trapFocusWithin(e, overlay)) return;
                if (e.key === 'Enter' && e.target === input) {
                    e.preventDefault();
                    e.stopPropagation();
                    close(readPromptValue());
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    close(null);
                }
            };

            confirm.addEventListener('click', onConfirm);
            cancel.addEventListener('click', onCancel);
            overlay.addEventListener('click', onBackdrop);
            overlay.addEventListener('keydown', onKey);
            if (symbols && allowQuickSymbols) {
                symbols.addEventListener('click', onSymbolClick);
            }
            if (colorPicker && hasColorPicker) {
                colorPicker.addEventListener('click', onColorClick);
            }
        });
    }

    showRatioPromptModal(message, defaultLeft = 1, defaultRight = 2) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('custom-modal-overlay');
            const msgEl = document.getElementById('custom-modal-message');
            const input = document.getElementById('custom-modal-input');
            const ratioFields = document.getElementById('custom-modal-ratio-fields');
            const leftInput = document.getElementById('custom-modal-ratio-left');
            const rightInput = document.getElementById('custom-modal-ratio-right');
            const symbols = document.getElementById('custom-modal-symbols');
            const colorPicker = document.getElementById('custom-modal-color-picker');
            const errorEl = document.getElementById('custom-modal-error');
            const confirm = document.getElementById('custom-modal-confirm');
            const cancel = document.getElementById('custom-modal-cancel');
            const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

            if (!overlay || !msgEl || !input || !ratioFields || !leftInput || !rightInput || !errorEl || !confirm || !cancel) {
                resolve(null);
                return;
            }

            msgEl.textContent = message;
            input.hidden = true;
            ratioFields.hidden = false;
            leftInput.value = `${defaultLeft}`;
            rightInput.value = `${defaultRight}`;
            errorEl.textContent = '';
            if (symbols) {
                symbols.hidden = true;
            }
            if (colorPicker) {
                colorPicker.textContent = '';
                colorPicker.hidden = true;
            }
            overlay.classList.add('show');
            overlay.setAttribute('aria-hidden', 'false');

            setTimeout(() => {
                if (overlay.classList.contains('show')) {
                    leftInput.focus();
                    leftInput.select();
                }
            }, 50);

            const close = (value) => {
                overlay.classList.remove('show');
                overlay.setAttribute('aria-hidden', 'true');
                input.hidden = false;
                ratioFields.hidden = true;
                confirm.removeEventListener('click', onConfirm);
                cancel.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onBackdrop);
                overlay.removeEventListener('keydown', onKey);
                if (activeCustomModalDismiss === dismiss) {
                    activeCustomModalDismiss = null;
                }
                restoreFocus(previousFocus);
                resolve(value);
            };

            const dismiss = () => close(null);
            activeCustomModalDismiss = dismiss;

            const onConfirm = () => {
                const ratio = this.reduceRatio(leftInput.value, rightInput.value);
                if (!ratio) {
                    errorEl.textContent = 'Enter positive whole numbers for both sides of the ratio.';
                    return;
                }

                close(ratio);
            };
            const onCancel = () => close(null);
            const onBackdrop = (e) => { if (e.target === overlay) close(null); };
            const onKey = (e) => {
                if (trapFocusWithin(e, overlay)) return;
                if (e.key === 'Enter' && (e.target === leftInput || e.target === rightInput)) {
                    e.preventDefault();
                    e.stopPropagation();
                    onConfirm();
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    close(null);
                }
            };

            confirm.addEventListener('click', onConfirm);
            cancel.addEventListener('click', onCancel);
            overlay.addEventListener('click', onBackdrop);
            overlay.addEventListener('keydown', onKey);
        });
    }

    showAlertModal(message) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('custom-modal-overlay');
            const msgEl   = document.getElementById('custom-modal-message');
            const input   = document.getElementById('custom-modal-input');
            const symbols = document.getElementById('custom-modal-symbols');
            const colorPicker = document.getElementById('custom-modal-color-picker');
            const errorEl = document.getElementById('custom-modal-error');
            const confirm = document.getElementById('custom-modal-confirm');
            const cancel  = document.getElementById('custom-modal-cancel');
            const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

            msgEl.textContent = message;
            input.style.display = 'none';
            if (symbols) {
                symbols.hidden = true;
            }
            if (colorPicker) {
                colorPicker.textContent = '';
                colorPicker.hidden = true;
            }
            errorEl.textContent = '';
            cancel.style.display = 'none';
            overlay.classList.add('show');
            overlay.setAttribute('aria-hidden', 'false');

            const close = () => {
                overlay.classList.remove('show');
                overlay.setAttribute('aria-hidden', 'true');
                input.style.display = '';
                cancel.style.display = '';
                confirm.removeEventListener('click', close);
                overlay.removeEventListener('keydown', onKey);
                overlay.removeEventListener('click', onBackdrop);
                if (activeCustomModalDismiss === dismiss) {
                    activeCustomModalDismiss = null;
                }
                restoreFocus(previousFocus);
                resolve();
            };

            const dismiss = () => close();
            activeCustomModalDismiss = dismiss;

            const onKey = (e) => {
                if (trapFocusWithin(e, overlay)) return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    close();
                }
            };
            const onBackdrop = (e) => { if (e.target === overlay) close(); };

            confirm.addEventListener('click', close);
            overlay.addEventListener('keydown', onKey);
            overlay.addEventListener('click', onBackdrop);
            window.requestAnimationFrame(() => {
                if (overlay.classList.contains('show')) {
                    confirm.focus();
                }
            });
        });
    }

    showConfirmModal(message, options = {}) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('custom-modal-overlay');
            const msgEl = document.getElementById('custom-modal-message');
            const input = document.getElementById('custom-modal-input');
            const ratioFields = document.getElementById('custom-modal-ratio-fields');
            const symbols = document.getElementById('custom-modal-symbols');
            const colorPicker = document.getElementById('custom-modal-color-picker');
            const errorEl = document.getElementById('custom-modal-error');
            const confirm = document.getElementById('custom-modal-confirm');
            const cancel = document.getElementById('custom-modal-cancel');
            const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

            if (!overlay || !msgEl || !input || !confirm || !cancel) {
                resolve(false);
                return;
            }

            const originalConfirmText = confirm.textContent;
            const originalCancelText = cancel.textContent;
            const dismissValue = Object.prototype.hasOwnProperty.call(options, 'dismissValue')
                ? options.dismissValue
                : false;

            msgEl.textContent = message;
            input.hidden = true;
            if (ratioFields) {
                ratioFields.hidden = true;
            }
            if (symbols) {
                symbols.hidden = true;
            }
            if (colorPicker) {
                colorPicker.textContent = '';
                colorPicker.hidden = true;
            }
            errorEl.textContent = '';
            confirm.textContent = options.confirmText || 'OK';
            cancel.textContent = options.cancelText || 'Cancel';
            cancel.style.display = '';

            overlay.classList.add('show');
            overlay.setAttribute('aria-hidden', 'false');

            const close = (value) => {
                overlay.classList.remove('show');
                overlay.setAttribute('aria-hidden', 'true');
                input.hidden = false;
                if (ratioFields) {
                    ratioFields.hidden = true;
                }
                if (symbols) {
                    symbols.hidden = true;
                }
                if (colorPicker) {
                    colorPicker.textContent = '';
                    colorPicker.hidden = true;
                }
                confirm.textContent = originalConfirmText;
                cancel.textContent = originalCancelText;
                confirm.removeEventListener('click', onConfirm);
                cancel.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onBackdrop);
                overlay.removeEventListener('keydown', onKey);
                if (activeCustomModalDismiss === dismiss) {
                    activeCustomModalDismiss = null;
                }
                restoreFocus(previousFocus);
                resolve(value);
            };

            const dismiss = () => close(dismissValue);
            activeCustomModalDismiss = dismiss;

            const onConfirm = () => close(true);
            const onCancel = () => close(false);
            const onBackdrop = (e) => { if (e.target === overlay) close(dismissValue); };
            const onKey = (e) => {
                if (trapFocusWithin(e, overlay)) return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    close(dismissValue);
                }
            };

            confirm.addEventListener('click', onConfirm);
            cancel.addEventListener('click', onCancel);
            overlay.addEventListener('click', onBackdrop);
            overlay.addEventListener('keydown', onKey);
            window.requestAnimationFrame(() => {
                if (overlay.classList.contains('show')) {
                    confirm.focus();
                }
            });
        });
    }

    buildLocalStateSnapshot() {
        const snapshot = this.getShareableStateSnapshot();
        return {
            ...snapshot,
            savedAt: Date.now()
        };
    }

    getLocalStateSignature(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') {
            return null;
        }

        try {
            return JSON.stringify({
                version: snapshot.version,
                ui: snapshot.ui,
                camera: snapshot.camera,
                labels: snapshot.labels,
                points: snapshot.points,
                composite: snapshot.composite,
                objects: snapshot.objects
            });
        } catch (error) {
            return null;
        }
    }

    hasRestorableContent(snapshot) {
        const slotCount = Array.isArray(snapshot?.composite?.slots) ? snapshot.composite.slots.length : 0;
        const itemCount = Array.isArray(snapshot?.objects?.items) ? snapshot.objects.items.length : 0;
        return slotCount > 0 || itemCount > 0;
    }

    hasKnownRestorableContent(snapshot) {
        const slots = Array.isArray(snapshot?.composite?.slots) ? snapshot.composite.slots : [];
        return slots.length > 0
            && slots.length <= 3
            && slots.every((slot) => !!this.normalizeSlotForRestore(slot));
    }

    writeRollbackStoragePair(currentKey, legacyKey, value, label) {
        const result = {
            currentUpdated: false,
            legacyUpdated: false,
            complete: false,
            successful: false,
            usedSingleCopyFallback: false,
            priorLegacyRestored: false,
            errors: []
        };
        const updateKey = (key, target) => {
            try {
                if (value === null) {
                    window.localStorage.removeItem(key);
                } else {
                    window.localStorage.setItem(key, value);
                }
                result[`${target}Updated`] = true;
                return true;
            } catch (error) {
                result.errors.push({ target, error });
                return false;
            }
        };

        if (value === null) {
            updateKey(currentKey, 'current');
            updateKey(legacyKey, 'legacy');
            result.complete = result.currentUpdated && result.legacyUpdated;
            result.successful = result.complete;
        } else {
            let priorCurrentValue = null;
            let priorCurrentReadable = false;
            let priorLegacyValue = null;
            let priorLegacyReadable = false;
            try {
                priorCurrentValue = window.localStorage.getItem(currentKey);
                priorCurrentReadable = true;
            } catch (error) {
                result.errors.push({ target: 'current-read', error });
            }
            try {
                priorLegacyValue = window.localStorage.getItem(legacyKey);
                priorLegacyReadable = true;
            } catch (error) {
                result.errors.push({ target: 'legacy-read', error });
            }

            updateKey(currentKey, 'current');
            updateKey(legacyKey, 'legacy');

            // When both replacements exceed browser quota, retain the canonical
            // current recovery copy, release only the redundant legacy copy, and
            // retry the current write. If that retry also fails, put the legacy
            // rollback value back so the existing diagram remains recoverable.
            const hasRedundantRecoveryPair = priorCurrentReadable
                && priorLegacyReadable
                && priorCurrentValue !== null
                && priorCurrentValue === priorLegacyValue;
            if (!result.currentUpdated && !result.legacyUpdated && hasRedundantRecoveryPair) {
                let legacyReleased = false;
                try {
                    window.localStorage.removeItem(legacyKey);
                    legacyReleased = true;
                } catch (error) {
                    result.errors.push({ target: 'legacy-release', error });
                }

                if (legacyReleased) {
                    if (updateKey(currentKey, 'current')) {
                        result.usedSingleCopyFallback = true;
                    } else if (priorLegacyValue === null) {
                        result.priorLegacyRestored = true;
                    } else {
                        try {
                            window.localStorage.setItem(legacyKey, priorLegacyValue);
                            result.priorLegacyRestored = true;
                        } catch (error) {
                            result.errors.push({ target: 'legacy-restore', error });
                        }
                    }
                }
            }

            result.complete = result.currentUpdated && result.legacyUpdated;
            result.successful = result.currentUpdated || result.legacyUpdated;
        }

        if (!result.complete) {
            const detail = result.errors[0]?.error;
            console.warn(
                result.successful
                    ? `Updated ${label} with one recovery copy because browser storage is constrained.`
                    : `Unable to update ${label}; the previous recovery copy was retained.`,
                detail || ''
            );
        }

        return result;
    }

    clearLocalStateSnapshot() {
        return this.writeRollbackStoragePair(
            LOCAL_STATE_KEY,
            LEGACY_LOCAL_STATE_KEY,
            null,
            'local state'
        );
    }

    parseRestorableLocalStateValue(raw) {
        if (typeof raw !== 'string' || raw.length === 0) {
            return null;
        }

        try {
            const parsed = JSON.parse(raw);
            const savedObjects = parsed?.objects?.items == null ? [] : parsed.objects.items;
            if (
                !parsed
                || parsed.version !== SHARE_STATE_VERSION
                || !this.hasRestorableContent(parsed)
                || !this.hasKnownRestorableContent(parsed)
                || !this.validateSavedSceneObjectsForRestore(savedObjects)
                || !this.normalizeLabelOverrideEntriesForRestore(parsed.labels?.base)
                || !this.normalizeLabelOverrideEntriesForRestore(parsed.labels?.derived)
                || !this.normalizePointStateSetForRestore(parsed.points?.hiddenSourceIds)
                || !this.normalizePointStateSetForRestore(parsed.points?.hiddenDerivedSignatures)
                || !this.validatePointColorOverrideEntriesForRestore(parsed.points?.baseColors)
                || !this.validatePointColorOverrideEntriesForRestore(parsed.points?.derivedColors)
            ) {
                return null;
            }
            return parsed;
        } catch (error) {
            return null;
        }
    }

    getLocalStateSavedAt(snapshot) {
        const savedAt = Number(snapshot?.savedAt);
        return Number.isFinite(savedAt) ? savedAt : null;
    }

    chooseNewestLocalStateValue(current, legacy) {
        const currentSavedAt = this.getLocalStateSavedAt(current.parsed);
        const legacySavedAt = this.getLocalStateSavedAt(legacy.parsed);
        if (currentSavedAt !== null && legacySavedAt !== null && legacySavedAt > currentSavedAt) {
            return legacy;
        }
        return current;
    }

    migrateLegacyStorageValue(legacyKey, currentKey, validate, label, choose = null) {
        try {
            const currentValue = window.localStorage.getItem(currentKey);
            const legacyValue = window.localStorage.getItem(legacyKey);
            const current = { value: currentValue, parsed: validate(currentValue) };
            const legacy = { value: legacyValue, parsed: validate(legacyValue) };
            const selected = current.parsed && legacy.parsed
                ? (choose ? choose(current, legacy) : current)
                : current.parsed
                    ? current
                    : legacy.parsed
                        ? legacy
                        : null;

            if (!selected) {
                return currentValue;
            }

            this.writeRollbackStoragePair(currentKey, legacyKey, selected.value, label);
            return selected.value;
        } catch (error) {
            console.warn(`Unable to synchronize legacy ${label}:`, error);
            return null;
        }
    }

    migrateLegacyLocalStateKeys() {
        const validate = (value) => this.parseRestorableLocalStateValue(value);
        this.migrateLegacyStorageValue(
            LEGACY_LOCAL_STATE_SUPPRESS_SIGNATURE_KEY,
            LOCAL_STATE_SUPPRESS_SIGNATURE_KEY,
            validate,
            'local-state suppression signature'
        );
    }

    getSuppressedLocalStateSignature() {
        for (const key of [LOCAL_STATE_SUPPRESS_SIGNATURE_KEY, LEGACY_LOCAL_STATE_SUPPRESS_SIGNATURE_KEY]) {
            try {
                const signature = window.localStorage.getItem(key);
                if (this.parseRestorableLocalStateValue(signature)) {
                    return signature;
                }
            } catch (error) {
                // Try the rollback key when one storage read is unavailable.
            }
        }
        return null;
    }

    setSuppressedLocalStateSignature(signature) {
        return this.writeRollbackStoragePair(
            LOCAL_STATE_SUPPRESS_SIGNATURE_KEY,
            LEGACY_LOCAL_STATE_SUPPRESS_SIGNATURE_KEY,
            signature || null,
            'local-state suppression signature'
        );
    }

    notifyLocalStateSaveFailure(message = 'Unable to save this diagram in browser storage. Export JSON to protect your work.', { force = false } = {}) {
        if (this.isShuttingDown || document.visibilityState !== 'visible'
            || (!force && this.localStateSaveFailureNotified)) {
            return;
        }
        this.localStateSaveFailureNotified = true;
        this.showToast(message, 7000);
    }

    scheduleLocalStateSave({ viewOnly = false } = {}) {
        if (this.embedMode || !this.localStateReady || this.isRestoringSharedState || this.isShuttingDown) {
            return;
        }
        if (viewOnly && this.localStateViewOnlySaveBlocked) {
            return;
        }
        if (!viewOnly) {
            this.localStateViewOnlySaveBlocked = false;
        }

        if (this.localStateSaveTimer) {
            clearTimeout(this.localStateSaveTimer);
            this.localStateSaveTimer = null;
        }

        this.localStateSaveTimer = window.setTimeout(() => {
            this.localStateSaveTimer = null;
            this.persistLocalStateNow();
        }, LOCAL_STATE_SAVE_DEBOUNCE_MS);
    }

    flushPendingLocalStateSave() {
        if (!this.localStateSaveTimer) {
            return false;
        }

        clearTimeout(this.localStateSaveTimer);
        this.localStateSaveTimer = null;
        this.persistLocalStateNow();
        return true;
    }

    persistLocalStateNow({ notifyOnFailure = true } = {}) {
        if (this.embedMode || !this.localStateReady || this.isRestoringSharedState || this.isShuttingDown) {
            return false;
        }

        const snapshot = this.buildLocalStateSnapshot();
        if (!this.hasRestorableContent(snapshot)) {
            const clearResult = this.clearLocalStateSnapshot();
            this.localDeletedBaselineSignature = null;
            const suppressionResult = this.setSuppressedLocalStateSignature(null);
            const cleared = clearResult.successful && suppressionResult.successful;
            if (cleared) {
                this.localStateSaveFailureNotified = false;
            } else if (notifyOnFailure) {
                this.notifyLocalStateSaveFailure();
            }
            return cleared;
        }

        const currentSignature = this.getLocalStateSignature(snapshot);
        const suppressedSignature = this.getSuppressedLocalStateSignature();
        if (
            (this.localDeletedBaselineSignature && currentSignature === this.localDeletedBaselineSignature)
            || (suppressedSignature && currentSignature === suppressedSignature)
        ) {
            const clearResult = this.clearLocalStateSnapshot();
            if (clearResult.successful) {
                this.localStateSaveFailureNotified = false;
            } else if (notifyOnFailure) {
                this.notifyLocalStateSaveFailure();
            }
            return clearResult.successful;
        }

        if (this.localDeletedBaselineSignature && currentSignature !== this.localDeletedBaselineSignature) {
            this.localDeletedBaselineSignature = null;
            this.setSuppressedLocalStateSignature(null);
        }

        try {
            const serialized = JSON.stringify(snapshot);
            const result = this.writeRollbackStoragePair(
                LOCAL_STATE_KEY,
                LEGACY_LOCAL_STATE_KEY,
                serialized,
                'local state'
            );
            if (result.successful) {
                this.localStateSaveFailureNotified = false;
                return true;
            }
        } catch (error) {
            console.warn('Unable to serialize local state:', error);
        }

        if (notifyOnFailure) {
            this.notifyLocalStateSaveFailure();
        }
        return false;
    }

    getStoredLocalStateCandidates() {
        try {
            this.migrateLegacyLocalStateKeys();
            const current = {
                key: LOCAL_STATE_KEY,
                value: window.localStorage.getItem(LOCAL_STATE_KEY)
            };
            const legacy = {
                key: LEGACY_LOCAL_STATE_KEY,
                value: window.localStorage.getItem(LEGACY_LOCAL_STATE_KEY)
            };
            current.parsed = this.parseRestorableLocalStateValue(current.value);
            legacy.parsed = this.parseRestorableLocalStateValue(legacy.value);

            let ordered = [];
            if (current.parsed && legacy.parsed) {
                const selected = this.chooseNewestLocalStateValue(current, legacy);
                ordered = selected === legacy ? [legacy, current] : [current, legacy];
            } else if (current.parsed) {
                ordered = [current];
            } else if (legacy.parsed) {
                ordered = [legacy];
            }

            return ordered.filter((candidate, index) => (
                ordered.findIndex((other) => other.value === candidate.value) === index
            ));
        } catch (error) {
            console.warn('Unable to read local state:', error);
            return [];
        }
    }

    hasAnyStoredLocalStateValue() {
        try {
            return [LOCAL_STATE_KEY, LEGACY_LOCAL_STATE_KEY].some((key) => {
                const value = window.localStorage.getItem(key);
                return typeof value === 'string' && value.length > 0;
            });
        } catch (error) {
            return false;
        }
    }

    async restoreLocalStateIfPresent() {
        const hadStoredState = this.hasAnyStoredLocalStateValue();
        const candidates = this.getStoredLocalStateCandidates();
        if (candidates.length === 0) {
            // Keep unrecognized or damaged raw saves recoverable. Passive camera,
            // display, and exit events may not replace them with an empty diagram;
            // a deliberate content edit releases this guard.
            this.localStateViewOnlySaveBlocked = hadStoredState;
            return false;
        }

        const suppressedSignature = this.getSuppressedLocalStateSignature();
        for (const candidate of candidates) {
            const candidateSignature = this.getLocalStateSignature(candidate.parsed);
            if (suppressedSignature && candidateSignature === suppressedSignature) {
                this.clearLocalStateSnapshot();
                this.localStateViewOnlySaveBlocked = false;
                return false;
            }

            if (!this.applySharedStateSnapshot(candidate.parsed)) {
                continue;
            }

            // Synchronize the rollback pair only after a candidate has restored
            // successfully. A newer corrupt save can no longer overwrite the
            // older working copy before it has proved restorable.
            this.writeRollbackStoragePair(
                LOCAL_STATE_KEY,
                LEGACY_LOCAL_STATE_KEY,
                candidate.value,
                'local state'
            );
            this.showToast('Restored previous diagram.');
            this.localDeletedBaselineSignature = null;
            this.localStateViewOnlySaveBlocked = false;
            this.setSuppressedLocalStateSignature(null);
            return true;
        }

        this.localStateViewOnlySaveBlocked = hadStoredState;
        return false;
    }

    showToast(message, durationMs = 2200) {
        if (!message) return;

        if (this.toastHideTimer) {
            clearTimeout(this.toastHideTimer);
            this.toastHideTimer = null;
        }

        if (!this.toastEl) {
            const toast = document.createElement('div');
            toast.className = 'app-toast';
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');
            document.body.appendChild(toast);
            this.toastEl = toast;
        }

        this.toastEl.textContent = message;
        this.toastEl.classList.add('show');

        this.toastHideTimer = setTimeout(() => {
            if (this.toastEl) {
                this.toastEl.classList.remove('show');
            }
            this.toastHideTimer = null;
        }, Math.max(800, durationMs));
    }

    setupCrashDiagnostics() {
        if (this._crashListenersBound) {
            return;
        }

        this.recordCrashEvent('app.init', {
            userAgent: navigator.userAgent,
            url: window.location.href,
            shortcut: this.crashReportShortcut,
            wasDiscardedAtLoad: this.wasDiscardedAtLoad,
            deviceMemoryGb: Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : null,
            hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null
        });

        this._onCrashWindowError = (event) => {
            this.recordCrashEvent('window.error', {
                message: event?.message || 'Unknown error',
                source: event?.filename || '',
                line: event?.lineno || 0,
                column: event?.colno || 0,
                stack: event?.error?.stack || ''
            });
        };

        this._onCrashUnhandledRejection = (event) => {
            const reason = event?.reason;
            this.recordCrashEvent('window.unhandledrejection', {
                message: reason?.message || String(reason || 'Unknown rejection'),
                stack: reason?.stack || ''
            });
        };

        this._onCrashVisibilityChange = () => {
            this.recordCrashEvent('document.visibilitychange', {
                state: document.visibilityState
            });
            if (document.visibilityState === 'hidden') {
                this.scheduleLocalStateSave({ viewOnly: true });
                this.flushPendingLocalStateSave();
            }
            this.recordIntegrityCheck(`visibilitychange:${document.visibilityState}`);
        };

        this._onCrashPageHide = (event) => {
            this.scheduleLocalStateSave({ viewOnly: true });
            this.flushPendingLocalStateSave();
            this.recordCrashEvent('window.pagehide', {
                persisted: event?.persisted === true
            });
        };

        this._onCrashPageShow = (event) => {
            this.recordCrashEvent('window.pageshow', {
                persisted: event?.persisted === true
            });
            this.recordIntegrityCheck('pageshow');
        };

        this._onCrashFocus = () => {
            this.recordCrashEvent('window.focus', {});
            this.recordIntegrityCheck('focus');
        };

        this._onCrashBlur = () => {
            this.recordCrashEvent('window.blur', {});
        };

        this._onCrashWebglContextLost = (event) => {
            // Prevent default so the browser can attempt WebGL context restoration.
            event.preventDefault();
            this.recordCrashEvent('canvas.webglcontextlost', {});
        };

        this._onCrashWebglContextRestored = () => {
            this.recordCrashEvent('canvas.webglcontextrestored', {});
            this.recordIntegrityCheck('webglcontextrestored');
        };

        this._onCrashFreeze = () => {
            this.recordCrashEvent('document.freeze', {});
            this.recordIntegrityCheck('freeze');
        };

        this._onCrashResume = () => {
            this.recordCrashEvent('document.resume', {});
            this.recordIntegrityCheck('resume');
        };

        window.addEventListener('error', this._onCrashWindowError);
        window.addEventListener('unhandledrejection', this._onCrashUnhandledRejection);
        document.addEventListener('visibilitychange', this._onCrashVisibilityChange);
        window.addEventListener('pagehide', this._onCrashPageHide);
        window.addEventListener('pageshow', this._onCrashPageShow);
        window.addEventListener('focus', this._onCrashFocus);
        window.addEventListener('blur', this._onCrashBlur);
        document.addEventListener('freeze', this._onCrashFreeze);
        document.addEventListener('resume', this._onCrashResume);
        this.canvas?.addEventListener('webglcontextlost', this._onCrashWebglContextLost);
        this.canvas?.addEventListener('webglcontextrestored', this._onCrashWebglContextRestored);

        this.crashWatchdogIntervalId = window.setInterval(() => {
            if (document.visibilityState === 'hidden') {
                this.recordIntegrityCheck('interval:hidden');
            }
        }, this.crashWatchdogIntervalMs);

        this.recordIntegrityCheck('startup');

        this._crashListenersBound = true;
    }

    teardownCrashDiagnostics() {
        if (!this._crashListenersBound) {
            return;
        }

        window.removeEventListener('error', this._onCrashWindowError);
        window.removeEventListener('unhandledrejection', this._onCrashUnhandledRejection);
        document.removeEventListener('visibilitychange', this._onCrashVisibilityChange);
        window.removeEventListener('pagehide', this._onCrashPageHide);
        window.removeEventListener('pageshow', this._onCrashPageShow);
        window.removeEventListener('focus', this._onCrashFocus);
        window.removeEventListener('blur', this._onCrashBlur);
        document.removeEventListener('freeze', this._onCrashFreeze);
        document.removeEventListener('resume', this._onCrashResume);
        this.canvas?.removeEventListener('webglcontextlost', this._onCrashWebglContextLost);
        this.canvas?.removeEventListener('webglcontextrestored', this._onCrashWebglContextRestored);

        if (this.crashWatchdogIntervalId) {
            window.clearInterval(this.crashWatchdogIntervalId);
            this.crashWatchdogIntervalId = null;
        }

        this._crashListenersBound = false;
    }

    recordCrashEvent(type, payload = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            type,
            payload
        };

        this.crashReportEntries.push(entry);
        if (this.crashReportEntries.length > this.maxCrashReportEntries) {
            this.crashReportEntries.splice(0, this.crashReportEntries.length - this.maxCrashReportEntries);
        }
    }

    buildStateIntegritySnapshot(reason = 'manual') {
        const sectionCounts = {};
        Object.entries(this.objectSections || {}).forEach(([key, sec]) => {
            sectionCounts[key] = sec?.list?.children?.length ?? null;
        });

        const sceneObjectTypeCounts = {};
        (this.sceneObjects || []).forEach((entry) => {
            const type = entry?.type || 'unknown';
            sceneObjectTypeCounts[type] = (sceneObjectTypeCounts[type] || 0) + 1;
        });

        const defaultParamsKeyCount = this.defaultParams && typeof this.defaultParams === 'object'
            ? Object.keys(this.defaultParams).length
            : 0;
        const primitiveMetaKeyCount = this.primitiveMeta && typeof this.primitiveMeta === 'object'
            ? Object.keys(this.primitiveMeta).length
            : 0;
        const orientationsKeyCount = this.orientations && typeof this.orientations === 'object'
            ? Object.keys(this.orientations).length
            : 0;

        const stateShape = {
            reason,
            visibilityState: document.visibilityState,
            compositeSlots: this.compositeSlots?.length ?? 0,
            pointDefinitions: this.pointDefinitions?.length ?? 0,
            derivedPoints: this.derivedPoints?.length ?? 0,
            sceneObjects: this.sceneObjects?.length ?? 0,
            visibleSceneObjects: (this.sceneObjects || []).filter((entry) => entry.visible !== false).length,
            selectedPoints: this.selectedPoints?.length ?? 0,
            sceneChildren: this.scene?.children?.length ?? 0,
            pointMarkers: this.pointMarkers?.size ?? 0,
            pointSprites: this.pointSprites?.length ?? 0,
            labelSprites: this.labelSprites?.length ?? 0,
            objectSectionDomCounts: sectionCounts,
            sceneObjectTypeCounts,
            panelOpen: this.panelOpen,
            triangleExtractState: this.triangleExtractTransitionState,
            triangleExtractOpen: !!this.activeTriangleExtraction,
            addDropdownVisible: this.addDropdown?.style?.display === 'block',
            primitiveConfigHealth: {
                defaultParamsKeyCount,
                primitiveMetaKeyCount,
                orientationsKeyCount
            },
            methodPresence: {
                addSlot: typeof this.addSlot === 'function',
                renderObjectsList: typeof this.renderObjectsList === 'function',
                buildComposite: typeof this.buildComposite === 'function'
            }
        };

        stateShape.stateSize = JSON.stringify(stateShape).length;
        return stateShape;
    }

    recordIntegrityCheck(reason = 'manual') {
        const snapshot = this.buildStateIntegritySnapshot(reason);
        const digest = [
            snapshot.visibilityState,
            snapshot.compositeSlots,
            snapshot.pointDefinitions,
            snapshot.derivedPoints,
            snapshot.sceneObjects,
            snapshot.visibleSceneObjects,
            snapshot.sceneChildren,
            snapshot.addDropdownVisible,
            snapshot.triangleExtractState
        ].join('|');

        if (reason === 'interval:hidden' && digest === this.lastIntegrityDigest) {
            return;
        }

        this.lastIntegrityDigest = digest;
        this.recordCrashEvent('state.integrity', snapshot);
    }

    isCrashReportOpen() {
        return !!this.crashReportOverlay?.classList.contains('show');
    }

    toggleCrashReport() {
        if (this.isCrashReportOpen()) {
            this.closeCrashReport();
            return;
        }

        this.openCrashReport();
    }

    openCrashReport() {
        if (!this.crashReportOverlay || !this.crashReportPre) {
            return;
        }

        this.crashReportOpenedAt = new Date().toISOString();
        this.recordIntegrityCheck('report:open');
        this.recordCrashEvent('crash-report.opened', {
            shortcut: this.crashReportShortcut
        });
        this.crashReportPre.textContent = this.buildCrashReportText();
        this.crashReportOverlay.classList.add('show');
        this.crashReportOverlay.setAttribute('aria-hidden', 'false');
        this.crashReportCloseBtn?.focus();
    }

    closeCrashReport() {
        if (!this.crashReportOverlay) {
            return;
        }

        this.crashReportOverlay.classList.remove('show');
        this.crashReportOverlay.setAttribute('aria-hidden', 'true');
    }

    refreshCrashReport() {
        if (!this.crashReportPre) {
            return;
        }

        this.recordIntegrityCheck('report:refresh');
        this.crashReportPre.textContent = this.buildCrashReportText();
    }

    buildCrashReportText() {
        const integritySnapshot = this.buildStateIntegritySnapshot('report:summary');
        const summary = {
            generatedAt: new Date().toISOString(),
            openedAt: this.crashReportOpenedAt,
            url: window.location.href,
            wasDiscardedAtLoad: this.wasDiscardedAtLoad,
            visibilityState: document.visibilityState,
            online: navigator.onLine,
            deviceMemoryGb: Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : null,
            hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
            performanceMemory: performance?.memory ? {
                jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
                totalJSHeapSize: performance.memory.totalJSHeapSize,
                usedJSHeapSize: performance.memory.usedJSHeapSize
            } : null,
            panelOpen: this.panelOpen,
            activeCompositePrimitives: this.compositeSlots.length,
            points: this.getAllPoints().length,
            sceneObjects: this.sceneObjects.length,
            visibleSceneObjects: this.sceneObjects.filter((entry) => entry.visible !== false).length,
            selectedPoints: this.selectedPoints.length,
            triangleExtractState: this.triangleExtractTransitionState,
            triangleExtractOpen: this.isTriangleExtractionOpen(),
            addDropdownVisible: this.addDropdown?.style.display === 'block',
            rendererInfo: this.renderer?.info ? {
                geometries: this.renderer.info.memory?.geometries ?? null,
                textures: this.renderer.info.memory?.textures ?? null,
                calls: this.renderer.info.render?.calls ?? null,
                triangles: this.renderer.info.render?.triangles ?? null,
                points: this.renderer.info.render?.points ?? null,
                lines: this.renderer.info.render?.lines ?? null
            } : null,
            integritySnapshot
        };

        const lines = [];
        lines.push('3DGeoGon Hidden Crash Report');
        lines.push(`Shortcut: ${this.crashReportShortcut}`);
        lines.push('');
        lines.push('[Summary]');
        lines.push(JSON.stringify(summary, null, 2));
        lines.push('');
        lines.push('[Recent Events]');

        if (this.crashReportEntries.length === 0) {
            lines.push('(no events recorded)');
        } else {
            this.crashReportEntries.slice(-80).forEach((entry) => {
                const payloadText = JSON.stringify(entry.payload || {});
                lines.push(`${entry.timestamp} | ${entry.type} | ${payloadText}`);
            });
        }

        return lines.join('\n');
    }

    async copyCrashReport() {
        if (!this.crashReportPre) {
            return;
        }

        const text = this.crashReportPre.textContent || this.buildCrashReportText();
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                this.showToast('Crash report copied.');
                return;
            }
        } catch {
            // Ignore and continue to fallback copy path.
        }

        const tempArea = document.createElement('textarea');
        tempArea.value = text;
        tempArea.setAttribute('readonly', 'true');
        tempArea.style.position = 'fixed';
        tempArea.style.left = '-9999px';
        document.body.appendChild(tempArea);
        tempArea.select();
        document.execCommand('copy');
        document.body.removeChild(tempArea);
        this.showToast('Crash report copied.');
    }

    isTriangleExtractionOpen() {
        return !!this.activeTriangleExtraction;
    }

    isInspectableSceneObject(item) {
        const def = item?.definition;
        if (!item || !def) {
            return false;
        }

        if (item.type === 'triangle' && Array.isArray(def.pointIds) && def.pointIds.length === 3) {
            return true;
        }

        if (item.type !== 'plane') {
            return false;
        }

        if (def.kind === 'plane' && Array.isArray(def.pointIds) && def.pointIds.length === 4) {
            return true;
        }

        if (def.kind !== 'base-highlight') {
            return false;
        }

        if (def.shape === 'polygon') {
            const boundaryPointIds = Array.isArray(def.boundaryPointIds) ? def.boundaryPointIds : def.pointIds;
            return Array.isArray(boundaryPointIds) && boundaryPointIds.length >= 3;
        }

        if (def.shape === 'circle') {
            const boundaryPointIds = Array.isArray(def.boundaryPointIds) ? def.boundaryPointIds : [];
            return (!!def.centerPointId && boundaryPointIds.length >= 2) || boundaryPointIds.length >= 3;
        }

        return false;
    }

    getInspectionShapeName(item) {
        const def = item?.definition;
        if (def?.kind === 'base-highlight') {
            return 'Base Highlight';
        }
        return item?.type === 'plane' ? 'Quadrilateral' : 'Triangle';
    }

    getInspectionObjectName(item) {
        const def = item?.definition;
        if (def?.kind === 'base-highlight') {
            return 'base highlight';
        }
        return item?.type === 'plane' ? 'quadrilateral' : 'triangle';
    }

    getPlanarRawPoints(worldPoints) {
        if (!Array.isArray(worldPoints) || worldPoints.length < 3) {
            return null;
        }

        const origin = worldPoints[0];
        const uVector = worldPoints[1].clone().sub(origin);
        if (uVector.lengthSq() <= 1e-12) {
            return null;
        }

        let normal = null;
        for (let index = 2; index < worldPoints.length; index += 1) {
            const candidate = new THREE.Vector3().crossVectors(uVector, worldPoints[index].clone().sub(origin));
            if (candidate.lengthSq() > 1e-12) {
                normal = candidate.normalize();
                break;
            }
        }

        if (!normal) {
            return null;
        }

        const u = uVector.clone().normalize();
        const v = new THREE.Vector3().crossVectors(normal, u).normalize();
        return worldPoints.map((point) => {
            const relative = point.clone().sub(origin);
            return {
                x: relative.dot(u),
                y: relative.dot(v)
            };
        });
    }

    buildInspectableExtractionData(item) {
        if (!this.isInspectableSceneObject(item)) {
            return null;
        }

        const def = item.definition;
        const stageAspectRatio = this.getTriangleExtractionStageAspectRatio();
        const shapeName = this.getInspectionShapeName(item);
        const inspectObjectName = this.getInspectionObjectName(item);
        const flightColor = this.getTriangleExtractionColor(def.color);

        if (def.kind === 'base-highlight' && def.shape === 'circle') {
            const sample = this.getCircleBaseSamplePoints(def);
            const labelPointIds = Array.isArray(def.pointIds) ? def.pointIds : [def.centerPointId, ...(def.boundaryPointIds || [])].filter(Boolean);
            const labelPoints = this.getVectorsByPointIds(labelPointIds);
            if (!sample || !labelPoints) {
                return null;
            }

            const rawRingPoints = sample.ringPoints.map((point) => {
                const relative = point.clone().sub(sample.center);
                return {
                    x: relative.dot(sample.u),
                    y: relative.dot(sample.v)
                };
            });
            const rawLabelPoints = labelPoints.map((point) => {
                const relative = point.clone().sub(sample.center);
                return {
                    x: relative.dot(sample.u),
                    y: relative.dot(sample.v)
                };
            });
            const layout = this.buildCircleExtractionLayout(rawRingPoints, rawLabelPoints, stageAspectRatio);
            if (!layout) {
                return null;
            }
            const markerLabelIndexes = labelPointIds.map((_, index) => index);

            return {
                item,
                layout,
                labels: labelPointIds.map((pointId) => this.getPointById(pointId)?.label || pointId),
                labelPointIds,
                sidePointIds: [],
                markerLabelIndexes,
                flightWorldPoints: sample.ringPoints.map((point) => point.clone()),
                sourcePoints: sample.ringPoints.map((point) => this.projectWorldPointToViewport(point)),
                shapeName,
                inspectObjectName,
                pointSequence: this.formatPointSequence(labelPointIds),
                color: flightColor,
                showSideLabels: false,
                showAngles: false
            };
        }

        const pointIds = def.kind === 'base-highlight'
            ? (Array.isArray(def.boundaryPointIds) ? def.boundaryPointIds : def.pointIds)
            : def.pointIds;
        if (!Array.isArray(pointIds) || pointIds.length < 3) {
            return null;
        }

        const points = pointIds.map((pointId) => this.getPointById(pointId));
        if (points.some((point) => !point)) {
            return null;
        }

        const worldPoints = points.map((point) => point.position.clone());
        const sourcePoints = worldPoints.map((point) => this.projectWorldPointToViewport(point));
        let layout = null;

        if (item.type === 'triangle' && def.kind !== 'base-highlight') {
            layout = this.buildCameraAwareTriangleExtractionLayout(
                worldPoints,
                sourcePoints,
                stageAspectRatio
            );
        } else {
            layout = this.buildCameraAwarePlanarPolygonExtractionLayout(
                worldPoints,
                sourcePoints,
                stageAspectRatio
            );
        }

        if (!layout) {
            return null;
        }

        return {
            item,
            layout,
            labels: points.map((point) => point.label || point.id),
            labelPointIds: pointIds,
            sidePointIds: pointIds,
            markerLabelIndexes: [],
            flightWorldPoints: worldPoints,
            sourcePoints,
            shapeName,
            inspectObjectName,
            pointSequence: this.formatPointSequence(pointIds),
            color: flightColor,
            showSideLabels: true,
            showAngles: true
        };
    }

    openTriangleExtraction(objectId) {
        if (this.triangleExtractTransitionState !== 'closed') {
            return;
        }

        if (this.isTriangleExtractionOpen()) {
            this.closeTriangleExtraction();
        }

        const item = this.sceneObjects.find((entry) => entry.id === objectId && this.isInspectableSceneObject(entry));
        if (!item) {
            return;
        }

        const extractionData = this.buildInspectableExtractionData(item);
        if (!extractionData) {
            return;
        }

        if (!this.triangleExtractOverlay || !this.triangleExtractModal || !this.triangleExtractFlightSvg) {
            return;
        }

        this.activeTriangleExtraction = {
            objectId: item.id,
            type: item.type,
            pointIds: [...extractionData.labelPointIds],
            labelPointIds: [...extractionData.labelPointIds],
            sidePointIds: [...extractionData.sidePointIds],
            flightWorldPoints: extractionData.flightWorldPoints.map((point) => point.clone()),
            layout: extractionData.layout,
            baseLayout: extractionData.layout,
            labels: [...extractionData.labels],
            item,
            color: extractionData.color,
            shapeName: extractionData.shapeName,
            inspectObjectName: extractionData.inspectObjectName,
            pointSequence: extractionData.pointSequence,
            showSideLabels: extractionData.showSideLabels,
            showAngles: extractionData.showAngles,
            markerLabelIndexes: [...(extractionData.markerLabelIndexes || [])],
            orientationQuarterTurns: 0,
            orientationFlipped: false,
            transformStageWidth: null,
            transformStageHeight: null
        };
        this.lastFocusedElementBeforeTriangleExtract = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this.controls.enabled = false;
        this._keysHeld?.clear();
        this.triangleExtractTransitionState = 'opening';

        this.triangleExtractOverlay.classList.add('show', 'pre-open');
        this.triangleExtractOverlay.classList.remove('settled');
        this.triangleExtractOverlay.setAttribute('aria-hidden', 'false');

        this.populateTriangleExtractionModal(extractionData.layout, extractionData.labels, item, extractionData.color, this.activeTriangleExtraction);
        this.updateTriangleExtractionOrientationButtons();

        const animationDurationMs = 1450;

        requestAnimationFrame(() => {
            if (!this.activeTriangleExtraction) {
                return;
            }

            this.triangleExtractOverlay.classList.remove('pre-open');
            const destinationPoints = this.getTriangleExtractionDestinationPoints(extractionData.layout);
            this.updateTriangleExtractFlightStyle(extractionData.color);

            if (!destinationPoints) {
                this.finalizeTriangleExtractionReveal();
                return;
            }

            if (animationDurationMs === 0) {
                this.renderTriangleExtractFlight(destinationPoints);
                this.finalizeTriangleExtractionReveal();
                return;
            }

            const startTime = performance.now();
            const step = (now) => {
                if (!this.activeTriangleExtraction) {
                    this.triangleExtractAnimationFrame = null;
                    return;
                }

                const rawProgress = Math.min(1, (now - startTime) / animationDurationMs);
                const eased = 1 - Math.pow(1 - rawProgress, 3);
                const currentPoints = extractionData.sourcePoints.map((point, index) => ({
                    x: THREE.MathUtils.lerp(point.x, destinationPoints[index].x, eased),
                    y: THREE.MathUtils.lerp(point.y, destinationPoints[index].y, eased)
                }));
                this.renderTriangleExtractFlight(currentPoints);

                if (rawProgress >= 1) {
                    this.triangleExtractAnimationFrame = null;
                    this.finalizeTriangleExtractionReveal();
                    return;
                }

                this.triangleExtractAnimationFrame = window.requestAnimationFrame(step);
            };

            this.renderTriangleExtractFlight(extractionData.sourcePoints);
            this.triangleExtractAnimationFrame = window.requestAnimationFrame(step);
        });
    }

    getTriangleSignedArea2D(points) {
        if (!Array.isArray(points) || points.length < 3) {
            return 0;
        }

        const a = points[0];
        const b = points[1];
        const c = points[2];
        return ((b.x - a.x) * (c.y - a.y)) - ((b.y - a.y) * (c.x - a.x));
    }

    scoreTriangleLayoutAgainstCamera(layout, cameraPoints) {
        if (!layout?.points2D || layout.points2D.length < 3 || !Array.isArray(cameraPoints) || cameraPoints.length < 3) {
            return -Infinity;
        }

        const normalizedLayout = this.normalizePointsForComparison(layout.points2D);
        const normalizedCamera = this.normalizePointsForComparison(cameraPoints);
        if (!normalizedLayout || !normalizedCamera) {
            return -Infinity;
        }

        // Vertex-to-vertex fit after translation/scale normalization.
        let pointError = 0;
        for (let index = 0; index < 3; index += 1) {
            const dx = normalizedLayout[index].x - normalizedCamera[index].x;
            const dy = normalizedLayout[index].y - normalizedCamera[index].y;
            pointError += (dx * dx) + (dy * dy);
        }

        // Edge-direction agreement stabilizes ties where point fit is very close.
        const edgePairs = [[0, 1], [1, 2], [2, 0]];
        let edgeDirectionScore = 0;
        edgePairs.forEach(([startIndex, endIndex]) => {
            const layoutDx = normalizedLayout[endIndex].x - normalizedLayout[startIndex].x;
            const layoutDy = normalizedLayout[endIndex].y - normalizedLayout[startIndex].y;
            const cameraDx = normalizedCamera[endIndex].x - normalizedCamera[startIndex].x;
            const cameraDy = normalizedCamera[endIndex].y - normalizedCamera[startIndex].y;

            const layoutLen = Math.hypot(layoutDx, layoutDy);
            const cameraLen = Math.hypot(cameraDx, cameraDy);
            if (layoutLen <= 1e-6 || cameraLen <= 1e-6) {
                return;
            }

            edgeDirectionScore += ((layoutDx / layoutLen) * (cameraDx / cameraLen))
                + ((layoutDy / layoutLen) * (cameraDy / cameraLen));
        });

        return edgeDirectionScore - (pointError * 2.5);
    }

    scorePolygonLayoutAgainstCamera(layout, cameraPoints) {
        if (!layout?.points2D || layout.points2D.length < 3 || !Array.isArray(cameraPoints) || cameraPoints.length !== layout.points2D.length) {
            return -Infinity;
        }

        const normalizedLayout = this.normalizePointsForComparison(layout.points2D);
        const normalizedCamera = this.normalizePointsForComparison(cameraPoints);
        if (!normalizedLayout || !normalizedCamera) {
            return -Infinity;
        }

        let pointError = 0;
        for (let index = 0; index < normalizedLayout.length; index += 1) {
            const dx = normalizedLayout[index].x - normalizedCamera[index].x;
            const dy = normalizedLayout[index].y - normalizedCamera[index].y;
            pointError += (dx * dx) + (dy * dy);
        }

        let edgeDirectionScore = 0;
        for (let index = 0; index < normalizedLayout.length; index += 1) {
            const nextIndex = (index + 1) % normalizedLayout.length;
            const layoutDx = normalizedLayout[nextIndex].x - normalizedLayout[index].x;
            const layoutDy = normalizedLayout[nextIndex].y - normalizedLayout[index].y;
            const cameraDx = normalizedCamera[nextIndex].x - normalizedCamera[index].x;
            const cameraDy = normalizedCamera[nextIndex].y - normalizedCamera[index].y;

            const layoutLen = Math.hypot(layoutDx, layoutDy);
            const cameraLen = Math.hypot(cameraDx, cameraDy);
            if (layoutLen <= 1e-6 || cameraLen <= 1e-6) {
                continue;
            }

            edgeDirectionScore += ((layoutDx / layoutLen) * (cameraDx / cameraLen))
                + ((layoutDy / layoutLen) * (cameraDy / cameraLen));
        }

        return edgeDirectionScore - (pointError * 2.5);
    }

    normalizePointsForComparison(points) {
        if (!Array.isArray(points) || points.length < 3) {
            return null;
        }

        const centroid = points.reduce((acc, point) => ({
            x: acc.x + point.x,
            y: acc.y + point.y
        }), { x: 0, y: 0 });
        centroid.x /= points.length;
        centroid.y /= points.length;

        const centered = points.map((point) => ({
            x: point.x - centroid.x,
            y: point.y - centroid.y
        }));

        const rms = Math.sqrt(
            centered.reduce((acc, point) => acc + (point.x * point.x) + (point.y * point.y), 0)
            / centered.length
        );
        if (rms <= 1e-6) {
            return null;
        }

        return centered.map((point) => ({
            x: point.x / rms,
            y: point.y / rms
        }));
    }

    applyCameraAwarePolygonOrientation(layout, cameraPoints) {
        if (!layout?.points2D || layout.points2D.length < 3) {
            return {
                layout,
                quarterTurns: 0,
                flipped: false,
                score: -Infinity
            };
        }

        const candidates = [];
        for (let quarterTurns = 0; quarterTurns < 4; quarterTurns += 1) {
            for (let flipIndex = 0; flipIndex < 2; flipIndex += 1) {
                const isFlipped = flipIndex === 1;
                const candidateLayout = (quarterTurns === 0 && !isFlipped)
                    ? layout
                    : this.buildTransformedExtractionLayout(layout, quarterTurns, isFlipped);

                if (!candidateLayout) {
                    continue;
                }

                const cameraScore = this.scorePolygonLayoutAgainstCamera(candidateLayout, cameraPoints);
                candidates.push({
                    layout: candidateLayout,
                    quarterTurns,
                    flipped: isFlipped,
                    cameraScore,
                    score: cameraScore
                });
            }
        }

        if (candidates.length === 0) {
            return {
                layout,
                quarterTurns: 0,
                flipped: false,
                score: -Infinity
            };
        }

        const selected = candidates.reduce((best, candidate) => {
            if (!best || candidate.cameraScore > best.cameraScore + 1e-6) {
                return candidate;
            }

            if (!best || Math.abs(candidate.cameraScore - best.cameraScore) <= 1e-6) {
                if (candidate.quarterTurns < best.quarterTurns) {
                    return candidate;
                }
                if (candidate.quarterTurns === best.quarterTurns && Number(candidate.flipped) < Number(best.flipped)) {
                    return candidate;
                }
            }

            return best;
        }, null);

        return selected || {
            layout,
            quarterTurns: 0,
            flipped: false,
            score: -Infinity
        };
    }

    applyCameraAwareTriangleOrientation(layout, cameraPoints) {
        if (!layout?.points2D || layout.points2D.length < 3) {
            return {
                layout,
                quarterTurns: 0,
                flipped: false
            };
        }

        const candidates = [];
        for (let quarterTurns = 0; quarterTurns < 4; quarterTurns += 1) {
            for (let flipIndex = 0; flipIndex < 2; flipIndex += 1) {
                const isFlipped = flipIndex === 1;
                const candidateLayout = (quarterTurns === 0 && !isFlipped)
                    ? layout
                    : this.buildTransformedExtractionLayout(layout, quarterTurns, isFlipped);

                if (!candidateLayout) {
                    continue;
                }

                const cameraScore = this.scoreTriangleLayoutAgainstCamera(candidateLayout, cameraPoints);
                candidates.push({
                    layout: candidateLayout,
                    quarterTurns,
                    flipped: isFlipped,
                    cameraScore,
                    score: cameraScore
                });
            }
        }

        if (candidates.length === 0) {
            return {
                layout,
                quarterTurns: 0,
                flipped: false,
                score: -Infinity
            };
        }

        const selected = candidates.reduce((best, candidate) => {
            if (!best || candidate.cameraScore > best.cameraScore + 1e-6) {
                return candidate;
            }

            if (!best || Math.abs(candidate.cameraScore - best.cameraScore) <= 1e-6) {
                if (candidate.quarterTurns < best.quarterTurns) {
                    return candidate;
                }
                if (candidate.quarterTurns === best.quarterTurns && Number(candidate.flipped) < Number(best.flipped)) {
                    return candidate;
                }
            }

            return best;
        }, null);

        return selected || {
            layout,
            quarterTurns: 0,
            flipped: false,
            score: -Infinity
        };
    }

    buildTriangleExtractionCandidateLayouts(worldPoints, targetAspectRatio = 1000 / 760) {
        if (!Array.isArray(worldPoints) || worldPoints.length !== 3) {
            return [];
        }

        const sideAB = worldPoints[0].distanceTo(worldPoints[1]);
        const sideBC = worldPoints[1].distanceTo(worldPoints[2]);
        const sideCA = worldPoints[2].distanceTo(worldPoints[0]);
        const baseLength = sideAB;
        if (baseLength <= 1e-6) {
            return [];
        }

        const cX = (sideCA * sideCA - sideBC * sideBC + baseLength * baseLength) / (2 * baseLength);
        const cY = Math.sqrt(Math.max(0, sideCA * sideCA - cX * cX));
        if (cY <= 1e-6) {
            return [];
        }

        const rawPoints = [
            { x: 0, y: 0 },
            { x: baseLength, y: 0 },
            { x: cX, y: cY }
        ];

        const stageWidth = 1000;
        const safeAspect = Number.isFinite(targetAspectRatio) && targetAspectRatio > 0.1
            ? targetAspectRatio
            : (1000 / 760);
        const stageHeight = Math.max(1, Math.round(stageWidth / safeAspect));
        const padding = this.getExtractionLayoutPadding(stageWidth, stageHeight);

        return this.getTriangleOrientationCandidates(rawPoints)
            .map((candidate) => {
                const minX = Math.min(...candidate.points.map((point) => point.x));
                const maxX = Math.max(...candidate.points.map((point) => point.x));
                const minY = Math.min(...candidate.points.map((point) => point.y));
                const maxY = Math.max(...candidate.points.map((point) => point.y));
                const width = Math.max(maxX - minX, 1e-6);
                const height = Math.max(maxY - minY, 1e-6);
                const scaleScore = Math.min((stageWidth - padding.x * 2) / width, (stageHeight - padding.y * 2) / height);
                const points2D = this.fitExtractionPointsToStage(candidate.points, stageWidth, stageHeight, padding.x, padding.y);
                const layout = points2D
                    ? this.buildExtractionLayoutFromPoints(points2D, stageWidth, stageHeight)
                    : null;

                return layout
                    ? {
                        layout,
                        scaleScore,
                        startIndex: candidate.startIndex,
                        endIndex: candidate.endIndex,
                        apexIndex: candidate.apexIndex
                    }
                    : null;
            })
            .filter(Boolean);
    }

    buildCameraAwareTriangleExtractionLayout(worldPoints, cameraPoints, targetAspectRatio = 1000 / 760) {
        const candidateLayouts = this.buildTriangleExtractionCandidateLayouts(worldPoints, targetAspectRatio);
        if (candidateLayouts.length === 0) {
            return this.buildTriangleExtractionLayout(worldPoints, targetAspectRatio);
        }

        let bestCandidate = null;
        candidateLayouts.forEach((candidate) => {
            const oriented = this.applyCameraAwareTriangleOrientation(candidate.layout, cameraPoints);
            const totalScore = (Number.isFinite(oriented.score) ? oriented.score : -Infinity)
                + (candidate.scaleScore * 0.015);

            if (!bestCandidate || totalScore > bestCandidate.totalScore + 1e-6) {
                bestCandidate = {
                    layout: oriented.layout,
                    totalScore
                };
            }
        });

        return bestCandidate?.layout || this.buildTriangleExtractionLayout(worldPoints, targetAspectRatio);
    }

    buildPolygonExtractionCandidateLayouts(rawPoints, targetAspectRatio = 1000 / 760) {
        if (!Array.isArray(rawPoints) || rawPoints.length < 3) {
            return [];
        }

        const stageWidth = 1000;
        const safeAspect = Number.isFinite(targetAspectRatio) && targetAspectRatio > 0.1
            ? targetAspectRatio
            : (1000 / 760);
        const stageHeight = Math.max(1, Math.round(stageWidth / safeAspect));
        const padding = this.getExtractionLayoutPadding(stageWidth, stageHeight);

        return this.getPolygonOrientationCandidates(rawPoints)
            .map((candidate) => {
                const minX = Math.min(...candidate.points.map((point) => point.x));
                const maxX = Math.max(...candidate.points.map((point) => point.x));
                const minY = Math.min(...candidate.points.map((point) => point.y));
                const maxY = Math.max(...candidate.points.map((point) => point.y));
                const width = Math.max(maxX - minX, 1e-6);
                const height = Math.max(maxY - minY, 1e-6);
                const scaleScore = Math.min((stageWidth - padding.x * 2) / width, (stageHeight - padding.y * 2) / height);
                const points2D = this.fitExtractionPointsToStage(candidate.points, stageWidth, stageHeight, padding.x, padding.y);
                const layout = points2D
                    ? this.buildExtractionLayoutFromPoints(points2D, stageWidth, stageHeight)
                    : null;

                return layout
                    ? {
                        layout,
                        scaleScore
                    }
                    : null;
            })
            .filter(Boolean);
    }

    buildCameraAwarePolygonExtractionLayout(rawPoints, cameraPoints, targetAspectRatio = 1000 / 760) {
        const candidateLayouts = this.buildPolygonExtractionCandidateLayouts(rawPoints, targetAspectRatio);
        if (candidateLayouts.length === 0) {
            return this.buildPolygonExtractionLayout(rawPoints, targetAspectRatio);
        }

        let bestCandidate = null;
        candidateLayouts.forEach((candidate) => {
            const oriented = this.applyCameraAwarePolygonOrientation(candidate.layout, cameraPoints);
            const totalScore = (Number.isFinite(oriented.score) ? oriented.score : -Infinity)
                + (candidate.scaleScore * 0.015);

            if (!bestCandidate || totalScore > bestCandidate.totalScore + 1e-6) {
                bestCandidate = {
                    layout: oriented.layout,
                    totalScore
                };
            }
        });

        return bestCandidate?.layout || this.buildPolygonExtractionLayout(rawPoints, targetAspectRatio);
    }

    buildCameraAwarePlanarPolygonExtractionLayout(worldPoints, cameraPoints, targetAspectRatio = 1000 / 760) {
        const rawPoints = this.getPlanarRawPoints(worldPoints);
        if (!rawPoints) {
            return null;
        }

        return this.buildCameraAwarePolygonExtractionLayout(rawPoints, cameraPoints, targetAspectRatio);
    }

    buildCameraAwarePlaneExtractionLayout(worldPoints, cameraPoints, targetAspectRatio = 1000 / 760) {
        if (!Array.isArray(worldPoints) || worldPoints.length !== 4) {
            return null;
        }
        return this.buildCameraAwarePlanarPolygonExtractionLayout(worldPoints, cameraPoints, targetAspectRatio);
    }

    closeTriangleExtraction(options = {}) {
        if (!this.activeTriangleExtraction || !this.triangleExtractOverlay || !this.triangleExtractModal) {
            return;
        }

        const forceClose = options?.force === true;
        if (!forceClose && this.triangleExtractTransitionState !== 'open') {
            return;
        }

        if (forceClose && this.triangleExtractTransitionState !== 'open') {
            this.finishTriangleExtractionClose();
            return;
        }

        if (this.triangleExtractSettleTimer) {
            window.clearTimeout(this.triangleExtractSettleTimer);
            this.triangleExtractSettleTimer = null;
        }
        if (this.triangleExtractAnimationFrame) {
            window.cancelAnimationFrame(this.triangleExtractAnimationFrame);
            this.triangleExtractAnimationFrame = null;
        }

        const extraction = this.activeTriangleExtraction;
        const animationDurationMs = 1450;
        const points = (extraction.pointIds || []).map((pointId) => this.getPointById(pointId));
        const worldPoints = Array.isArray(extraction.flightWorldPoints) && extraction.flightWorldPoints.length >= 3
            ? extraction.flightWorldPoints
            : (points.some((point) => !point)
                ? null
                : points.map((point) => point.position.clone()));
        const returnPoints = worldPoints
            ? worldPoints.map((point) => this.projectWorldPointToViewport(point))
            : null;
        const startPoints = extraction.layout
            ? this.getTriangleExtractionDestinationPoints(extraction.layout)
            : null;

        // Hide modal chrome/text first, then run a reverse flight animation.
        this.triangleExtractTransitionState = 'closing';
        this.triangleExtractOverlay.classList.remove('settled', 'pre-open');
        if (extraction.color) {
            this.updateTriangleExtractFlightStyle(extraction.color);
        }

        if (!startPoints || !returnPoints || animationDurationMs === 0) {
            this.finishTriangleExtractionClose();
            return;
        }

        this.renderTriangleExtractFlight(startPoints);
        const startTime = performance.now();
        const step = (now) => {
            if (!this.activeTriangleExtraction) {
                this.triangleExtractAnimationFrame = null;
                return;
            }

            const rawProgress = Math.min(1, (now - startTime) / animationDurationMs);
            const eased = 1 - Math.pow(1 - rawProgress, 3);
            const currentPoints = startPoints.map((point, index) => ({
                x: THREE.MathUtils.lerp(point.x, returnPoints[index].x, eased),
                y: THREE.MathUtils.lerp(point.y, returnPoints[index].y, eased)
            }));
            this.renderTriangleExtractFlight(currentPoints);

            if (rawProgress >= 1) {
                this.triangleExtractAnimationFrame = null;
                this.finishTriangleExtractionClose();
                return;
            }

            this.triangleExtractAnimationFrame = window.requestAnimationFrame(step);
        };

        this.triangleExtractAnimationFrame = window.requestAnimationFrame(step);
    }

    finishTriangleExtractionClose() {
        this.activeTriangleExtraction = null;
        this.triangleExtractTransitionState = 'closed';
        this.triangleExtractOverlay.classList.remove('show', 'pre-open', 'settled');
        this.triangleExtractOverlay.setAttribute('aria-hidden', 'true');
        this.controls.enabled = true;
        this.clearTriangleExtractFlight();
        this.updateTriangleExtractionOrientationButtons();

        if (this.lastFocusedElementBeforeTriangleExtract?.focus) {
            this.lastFocusedElementBeforeTriangleExtract.focus();
        }
        this.lastFocusedElementBeforeTriangleExtract = null;
    }

    projectWorldPointToViewport(worldPoint) {
        const rect = this.canvas.getBoundingClientRect();
        const projected = worldPoint.clone().project(this.camera);
        return {
            x: rect.left + ((projected.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - projected.y) / 2) * rect.height
        };
    }

    getTriangleExtractionDestinationPoints(layout) {
        if (!this.triangleExtractSvg) {
            return null;
        }

        const rect = this.triangleExtractSvg.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return null;
        }

        return layout.points2D.map((point) => ({
            x: rect.left + (point.x / layout.stageWidth) * rect.width,
            y: rect.top + (point.y / layout.stageHeight) * rect.height
        }));
    }

    getTriangleExtractionColor(colorValue) {
        const numericColor = Number.isFinite(colorValue) ? colorValue : 0xff595e;
        const hex = `#${numericColor.toString(16).padStart(6, '0')}`;
        return {
            stroke: hex,
            fill: `${hex}55`
        };
    }

    updateTriangleExtractFlightStyle(color) {
        if (this.triangleExtractFlightPolygon) {
            this.triangleExtractFlightPolygon.style.fill = color.fill;
        }
        if (this.triangleExtractFlightOutline) {
            this.triangleExtractFlightOutline.style.stroke = color.stroke;
        }
    }

    renderTriangleExtractFlight(points) {
        if (!this.triangleExtractFlightSvg || !this.triangleExtractFlightPolygon || !this.triangleExtractFlightOutline || points.length < 3) {
            return;
        }

        const overlayRect = this.triangleExtractOverlay.getBoundingClientRect();
        this.triangleExtractFlightSvg.setAttribute('viewBox', `0 0 ${Math.max(1, overlayRect.width)} ${Math.max(1, overlayRect.height)}`);
        const localPoints = points.map((point) => ({
            x: point.x - overlayRect.left,
            y: point.y - overlayRect.top
        }));
        const pointsString = localPoints.map((point) => `${point.x},${point.y}`).join(' ');
        this.triangleExtractFlightPolygon.setAttribute('points', pointsString);
        this.triangleExtractFlightOutline.setAttribute('points', `${pointsString} ${localPoints[0].x},${localPoints[0].y}`);
    }

    clearTriangleExtractFlight() {
        this.triangleExtractFlightPolygon?.setAttribute('points', '');
        this.triangleExtractFlightOutline?.setAttribute('points', '');
    }

    finalizeTriangleExtractionReveal() {
        this.triangleExtractSettleTimer = window.setTimeout(() => {
            if (!this.activeTriangleExtraction || !this.triangleExtractOverlay) {
                return;
            }

            this.clearTriangleExtractFlight();
            this.triangleExtractOverlay.classList.add('settled');
            this.triangleExtractTransitionState = 'open';
            this.refreshTriangleExtractionLayoutForLiveStage();
            this.updateTriangleExtractionOrientationButtons();
            this.triangleExtractCloseBtn?.focus();
            this.triangleExtractSettleTimer = null;
        }, 30);
    }

    getTriangleExtractionStageAspectRatio() {
        const svgRect = this.triangleExtractSvg?.getBoundingClientRect();
        if (svgRect && svgRect.width > 1 && svgRect.height > 1) {
            return svgRect.width / svgRect.height;
        }

        const rect = this.triangleExtractStage?.getBoundingClientRect();
        if (rect && rect.width > 1 && rect.height > 1) {
            return rect.width / rect.height;
        }

        const modalRect = this.triangleExtractModal?.getBoundingClientRect();
        if (modalRect && modalRect.width > 1 && modalRect.height > 1) {
            // Approximate content area by reserving room for the header.
            const estimatedStageHeight = Math.max(1, modalRect.height - 84);
            return modalRect.width / estimatedStageHeight;
        }

        return window.innerWidth > 1 && window.innerHeight > 1
            ? (window.innerWidth / window.innerHeight)
            : (1000 / 760);
    }

    getTriangleOrientationCandidates(rawPoints) {
        const candidates = [];
        const baseDefinitions = [
            { startIndex: 0, endIndex: 1, apexIndex: 2 },
            { startIndex: 1, endIndex: 2, apexIndex: 0 },
            { startIndex: 2, endIndex: 0, apexIndex: 1 }
        ];

        baseDefinitions.forEach((base) => {
            const start = rawPoints[base.startIndex];
            const end = rawPoints[base.endIndex];
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const baseLength = Math.hypot(dx, dy);
            if (baseLength <= 1e-6) {
                return;
            }

            const ux = dx / baseLength;
            const uy = dy / baseLength;
            const oriented = rawPoints.map((point) => {
                const relX = point.x - start.x;
                const relY = point.y - start.y;
                return {
                    x: relX * ux + relY * uy,
                    y: -relX * uy + relY * ux
                };
            });

            if (oriented[base.apexIndex].y < 0) {
                oriented.forEach((point) => {
                    point.y *= -1;
                });
            }

            candidates.push({
                points: oriented,
                baseLength,
                startIndex: base.startIndex,
                endIndex: base.endIndex,
                apexIndex: base.apexIndex
            });
        });

        return candidates;
    }

    getPolygonOrientationCandidates(rawPoints) {
        const candidates = [];

        for (let index = 0; index < rawPoints.length; index += 1) {
            const start = rawPoints[index];
            const end = rawPoints[(index + 1) % rawPoints.length];
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const baseLength = Math.hypot(dx, dy);
            if (baseLength <= 1e-6) {
                continue;
            }

            const ux = dx / baseLength;
            const uy = dy / baseLength;
            const oriented = rawPoints.map((point) => {
                const relX = point.x - start.x;
                const relY = point.y - start.y;
                return {
                    x: relX * ux + relY * uy,
                    y: -relX * uy + relY * ux
                };
            });

            const signedArea = oriented.reduce((area, point, pointIndex) => {
                const nextPoint = oriented[(pointIndex + 1) % oriented.length];
                return area + (point.x * nextPoint.y) - (nextPoint.x * point.y);
            }, 0) / 2;

            if (signedArea < 0) {
                oriented.forEach((point) => {
                    point.y *= -1;
                });
            }

            candidates.push({
                points: oriented,
                baseLength
            });
        }

        return candidates;
    }

    getExtractionLayoutPadding(stageWidth, stageHeight) {
        return {
            x: Math.max(88, Math.min(128, stageWidth * 0.115)),
            y: Math.max(72, Math.min(104, stageHeight * 0.135))
        };
    }

    fitExtractionPointsToStage(rawPoints, stageWidth, stageHeight, paddingX = null, paddingY = null, invertYAxis = true) {
        if (!Array.isArray(rawPoints) || rawPoints.length < 3) {
            return null;
        }

        const padding = this.getExtractionLayoutPadding(stageWidth, stageHeight);
        const safePaddingX = Number.isFinite(paddingX) ? paddingX : padding.x;
        const safePaddingY = Number.isFinite(paddingY) ? paddingY : padding.y;

        const minX = Math.min(...rawPoints.map((point) => point.x));
        const maxX = Math.max(...rawPoints.map((point) => point.x));
        const minY = Math.min(...rawPoints.map((point) => point.y));
        const maxY = Math.max(...rawPoints.map((point) => point.y));
        const width = Math.max(maxX - minX, 1e-6);
        const height = Math.max(maxY - minY, 1e-6);
        const scale = Math.min((stageWidth - safePaddingX * 2) / width, (stageHeight - safePaddingY * 2) / height);
        const offsetX = (stageWidth - width * scale) / 2 - minX * scale;
        const offsetY = invertYAxis
            ? ((stageHeight - height * scale) / 2 + maxY * scale)
            : ((stageHeight - height * scale) / 2 - minY * scale);

        return rawPoints.map((point) => ({
            x: offsetX + point.x * scale,
            y: invertYAxis
                ? (offsetY - point.y * scale)
                : (offsetY + point.y * scale)
        }));
    }

    fitExtractionPointsAndExtrasToStage(rawPoints, extraRawPoints, stageWidth, stageHeight, paddingX = null, paddingY = null, invertYAxis = true) {
        if (!Array.isArray(rawPoints) || rawPoints.length < 3) {
            return null;
        }

        const padding = this.getExtractionLayoutPadding(stageWidth, stageHeight);
        const safePaddingX = Number.isFinite(paddingX) ? paddingX : padding.x;
        const safePaddingY = Number.isFinite(paddingY) ? paddingY : padding.y;

        const minX = Math.min(...rawPoints.map((point) => point.x));
        const maxX = Math.max(...rawPoints.map((point) => point.x));
        const minY = Math.min(...rawPoints.map((point) => point.y));
        const maxY = Math.max(...rawPoints.map((point) => point.y));
        const width = Math.max(maxX - minX, 1e-6);
        const height = Math.max(maxY - minY, 1e-6);
        const scale = Math.min((stageWidth - safePaddingX * 2) / width, (stageHeight - safePaddingY * 2) / height);
        const offsetX = (stageWidth - width * scale) / 2 - minX * scale;
        const offsetY = invertYAxis
            ? ((stageHeight - height * scale) / 2 + maxY * scale)
            : ((stageHeight - height * scale) / 2 - minY * scale);

        const mapPoint = (point) => ({
            x: offsetX + point.x * scale,
            y: invertYAxis
                ? (offsetY - point.y * scale)
                : (offsetY + point.y * scale)
        });

        return {
            points: rawPoints.map(mapPoint),
            extraPoints: Array.isArray(extraRawPoints) ? extraRawPoints.map(mapPoint) : []
        };
    }

    buildExtractionLayoutFromPoints(points2D, stageWidth, stageHeight, options = {}) {
        if (!Array.isArray(points2D) || points2D.length < 3) {
            return null;
        }

        const centroid = points2D.reduce((acc, point) => ({
            x: acc.x + point.x,
            y: acc.y + point.y
        }), { x: 0, y: 0 });
        centroid.x /= points2D.length;
        centroid.y /= points2D.length;

        const labelAnchorPoints2D = Array.isArray(options.labelAnchorPoints2D)
            ? options.labelAnchorPoints2D
            : points2D;
        const labelPositions = labelAnchorPoints2D.map((point) => {
            let dx = point.x - centroid.x;
            let dy = point.y - centroid.y;
            if (Math.hypot(dx, dy) <= 1e-6) {
                dx = 0;
                dy = 1;
            }
            const length = Math.hypot(dx, dy) || 1;
            const offset = 52;
            return {
                x: point.x + (dx / length) * offset,
                y: point.y + (dy / length) * offset
            };
        });

        const sideEdgePairs = points2D.map((point, index) => [point, points2D[(index + 1) % points2D.length]]);
        const sideLabelPositions = sideEdgePairs.map(([a, b]) => this.getOffsetMidpoint(a, b, centroid, 34));
        const sideLabelAngles = sideEdgePairs.map(([a, b]) => {
            let angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
            if (angle > 90) angle -= 180;
            if (angle < -90) angle += 180;
            return angle;
        });

        return {
            points2D,
            labelAnchorPoints2D,
            labelPositions,
            sideLabelPositions,
            sideLabelAngles,
            rightAnglePath: options.showRightAngles === false ? '' : this.buildPolygonRightAnglePath(points2D),
            showSideLabels: options.showSideLabels !== false,
            showAngles: options.showAngles !== false,
            stageWidth,
            stageHeight
        };
    }

    buildCircleExtractionLayout(rawRingPoints, rawLabelPoints, targetAspectRatio = 1000 / 760) {
        if (!Array.isArray(rawRingPoints) || rawRingPoints.length < 12) {
            return null;
        }

        const stageWidth = 1000;
        const safeAspect = Number.isFinite(targetAspectRatio) && targetAspectRatio > 0.1
            ? targetAspectRatio
            : (1000 / 760);
        const stageHeight = Math.max(1, Math.round(stageWidth / safeAspect));
        const padding = this.getExtractionLayoutPadding(stageWidth, stageHeight);
        const fitted = this.fitExtractionPointsAndExtrasToStage(
            rawRingPoints,
            rawLabelPoints,
            stageWidth,
            stageHeight,
            padding.x,
            padding.y,
            true
        );
        if (!fitted) {
            return null;
        }

        return this.buildExtractionLayoutFromPoints(fitted.points, stageWidth, stageHeight, {
            labelAnchorPoints2D: fitted.extraPoints,
            showSideLabels: false,
            showAngles: false,
            showRightAngles: false
        });
    }

    buildTransformedExtractionLayout(baseLayout, quarterTurns = 0, isFlipped = false, forcedStageWidth = null, forcedStageHeight = null) {
        if (!baseLayout?.points2D?.length) {
            return null;
        }

        const stageWidth = Number.isFinite(forcedStageWidth) && forcedStageWidth > 1
            ? forcedStageWidth
            : (baseLayout.stageWidth || 1000);
        const stageHeight = Number.isFinite(forcedStageHeight) && forcedStageHeight > 1
            ? forcedStageHeight
            : (baseLayout.stageHeight || 760);

        // Rotate/flip from a normalized geometry basis so each orientation can
        // be re-fitted to the stage independently (prevents inherited shrinking).
        let transformBasePoints = Array.isArray(baseLayout.transformBasePoints)
            ? baseLayout.transformBasePoints
            : null;
        let transformLabelPoints = Array.isArray(baseLayout.transformLabelPoints)
            ? baseLayout.transformLabelPoints
            : null;

        if (!transformBasePoints || transformBasePoints.length !== baseLayout.points2D.length) {
            const centroid = baseLayout.points2D.reduce((acc, point) => ({
                x: acc.x + point.x,
                y: acc.y + point.y
            }), { x: 0, y: 0 });
            centroid.x /= baseLayout.points2D.length;
            centroid.y /= baseLayout.points2D.length;

            const centered = baseLayout.points2D.map((point) => ({
                x: point.x - centroid.x,
                y: point.y - centroid.y
            }));

            const minX = Math.min(...centered.map((point) => point.x));
            const maxX = Math.max(...centered.map((point) => point.x));
            const minY = Math.min(...centered.map((point) => point.y));
            const maxY = Math.max(...centered.map((point) => point.y));
            const maxDimension = Math.max(maxX - minX, maxY - minY, 1e-6);

            transformBasePoints = centered.map((point) => ({
                x: point.x / maxDimension,
                y: point.y / maxDimension
            }));

            baseLayout.transformBasePoints = transformBasePoints;
            transformLabelPoints = Array.isArray(baseLayout.labelAnchorPoints2D)
                ? baseLayout.labelAnchorPoints2D.map((point) => ({
                    x: (point.x - centroid.x) / maxDimension,
                    y: (point.y - centroid.y) / maxDimension
                }))
                : null;
            baseLayout.transformLabelPoints = transformLabelPoints;
        }

        const normalizedQuarterTurns = ((quarterTurns % 4) + 4) % 4;
        const transformPoint = (point) => {
            let x = point.x;
            let y = point.y;

            if (isFlipped) {
                x *= -1;
            }

            for (let index = 0; index < normalizedQuarterTurns; index += 1) {
                const nextX = -y;
                const nextY = x;
                x = nextX;
                y = nextY;
            }

            return { x, y };
        };
        const transformed = transformBasePoints.map(transformPoint);
        const transformedLabels = Array.isArray(transformLabelPoints)
            ? transformLabelPoints.map(transformPoint)
            : [];

        const fitted = this.fitExtractionPointsAndExtrasToStage(
            transformed,
            transformedLabels,
            stageWidth,
            stageHeight,
            null,
            null,
            false
        );
        return fitted
            ? this.buildExtractionLayoutFromPoints(fitted.points, stageWidth, stageHeight, {
                labelAnchorPoints2D: fitted.extraPoints,
                showSideLabels: baseLayout.showSideLabels !== false,
                showAngles: baseLayout.showAngles !== false,
                showRightAngles: baseLayout.rightAnglePath !== ''
            })
            : null;
    }

    getLiveTriangleExtractionTransformStageDimensions(fallbackLayout = null) {
        const fallbackWidth = fallbackLayout?.stageWidth || 1000;
        const fallbackHeight = fallbackLayout?.stageHeight || 760;
        const svgRect = this.triangleExtractSvg?.getBoundingClientRect();
        const stageRect = this.triangleExtractStage?.getBoundingClientRect();
        const rect = svgRect && svgRect.width > 1 && svgRect.height > 1
            ? svgRect
            : stageRect;

        if (!rect || rect.width <= 1 || rect.height <= 1) {
            return {
                stageWidth: fallbackWidth,
                stageHeight: fallbackHeight
            };
        }

        const stageWidth = 1000;
        const stageHeight = Math.max(1, Math.round(stageWidth * (rect.height / rect.width)));
        return { stageWidth, stageHeight };
    }

    refreshTriangleExtractionLayoutForLiveStage() {
        if (!this.activeTriangleExtraction?.baseLayout) {
            return;
        }

        const orientationQuarterTurns = this.activeTriangleExtraction.orientationQuarterTurns || 0;
        const orientationFlipped = this.activeTriangleExtraction.orientationFlipped === true;
        const { stageWidth, stageHeight } = this.getLiveTriangleExtractionTransformStageDimensions(this.activeTriangleExtraction.baseLayout);
        this.activeTriangleExtraction.transformStageWidth = stageWidth;
        this.activeTriangleExtraction.transformStageHeight = stageHeight;
        const layout = this.buildTransformedExtractionLayout(
            this.activeTriangleExtraction.baseLayout,
            orientationQuarterTurns,
            orientationFlipped,
            stageWidth,
            stageHeight
        );

        if (!layout) {
            return;
        }

        this.activeTriangleExtraction.layout = layout;
        this.populateTriangleExtractionModal(
            layout,
            this.activeTriangleExtraction.labels,
            this.activeTriangleExtraction.item,
            this.activeTriangleExtraction.color,
            this.activeTriangleExtraction
        );
    }

    rotateTriangleExtractionLayout() {
        if (this.triangleExtractTransitionState !== 'open' || !this.activeTriangleExtraction?.baseLayout) {
            return;
        }

        const nextQuarterTurns = (((this.activeTriangleExtraction.orientationQuarterTurns || 0) + 1) % 4 + 4) % 4;
        this.applyTriangleExtractionOrientation(nextQuarterTurns, this.activeTriangleExtraction.orientationFlipped === true);
    }

    flipTriangleExtractionLayout() {
        if (this.triangleExtractTransitionState !== 'open' || !this.activeTriangleExtraction?.baseLayout) {
            return;
        }

        this.applyTriangleExtractionOrientation(
            this.activeTriangleExtraction.orientationQuarterTurns || 0,
            !(this.activeTriangleExtraction.orientationFlipped === true)
        );
    }

    applyTriangleExtractionOrientation(quarterTurns, isFlipped) {
        if (!this.activeTriangleExtraction?.baseLayout) {
            return;
        }

        let stageWidth = this.activeTriangleExtraction.transformStageWidth;
        let stageHeight = this.activeTriangleExtraction.transformStageHeight;

        if (!Number.isFinite(stageWidth) || !Number.isFinite(stageHeight) || stageWidth <= 1 || stageHeight <= 1) {
            const resolved = this.getLiveTriangleExtractionTransformStageDimensions(this.activeTriangleExtraction.baseLayout);
            stageWidth = resolved.stageWidth;
            stageHeight = resolved.stageHeight;
            this.activeTriangleExtraction.transformStageWidth = stageWidth;
            this.activeTriangleExtraction.transformStageHeight = stageHeight;
        }

        const layout = this.buildTransformedExtractionLayout(
            this.activeTriangleExtraction.baseLayout,
            quarterTurns,
            isFlipped,
            stageWidth,
            stageHeight
        );
        if (!layout) {
            return;
        }

        this.activeTriangleExtraction.orientationQuarterTurns = ((quarterTurns % 4) + 4) % 4;
        this.activeTriangleExtraction.orientationFlipped = isFlipped === true;
        this.activeTriangleExtraction.layout = layout;
        this.populateTriangleExtractionModal(
            layout,
            this.activeTriangleExtraction.labels,
            this.activeTriangleExtraction.item,
            this.activeTriangleExtraction.color,
            this.activeTriangleExtraction
        );
        this.updateTriangleExtractionOrientationButtons();
    }

    updateTriangleExtractionOrientationButtons() {
        const hasExtraction = !!this.activeTriangleExtraction && this.triangleExtractTransitionState === 'open';
        if (this.triangleExtractRotateBtn) {
            this.triangleExtractRotateBtn.disabled = !hasExtraction;
        }
        if (this.triangleExtractFlipBtn) {
            this.triangleExtractFlipBtn.disabled = !hasExtraction;
            this.triangleExtractFlipBtn.setAttribute('aria-pressed', this.activeTriangleExtraction?.orientationFlipped === true ? 'true' : 'false');
        }
    }

    detectIOSWebKit() {
        const userAgent = navigator.userAgent || '';
        const platform = navigator.platform || '';
        const isIOSDevice = /iPhone|iPad|iPod/.test(userAgent)
            || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const isWebKitEngine = /WebKit/i.test(userAgent);
        return isIOSDevice && isWebKitEngine;
    }

    forceTriangleExtractionSvgRepaint() {
        if (!this.isIOSWebKit || !this.triangleExtractSvg) {
            return;
        }

        // iOS Safari can retain stale 1px glyph/stroke fragments when only SVG
        // geometry attributes change; nudging transform forces a clean repaint.
        this.triangleExtractRepaintNonce = (this.triangleExtractRepaintNonce + 1) % 2;
        const nudge = this.triangleExtractRepaintNonce === 0 ? '0px' : '0.001px';
        this.triangleExtractSvg.style.transform = `translateX(${nudge})`;
        this.triangleExtractSvg.getBoundingClientRect();
        this.triangleExtractSvg.style.transform = '';
    }

    buildPolygonExtractionLayout(rawPoints, targetAspectRatio = 1000 / 760) {
        if (!Array.isArray(rawPoints) || rawPoints.length < 3) {
            return null;
        }

        const stageWidth = 1000;
        const safeAspect = Number.isFinite(targetAspectRatio) && targetAspectRatio > 0.1
            ? targetAspectRatio
            : (1000 / 760);
        const stageHeight = Math.max(1, Math.round(stageWidth / safeAspect));
        const padding = this.getExtractionLayoutPadding(stageWidth, stageHeight);
        const paddingX = padding.x;
        const paddingY = padding.y;

        const candidates = this.getPolygonOrientationCandidates(rawPoints);
        if (candidates.length === 0) {
            return null;
        }

        let bestCandidate = null;
        candidates.forEach((candidate) => {
            const minX = Math.min(...candidate.points.map((point) => point.x));
            const maxX = Math.max(...candidate.points.map((point) => point.x));
            const minY = Math.min(...candidate.points.map((point) => point.y));
            const maxY = Math.max(...candidate.points.map((point) => point.y));
            const width = Math.max(maxX - minX, 1e-6);
            const height = Math.max(maxY - minY, 1e-6);
            const scale = Math.min((stageWidth - paddingX * 2) / width, (stageHeight - paddingY * 2) / height);

            if (!bestCandidate || scale > bestCandidate.scale + 1e-6) {
                bestCandidate = {
                    ...candidate,
                    minX,
                    minY,
                    maxY,
                    width,
                    height,
                    scale
                };
                return;
            }

            if (bestCandidate && Math.abs(scale - bestCandidate.scale) <= 1e-6 && candidate.baseLength > bestCandidate.baseLength) {
                bestCandidate = {
                    ...candidate,
                    minX,
                    minY,
                    maxY,
                    width,
                    height,
                    scale
                };
            }
        });

        if (!bestCandidate) {
            return null;
        }

        const points2D = this.fitExtractionPointsToStage(bestCandidate.points, stageWidth, stageHeight, paddingX, paddingY);
        return points2D
            ? this.buildExtractionLayoutFromPoints(points2D, stageWidth, stageHeight)
            : null;
    }

    buildTriangleExtractionLayout(worldPoints, targetAspectRatio = 1000 / 760) {
        const sideAB = worldPoints[0].distanceTo(worldPoints[1]);
        const sideBC = worldPoints[1].distanceTo(worldPoints[2]);
        const sideCA = worldPoints[2].distanceTo(worldPoints[0]);
        const baseLength = sideAB;

        if (baseLength <= 1e-6) {
            return null;
        }

        const cX = (sideCA * sideCA - sideBC * sideBC + baseLength * baseLength) / (2 * baseLength);
        const cY = Math.sqrt(Math.max(0, sideCA * sideCA - cX * cX));
        if (cY <= 1e-6) {
            return null;
        }

        const rawPoints = [
            { x: 0, y: 0 },
            { x: baseLength, y: 0 },
            { x: cX, y: cY }
        ];

        const sideSquares = [sideAB * sideAB, sideBC * sideBC, sideCA * sideCA].sort((a, b) => a - b);
        const rightAngleTolerance = Math.max(1e-6, sideSquares[2] * 0.0025);
        const isRightAngled = Math.abs(sideSquares[0] + sideSquares[1] - sideSquares[2]) <= rightAngleTolerance;

        if (isRightAngled) {
            const stageWidth = 1000;
            const safeAspect = Number.isFinite(targetAspectRatio) && targetAspectRatio > 0.1
                ? targetAspectRatio
                : (1000 / 760);
            const stageHeight = Math.max(1, Math.round(stageWidth / safeAspect));
            const padding = this.getExtractionLayoutPadding(stageWidth, stageHeight);
            const hypotenuseLength = Math.max(sideAB, sideBC, sideCA);
            const lengthTolerance = Math.max(1e-6, hypotenuseLength * 0.0035);

            const legBaseCandidates = this.getTriangleOrientationCandidates(rawPoints)
                .filter((candidate) => Math.abs(candidate.baseLength - hypotenuseLength) > lengthTolerance);

            let bestLayout = null;
            let bestScaleScore = -Infinity;
            legBaseCandidates.forEach((candidate) => {
                const fittedPoints = this.fitExtractionPointsToStage(candidate.points, stageWidth, stageHeight, padding.x, padding.y);
                if (!fittedPoints) {
                    return;
                }

                const minX = Math.min(...candidate.points.map((point) => point.x));
                const maxX = Math.max(...candidate.points.map((point) => point.x));
                const minY = Math.min(...candidate.points.map((point) => point.y));
                const maxY = Math.max(...candidate.points.map((point) => point.y));
                const width = Math.max(maxX - minX, 1e-6);
                const height = Math.max(maxY - minY, 1e-6);
                const scaleScore = Math.min((stageWidth - padding.x * 2) / width, (stageHeight - padding.y * 2) / height);

                if (scaleScore > bestScaleScore + 1e-6) {
                    bestScaleScore = scaleScore;
                    bestLayout = this.buildExtractionLayoutFromPoints(fittedPoints, stageWidth, stageHeight);
                }
            });

            if (bestLayout) {
                return bestLayout;
            }
        }

        return this.buildPolygonExtractionLayout(rawPoints, targetAspectRatio);
    }

    buildPlaneExtractionLayout(worldPoints, targetAspectRatio = 1000 / 760) {
        if (!Array.isArray(worldPoints) || worldPoints.length !== 4) {
            return null;
        }

        const origin = worldPoints[0];
        const uVector = worldPoints[1].clone().sub(origin);
        if (uVector.lengthSq() <= 1e-12) {
            return null;
        }

        let normal = null;
        for (let index = 2; index < worldPoints.length; index += 1) {
            const candidate = new THREE.Vector3().crossVectors(uVector, worldPoints[index].clone().sub(origin));
            if (candidate.lengthSq() > 1e-12) {
                normal = candidate.normalize();
                break;
            }
        }

        if (!normal) {
            return null;
        }

        const u = uVector.clone().normalize();
        const v = new THREE.Vector3().crossVectors(normal, u).normalize();
        const rawPoints = worldPoints.map((point) => {
            const relative = point.clone().sub(origin);
            return {
                x: relative.dot(u),
                y: relative.dot(v)
            };
        });

        return this.buildPolygonExtractionLayout(rawPoints, targetAspectRatio);
    }

    getOffsetMidpoint(a, b, centroid, offsetDistance) {
        const midpoint = {
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2
        };
        const dx = midpoint.x - centroid.x;
        const dy = midpoint.y - centroid.y;
        const length = Math.hypot(dx, dy) || 1;
        return {
            x: midpoint.x + (dx / length) * offsetDistance,
            y: midpoint.y + (dy / length) * offsetDistance
        };
    }

    buildPolygonRightAnglePath(points2D, tolerance = 0.03) {
        if (!Array.isArray(points2D) || points2D.length < 3) {
            return '';
        }

        const pathParts = [];
        for (let index = 0; index < points2D.length; index += 1) {
            const vertex = points2D[index];
            const previous = points2D[(index - 1 + points2D.length) % points2D.length];
            const next = points2D[(index + 1) % points2D.length];
            const v1x = previous.x - vertex.x;
            const v1y = previous.y - vertex.y;
            const v2x = next.x - vertex.x;
            const v2y = next.y - vertex.y;
            const mag1 = Math.hypot(v1x, v1y);
            const mag2 = Math.hypot(v2x, v2y);
            if (mag1 <= 1e-6 || mag2 <= 1e-6) {
                continue;
            }

            const cosTheta = (v1x * v2x + v1y * v2y) / (mag1 * mag2);
            if (Math.abs(cosTheta) > tolerance) {
                continue;
            }

            const armLength = Math.min(34, Math.min(mag1, mag2) * 0.25);
            const prevUnit = { x: v1x / mag1, y: v1y / mag1 };
            const nextUnit = { x: v2x / mag2, y: v2y / mag2 };
            const p1 = { x: vertex.x + prevUnit.x * armLength, y: vertex.y + prevUnit.y * armLength };
            const p2 = { x: p1.x + nextUnit.x * armLength, y: p1.y + nextUnit.y * armLength };
            const p3 = { x: vertex.x + nextUnit.x * armLength, y: vertex.y + nextUnit.y * armLength };
            pathParts.push(`M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y}`);
        }

        return pathParts.join(' ');
    }

    ensureTriangleExtractionDynamicGroups() {
        if (!this.triangleExtractSvg) {
            return;
        }

        const ns = 'http://www.w3.org/2000/svg';
        if (!this.triangleExtractDynamicMarkersGroup) {
            this.triangleExtractDynamicMarkersGroup = document.createElementNS(ns, 'g');
            this.triangleExtractDynamicMarkersGroup.id = 'triangle-extract-dynamic-markers-group';
            this.triangleExtractSvg.insertBefore(this.triangleExtractDynamicMarkersGroup, this.triangleExtractDynamicSideLabelsGroup || this.triangleExtractAnglesGroup || null);
        }

        if (!this.triangleExtractDynamicSideLabelsGroup) {
            this.triangleExtractDynamicSideLabelsGroup = document.createElementNS(ns, 'g');
            this.triangleExtractDynamicSideLabelsGroup.id = 'triangle-extract-dynamic-side-labels-group';
            this.triangleExtractSvg.insertBefore(this.triangleExtractDynamicSideLabelsGroup, this.triangleExtractAnglesGroup || null);
        }

        if (!this.triangleExtractDynamicLabelsGroup) {
            this.triangleExtractDynamicLabelsGroup = document.createElementNS(ns, 'g');
            this.triangleExtractDynamicLabelsGroup.id = 'triangle-extract-dynamic-labels-group';
            this.triangleExtractSvg.appendChild(this.triangleExtractDynamicLabelsGroup);
        }
    }

    clearStaticTriangleExtractionLabels() {
        Object.values(this.triangleExtractLabelEls || {}).forEach((labelEl) => {
            if (!labelEl) return;
            labelEl.textContent = '';
            labelEl.setAttribute('visibility', 'hidden');
        });

        Object.values(this.triangleExtractSideEls || {}).forEach((sideEl) => {
            if (!sideEl) return;
            sideEl.textContent = '';
            sideEl.setAttribute('visibility', 'hidden');
            sideEl.removeAttribute('transform');
        });
    }

    populateTriangleExtractionModal(layout, labels, item, color, extraction = null) {
        const pointIds = Array.isArray(extraction?.labelPointIds) ? extraction.labelPointIds : item.definition.pointIds;
        const sidePointIds = Array.isArray(extraction?.sidePointIds) ? extraction.sidePointIds : pointIds;
        const pointSequence = extraction?.pointSequence || this.formatPointSequence(pointIds);
        const pointCount = labels.length;
        const shapeName = extraction?.shapeName || this.getInspectionShapeName(item);
        const polygonPoints = layout.points2D.map((point) => `${point.x},${point.y}`).join(' ');
        const showSideLabels = extraction?.showSideLabels !== false && layout.showSideLabels !== false;
        const showAngles = extraction?.showAngles !== false && layout.showAngles !== false;
        const markerLabelIndexes = Array.isArray(extraction?.markerLabelIndexes) ? extraction.markerLabelIndexes : [];
        const shapeCenterLabel = this.getInspectionShapeCenterLabel(item, sidePointIds);
        this.ensureTriangleExtractionDynamicGroups();
        this.clearStaticTriangleExtractionLabels();

        if (this.triangleExtractTitle) {
            this.triangleExtractTitle.textContent = `${shapeName} ${pointSequence}`;
        }
        if (this.triangleExtractCloseBtn) {
            this.triangleExtractCloseBtn.setAttribute('aria-label', `Close inspected ${shapeName.toLowerCase()}`);
        }
        if (this.triangleExtractSvg) {
            this.triangleExtractSvg.setAttribute('viewBox', `0 0 ${layout.stageWidth} ${layout.stageHeight}`);
            this.triangleExtractSvg.setAttribute('aria-label', `${shapeName} 2D view`);
        }
        if (this.triangleExtractPolygon) {
            this.triangleExtractPolygon.setAttribute('points', polygonPoints);
            if (color) this.triangleExtractPolygon.style.fill = color.fill;
        }
        if (this.triangleExtractOutline) {
            this.triangleExtractOutline.setAttribute('points', `${polygonPoints} ${layout.points2D[0].x},${layout.points2D[0].y}`);
            if (color) this.triangleExtractOutline.style.stroke = color.stroke;
        }
        if (this.triangleExtractRightAngle) {
            const hasRightAngle = layout.rightAnglePath.length > 0;
            this.triangleExtractRightAngle.hidden = !hasRightAngle;
            this.triangleExtractRightAngle.setAttribute('d', layout.rightAnglePath);
            if (color) this.triangleExtractRightAngle.style.stroke = color.stroke;
        }

        if (this.triangleExtractDynamicMarkersGroup) {
            this.triangleExtractDynamicMarkersGroup.innerHTML = '';
            const ns = 'http://www.w3.org/2000/svg';
            markerLabelIndexes.forEach((labelIndex) => {
                const point = layout.labelAnchorPoints2D?.[labelIndex];
                if (!point) return;
                const marker = document.createElementNS(ns, 'circle');
                marker.setAttribute('class', 'triangle-extract-point-marker');
                marker.setAttribute('cx', `${point.x}`);
                marker.setAttribute('cy', `${point.y}`);
                marker.setAttribute('r', '11');
                this.triangleExtractDynamicMarkersGroup.appendChild(marker);
            });
        }

        if (this.triangleExtractDynamicLabelsGroup) {
            this.triangleExtractDynamicLabelsGroup.innerHTML = '';
            const ns = 'http://www.w3.org/2000/svg';
            for (let index = 0; index < pointCount; index += 1) {
                const pos = layout.labelPositions[index];
                if (!pos) continue;
                const labelEl = document.createElementNS(ns, 'text');
                labelEl.setAttribute('class', 'triangle-extract-label triangle-extract-dynamic-label');
                labelEl.setAttribute('x', `${pos.x}`);
                labelEl.setAttribute('y', `${pos.y}`);
                labelEl.textContent = this.applyEmbedVariableSubstitutions(labels[index]);
                this.triangleExtractDynamicLabelsGroup.appendChild(labelEl);
            }
            if (shapeCenterLabel) {
                const center = this.getExtractionLayoutCentroid(layout);
                const labelGroup = document.createElementNS(ns, 'g');
                labelGroup.setAttribute('class', 'triangle-extract-shape-label');
                labelGroup.setAttribute('transform', `translate(${center.x}, ${center.y})`);

                const displayText = this.applyEmbedVariableSubstitutions(shapeCenterLabel.text);
                const fontSize = displayText.length > 10 ? 32 : 38;
                const estimatedWidth = Math.max(58, Math.min(320, displayText.length * fontSize * 0.62 + 34));
                const estimatedHeight = fontSize + 22;

                const backgroundEl = document.createElementNS(ns, 'rect');
                backgroundEl.setAttribute('class', 'triangle-extract-shape-label-bg');
                backgroundEl.setAttribute('x', `${-estimatedWidth / 2}`);
                backgroundEl.setAttribute('y', `${-estimatedHeight / 2}`);
                backgroundEl.setAttribute('width', `${estimatedWidth}`);
                backgroundEl.setAttribute('height', `${estimatedHeight}`);
                backgroundEl.setAttribute('rx', '13');
                backgroundEl.style.fill = shapeCenterLabel.background;
                backgroundEl.style.stroke = shapeCenterLabel.borderColor;

                const textEl = document.createElementNS(ns, 'text');
                textEl.setAttribute('class', 'triangle-extract-shape-label-text');
                textEl.setAttribute('x', '0');
                textEl.setAttribute('y', '0');
                textEl.style.fill = shapeCenterLabel.textColor;
                textEl.style.fontSize = `${fontSize}px`;
                textEl.textContent = displayText;

                labelGroup.appendChild(backgroundEl);
                labelGroup.appendChild(textEl);
                this.triangleExtractDynamicLabelsGroup.appendChild(labelGroup);
            }
        }

        if (this.triangleExtractDynamicSideLabelsGroup) {
            this.triangleExtractDynamicSideLabelsGroup.innerHTML = '';
            if (showSideLabels) {
                const ns = 'http://www.w3.org/2000/svg';
                const sidePairs = this.getPolygonEdgePairsInOrder(sidePointIds);
                sidePairs.forEach((pair, index) => {
                    const edgeLabelObj = this.findEdgeLabelObject(pair);
                    const labelText = edgeLabelObj?.definition?.text ?? '';
                    const pos = layout.sideLabelPositions[index];
                    if (!labelText || !pos) return;

                    const angle = layout.sideLabelAngles[index] || 0;
                    const sideEl = document.createElementNS(ns, 'text');
                    sideEl.setAttribute('class', 'triangle-extract-side-label triangle-extract-dynamic-side-label');
                    sideEl.setAttribute('x', `${pos.x}`);
                    sideEl.setAttribute('y', `${pos.y}`);
                    sideEl.setAttribute('transform', `rotate(${angle}, ${pos.x}, ${pos.y})`);
                    sideEl.textContent = this.applyEmbedVariableSubstitutions(labelText);
                    this.triangleExtractDynamicSideLabelsGroup.appendChild(sideEl);
                });
            }
        }

        if (this.triangleExtractAnglesGroup) {
            this.triangleExtractAnglesGroup.innerHTML = '';
            const ns = 'http://www.w3.org/2000/svg';
            const angleObjects = showAngles ? this.findAngleLabelObjectsForPolygon(sidePointIds) : [];
            for (const angleObj of angleObjects) {
                const def = angleObj.definition;
                const vertexIndex = sidePointIds.indexOf(def.pointIds[1]);
                const aIndex = sidePointIds.indexOf(def.pointIds[0]);
                const cIndex = sidePointIds.indexOf(def.pointIds[2]);
                if (vertexIndex < 0 || aIndex < 0 || cIndex < 0) continue;

                const vertex = layout.points2D[vertexIndex];
                const aPoint = layout.points2D[aIndex];
                const cPoint = layout.points2D[cIndex];
                const d1x = aPoint.x - vertex.x, d1y = aPoint.y - vertex.y;
                const d2x = cPoint.x - vertex.x, d2y = cPoint.y - vertex.y;
                const armLen1 = Math.hypot(d1x, d1y);
                const armLen2 = Math.hypot(d2x, d2y);
                if (armLen1 < 1e-6 || armLen2 < 1e-6) continue;

                const dir1 = { x: d1x / armLen1, y: d1y / armLen1 };
                const dir2 = { x: d2x / armLen2, y: d2y / armLen2 };
                const isCompactViewport = window.matchMedia?.('(max-width: 768px)').matches ?? (window.innerWidth < 768);
                const arcRadiusFactor = isCompactViewport ? 0.34 : 0.25;
                const maxArcRadius = isCompactViewport ? 92 : 65;
                const r = Math.min(maxArcRadius, Math.min(armLen1, armLen2) * arcRadiusFactor);

                const startX = vertex.x + dir1.x * r;
                const startY = vertex.y + dir1.y * r;
                const endX = vertex.x + dir2.x * r;
                const endY = vertex.y + dir2.y * r;
                const cross = dir1.x * dir2.y - dir1.y * dir2.x;
                const sweep = cross > 0 ? 1 : 0;

                const arcColor = this.getTriangleExtractionColor(Number.isFinite(def.color) ? def.color : 0x00d1b2).stroke;

                const arcEl = document.createElementNS(ns, 'path');
                arcEl.setAttribute('d', `M ${startX} ${startY} A ${r} ${r} 0 0 ${sweep} ${endX} ${endY}`);
                arcEl.setAttribute('class', 'triangle-extract-angle-arc');
                arcEl.style.stroke = arcColor;
                this.triangleExtractAnglesGroup.appendChild(arcEl);

                const bisX = dir1.x + dir2.x;
                const bisY = dir1.y + dir2.y;
                const bisMag = Math.hypot(bisX, bisY) || 1;
                const labelDist = r + (isCompactViewport ? 36 : 28);
                const textEl = document.createElementNS(ns, 'text');
                textEl.setAttribute('x', `${vertex.x + (bisX / bisMag) * labelDist}`);
                textEl.setAttribute('y', `${vertex.y + (bisY / bisMag) * labelDist}`);
                textEl.setAttribute('class', 'triangle-extract-angle-text');
                textEl.textContent = this.applyEmbedVariableSubstitutions(def.text);
                this.triangleExtractAnglesGroup.appendChild(textEl);
            }
        }

        this.forceTriangleExtractionSvgRepaint();
    }

    getInspectionShapeCenterLabel(item, pointIds) {
        if (!this.isShapeCenterLabelTarget(item)) {
            return null;
        }

        const shapeLabel = this.findShapeLabelObject(pointIds);
        const labelText = String(shapeLabel?.definition?.text ?? '').trim();
        if (!shapeLabel || shapeLabel.visible === false || !labelText) {
            return null;
        }

        return {
            text: labelText,
            background: this.getLabelDefinitionColorHex(shapeLabel.definition),
            borderColor: '#000000',
            textColor: this.getLabelTextColor()
        };
    }

    getExtractionLayoutCentroid(layout) {
        const points = Array.isArray(layout?.points2D) ? layout.points2D : [];
        if (points.length === 0) {
            return { x: 0, y: 0 };
        }

        let signedAreaTimesTwo = 0;
        let centroidXFactor = 0;
        let centroidYFactor = 0;
        for (let index = 0; index < points.length; index += 1) {
            const current = points[index];
            const next = points[(index + 1) % points.length];
            const cross = (current.x * next.y) - (next.x * current.y);
            signedAreaTimesTwo += cross;
            centroidXFactor += (current.x + next.x) * cross;
            centroidYFactor += (current.y + next.y) * cross;
        }

        if (Math.abs(signedAreaTimesTwo) > 1e-6) {
            return {
                x: centroidXFactor / (3 * signedAreaTimesTwo),
                y: centroidYFactor / (3 * signedAreaTimesTwo)
            };
        }

        const centroid = points.reduce((acc, point) => ({
            x: acc.x + point.x,
            y: acc.y + point.y
        }), { x: 0, y: 0 });
        return {
            x: centroid.x / points.length,
            y: centroid.y / points.length
        };
    }

    formatTriangleSideLength(lengthValue) {
        const rounded = Math.round(lengthValue * 100) / 100;
        return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
    }

    parsePositiveInteger(value) {
        const text = `${value ?? ''}`.trim();
        if (!/^[1-9]\d*$/.test(text)) {
            return null;
        }

        const parsed = Number(text);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }

    greatestCommonDivisor(leftValue, rightValue) {
        let left = Math.abs(leftValue);
        let right = Math.abs(rightValue);

        while (right !== 0) {
            const remainder = left % right;
            left = right;
            right = remainder;
        }

        return left || 1;
    }

    reduceRatio(leftValue, rightValue) {
        const left = this.parsePositiveInteger(leftValue);
        const right = this.parsePositiveInteger(rightValue);
        if (!left || !right) {
            return null;
        }

        const divisor = this.greatestCommonDivisor(left, right);
        return {
            left: left / divisor,
            right: right / divisor
        };
    }

    toggleGrid() {
        this.gridVisible = !this.gridVisible;
        if (this.grid) {
            this.grid.visible = this.getEffectiveGridVisible();
        }
        this.updateGridToggleUI();
        this.scheduleLocalStateSave({ viewOnly: true });
    }

    getEffectiveGridVisible() {
        return this.gridVisible && !this.embedMode;
    }

    updateGridToggleUI() {
        if (!this.gridToggleBtn) {
            return;
        }

        this.gridToggleBtn.style.background = this.gridVisible ? '#2A3F5A' : '#1a2a3f';
        this.gridToggleBtn.style.opacity = this.gridVisible ? '1' : '0.6';
        this.gridToggleBtn.title = this.gridVisible
            ? 'Grid enabled (click to disable)'
            : 'Grid disabled (click to enable)';

        if (this.gridIcon) {
            this.gridIcon.classList.toggle('grid-active', this.gridVisible);
        }
    }

    togglePointMarkers() {
        this.pointMarkersVisible = !this.pointMarkersVisible;
        this.updatePointMarkerToggleUI();
        this.pointMarkers.forEach((marker, pointId) => {
            marker.visible = this.pointMarkersVisible && !this.isPointHidden(this.getPointById(pointId));
        });
        this.scheduleLocalStateSave({ viewOnly: true });
    }

    updatePointMarkerToggleUI() {
        if (!this.pointMarkerToggleBtn) return;
        this.pointMarkerToggleBtn.title = this.pointMarkersVisible
            ? 'Point markers visible (click to hide)'
            : 'Point markers hidden (click to show)';
        if (this.pointFilledIcon) {
            this.pointFilledIcon.classList.toggle('point-marker-active', this.pointMarkersVisible);
        }
        if (this.pointHollowIcon) {
            this.pointHollowIcon.classList.toggle('point-marker-active', !this.pointMarkersVisible);
        }
    }

    getPointDefaultColor(point) {
        return this.normalizeConstructionColor(LABEL_BADGE_BACKGROUND_COLOR);
    }

    getPointColor(point) {
        if (!point) {
            return this.getPointDefaultColor(point);
        }

        if (point.isDerived) {
            const signature = point.signature || point.id;
            if (signature && this.derivedPointColorOverrides.has(signature)) {
                return this.normalizeConstructionColor(this.derivedPointColorOverrides.get(signature), this.getPointDefaultColor(point));
            }
            return this.getPointDefaultColor(point);
        }

        for (const sourceId of (point.sourceIds || [])) {
            if (this.basePointColorOverrides.has(sourceId)) {
                return this.normalizeConstructionColor(this.basePointColorOverrides.get(sourceId), this.getPointDefaultColor(point));
            }
        }

        return this.getPointDefaultColor(point);
    }

    getPointColorHex(point) {
        return this.getConstructionColorHex(this.getPointColor(point), this.getPointDefaultColor(point));
    }

    applyPointColorOverride(point, color) {
        if (!point) {
            return false;
        }

        const nextColor = this.normalizeConstructionColor(color, this.getPointColor(point));
        if (point.isDerived) {
            const signature = point.signature || point.id;
            if (!signature) {
                return false;
            }
            this.derivedPointColorOverrides.set(signature, nextColor);
            return true;
        }

        const sourceIds = Array.isArray(point.sourceIds) ? point.sourceIds : [];
        if (sourceIds.length === 0) {
            return false;
        }
        sourceIds.forEach((sourceId) => this.basePointColorOverrides.set(sourceId, nextColor));
        return true;
    }

    updateGhostToggleUI() {
        if (!this.ghostToggleBtn) {
            return;
        }

        this.ghostToggleBtn.title = this.ghostFaces
            ? 'Transparent faces enabled (click for solid faces)'
            : 'Solid faces enabled (click for transparent faces)';

        if (this.ghostWireIcon) {
            this.ghostWireIcon.classList.toggle('ghost-active', this.ghostFaces);
        }

        if (this.ghostSolidIcon) {
            this.ghostSolidIcon.classList.toggle('ghost-active', !this.ghostFaces);
        }
    }

    toggleLabelBadgeMode() {
        const cycle = { badge: 'off', off: 'plain', plain: 'badge' };
        this.labelMode = cycle[this.labelMode] || 'badge';
        this.updateLabelBadgeToggleUI();
        this.refreshSceneTextSizing();
        this.scheduleLocalStateSave({ viewOnly: true });
    }

    updateLabelBadgeToggleUI() {
        if (!this.labelBadgeToggleBtn) {
            return;
        }

        const titles = {
            badge: 'Labels with badges (click to hide)',
            off: 'Labels hidden (click for plain)',
            plain: 'Plain labels (click to restore badges)'
        };
        this.labelBadgeToggleBtn.title = titles[this.labelMode] || '';

        if (this.labelPlainIcon) {
            this.labelPlainIcon.classList.toggle('label-badge-active', this.labelMode === 'plain');
        }
        if (this.labelBadgeIcon) {
            this.labelBadgeIcon.classList.toggle('label-badge-active', this.labelMode === 'badge');
        }
        if (this.labelOffIcon) {
            this.labelOffIcon.classList.toggle('label-badge-active', this.labelMode === 'off');
        }
    }

    toggleDisplaySizeMode() {
        const cycle = { small: 'large', large: 'xlarge', xlarge: 'small' };
        this.displaySizeMode = cycle[this.displaySizeMode] || 'small';
        this.updateDisplaySizeToggleUI();
        this.refreshSceneTextSizing();
        this.scheduleLocalStateSave({ viewOnly: true });
    }

    updateDisplaySizeToggleUI() {
        if (this.sizeSmallOption) {
            this.sizeSmallOption.classList.toggle('size-active', this.displaySizeMode === 'small');
        }
        if (this.sizeLargeOption) {
            this.sizeLargeOption.classList.toggle('size-active', this.displaySizeMode === 'large');
        }
        if (this.sizeXlargeOption) {
            this.sizeXlargeOption.classList.toggle('size-active', this.displaySizeMode === 'xlarge');
        }
    }

    refreshSceneTextSizing() {
        this.rebuildConstructions();
        this.buildPointMarkers();
        this.updatePointMarkerStyles();
        this.syncAllLabelVisibility();
    }

    getEdgeColor() {
        return this.themeMode === 'dark' ? 0xffffff : 0x000000;
    }

    getLabelTextColor() {
        return (this.labelMode !== 'badge' && this.themeMode === 'dark') ? '#ffffff' : '#000000';
    }

    toggleThemeMode() {
        this.themeMode = this.themeMode === 'light' ? 'dark' : 'light';
        this.applyThemeMode();
        this.scheduleLocalStateSave({ viewOnly: true });
    }

    applyThemeMode() {
        document.documentElement.setAttribute('data-theme', this.themeMode);
        if (this.scene?.background) {
            this.scene.background.set(this.themeMode === 'dark' ? 0x606060 : 0xffffff);
        }
        this.updateGridThemeAppearance();
        this.updateThemeToggleUI();
        const edgeColor = this.getEdgeColor();
        this.primitiveGroup?.traverse((obj) => {
            if (obj.material instanceof THREE.LineBasicMaterial) {
                obj.material.color.setHex(edgeColor);
                obj.material.needsUpdate = true;
            }
        });
        this.buildPointMarkers();
    }

    updateThemeToggleUI() {
        if (this.lightIcon) {
            this.lightIcon.classList.toggle('theme-active', this.themeMode === 'light');
        }
        if (this.darkIcon) {
            this.darkIcon.classList.toggle('theme-active', this.themeMode === 'dark');
        }
    }

    updateGridThemeAppearance() {
        if (!this.grid) {
            return;
        }

        const materials = Array.isArray(this.grid.material)
            ? this.grid.material
            : [this.grid.material];
        const isDark = this.themeMode === 'dark';

        materials.forEach((material) => {
            if (!material) {
                return;
            }

            material.transparent = isDark;
            material.opacity = isDark ? 0.35 : 1;
            material.needsUpdate = true;
        });
    }

    onWindowResize() {
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height, false);
        this.updateConstructionLineMaterialResolutions();
        this.refreshSliderBadges();
        if (this.isTriangleExtractionOpen() && this.triangleExtractModal) {
            this.triangleExtractModal.style.transform = 'translate(0px, 0px) scale(1)';
        }
        this.scheduleEmbedViewportFit(80);
    }

    updateConstructionLineMaterialResolutions() {
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        this.constructionLineMaterials.forEach((material) => {
            material.resolution.set(width, height);
        });
    }

    // --- Composite helpers ---

    getOrientationQuaternion(primitiveKey, orientationValue) {
        const q = new THREE.Quaternion();

        if (primitiveKey === 'cylinder') {
            if (orientationValue === 'horizontal') {
                q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
            }
        } else if (primitiveKey === 'cone') {
            if (orientationValue === 'apex-down') {
                q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
            } else if (orientationValue === 'sideways-right') {
                q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
            }
        } else if (primitiveKey === 'rectangular-pyramid') {
            if (orientationValue === 'apex-down') {
                q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
            }
        }

        return q;
    }

    getCompatiblePrimitives() {
        if (this.compositeSlots.length >= 3) return [];

        const existingPrimitives = new Set(this.compositeSlots.map((s) => s.primitive));
        const disallowedSelfAdds = new Set(['cuboid', 'cylinder']);

        return Object.keys(this.defaultParams).filter((primKey) => {
            if (existingPrimitives.has(primKey) && disallowedSelfAdds.has(primKey)) return false;
            const guestFaces = ATTACHMENT_FACES[primKey] || [];
            if (guestFaces.length === 0) return false;

            const draftSlot = {
                primitive: primKey,
                orientation: this.orientations[primKey]?.[0]?.value || 'standard',
                params: { ...this.defaultParams[primKey] }
            };

            return this.getValidHostFaceEntries(draftSlot, this.compositeSlots, { excludeOccupied: true }).length > 0;
        });
    }

    getHostFaceKey(slotId, faceId) {
        return `${slotId}:${faceId}`;
    }

    getFaceDefById(slot, faceId) {
        if (!slot || !faceId) return null;
        return (ATTACHMENT_FACES[slot.primitive] || []).find((f) => f.id === faceId) || null;
    }

    resolveFaceNormal(faceDef, params) {
        const raw = typeof faceDef.normal === 'function' ? faceDef.normal(params) : faceDef.normal;
        const normal = raw ? raw.clone() : new THREE.Vector3(0, 1, 0);
        if (normal.lengthSq() < 1e-8) return new THREE.Vector3(0, 1, 0);
        return normal.normalize();
    }

    resolveFaceUAxis(faceDef, params) {
        const raw = typeof faceDef.uAxis === 'function' ? faceDef.uAxis(params) : faceDef.uAxis;
        const uAxis = raw ? raw.clone() : new THREE.Vector3(1, 0, 0);
        if (uAxis.lengthSq() < 1e-8) return new THREE.Vector3(1, 0, 0);
        return uAxis.normalize();
    }

    resolveFaceDims(faceDef, params) {
        const raw = typeof faceDef.dims === 'function' ? faceDef.dims(params) : faceDef.dims;
        return Array.isArray(raw) ? raw : [];
    }

    getFaceDimValue(slot, faceDef, dimKey) {
        if (!slot || !faceDef || !dimKey) return undefined;
        if (Object.prototype.hasOwnProperty.call(slot.params, dimKey)) {
            return slot.params[dimKey];
        }

        if (slot.primitive === 'right-triangle-prism' && dimKey === 'isoscelesSide') {
            const { legA, legB } = slot.params;
            return Math.hypot(legA / 2, legB);
        }

        if (slot.primitive === 'right-triangle-prism' && dimKey === 'hypotenuse') {
            const { legA, legB } = slot.params;
            return Math.hypot(legA, legB);
        }

        return undefined;
    }

    getOccupiedHostFaceKeys(excludeSlotId = null) {
        const occupied = new Set();
        this.compositeSlots.forEach((slot) => {
            if (slot.id === excludeSlotId) return;
            if (slot.hostSlotId == null || !slot.hostFaceId) return;
            occupied.add(this.getHostFaceKey(slot.hostSlotId, slot.hostFaceId));

            // Also block the guest face at this join so internal faces cannot be selected.
            const hostSlot = this.compositeSlots.find((s) => s.id === slot.hostSlotId);
            const hostFaceDef = this.getFaceDefById(hostSlot, slot.hostFaceId);
            if (!hostFaceDef) return;

            const hostFaceNormal = this.resolveFaceNormal(hostFaceDef, hostSlot.params);
            const guestFaceDef = this.getGuestAttachFaceDef(slot, hostFaceNormal, hostFaceDef.type);
            if (guestFaceDef) {
                occupied.add(this.getHostFaceKey(slot.id, guestFaceDef.id));
            }
        });
        return occupied;
    }

    getValidHostFaceEntries(guestSlot, previousSlots, options = {}) {
        const excludeOccupied = options.excludeOccupied === true;
        const excludeSlotId = options.excludeSlotId ?? null;
        const guestFaceTypes = new Set((ATTACHMENT_FACES[guestSlot.primitive] || []).map((f) => f.type));
        if (guestFaceTypes.size === 0) return [];

        const occupiedKeys = excludeOccupied ? this.getOccupiedHostFaceKeys(excludeSlotId) : null;

        const result = [];
        previousSlots.forEach((hostSlot) => {
            (ATTACHMENT_FACES[hostSlot.primitive] || []).forEach((faceDef) => {
                if (guestFaceTypes.has(faceDef.type)) {
                    const key = this.getHostFaceKey(hostSlot.id, faceDef.id);
                    if (occupiedKeys && occupiedKeys.has(key)) {
                        return;
                    }
                    result.push({
                        slotId: hostSlot.id,
                        slot: hostSlot,
                        faceId: faceDef.id,
                        faceDef,
                        label: `${this.primitiveMeta[hostSlot.primitive].label}: ${faceDef.label}`,
                    });
                }
            });
        });
        return result;
    }

    ensureSlotHostBinding(slot, previousSlots) {
        const allEntries = this.getValidHostFaceEntries(slot, previousSlots);
        if (allEntries.length === 0) {
            slot.hostSlotId = null;
            slot.hostFaceId = null;
            return null;
        }

        const occupiedByOthers = this.getOccupiedHostFaceKeys(slot.id);
        const findCurrent = () => allEntries.find((entry) => entry.slotId === slot.hostSlotId && entry.faceId === slot.hostFaceId);

        const currentEntry = findCurrent();
        if (currentEntry && !occupiedByOthers.has(this.getHostFaceKey(currentEntry.slotId, currentEntry.faceId))) {
            return currentEntry;
        }

        const availableEntries = allEntries.filter((entry) => !occupiedByOthers.has(this.getHostFaceKey(entry.slotId, entry.faceId)));
        const picked = availableEntries[0] || null;
        if (!picked) {
            slot.hostSlotId = null;
            slot.hostFaceId = null;
            return null;
        }

        slot.hostSlotId = picked.slotId;
        slot.hostFaceId = picked.faceId;
        return picked;
    }

    getGuestAttachFaceDef(guestSlot, hostFaceNormal, hostFaceType = null) {
        const faces = ATTACHMENT_FACES[guestSlot.primitive] || [];
        if (faces.length === 0) return null;

        if (guestSlot?.attachFaceId) {
            const explicitFace = faces.find((face) => face.id === guestSlot.attachFaceId);
            if (explicitFace && (!hostFaceType || explicitFace.type === hostFaceType)) {
                return explicitFace;
            }
        }

        const targetNormal = hostFaceNormal.clone().negate();
        const ABS_DOT_EPSILON = 1e-6;
        const DOT_EPSILON = 1e-6;

        const pickBest = (candidates) => {
            let best = null;
            let bestIndex = Infinity;
            let bestAbsDot = -Infinity;
            let bestDot = -Infinity;

            candidates.forEach(({ face, index }) => {
                const faceNormal = this.resolveFaceNormal(face, guestSlot.params);
                const dot = faceNormal.dot(targetNormal);
                const absDot = Math.abs(dot);

                if (best === null) {
                    best = face; bestIndex = index; bestAbsDot = absDot; bestDot = dot;
                    return;
                }

                const absDelta = absDot - bestAbsDot;
                if (absDelta > ABS_DOT_EPSILON) {
                    best = face; bestIndex = index; bestAbsDot = absDot; bestDot = dot;
                    return;
                }

                if (Math.abs(absDelta) <= ABS_DOT_EPSILON) {
                    const dotDelta = dot - bestDot;
                    if (dotDelta > DOT_EPSILON || (Math.abs(dotDelta) <= DOT_EPSILON && index < bestIndex)) {
                        best = face; bestIndex = index; bestAbsDot = absDot; bestDot = dot;
                    }
                }
            });
            return best;
        };

        const indexed = faces.map((face, index) => ({ face, index }));

        // Prefer matching face type so (e.g.) a rectangle host never picks a triangle guest face
        if (hostFaceType) {
            const sameType = indexed.filter(({ face }) => face.type === hostFaceType);
            if (sameType.length > 0) {
                return pickBest(sameType);
            }
        }

        return pickBest(indexed);
    }

    getAttachmentQuarterTurns(slot, guestFaceDef = null, hostFaceDef = null) {
        if (!slot || slot.primitive !== 'right-triangle-prism') {
            return 0;
        }

        if (guestFaceDef?.type !== 'rectangle' || hostFaceDef?.type !== 'rectangle') {
            return 0;
        }

        return ((slot.attachRotationQuarterTurns || 0) % 4 + 4) % 4;
    }

    getAttachmentDimsForHost(slot, guestFaceDef, hostFaceDef = null) {
        const guestDims = this.resolveFaceDims(guestFaceDef, slot.params).slice();
        const turns = this.getAttachmentQuarterTurns(slot, guestFaceDef, hostFaceDef);
        if (guestDims.length >= 2 && turns % 2 === 1) {
            [guestDims[0], guestDims[1]] = [guestDims[1], guestDims[0]];
        }
        return guestDims;
    }

    snapSlotDimensions(guestSlot) {
        const guestSlotIndex = this.compositeSlots.findIndex((s) => s.id === guestSlot.id);
        if (guestSlotIndex <= 0) return;
        const prevSlots = this.compositeSlots.slice(0, guestSlotIndex);
        const entry = this.ensureSlotHostBinding(guestSlot, prevSlots);
        if (!entry) return;

        const { slot: hostSlot, faceDef: hostFaceDef } = entry;
    this.syncAttachmentSpecificVariants(guestSlot, hostSlot, hostFaceDef);
        const hostFaceNormal = this.resolveFaceNormal(hostFaceDef, hostSlot.params);
        const guestFaceDef = this.getGuestAttachFaceDef(guestSlot, hostFaceNormal, hostFaceDef.type);
        if (!guestFaceDef) return;

        const hostDims = this.resolveFaceDims(hostFaceDef, hostSlot.params);
        const guestDims = this.getAttachmentDimsForHost(guestSlot, guestFaceDef, hostFaceDef);
        hostDims.forEach((dim, i) => {
            const guestDim = guestDims[i];
            const hostValue = this.getFaceDimValue(hostSlot, hostFaceDef, dim);
            if (guestSlot.primitive === 'right-triangle-prism' && guestDim === 'isoscelesSide') {
                const halfBase = guestSlot.params.legA / 2;
                if (typeof hostValue === 'number' && Number.isFinite(hostValue) && hostValue >= halfBase) {
                    guestSlot.params.legB = Math.sqrt(Math.max(0, hostValue * hostValue - halfBase * halfBase));
                }
                return;
            }
            if (!guestDim || !Object.prototype.hasOwnProperty.call(guestSlot.params, guestDim)) return;
            if (typeof hostValue === 'number' && Number.isFinite(hostValue)) {
                guestSlot.params[guestDim] = hostValue;
            }
        });
    }

    syncAttachmentSpecificVariants(guestSlot, hostSlot, hostFaceDef) {
        if (!guestSlot || !hostSlot || !hostFaceDef) {
            return;
        }

        const isGuestTetra = guestSlot.primitive === 'tetrahedron';
        const isHostTetra = hostSlot.primitive === 'tetrahedron';
        const isGuestPrism = guestSlot.primitive === 'right-triangle-prism';
        const isHostPrism = hostSlot.primitive === 'right-triangle-prism';

        // Prism <-> tetrahedron attachments should always drive tetra mode from prism mode,
        // regardless of which primitive is host/guest.
        if (isGuestTetra && isHostPrism && (hostFaceDef.id === 'front-triangle' || hostFaceDef.id === 'back-triangle')) {
            const prismMode = normalizeTriangularPrismMode(hostSlot.params.triangleMode);
            guestSlot.params.baseTriangleMode = prismMode === 'isosceles' ? 'isosceles' : 'right-angled';
            guestSlot.params.baseMirror = (prismMode === 'right-above-A') !== (hostFaceDef.id === 'back-triangle');
            return;
        }

        if (isGuestPrism && isHostTetra && hostFaceDef.id === 'base-triangle') {
            const hostFaceNormal = this.resolveFaceNormal(hostFaceDef, hostSlot.params);
            const prismFaceDef = this.getGuestAttachFaceDef(guestSlot, hostFaceNormal, hostFaceDef.type);
            if (prismFaceDef && (prismFaceDef.id === 'front-triangle' || prismFaceDef.id === 'back-triangle')) {
                const prismMode = normalizeTriangularPrismMode(guestSlot.params.triangleMode);
                hostSlot.params.baseTriangleMode = prismMode === 'isosceles' ? 'isosceles' : 'right-angled';
                hostSlot.params.baseMirror = (prismMode === 'right-above-A') !== (prismFaceDef.id === 'back-triangle');
            }
            return;
        }

        // Tetrahedron <-> tetrahedron keeps mirrored right-angle compatibility.
        if (isGuestTetra && isHostTetra && hostFaceDef.id === 'base-triangle') {
            const hostBaseMode = normalizeTetrahedronBaseMode(hostSlot.params.baseTriangleMode);
            guestSlot.params.baseTriangleMode = hostBaseMode;
            guestSlot.params.baseMirror = hostBaseMode === 'right-angled';
            return;
        }

        if (isGuestTetra) {
            guestSlot.params.baseMirror = false;
        }
    }

    isTetraBaseModeLocked(slot) {
        return !!this.getLinkedTetraBaseController(slot);
    }

    getLinkedTetraBaseController(slot) {
        if (!slot || slot.primitive !== 'tetrahedron') {
            return null;
        }

        if (slot.hostSlotId != null && slot.hostFaceId) {
            const hostSlot = this.compositeSlots.find((s) => s.id === slot.hostSlotId);
            const hostFaceDef = this.getFaceDefById(hostSlot, slot.hostFaceId);
            if (hostSlot?.primitive === 'right-triangle-prism'
                && (hostFaceDef?.id === 'front-triangle' || hostFaceDef?.id === 'back-triangle')) {
                return hostSlot;
            }

            if (hostSlot?.primitive === 'tetrahedron' && hostFaceDef?.id === 'base-triangle') {
                return hostSlot;
            }
        }

        const attachedPrismGuest = this.compositeSlots.find((child) => {
            if (child.hostSlotId !== slot.id || child.primitive !== 'right-triangle-prism' || !child.hostFaceId) {
                return false;
            }

            const hostFaceDef = this.getFaceDefById(slot, child.hostFaceId);
            return hostFaceDef?.id === 'base-triangle';
        });

        return attachedPrismGuest || null;
    }

    syncLinkedTetraModesForPrism(prismSlot) {
        if (!prismSlot || prismSlot.primitive !== 'right-triangle-prism') {
            return;
        }

        // Prism as guest attached to a tetrahedron host.
        if (prismSlot.hostSlotId != null && prismSlot.hostFaceId) {
            const hostSlot = this.compositeSlots.find((s) => s.id === prismSlot.hostSlotId);
            const hostFaceDef = this.getFaceDefById(hostSlot, prismSlot.hostFaceId);
            if (hostSlot?.primitive === 'tetrahedron' && hostFaceDef?.id === 'base-triangle') {
                this.syncAttachmentSpecificVariants(prismSlot, hostSlot, hostFaceDef);
            }
        }

        // Prism as host with tetrahedron guests.
        this.compositeSlots.forEach((child) => {
            if (child.hostSlotId !== prismSlot.id || child.primitive !== 'tetrahedron' || !child.hostFaceId) {
                return;
            }

            const hostFaceDef = this.getFaceDefById(prismSlot, child.hostFaceId);
            if (hostFaceDef?.id === 'front-triangle' || hostFaceDef?.id === 'back-triangle') {
                this.syncAttachmentSpecificVariants(child, prismSlot, hostFaceDef);
            }
        });
    }

    normalizeCuboidPyramidHostOrder() {
        if (this.compositeSlots.length !== 2) {
            return;
        }

        const cuboidSlot = this.compositeSlots.find((slot) => slot.primitive === 'cuboid');
        const pyramidSlot = this.compositeSlots.find((slot) => slot.primitive === 'rectangular-pyramid');
        if (!cuboidSlot || !pyramidSlot) {
            return;
        }

        // Already in preferred directed attachment: cuboid host -> pyramid guest.
        if (cuboidSlot.hostSlotId == null && pyramidSlot.hostSlotId === cuboidSlot.id) {
            return;
        }

        this.compositeSlots = [cuboidSlot, pyramidSlot];
        cuboidSlot.hostSlotId = null;
        cuboidSlot.hostFaceId = null;
        pyramidSlot.hostSlotId = null;
        pyramidSlot.hostFaceId = null;
        this.snapSlotDimensions(pyramidSlot);
    }

    normalizeCuboidPrismHostOrder() {
        if (this.compositeSlots.length !== 2) {
            return;
        }

        const cuboidSlot = this.compositeSlots.find((slot) => slot.primitive === 'cuboid');
        const prismSlot = this.compositeSlots.find((slot) => slot.primitive === 'right-triangle-prism');
        if (!cuboidSlot || !prismSlot) {
            return;
        }

        // Already in preferred directed attachment: cuboid host -> prism guest.
        if (cuboidSlot.hostSlotId == null && prismSlot.hostSlotId === cuboidSlot.id) {
            return;
        }

        this.compositeSlots = [cuboidSlot, prismSlot];
        cuboidSlot.hostSlotId = null;
        cuboidSlot.hostFaceId = null;
        prismSlot.hostSlotId = null;
        prismSlot.hostFaceId = null;
        this.snapSlotDimensions(prismSlot);
    }

    normalizeCylinderConeHostOrder() {
        if (this.compositeSlots.length !== 2) {
            return;
        }

        const cylinderSlot = this.compositeSlots.find((slot) => slot.primitive === 'cylinder');
        const coneSlot = this.compositeSlots.find((slot) => slot.primitive === 'cone');
        if (!cylinderSlot || !coneSlot) {
            return;
        }

        // Already in preferred directed attachment: cylinder host -> cone guest.
        if (cylinderSlot.hostSlotId == null && coneSlot.hostSlotId === cylinderSlot.id) {
            return;
        }

        this.compositeSlots = [cylinderSlot, coneSlot];
        cylinderSlot.hostSlotId = null;
        cylinderSlot.hostFaceId = null;
        coneSlot.hostSlotId = null;
        coneSlot.hostFaceId = null;
        this.snapSlotDimensions(coneSlot);
    }

    normalizeCylinderHemisphereHostOrder() {
        if (this.compositeSlots.length !== 2) {
            return;
        }

        const cylinderSlot = this.compositeSlots.find((slot) => slot.primitive === 'cylinder');
        const hemisphereSlot = this.compositeSlots.find((slot) => slot.primitive === 'hemisphere');
        if (!cylinderSlot || !hemisphereSlot) {
            return;
        }

        // Already in preferred directed attachment: cylinder host -> hemisphere guest.
        if (cylinderSlot.hostSlotId == null && hemisphereSlot.hostSlotId === cylinderSlot.id) {
            return;
        }

        this.compositeSlots = [cylinderSlot, hemisphereSlot];
        cylinderSlot.hostSlotId = null;
        cylinderSlot.hostFaceId = null;
        hemisphereSlot.hostSlotId = null;
        hemisphereSlot.hostFaceId = null;
        this.snapSlotDimensions(hemisphereSlot);
    }

    getAvailableSlotId() {
        const usedIds = new Set(
            this.compositeSlots
                .map((slot) => slot?.id)
                .filter((id) => this.isValidSlotId(id))
        );
        let candidate = this.isValidNextSlotId(this.nextSlotId) ? this.nextSlotId : 1;
        const start = candidate;
        do {
            if (!usedIds.has(candidate)) {
                return candidate;
            }
            candidate = candidate < MAX_SLOT_ID ? candidate + 1 : 1;
        } while (candidate !== start);
        return null;
    }

    reserveNextSlotId() {
        const slotId = this.getAvailableSlotId();
        if (slotId == null) {
            return null;
        }
        this.nextSlotId = slotId < MAX_SLOT_ID ? slotId + 1 : 1;
        return slotId;
    }

    addSlot(primitiveKey) {
        if (!this.primitiveMeta || !this.primitiveMeta[primitiveKey]) {
            this.recordCrashEvent('add.slot.rejected', {
                reason: 'primitive-meta-missing',
                primitiveKey,
                primitiveMetaKeys: this.primitiveMeta && typeof this.primitiveMeta === 'object'
                    ? Object.keys(this.primitiveMeta).length
                    : 0
            });
            return;
        }

        const orientation = this.orientations?.[primitiveKey]?.[0]?.value;
        const paramsTemplate = this.defaultParams?.[primitiveKey];
        if (!orientation || !paramsTemplate) {
            this.recordCrashEvent('add.slot.rejected', {
                reason: 'primitive-config-missing',
                primitiveKey,
                hasOrientation: !!orientation,
                hasDefaultParams: !!paramsTemplate,
                orientationsKeys: this.orientations && typeof this.orientations === 'object'
                    ? Object.keys(this.orientations).length
                    : 0,
                defaultParamsKeys: this.defaultParams && typeof this.defaultParams === 'object'
                    ? Object.keys(this.defaultParams).length
                    : 0
            });
            return;
        }

        if (this.compositeSlots.length === 0) {
            // First slot - reset everything
            const slot = {
                id: null,
                primitive: primitiveKey,
                orientation,
                params: { ...paramsTemplate },
                hostSlotId: null,
                hostFaceId: null,
                attachFaceId: null,
                attachRotationQuarterTurns: 0,
            };
            const slotId = this.reserveNextSlotId();
            if (slotId == null) {
                this.recordCrashEvent('add.slot.rejected', {
                    reason: 'slot-id-capacity',
                    primitiveKey,
                    compositeSlots: this.compositeSlots.length
                });
                return;
            }
            slot.id = slotId;
            this.compositeSlots.push(slot);
        } else {
            if (this.compositeSlots.length >= 3) {
                this.recordCrashEvent('add.slot.rejected', {
                    reason: 'max-primitives-reached',
                    primitiveKey,
                    compositeSlots: this.compositeSlots.length
                });
                return;
            }
            const slot = {
                id: null,
                primitive: primitiveKey,
                orientation,
                params: { ...paramsTemplate },
                hostSlotId: null,
                hostFaceId: null,
                attachFaceId: null,
                attachRotationQuarterTurns: 0,
            };

            const prevSlots = this.compositeSlots.slice();
            const availableEntries = this.getValidHostFaceEntries(slot, prevSlots, { excludeOccupied: true });
            if (availableEntries.length === 0) {
                this.recordCrashEvent('add.slot.rejected', {
                    reason: 'no-compatible-host-face',
                    primitiveKey,
                    compositeSlots: this.compositeSlots.length
                });
                return;
            }

            const slotId = this.reserveNextSlotId();
            if (slotId == null) {
                this.recordCrashEvent('add.slot.rejected', {
                    reason: 'slot-id-capacity',
                    primitiveKey,
                    compositeSlots: this.compositeSlots.length
                });
                return;
            }
            slot.id = slotId;
            this.compositeSlots.push(slot);
            this.snapSlotDimensions(slot);
            this.normalizeCuboidPyramidHostOrder();
            this.normalizeCuboidPrismHostOrder();
            this.normalizeCylinderConeHostOrder();
            this.normalizeCylinderHemisphereHostOrder();
        }

        this.recordCrashEvent('add.slot.success', {
            primitiveKey,
            compositeSlots: this.compositeSlots.length
        });

        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
        this.closePanelOnMobile();
    }

    removeSlot(slotId) {
        const idx = this.compositeSlots.findIndex((s) => s.id === slotId);
        if (idx === -1) return;
        // Remove only this slot; remaining slots will be re-evaluated against available hosts.
        this.compositeSlots.splice(idx, 1);
        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    cycleSlotFace(slotId) {
        const slotIdx = this.compositeSlots.findIndex((s) => s.id === slotId);
        if (slotIdx <= 0) return;
        const slot = this.compositeSlots[slotIdx];
        const prevSlots = this.compositeSlots.slice(0, slotIdx);
        const entries = this.getValidHostFaceEntries(slot, prevSlots, { excludeOccupied: true, excludeSlotId: slot.id });
        if (entries.length <= 1) return;

        const currentIndex = entries.findIndex((entry) => entry.slotId === slot.hostSlotId && entry.faceId === slot.hostFaceId);
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % entries.length : 0;
        slot.hostSlotId = entries[nextIndex].slotId;
        slot.hostFaceId = entries[nextIndex].faceId;
        this.snapSlotDimensions(slot);
        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    getCurrentHostEntryForSlot(slot) {
        if (!slot || slot.hostSlotId == null || !slot.hostFaceId) {
            return null;
        }

        const hostSlot = this.compositeSlots.find((candidate) => candidate.id === slot.hostSlotId);
        const hostFaceDef = this.getFaceDefById(hostSlot, slot.hostFaceId);
        if (!hostSlot || !hostFaceDef) {
            return null;
        }

        return { slot: hostSlot, faceDef: hostFaceDef };
    }

    getPrismAttachFaceCandidates(slot, hostFaceType = 'rectangle') {
        if (!slot || slot.primitive !== 'right-triangle-prism') {
            return [];
        }

        return (ATTACHMENT_FACES[slot.primitive] || []).filter((faceDef) => faceDef.type === hostFaceType);
    }

    getPrismAttachFaceLabel(faceId) {
        return (ATTACHMENT_FACES['right-triangle-prism'] || []).find((faceDef) => faceDef.id === faceId)?.label || 'Rectangle';
    }

    isPrismRectAttachmentConfigurable(slot) {
        if (!slot || slot.primitive !== 'right-triangle-prism' || slot.hostSlotId == null || !slot.hostFaceId) {
            return false;
        }

        const hostEntry = this.getCurrentHostEntryForSlot(slot);
        return hostEntry?.faceDef?.type === 'rectangle';
    }

    cyclePrismAttachFace(slotId) {
        const slot = this.compositeSlots.find((candidate) => candidate.id === slotId);
        if (!this.isPrismRectAttachmentConfigurable(slot)) return;

        const hostEntry = this.getCurrentHostEntryForSlot(slot);
        const candidates = this.getPrismAttachFaceCandidates(slot, hostEntry.faceDef.type);
        if (candidates.length <= 1) return;

        const hostFaceNormal = this.resolveFaceNormal(hostEntry.faceDef, hostEntry.slot.params);
        const currentFace = this.getGuestAttachFaceDef(slot, hostFaceNormal, hostEntry.faceDef.type);
        const currentIndex = candidates.findIndex((candidate) => candidate.id === currentFace?.id);
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % candidates.length : 0;

        slot.attachFaceId = candidates[nextIndex].id;
        this.snapSlotDimensions(slot);
        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    getPrismAttachRotationLabel(quarterTurns) {
        const normalized = ((quarterTurns || 0) % 4 + 4) % 4;
        return `${normalized * 90}\u00b0`;
    }

    cyclePrismAttachRotation(slotId) {
        const slot = this.compositeSlots.find((candidate) => candidate.id === slotId);
        if (!this.isPrismRectAttachmentConfigurable(slot)) return;

        slot.attachRotationQuarterTurns = (((slot.attachRotationQuarterTurns || 0) + 1) % 4 + 4) % 4;
        this.snapSlotDimensions(slot);
        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    getTriangularPrismModeLabel(mode) {
        const normalizedMode = mode === 'equilateral' ? 'isosceles' : mode;
        return this.triangularPrismModes.find((opt) => opt.value === normalizedMode)?.label || 'Isosceles';
    }

    cycleTriangularPrismMode(slotId) {
        const slot = this.compositeSlots.find((s) => s.id === slotId);
        if (!slot || slot.primitive !== 'right-triangle-prism') return;

        const options = this.triangularPrismModes;
        const current = slot.params.triangleMode === 'equilateral' ? 'isosceles' : (slot.params.triangleMode || 'isosceles');
        const currentIndex = options.findIndex((opt) => opt.value === current);
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % options.length : 0;
        slot.params.triangleMode = options[nextIndex].value;
        this.syncLinkedTetraModesForPrism(slot);

        const slotIndex = this.compositeSlots.findIndex((s) => s.id === slotId);
        this.compositeSlots.slice(slotIndex + 1).forEach((laterSlot) => this.snapSlotDimensions(laterSlot));

        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    toggleCuboidFaceCenters(slotId) {
        const slot = this.compositeSlots.find((s) => s.id === slotId);
        if (!slot || slot.primitive !== 'cuboid') return;

        const modes = ['off', 'top-bottom', 'left-right', 'front-back', 'all'];
        const current = this.getCuboidFaceCentersMode(slot.params);
        const currentIndex = modes.indexOf(current);
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % modes.length : 0;
        slot.params.includeFaceCentersMode = modes[nextIndex];
        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    getCuboidFaceCentersMode(params = {}) {
        const mode = params.includeFaceCentersMode;
        if (mode === 'off' || mode === 'top-bottom' || mode === 'left-right' || mode === 'front-back' || mode === 'all') {
            return mode;
        }

        // Backward compatibility with legacy boolean flag.
        return params.includeFaceCenters === true ? 'all' : 'off';
    }

    getCuboidFaceCentersModeLabel(mode) {
        const labels = {
            off: 'Off',
            'top-bottom': 'Top/Bottom',
            'left-right': 'Left/Right',
            'front-back': 'Front/Back',
            all: 'All'
        };
        return labels[mode] || 'Off';
    }

    isRectangularPyramidBaseCenterVisible(params = {}) {
        return params.showBaseCenter !== false;
    }

    toggleRectangularPyramidBaseCenter(slotId) {
        const slot = this.compositeSlots.find((s) => s.id === slotId);
        if (!slot || slot.primitive !== 'rectangular-pyramid') return;

        slot.params.showBaseCenter = !this.isRectangularPyramidBaseCenterVisible(slot.params);
        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    getRectangularPyramidBaseCenterLabel(params = {}) {
        return this.isRectangularPyramidBaseCenterVisible(params) ? 'Shown' : 'Hidden';
    }

    isPolygonalApothemVisible(params = {}) {
        return params.showApothem !== false;
    }

    togglePolygonalApothem(slotId) {
        const slot = this.compositeSlots.find((s) => s.id === slotId);
        if (!slot || !getPolygonalPrimitiveConfig(slot.primitive)) return;

        slot.params.showApothem = !this.isPolygonalApothemVisible(slot.params);
        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    getPolygonalApothemLabel(params = {}) {
        return this.isPolygonalApothemVisible(params) ? 'Shown' : 'Hidden';
    }

    isPolygonalPrismBaseCentersVisible(params = {}) {
        return params.showBaseCenters !== false;
    }

    togglePolygonalPrismBaseCenters(slotId) {
        const slot = this.compositeSlots.find((s) => s.id === slotId);
        const polygonal = slot ? getPolygonalPrimitiveConfig(slot.primitive) : null;
        if (!slot || polygonal?.kind !== 'prism') return;

        slot.params.showBaseCenters = !this.isPolygonalPrismBaseCentersVisible(slot.params);
        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    getPolygonalPrismBaseCentersLabel(params = {}) {
        return this.isPolygonalPrismBaseCentersVisible(params) ? 'Shown' : 'Hidden';
    }

    isCylinderCenterVisible(params = {}) {
        return params.showCenter !== false;
    }

    toggleCylinderCenter(slotId) {
        const slot = this.compositeSlots.find((s) => s.id === slotId);
        if (!slot || slot.primitive !== 'cylinder') return;

        slot.params.showCenter = !this.isCylinderCenterVisible(slot.params);
        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    getCylinderCenterLabel(params = {}) {
        return this.isCylinderCenterVisible(params) ? 'Shown' : 'Hidden';
    }

    isCylinderEndCentersVisible(params = {}) {
        return params.showEndCenters !== false;
    }

    toggleCylinderEndCenters(slotId) {
        const slot = this.compositeSlots.find((s) => s.id === slotId);
        if (!slot || slot.primitive !== 'cylinder') return;

        slot.params.showEndCenters = !this.isCylinderEndCentersVisible(slot.params);
        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    getCylinderEndCentersLabel(params = {}) {
        return this.isCylinderEndCentersVisible(params) ? 'Shown' : 'Hidden';
    }

    getTetrahedronTriangleModeLabel(mode) {
        return this.tetrahedronTriangleModes.find((opt) => opt.value === normalizeTetrahedronBaseMode(mode))?.label || 'Isosceles';
    }

    cycleTetrahedronTriangleMode(slotId, focusSlotId = slotId) {
        const slot = this.compositeSlots.find((s) => s.id === slotId);
        if (!slot || slot.primitive !== 'tetrahedron') return;
        const linkedController = this.getLinkedTetraBaseController(slot);
        if (linkedController?.primitive === 'right-triangle-prism') {
            this.cycleTriangularPrismMode(linkedController.id);
            return;
        }

        if (linkedController?.primitive === 'tetrahedron') {
            this.cycleTetrahedronTriangleMode(linkedController.id, focusSlotId);
            return;
        }

        const options = this.tetrahedronTriangleModes;
        const current = normalizeTetrahedronBaseMode(slot.params.baseTriangleMode);
        const currentIndex = options.findIndex((opt) => opt.value === current);
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % options.length : 0;
        slot.params.baseTriangleMode = options[nextIndex].value;
        this.snapSlotDimensions(slot);

        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
        this.primitiveCardsListEl
            .querySelector(`[data-cycle-tetrahedron-mode-slot-id="${focusSlotId}"]`)
            ?.focus({ preventScroll: true });
    }

    getTetrahedronApexLabel(apexPosition) {
        return this.tetrahedronApexPositions.find((opt) => opt.value === apexPosition)?.label || 'Above A';
    }

    cycleTetrahedronApex(slotId) {
        const slot = this.compositeSlots.find((s) => s.id === slotId);
        if (!slot || slot.primitive !== 'tetrahedron') return;

        const options = this.tetrahedronApexPositions;
        const current = slot.params.apexPosition || 'A';
        const currentIndex = options.findIndex((opt) => opt.value === current);
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % options.length : 0;
        slot.params.apexPosition = options[nextIndex].value;

        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
        this.primitiveCardsListEl
            .querySelector(`[data-cycle-tetrahedron-apex-slot-id="${slotId}"]`)
            ?.focus({ preventScroll: true });
    }

    refreshTetrahedronDerivedHeightControl(slot) {
        if (!slot || slot.primitive !== 'tetrahedron'
            || normalizeTetrahedronBaseMode(slot.params.baseTriangleMode) !== 'equilateral') {
            return;
        }

        const input = this.primitiveCardsListEl.querySelector(
            `[data-slot-id="${slot.id}"] [data-param-key="triangleHeight"] .slider-input`
        );
        if (!input) return;
        input.value = String(getTetrahedronBaseTriangleHeight(slot.params));
        this.updateSliderFill(input);
    }

    getRectangularPyramidApexLabel(apexPosition) {
        return this.rectangularPyramidApexPositions.find((opt) => opt.value === apexPosition)?.label || 'Centre';
    }

    isOrientationControlVisible(slot) {
        if (!slot) {
            return false;
        }

        if (slot.hostSlotId != null) {
            const hostSlot = this.compositeSlots.find((candidate) => candidate.id === slot.hostSlotId);
            const hostFaceDef = this.getFaceDefById(hostSlot, slot.hostFaceId);

            if (slot.primitive === 'rectangular-pyramid' && hostSlot?.primitive === 'cuboid') {
                // In this attachment context apex-up/down is visually equivalent, so hide inert controls.
                return false;
            }

            if ((slot.primitive === 'cone' || slot.primitive === 'cylinder') && hostFaceDef?.type === 'circle') {
                // Circular joins are rotationally symmetric; these controls are redundant when attached.
                return false;
            }
        }

        return true;
    }

    cycleRectangularPyramidApex(slotId) {
        const slot = this.compositeSlots.find((s) => s.id === slotId);
        if (!slot || slot.primitive !== 'rectangular-pyramid') return;

        const options = this.rectangularPyramidApexPositions;
        const current = slot.params.apexPosition || 'center';
        const currentIndex = options.findIndex((opt) => opt.value === current);
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % options.length : 0;
        slot.params.apexPosition = options[nextIndex].value;

        this.resetSceneObjects();
        this.buildComposite();
        this.renderCompositeCards();
    }

    renderCompositeCards() {
        this.primitiveCardsListEl.innerHTML = '';
        const hasMultiple = this.compositeSlots.length > 1;
        this.updatePrimarySectionCounts();

        if (this.compositeSlots.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'section-note';
            empty.textContent = 'Click Add to create a primitive.';
            this.primitiveCardsListEl.appendChild(empty);
            return;
        }

        this.compositeSlots.forEach((slot, idx) => {
            const card = document.createElement('div');
            card.className = 'primitive-card';
            card.dataset.slotId = String(slot.id);

            // Header
            const header = document.createElement('div');
            header.className = 'primitive-card-header';

            const titleEl = document.createElement('span');
            titleEl.className = 'primitive-card-title';
            titleEl.textContent = this.primitiveMeta[slot.primitive].label;
            header.appendChild(titleEl);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'card-remove-btn';
            removeBtn.dataset.removeSlotId = String(slot.id);
            removeBtn.setAttribute('aria-label', `Remove ${this.primitiveMeta[slot.primitive].label}`);
            removeBtn.textContent = 'X';
            header.appendChild(removeBtn);
            card.appendChild(header);

            // Orientation chips (only if multiple options)
            const orientOptions = this.orientations[slot.primitive] || [];
            if (orientOptions.length > 1 && this.isOrientationControlVisible(slot)) {
                const orientRow = document.createElement('div');
                orientRow.className = 'orientation-inline-row';
                const orientLabel = document.createElement('span');
                orientLabel.className = 'field-label orientation-inline-label';
                orientLabel.textContent = 'Orientation';

                const chipsEl = document.createElement('div');
                chipsEl.className = 'orientation-chip-row';
                chipsEl.setAttribute('role', 'radiogroup');
                chipsEl.setAttribute('aria-label', 'Orientation');

                orientOptions.forEach((opt) => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'orientation-chip-btn';
                    btn.dataset.orientationValue = opt.value;
                    btn.textContent = opt.chipLabel || opt.label;
                    btn.title = opt.label;
                    btn.setAttribute('role', 'radio');
                    const isActive = opt.value === slot.orientation;
                    btn.classList.toggle('is-active', isActive);
                    btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
                    chipsEl.appendChild(btn);
                });

                orientRow.appendChild(orientLabel);
                orientRow.appendChild(chipsEl);
                card.appendChild(orientRow);
            }

            // Sliders
            const sliderStack = document.createElement('div');
            sliderStack.className = 'slider-stack';

            (this.primitiveMeta[slot.primitive].params || []).forEach((config) => {
                const row = document.createElement('div');
                row.className = 'slider-row';
                row.dataset.paramKey = config.key;
                const isDerivedTetrahedronHeight = slot.primitive === 'tetrahedron'
                    && config.key === 'triangleHeight'
                    && normalizeTetrahedronBaseMode(slot.params.baseTriangleMode) === 'equilateral';
                row.classList.toggle('is-derived-param', isDerivedTetrahedronHeight);

                const inputId = `slot-${slot.id}-${config.key}-slider`;
                const labelEl = document.createElement('label');
                labelEl.className = 'slider-name';
                labelEl.htmlFor = inputId;
                labelEl.textContent = isDerivedTetrahedronHeight ? 'HEIGHT (AUTO)' : config.label;

                const inputWrap = document.createElement('div');
                inputWrap.className = 'slider-input-wrap';

                const input = document.createElement('input');
                input.id = inputId;
                input.className = 'slider-input';
                input.type = 'range';
                input.min = String(isDerivedTetrahedronHeight ? 0 : config.min);
                input.max = String(config.max);
                input.step = isDerivedTetrahedronHeight ? 'any' : String(config.step);
                input.value = String(isDerivedTetrahedronHeight
                    ? getTetrahedronBaseTriangleHeight(slot.params)
                    : slot.params[config.key]);
                input.setAttribute('aria-label', isDerivedTetrahedronHeight
                    ? 'Base triangle height, calculated automatically for an equilateral base'
                    : (config.accessibleLabel || config.label));
                if (isDerivedTetrahedronHeight) {
                    input.disabled = true;
                    input.title = 'Calculated automatically from the base side length';
                    row.title = input.title;
                }
                this.updateSliderFill(input);

                input.addEventListener('input', () => {
                    const newVal = Number(input.value);
                    slot.params[config.key] = newVal;
                    this.updateSliderFill(input);
                    if (slot.primitive === 'tetrahedron' && config.key === 'base') {
                        this.refreshTetrahedronDerivedHeightControl(slot);
                    }

                    // Propagate to linked params
                    this.slotLinkages.forEach((link) => {
                        if (link.fromSlotId !== slot.id || link.fromParam !== config.key) return;
                        const linkedSlot = this.compositeSlots.find((s) => s.id === link.toSlotId);
                        if (!linkedSlot) return;
                        linkedSlot.params[link.toParam] = newVal;
                        if (linkedSlot.primitive === 'tetrahedron' && link.toParam === 'base') {
                            this.refreshTetrahedronDerivedHeightControl(linkedSlot);
                        }
                        const linkedRow = this.primitiveCardsListEl.querySelector(`[data-slot-id="${link.toSlotId}"] [data-param-key="${link.toParam}"]`);
                        if (linkedRow) {
                            const li = linkedRow.querySelector('.slider-input');
                            if (li) {
                                li.value = String(newVal);
                                this.updateSliderFill(li);
                            }
                        }
                    });

                    this.buildComposite({ fitCamera: false });
                });

                inputWrap.append(input);
                row.append(labelEl, inputWrap);
                sliderStack.appendChild(row);
            });

            card.appendChild(sliderStack);

            if (slot.primitive === 'cuboid') {
                const cuboidFaceCentersBtn = document.createElement('button');
                cuboidFaceCentersBtn.type = 'button';
                cuboidFaceCentersBtn.className = 'card-cycle-btn';
                cuboidFaceCentersBtn.dataset.toggleCuboidFaceCentersSlotId = String(slot.id);
                const centersMode = this.getCuboidFaceCentersMode(slot.params);
                cuboidFaceCentersBtn.textContent = `Face Centres: ${this.getCuboidFaceCentersModeLabel(centersMode)}`;
                card.appendChild(cuboidFaceCentersBtn);
            }

            if (slot.primitive === 'right-triangle-prism') {
                const triangleModeCycleBtn = document.createElement('button');
                triangleModeCycleBtn.type = 'button';
                triangleModeCycleBtn.className = 'card-cycle-btn';
                triangleModeCycleBtn.dataset.cycleTriangleModeSlotId = String(slot.id);
                triangleModeCycleBtn.textContent = `Cycle: ${this.getTriangularPrismModeLabel(slot.params.triangleMode)}`;
                card.appendChild(triangleModeCycleBtn);

                if (this.isPrismRectAttachmentConfigurable(slot)) {
                    const hostEntry = this.getCurrentHostEntryForSlot(slot);
                    const hostFaceNormal = this.resolveFaceNormal(hostEntry.faceDef, hostEntry.slot.params);
                    const currentFace = this.getGuestAttachFaceDef(slot, hostFaceNormal, hostEntry.faceDef.type);

                    const attachFaceCycleBtn = document.createElement('button');
                    attachFaceCycleBtn.type = 'button';
                    attachFaceCycleBtn.className = 'card-cycle-btn';
                    attachFaceCycleBtn.dataset.cyclePrismAttachFaceSlotId = String(slot.id);
                    attachFaceCycleBtn.textContent = `Flush Face: ${this.getPrismAttachFaceLabel(currentFace?.id)}`;
                    card.appendChild(attachFaceCycleBtn);

                    const attachRotationCycleBtn = document.createElement('button');
                    attachRotationCycleBtn.type = 'button';
                    attachRotationCycleBtn.className = 'card-cycle-btn';
                    attachRotationCycleBtn.dataset.cyclePrismAttachRotationSlotId = String(slot.id);
                    attachRotationCycleBtn.textContent = `Rotate: ${this.getPrismAttachRotationLabel(slot.attachRotationQuarterTurns)}`;
                    card.appendChild(attachRotationCycleBtn);
                }
            }

            if (slot.primitive === 'cylinder') {
                const cylinderEndCentersBtn = document.createElement('button');
                cylinderEndCentersBtn.type = 'button';
                cylinderEndCentersBtn.className = 'card-cycle-btn';
                cylinderEndCentersBtn.dataset.toggleCylinderEndCentersSlotId = String(slot.id);
                cylinderEndCentersBtn.textContent = `Centres A/B: ${this.getCylinderEndCentersLabel(slot.params)}`;
                card.appendChild(cylinderEndCentersBtn);

                const cylinderCenterBtn = document.createElement('button');
                cylinderCenterBtn.type = 'button';
                cylinderCenterBtn.className = 'card-cycle-btn';
                cylinderCenterBtn.dataset.toggleCylinderCenterSlotId = String(slot.id);
                cylinderCenterBtn.textContent = `Centre O: ${this.getCylinderCenterLabel(slot.params)}`;
                card.appendChild(cylinderCenterBtn);
            }

            if (slot.primitive === 'tetrahedron') {
                const tetrahedronModeCycleBtn = document.createElement('button');
                tetrahedronModeCycleBtn.type = 'button';
                tetrahedronModeCycleBtn.className = 'card-cycle-btn';
                tetrahedronModeCycleBtn.dataset.cycleTetrahedronModeSlotId = String(slot.id);
                tetrahedronModeCycleBtn.textContent = this.isTetraBaseModeLocked(slot)
                    ? `Cycle Base (linked): ${this.getTetrahedronTriangleModeLabel(slot.params.baseTriangleMode)}`
                    : `Cycle Base: ${this.getTetrahedronTriangleModeLabel(slot.params.baseTriangleMode)}`;
                tetrahedronModeCycleBtn.setAttribute(
                    'aria-label',
                    `Base triangle type: ${this.getTetrahedronTriangleModeLabel(slot.params.baseTriangleMode)}. Activate to choose the next type.`
                );
                if (this.isTetraBaseModeLocked(slot)) {
                    const linkedController = this.getLinkedTetraBaseController(slot);
                    tetrahedronModeCycleBtn.title = linkedController?.primitive === 'tetrahedron'
                        ? 'Linked to attached tetrahedron (click to cycle host tetra type)'
                        : 'Linked to attached prism (click to cycle prism type)';
                }
                card.appendChild(tetrahedronModeCycleBtn);

                const tetrahedronApexCycleBtn = document.createElement('button');
                tetrahedronApexCycleBtn.type = 'button';
                tetrahedronApexCycleBtn.className = 'card-cycle-btn';
                tetrahedronApexCycleBtn.dataset.cycleTetrahedronApexSlotId = String(slot.id);
                tetrahedronApexCycleBtn.textContent = `Cycle Apex: ${this.getTetrahedronApexLabel(slot.params.apexPosition)}`;
                tetrahedronApexCycleBtn.setAttribute(
                    'aria-label',
                    `Apex position: ${this.getTetrahedronApexLabel(slot.params.apexPosition)}. Activate to choose the next position.`
                );
                card.appendChild(tetrahedronApexCycleBtn);
            }

            if (slot.primitive === 'rectangular-pyramid') {
                const apexCycleBtn = document.createElement('button');
                apexCycleBtn.type = 'button';
                apexCycleBtn.className = 'card-cycle-btn';
                apexCycleBtn.dataset.cycleApexSlotId = String(slot.id);
                apexCycleBtn.textContent = `Cycle Apex: ${this.getRectangularPyramidApexLabel(slot.params.apexPosition)}`;
                card.appendChild(apexCycleBtn);

                const baseCenterBtn = document.createElement('button');
                baseCenterBtn.type = 'button';
                baseCenterBtn.className = 'card-cycle-btn';
                baseCenterBtn.dataset.toggleRectangularPyramidBaseCenterSlotId = String(slot.id);
                baseCenterBtn.textContent = `Base Centre O: ${this.getRectangularPyramidBaseCenterLabel(slot.params)}`;
                card.appendChild(baseCenterBtn);
            }

            const polygonalConfig = getPolygonalPrimitiveConfig(slot.primitive);
            if (polygonalConfig?.kind === 'prism') {
                const baseCentersBtn = document.createElement('button');
                baseCentersBtn.type = 'button';
                baseCentersBtn.className = 'card-cycle-btn';
                baseCentersBtn.dataset.togglePolygonalPrismBaseCentersSlotId = String(slot.id);
                baseCentersBtn.textContent = `Base Centres O1/O2: ${this.getPolygonalPrismBaseCentersLabel(slot.params)}`;
                card.appendChild(baseCentersBtn);
            }

            if (polygonalConfig) {
                const apothemBtn = document.createElement('button');
                apothemBtn.type = 'button';
                apothemBtn.className = 'card-cycle-btn';
                apothemBtn.dataset.togglePolygonalApothemSlotId = String(slot.id);
                apothemBtn.textContent = `Apothem: ${this.getPolygonalApothemLabel(slot.params)}`;
                card.appendChild(apothemBtn);
            }

            // Cycle face button (slot 1+)
            if (idx > 0) {
                const prevSlots = this.compositeSlots.slice(0, idx);
                const entries = this.getValidHostFaceEntries(slot, prevSlots, { excludeOccupied: true, excludeSlotId: slot.id });
                if (entries.length > 0) {
                    const currentEntry = entries.find((entry) => entry.slotId === slot.hostSlotId && entry.faceId === slot.hostFaceId) || entries[0];
                    const currentLabel = currentEntry?.label || 'Face';

                    if (entries.length > 1) {
                        const cycleBtn = document.createElement('button');
                        cycleBtn.type = 'button';
                        cycleBtn.className = 'card-cycle-btn';
                        cycleBtn.dataset.cycleSlotId = String(slot.id);
                        cycleBtn.textContent = `Cycle: ${currentLabel}`;
                        card.appendChild(cycleBtn);
                    } else {
                        const faceInfo = document.createElement('div');
                        faceInfo.className = 'card-face-info';
                        faceInfo.textContent = currentLabel;
                        card.appendChild(faceInfo);
                    }
                }
            }

            this.primitiveCardsListEl.appendChild(card);
        });
    }

    updateSliderFill(input) {
        const min = Number(input.min);
        const max = Number(input.max);
        const value = Number(input.value);
        const ratio = max === min ? 0 : (value - min) / (max - min);

        input.style.setProperty('--slider-fill', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
    }

    refreshSliderBadges() {
        this.primitiveCardsListEl.querySelectorAll('.slider-input').forEach((input) => {
            this.updateSliderFill(input);
        });
    }

    buildPrimitive(options = {}) {
        this.buildComposite(options);
    }

    getCurvedSlotDescriptor(slot, worldLocalPoints) {
        if (!['sphere', 'hemisphere', 'cylinder', 'cone'].includes(slot?.primitive)) return null;
        const points = new Map((worldLocalPoints || []).map((point) => [point.id, point.position]));
        const freezeVector = (vector) => Object.freeze({ x: vector.x, y: vector.y, z: vector.z });
        const makeDescriptor = (center, axis, radius, height = undefined) => {
            if (!center || !axis || !Number.isFinite(radius) || radius <= 0 || axis.lengthSq() <= 1e-16) return null;
            const normalizedAxis = axis.clone().normalize();
            const descriptor = {
                primitiveKey: slot.primitive,
                center: freezeVector(center),
                axis: freezeVector(normalizedAxis),
                radius
            };
            if (height !== undefined) {
                if (!Number.isFinite(height) || height <= 0) return null;
                descriptor.height = height;
            }
            return Object.freeze(descriptor);
        };

        if (slot.primitive === 'sphere') {
            const center = points.get('O');
            const top = points.get('A');
            return center && top
                ? makeDescriptor(center.clone(), top.clone().sub(center), center.distanceTo(top))
                : null;
        }
        if (slot.primitive === 'hemisphere') {
            const center = points.get('F');
            const domeTop = points.get('A');
            return center && domeTop
                ? makeDescriptor(center.clone(), domeTop.clone().sub(center), center.distanceTo(domeTop))
                : null;
        }
        if (slot.primitive === 'cone') {
            const apex = points.get('A');
            const baseCenter = points.get('B');
            const rimPoint = points.get('C');
            return apex && baseCenter && rimPoint
                ? makeDescriptor(
                    baseCenter.clone(),
                    apex.clone().sub(baseCenter),
                    baseCenter.distanceTo(rimPoint),
                    baseCenter.distanceTo(apex)
                )
                : null;
        }

        const plusFirst = points.get('C');
        const plusSecond = points.get('D');
        const minusFirst = points.get('E');
        const minusSecond = points.get('F');
        if (!plusFirst || !plusSecond || !minusFirst || !minusSecond) return null;
        const plusCenter = plusFirst.clone().add(plusSecond).multiplyScalar(0.5);
        const minusCenter = minusFirst.clone().add(minusSecond).multiplyScalar(0.5);
        return makeDescriptor(
            plusCenter.clone().add(minusCenter).multiplyScalar(0.5),
            plusCenter.clone().sub(minusCenter),
            plusFirst.distanceTo(plusSecond) / 2,
            plusCenter.distanceTo(minusCenter)
        );
    }

    buildComposite(options = {}) {
        const fitCamera = options.fitCamera !== false;
        this.clearComposite();

        this.compositeGroup = new THREE.Group();
        this.scene.add(this.compositeGroup);
        this.primitiveGroup = this.compositeGroup; // alias used by buildPointMarkers etc.
        this.primitiveMeshes = [];
        this.slotLinkages = [];

        if (this.compositeSlots.length === 0) {
            this.pointDefinitions = [];
            this.refreshDerivedPoints();
            this.pruneHiddenPointState();
            this.rebuildConstructions();
            this.buildPointMarkers();
            this.updatePanelCopy();
            this.renderPointsList();
            this.renderSelectionSummary();
            this.renderActions();
            this.updateCanvasEmptyState();
            this.scheduleLocalStateSave();
            return;
        }

        // The first slot is the root by definition. Removing an earlier host can
        // promote a former guest into this position; clear its stale attachment
        // metadata before the snapshot is autosaved so the app always emits a
        // graph it can restore.
        this.compositeSlots[0].hostSlotId = null;
        this.compositeSlots[0].hostFaceId = null;

        let allPoints = [];
        let maxBoundsRadius = 6;

        this.compositeSlots.forEach((slot, idx) => {
            let entry = null;
            if (idx > 0) {
                const prevSlots = this.compositeSlots.slice(0, idx);
                entry = this.ensureSlotHostBinding(slot, prevSlots);
                if (entry) {
                    this.snapSlotDimensions(slot);
                }
            }

            const def = this.createSlotDefinition(slot);

            if (idx > 0) {
                if (entry) {
                    const hostSlotGroup = this.slotGroupMap.get(entry.slotId);
                    const hostGroupQ = hostSlotGroup ? hostSlotGroup.quaternion : new THREE.Quaternion();
                    const hostGroupP = hostSlotGroup ? hostSlotGroup.position : new THREE.Vector3();

                    // Apply orientation rotation to face definition (which is in standard space)
                    const hostOrientQ = this.getOrientationQuaternion(entry.slot.primitive, entry.slot.orientation);

                    const hostFaceCenter = entry.faceDef.center(entry.slot.params)
                        .clone()
                        .applyQuaternion(hostOrientQ)
                        .applyQuaternion(hostGroupQ)
                        .add(hostGroupP);
                    const hostCenterToFace = hostFaceCenter.clone().sub(hostGroupP);
                    const hostFaceNormal = this.resolveFaceNormal(entry.faceDef, entry.slot.params)
                        .clone()
                        .applyQuaternion(hostOrientQ)
                        .applyQuaternion(hostGroupQ);
                    const hostFaceU = this.resolveFaceUAxis(entry.faceDef, entry.slot.params)
                        .clone()
                        .applyQuaternion(hostOrientQ)
                        .applyQuaternion(hostGroupQ)
                        .normalize();

                    // Guard against inverted face metadata by forcing normals to point away from the host center.
                    if (hostCenterToFace.lengthSq() > 1e-8 && hostFaceNormal.dot(hostCenterToFace) < 0) {
                        hostFaceNormal.multiplyScalar(-1);
                        hostFaceU.multiplyScalar(-1);
                    }

                    const guestFaceDef = this.applySlotTransform(def.group, slot, hostFaceCenter, hostFaceNormal, hostFaceU, {
                        hostSlot: entry.slot,
                        hostFaceDef: entry.faceDef,
                        hostGroupQuaternion: hostGroupQ.clone(),
                        hostGroupPosition: hostGroupP.clone()
                    });

                    if (guestFaceDef) {
                        this.slotAttachmentFaceMap.set(slot.id, {
                            hostSlotId: entry.slotId,
                            hostFaceId: entry.faceDef.id,
                            guestFaceId: guestFaceDef.id
                        });
                        this.addLinkages(
                            { slotId: entry.slotId, dims: this.resolveFaceDims(entry.faceDef, entry.slot.params) },
                            { slotId: slot.id, dims: this.getAttachmentDimsForHost(slot, guestFaceDef, entry.faceDef) }
                        );
                    }
                }
            }

            this.slotGroupMap.set(slot.id, def.group);
            this.compositeGroup.add(def.group);
            this.primitiveMeshes.push(def.mesh);

            const qRot = def.group.quaternion;
            const vPos = def.group.position;
            const worldLocalPoints = def.points.map((pt) => ({
                ...pt,
                position: pt.position.clone().applyQuaternion(qRot).add(vPos),
            }));
            const curvedDescriptor = this.getCurvedSlotDescriptor(slot, worldLocalPoints);
            if (curvedDescriptor) {
                this.slotCurvedDescriptorMap.set(slot.id, curvedDescriptor);
            }
            try {
                const topology = buildPolyhedralTopology({
                    primitiveKey: slot.primitive,
                    points: worldLocalPoints.map((point) => ({
                        id: point.id,
                        position: {
                            x: point.position.x,
                            y: point.position.y,
                            z: point.position.z
                        }
                    }))
                });
                this.slotTopologyMap.set(slot.id, topology);
            } catch (error) {
                if (!(error instanceof PolyhedralTopologyError) || error.code !== 'UNSUPPORTED_PRIMITIVE') {
                    throw error;
                }
                this.slotTopologyErrors.set(slot.id, {
                    code: error.code,
                    message: error.message,
                    primitiveKey: slot.primitive
                });
            }
            const worldPoints = worldLocalPoints.map((pt) => ({
                ...pt,
                id: `s${slot.id}_${pt.id}`,
                label: pt.label
            }));
            allPoints = allPoints.concat(worldPoints);
            maxBoundsRadius = Math.max(maxBoundsRadius, def.boundsRadius + def.group.position.length());
        });

        this.pointDefinitions = this.mergeCoincidentBasePoints(allPoints);
        this.refreshDerivedPoints();
        this.pruneHiddenPointState();
        this.rebuildConstructions();
        this.buildPointMarkers();
        this.updatePanelCopy();
        this.renderPointsList();
        this.renderSelectionSummary();
        this.renderActions();
        if (fitCamera) {
            this.fitCameraToObject(this.compositeGroup);
        }
        this.updateCanvasEmptyState();
        this.scheduleLocalStateSave();
    }

    getCompositeInternalFaceIds() {
        const internalFaceIdsBySlot = new Map();
        const addInternalFace = (slotId, faceId) => {
            if (slotId == null || typeof faceId !== 'string' || faceId.length === 0) return;
            if (!internalFaceIdsBySlot.has(slotId)) {
                internalFaceIdsBySlot.set(slotId, new Set());
            }
            internalFaceIdsBySlot.get(slotId).add(faceId);
        };

        this.slotAttachmentFaceMap.forEach((attachment, guestSlotId) => {
            addInternalFace(attachment.hostSlotId, attachment.hostFaceId);
            addInternalFace(guestSlotId, attachment.guestFaceId);
        });
        return internalFaceIdsBySlot;
    }

    validateResolvedCompositeAttachmentFaces() {
        const occupiedFaceKeys = new Set();
        for (let index = 1; index < this.compositeSlots.length; index += 1) {
            const slot = this.compositeSlots[index];
            if (slot.hostSlotId == null) continue;
            const attachment = this.slotAttachmentFaceMap.get(slot.id);
            if (!attachment
                    || attachment.hostSlotId !== slot.hostSlotId
                    || attachment.hostFaceId !== slot.hostFaceId
                    || (slot.attachFaceId != null && attachment.guestFaceId !== slot.attachFaceId)) {
                return false;
            }
            const faceKeys = [
                this.getHostFaceKey(attachment.hostSlotId, attachment.hostFaceId),
                this.getHostFaceKey(slot.id, attachment.guestFaceId)
            ];
            if (faceKeys.some((key) => occupiedFaceKeys.has(key))) return false;
            faceKeys.forEach((key) => occupiedFaceKeys.add(key));
        }
        return true;
    }

    buildCurrentCompositeExteriorTopology() {
        return buildCompositeExteriorTopology({
            slots: this.compositeSlots.map((slot) => ({
                slotId: String(slot.id),
                primitiveKey: slot.primitive,
                topology: this.slotTopologyMap.get(slot.id)
            })),
            attachments: [...this.slotAttachmentFaceMap.entries()].map(([guestSlotId, attachment]) => ({
                guestSlotId: String(guestSlotId),
                hostSlotId: String(attachment.hostSlotId),
                hostFaceId: attachment.hostFaceId,
                guestFaceId: attachment.guestFaceId
            }))
        });
    }

    buildFallbackCompositeProjectionTopology(internalFaceIdsBySlot) {
        const vertices = [];
        const faces = [];
        const edges = [];
        this.compositeSlots.forEach((slot) => {
            const topology = this.buildExteriorSlotTopology(
                slot.id,
                internalFaceIdsBySlot.get(slot.id) || new Set()
            );
            if (!topology) return;
            const prefix = `slot-${String(slot.id)}::`;
            const vertexId = (id) => `${prefix}${String(id)}`;
            topology.vertices.forEach((vertex) => vertices.push({
                ...vertex,
                id: vertexId(vertex.id)
            }));
            topology.faces.forEach((face) => faces.push({
                ...face,
                id: `${prefix}${String(face.id)}`,
                vertexIds: face.vertexIds.map(vertexId)
            }));
            topology.edges.forEach((edge) => edges.push({
                id: `${prefix}${String(edge.id)}`,
                vertexIds: edge.vertexIds.map(vertexId)
            }));
        });
        return {
            primitiveKey: 'composite-projection-fallback',
            vertices,
            faces,
            edges
        };
    }

    buildExteriorSlotTopology(slotId, internalFaceIds = new Set()) {
        const topology = this.slotTopologyMap.get(slotId);
        if (!topology) return null;
        if (!(internalFaceIds instanceof Set) || internalFaceIds.size === 0) {
            return topology;
        }

        const faces = topology.faces.filter((face) => !internalFaceIds.has(face.id));
        const exteriorEdgeIds = new Set();
        faces.forEach((face) => {
            face.vertexIds.forEach((firstId, index) => {
                const secondId = face.vertexIds[(index + 1) % face.vertexIds.length];
                exteriorEdgeIds.add([firstId, secondId].sort().join('-'));
            });
        });
        const edges = topology.edges
            .filter((edge) => exteriorEdgeIds.has(edge.id))
            .map((edge) => ({ id: edge.id, vertexIds: [...edge.vertexIds] }));
        return {
            primitiveKey: topology.primitiveKey,
            vertices: topology.vertices,
            faces,
            edges
        };
    }

    getCompositeOrthographicProjection(viewId, options = {}) {
        const showHiddenEdges = options.showHiddenEdges === true;
        if (this.compositeSlots.length === 0) {
            return {
                supported: false,
                reason: 'empty-diagram',
                viewId,
                slots: [],
                unsupportedSlots: [],
                bounds: getProjectedBounds([])
            };
        }

        const unsupportedSlots = this.compositeSlots
            .filter((slot) => !this.slotTopologyMap.has(slot.id) && !this.slotCurvedDescriptorMap.has(slot.id))
            .map((slot) => ({
                slotId: slot.id,
                primitiveKey: slot.primitive,
                diagnostic: this.slotTopologyErrors.get(slot.id) || null
            }));
        if (unsupportedSlots.length > 0) {
            return {
                supported: false,
                reason: 'unsupported-primitive',
                viewId,
                slots: [],
                unsupportedSlots,
                bounds: getProjectedBounds([])
            };
        }

        const internalFaceIdsBySlot = this.getCompositeInternalFaceIds();
        const slots = [];
        for (const slot of this.compositeSlots) {
            const internalFaceIds = internalFaceIdsBySlot.get(slot.id) || new Set();
            const topology = this.buildExteriorSlotTopology(slot.id, internalFaceIds);
            if (topology) {
                slots.push({
                    slotId: slot.id,
                    primitiveKey: slot.primitive,
                    geometryKind: 'polyhedral',
                    internalFaceIds: [...internalFaceIds].sort(),
                    projection: projectTopologyToView(topology, viewId, { showHiddenEdges })
                });
                continue;
            }
            const descriptor = this.slotCurvedDescriptorMap.get(slot.id);
            try {
                slots.push({
                    slotId: slot.id,
                    primitiveKey: slot.primitive,
                    geometryKind: 'curved',
                    internalFaceIds: [...internalFaceIds].sort(),
                    projection: projectCurvedPrimitiveToView(descriptor, viewId, { showHiddenEdges })
                });
            } catch (error) {
                if (!(error instanceof CurvedOrthographicError)) throw error;
                return {
                    supported: false,
                    reason: 'curved-projection-error',
                    viewId,
                    slots: [],
                    unsupportedSlots: [{
                        slotId: slot.id,
                        primitiveKey: slot.primitive,
                        diagnostic: { code: error.code, message: error.message }
                    }],
                    bounds: getProjectedBounds([])
                };
            }
        }
        let compositeProjection = null;
        let fallbackCompositeProjection = null;
        let compositeProjectionFallbackReason = null;
        if (this.compositeSlots.length > 1
                && this.compositeSlots.every((slot) => this.slotTopologyMap.has(slot.id))) {
            try {
                compositeProjection = projectTopologyToView(
                    this.buildCurrentCompositeExteriorTopology(),
                    viewId,
                    { showHiddenEdges }
                );
            } catch (error) {
                if (!(error instanceof CompositeTopologyError)) throw error;
                // Some displayable attachments intentionally cannot form an exact
                // closed composite (for example a partial/mismatched face join).
                // Preserve their useful per-slot view while exact composites use
                // the merged exterior to remove internal and coplanar join seams.
                compositeProjectionFallbackReason = error.code;
                // Even when the faces cannot form one exact closed solid, project
                // the disconnected exterior topologies together. This lets the
                // pure hidden-line pass compare edges against faces in other
                // slots instead of drawing rear edges through a nearer object.
                fallbackCompositeProjection = projectTopologyToView(
                    this.buildFallbackCompositeProjectionTopology(internalFaceIdsBySlot),
                    viewId,
                    { showHiddenEdges }
                );
            }
        }
        const bounds = compositeProjection?.bounds
            || fallbackCompositeProjection?.bounds
            || getProjectedBounds(slots.flatMap((slot) => [
            slot.projection.bounds.min,
            slot.projection.bounds.max
        ]));
        return {
            supported: true,
            reason: null,
            viewId: slots[0]?.projection?.viewId || viewId,
            slots,
            compositeProjection,
            fallbackCompositeProjection,
            compositeProjectionFallbackReason,
            unsupportedSlots: [],
            bounds
        };
    }

    getTwoDViewLabel(viewId) {
        return {
            front: 'Front View',
            top: 'Top View',
            right: 'Right Side View',
            three: '3-View Sheet',
            net: 'Net'
        }[viewId] || '2-D View';
    }

    getTwoDViewsUnsupportedMessage(projection) {
        if (projection?.reason === 'empty-diagram') {
            return 'Add a 3-D object before opening 2-D Views.';
        }
        const labels = (projection?.unsupportedSlots || []).map((slot) => (
            this.primitiveMeta[slot.primitiveKey]?.label || slot.primitiveKey
        ));
        if (labels.length > 0) {
            return `2-D Views are not available yet for ${labels.join(', ')}.`;
        }
        return 'This diagram cannot be shown as a 2-D view.';
    }

    collectOrthographicDrawingEdges(projection) {
        const edgesByLine = new Map();
        const pointKey = (point) => {
            const x = Math.abs(point.x) < 1e-9 ? 0 : point.x;
            const y = Math.abs(point.y) < 1e-9 ? 0 : point.y;
            return `${x.toFixed(7)},${y.toFixed(7)}`;
        };

        const combinedProjection = projection.compositeProjection || projection.fallbackCompositeProjection;
        const drawableSlots = combinedProjection
            ? [{
                slotId: 'composite',
                primitiveKey: 'composite',
                projection: combinedProjection
            }]
            : projection.slots;
        drawableSlots.forEach((slot) => {
            (slot.projection.edges || []).forEach((edge) => {
                const endpoints = edge.points.map(pointKey).sort();
                const key = endpoints.join('|');
                const candidate = {
                    ...edge,
                    slotId: slot.slotId,
                    primitiveKey: slot.primitiveKey
                };
                const current = edgesByLine.get(key);
                if (!current
                        || (current.visibility === 'hidden' && candidate.visibility === 'visible')
                        || (current.visibility === candidate.visibility && candidate.depth > current.depth)) {
                    edgesByLine.set(key, candidate);
                }
            });
        });
        return [...edgesByLine.values()].sort((left, right) => {
            if (left.visibility !== right.visibility) {
                return left.visibility === 'hidden' ? -1 : 1;
            }
            if (Math.abs(left.depth - right.depth) > 1e-9) return left.depth - right.depth;
            return `${left.slotId}:${left.id}`.localeCompare(`${right.slotId}:${right.id}`);
        });
    }

    buildOrthographicLineMarkup(edges, mapPoint) {
        return edges.map((edge) => {
            const start = mapPoint(edge.points[0]);
            const end = mapPoint(edge.points[1]);
            const hidden = edge.visibility === 'hidden';
            const dash = hidden ? ' stroke-dasharray="12 10"' : '';
            const stroke = hidden ? '#74879A' : '#17334F';
            const width = hidden ? 3 : 4;
            return `<line x1="${start.x.toFixed(3)}" y1="${start.y.toFixed(3)}" x2="${end.x.toFixed(3)}" y2="${end.y.toFixed(3)}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" vector-effect="non-scaling-stroke"${dash}/>`;
        }).join('');
    }

    getCurvedCompositeSuppressedCurveIds() {
        const suppressedBySlot = new Map();
        const suppress = (slotId, curveIds) => {
            if (slotId == null || !Array.isArray(curveIds) || curveIds.length === 0) return;
            if (!suppressedBySlot.has(slotId)) suppressedBySlot.set(slotId, new Set());
            curveIds.forEach((curveId) => suppressedBySlot.get(slotId).add(curveId));
        };
        const cylinderCapCurveIds = {
            top: [
                'cylinder-end-rim-plus',
                'cylinder-end-plus-edge',
                'cylinder-end-plus-silhouette',
                'cylinder-silhouette'
            ],
            bottom: [
                'cylinder-end-rim-minus',
                'cylinder-end-minus-edge',
                'cylinder-end-minus-silhouette',
                'cylinder-silhouette'
            ]
        };

        this.slotAttachmentFaceMap.forEach((attachment, guestSlotId) => {
            const hostSlot = this.compositeSlots.find((slot) => slot.id === attachment.hostSlotId);
            const guestSlot = this.compositeSlots.find((slot) => slot.id === guestSlotId);
            if (!hostSlot || !guestSlot) return;

            const joined = [
                { slot: hostSlot, faceId: attachment.hostFaceId },
                { slot: guestSlot, faceId: attachment.guestFaceId }
            ];
            const cylinder = joined.find((entry) => entry.slot.primitive === 'cylinder');
            const hemisphere = joined.find((entry) => entry.slot.primitive === 'hemisphere');
            const cone = joined.find((entry) => entry.slot.primitive === 'cone');
            if (!cylinder) return;
            const cylinderCurveIds = cylinderCapCurveIds[cylinder.faceId];
            if (!cylinderCurveIds) return;

            if (hemisphere?.faceId === 'flat') {
                // A same-radius cylinder and hemisphere meet tangentially along
                // this attachment. Their cap/rim curves are internal construction
                // seams, not exterior edges. Keep the side and dome silhouettes.
                suppress(cylinder.slot.id, cylinderCurveIds);
                suppress(hemisphere.slot.id, [
                    'hemisphere-flat-rim',
                    'hemisphere-rim-silhouette'
                ]);
                return;
            }

            if (cone?.faceId === 'base') {
                // A cylinder-to-cone join is a genuine crease, but the two solids
                // describe it redundantly. Keep the cone's visible base silhouette
                // as the single exterior crease and remove both internal cap rims.
                suppress(cylinder.slot.id, cylinderCurveIds);
                suppress(cone.slot.id, ['cone-base-rim']);
            }
        });
        return suppressedBySlot;
    }

    collectOrthographicDrawingCurves(projection) {
        const curves = [];
        const suppressedBySlot = this.getCurvedCompositeSuppressedCurveIds();
        projection.slots.forEach((slot) => {
            if (slot.geometryKind !== 'curved') return;
            const suppressedIds = suppressedBySlot.get(slot.slotId) || new Set();
            const outlineCurves = (slot.projection.outlineCurves || [])
                .filter((curve) => !suppressedIds.has(curve.id));
            const outlineIds = new Set(outlineCurves.map((curve) => curve.id).filter(Boolean));
            outlineCurves.forEach((curve) => curves.push({
                ...curve,
                slotId: slot.slotId,
                primitiveKey: slot.primitiveKey,
                visibility: 'visible',
                layer: 'outline'
            }));
            (slot.projection.featureCurves || []).forEach((curve) => {
                if (suppressedIds.has(curve.id)) return;
                if (curve.visibility !== 'hidden' && outlineIds.has(curve.id)) return;
                curves.push({
                    ...curve,
                    slotId: slot.slotId,
                    primitiveKey: slot.primitiveKey,
                    layer: 'feature'
                });
            });
        });
        return curves.sort((left, right) => {
            if (left.visibility !== right.visibility) return left.visibility === 'hidden' ? -1 : 1;
            if (left.layer !== right.layer) return left.layer === 'feature' ? -1 : 1;
            return `${left.slotId}:${left.id || left.type}`.localeCompare(`${right.slotId}:${right.id || right.type}`);
        });
    }

    buildOrthographicCurveMarkup(curves, mapPoint, scale) {
        const curvePoint = (curve, angle) => ({
            x: curve.center.x
                + curve.radiusX * Math.cos(angle) * Math.cos(curve.rotation)
                - curve.radiusY * Math.sin(angle) * Math.sin(curve.rotation),
            y: curve.center.y
                + curve.radiusX * Math.cos(angle) * Math.sin(curve.rotation)
                + curve.radiusY * Math.sin(angle) * Math.cos(curve.rotation)
        });
        return curves.map((curve) => {
            const hidden = curve.visibility === 'hidden';
            const stroke = hidden ? '#74879A' : '#17334F';
            const width = curve.layer === 'outline' ? 4 : 3;
            const dash = hidden ? ' stroke-dasharray="12 10"' : '';
            const common = `data-curve-id="${this.escapeXmlText(curve.id || curve.type)}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" vector-effect="non-scaling-stroke"${dash}`;
            if (curve.type === 'line') {
                const start = mapPoint(curve.start);
                const end = mapPoint(curve.end);
                return `<line x1="${start.x.toFixed(3)}" y1="${start.y.toFixed(3)}" x2="${end.x.toFixed(3)}" y2="${end.y.toFixed(3)}" ${common}/>`;
            }
            if (curve.type === 'circle') {
                const center = mapPoint(curve.center);
                return `<circle cx="${center.x.toFixed(3)}" cy="${center.y.toFixed(3)}" r="${(curve.radius * scale).toFixed(3)}" ${common}/>`;
            }
            if (curve.type === 'ellipse') {
                const center = mapPoint(curve.center);
                const rotation = -curve.rotation * 180 / Math.PI;
                return `<ellipse cx="${center.x.toFixed(3)}" cy="${center.y.toFixed(3)}" rx="${(curve.radiusX * scale).toFixed(3)}" ry="${(curve.radiusY * scale).toFixed(3)}" transform="rotate(${rotation.toFixed(6)} ${center.x.toFixed(3)} ${center.y.toFixed(3)})" ${common}/>`;
            }
            if (curve.type === 'ellipseArc') {
                const start = mapPoint(curvePoint(curve, curve.startAngle));
                const end = mapPoint(curvePoint(curve, curve.endAngle));
                const span = curve.endAngle - curve.startAngle;
                const largeArcFlag = Math.abs(span) > Math.PI ? 1 : 0;
                const sweepFlag = span >= 0 ? 0 : 1;
                const rotation = -curve.rotation * 180 / Math.PI;
                const path = `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${(curve.radiusX * scale).toFixed(3)} ${(curve.radiusY * scale).toFixed(3)} ${rotation.toFixed(6)} ${largeArcFlag} ${sweepFlag} ${end.x.toFixed(3)} ${end.y.toFixed(3)}`;
                return `<path d="${path}" ${common}/>`;
            }
            return '';
        }).join('');
    }

    buildOrthographicViewDrawing(viewId, options = {}) {
        const width = Number.isFinite(options.width) ? options.width : 1000;
        const height = Number.isFinite(options.height) ? options.height : 760;
        const showHiddenEdges = options.showHiddenEdges === true;
        const projection = this.getCompositeOrthographicProjection(viewId, { showHiddenEdges });
        if (!projection.supported) {
            return {
                supported: false,
                projection,
                width,
                height,
                label: this.getTwoDViewLabel(viewId),
                message: this.getTwoDViewsUnsupportedMessage(projection)
            };
        }

        const label = this.getTwoDViewLabel(viewId);
        const fit = fitProjectedBounds(projection.bounds, { width, height, padding: 72 });
        const edges = this.collectOrthographicDrawingEdges(projection);
        const lines = this.buildOrthographicLineMarkup(
            edges,
            (point) => mapProjectedPointToViewport(point, fit)
        );
        const curves = this.collectOrthographicDrawingCurves(projection);
        const curveMarkup = this.buildOrthographicCurveMarkup(
            curves,
            (point) => mapProjectedPointToViewport(point, fit),
            fit.scale
        );
        const safeLabel = this.escapeXmlText(label);
        const content = [
            `<title>${safeLabel} of the current 3DGeoGon diagram</title>`,
            `<desc>True orthographic ${safeLabel.toLowerCase()} with visible edges${showHiddenEdges ? ' and dashed hidden edges' : ''}.</desc>`,
            `<rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
            `<g aria-label="${safeLabel} edges">${lines}</g>`,
            `<g aria-label="${safeLabel} curved outlines">${curveMarkup}</g>`
        ].join('');
        return { supported: true, projection, width, height, label, edges, curves, content };
    }

    buildOrthographicViewSheetDrawing(options = {}) {
        const width = Number.isFinite(options.width) ? options.width : 1260;
        const height = Number.isFinite(options.height) ? options.height : 500;
        const showHiddenEdges = options.showHiddenEdges === true;
        const viewIds = ['front', 'top', 'right'];
        const projections = viewIds.map((viewId) => this.getCompositeOrthographicProjection(viewId, { showHiddenEdges }));
        const unsupported = projections.find((projection) => !projection.supported);
        if (unsupported) {
            return {
                supported: false,
                projection: unsupported,
                width,
                height,
                label: this.getTwoDViewLabel('three'),
                message: this.getTwoDViewsUnsupportedMessage(unsupported)
            };
        }

        const outerPadding = 24;
        const gap = 18;
        const headingHeight = 44;
        const panelWidth = (width - outerPadding * 2 - gap * 2) / 3;
        const panelHeight = height - outerPadding * 2;
        const diagramTop = headingHeight;
        const diagramHeight = panelHeight - diagramTop;
        const diagramPadding = 30;
        let sharedScale = Number.POSITIVE_INFINITY;
        projections.forEach((projection) => {
            if (projection.bounds.width > 0) {
                sharedScale = Math.min(sharedScale, (panelWidth - diagramPadding * 2) / projection.bounds.width);
            }
            if (projection.bounds.height > 0) {
                sharedScale = Math.min(sharedScale, (diagramHeight - diagramPadding * 2) / projection.bounds.height);
            }
        });
        if (!Number.isFinite(sharedScale) || sharedScale <= 0) sharedScale = 1;

        const panelMarkup = projections.map((projection, index) => {
            const viewId = viewIds[index];
            const label = this.getTwoDViewLabel(viewId);
            const safeLabel = this.escapeXmlText(label);
            const panelX = outerPadding + index * (panelWidth + gap);
            const panelY = outerPadding;
            const centreX = panelX + panelWidth / 2;
            const centreY = panelY + diagramTop + diagramHeight / 2;
            const mapPoint = (point) => ({
                x: centreX + (point.x - projection.bounds.centerX) * sharedScale,
                y: centreY - (point.y - projection.bounds.centerY) * sharedScale
            });
            const edges = this.collectOrthographicDrawingEdges(projection);
            const curves = this.collectOrthographicDrawingCurves(projection);
            return [
                `<g aria-label="${safeLabel}">`,
                `<rect x="${panelX.toFixed(3)}" y="${panelY}" width="${panelWidth.toFixed(3)}" height="${panelHeight}" rx="10" fill="#FFFFFF" stroke="#B9C6D2" stroke-width="2"/>`,
                `<text x="${centreX.toFixed(3)}" y="${panelY + 31}" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#17334F">${safeLabel}</text>`,
                this.buildOrthographicLineMarkup(edges, mapPoint),
                this.buildOrthographicCurveMarkup(curves, mapPoint, sharedScale),
                '</g>'
            ].join('');
        }).join('');
        const label = this.getTwoDViewLabel('three');
        const content = [
            `<title>${this.escapeXmlText(label)} of the current 3DGeoGon diagram</title>`,
            `<desc>Front, Top, and Right Side orthographic views shown at one common scale.</desc>`,
            `<rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
            panelMarkup
        ].join('');
        return { supported: true, projections, width, height, label, sharedScale, content };
    }

    buildOrthographicViewSvgMarkup(viewId, options = {}) {
        const drawing = viewId === 'three'
            ? this.buildOrthographicViewSheetDrawing(options)
            : this.buildOrthographicViewDrawing(viewId, options);
        if (!drawing.supported) return null;
        const safeLabel = this.escapeXmlText(drawing.label);
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${drawing.width}" height="${drawing.height}" viewBox="0 0 ${drawing.width} ${drawing.height}" role="img" aria-label="${safeLabel}">${drawing.content}</svg>`;
    }

    getNetLayout() {
        if (this.compositeSlots.length === 0) {
            return { supported: false, reason: 'empty-diagram', layout: null, slot: null };
        }
        if (this.compositeSlots.length > 1) {
            const unsupportedSlots = this.compositeSlots.filter((slot) => !this.slotTopologyMap.has(slot.id));
            if (unsupportedSlots.length > 0) {
                return {
                    supported: false,
                    reason: 'unsupported-composite-primitive',
                    unsupportedSlots,
                    layout: null,
                    slot: null
                };
            }
            try {
                const topology = this.buildCurrentCompositeExteriorTopology();
                return {
                    supported: true,
                    reason: null,
                    kind: 'polyhedral',
                    composite: true,
                    slot: null,
                    topology,
                    layout: buildPolyhedralNet(topology)
                };
            } catch (error) {
                return {
                    supported: false,
                    reason: error instanceof CompositeTopologyError ? error.code : 'net-layout-error',
                    error,
                    layout: null,
                    slot: null
                };
            }
        }

        const slot = this.compositeSlots[0];
        const topology = this.slotTopologyMap.get(slot.id);
        try {
            if (topology) {
                return {
                    supported: true,
                    reason: null,
                    kind: 'polyhedral',
                    slot,
                    topology,
                    layout: buildPolyhedralNet(topology)
                };
            }
            if (slot.primitive === 'cylinder' || slot.primitive === 'cone') {
                return {
                    supported: true,
                    reason: null,
                    kind: 'curved',
                    slot,
                    topology: null,
                    layout: buildCurvedPrimitiveNet({ primitiveKey: slot.primitive, params: slot.params })
                };
            }
        } catch (error) {
            return {
                supported: false,
                reason: error instanceof CurvedNetLayoutError ? error.code : 'net-layout-error',
                error,
                layout: null,
                slot
            };
        }
        return { supported: false, reason: 'unsupported-exact-net', layout: null, slot };
    }

    getNetUnsupportedMessage(result) {
        if (result?.reason === 'empty-diagram') {
            return 'Add a 3-D object before opening its net.';
        }
        if (result?.reason === 'unsupported-composite-primitive') {
            return 'Composite nets currently require objects with complete matching flat faces.';
        }
        if (result?.error?.diagnostic) {
            return result.error.diagnostic;
        }
        const primitiveLabel = result?.slot
            ? (this.primitiveMeta[result.slot.primitive]?.label || result.slot.primitive)
            : 'this object';
        if (result?.reason === 'UNSUPPORTED_EXACT_NET' || result?.reason === 'unsupported-exact-net') {
            return `${primitiveLabel} has no exact flat net because its curved surface cannot be flattened without distortion.`;
        }
        if (result?.error instanceof CompositeTopologyError) {
            return 'This composite cannot make one exact net: its joined faces must match completely and its objects must not overlap.';
        }
        return `A valid non-overlapping net could not be made for ${primitiveLabel}.`;
    }

    buildPolyhedralNetDrawing(netResult, { width, height } = {}) {
        const layout = netResult.layout;
        const drawingWidth = Number.isFinite(width) ? width : 1000;
        const drawingHeight = Number.isFinite(height) ? height : 760;
        const fit = fitProjectedBounds(layout.bounds, { width: drawingWidth, height: drawingHeight, padding: 78 });
        const mapPoint = (point) => mapProjectedPointToViewport(point, fit);
        const faceColours = ['#EAF4FB', '#FDF1D6', '#E9F6EA', '#F4EAFB', '#FCE9E7'];
        const faces = layout.faces.map((face, index) => {
            const mapped = face.points.map(mapPoint);
            const points = mapped.map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' ');
            const centre = mapped.reduce((sum, point) => ({
                x: sum.x + point.x / mapped.length,
                y: sum.y + point.y / mapped.length
            }), { x: 0, y: 0 });
            const safeLabel = this.escapeXmlText(face.label || face.id);
            return [
                `<polygon points="${points}" fill="${faceColours[index % faceColours.length]}" stroke="none"/>`,
                `<text x="${centre.x.toFixed(3)}" y="${centre.y.toFixed(3)}" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#29445D">${safeLabel}</text>`
            ].join('');
        }).join('');
        const cuts = layout.cutEdges.flatMap((edge) => edge.segments).map((segment) => {
            const [start, end] = segment.points.map(mapPoint);
            return `<line x1="${start.x.toFixed(3)}" y1="${start.y.toFixed(3)}" x2="${end.x.toFixed(3)}" y2="${end.y.toFixed(3)}" stroke="#17334F" stroke-width="4" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
        }).join('');
        const folds = layout.foldEdges.map((edge) => {
            const [start, end] = edge.points.map(mapPoint);
            return `<line x1="${start.x.toFixed(3)}" y1="${start.y.toFixed(3)}" x2="${end.x.toFixed(3)}" y2="${end.y.toFixed(3)}" stroke="#3F78A8" stroke-width="3" stroke-dasharray="10 8" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
        }).join('');
        const primitiveLabel = netResult.composite
            ? 'Composite Shape'
            : (this.primitiveMeta[netResult.slot.primitive]?.label || netResult.slot.primitive);
        const label = `${primitiveLabel} Net`;
        const content = [
            `<title>${this.escapeXmlText(label)}</title>`,
            `<desc>An exact unfolded net. Solid lines are cuts and dashed blue lines are folds.</desc>`,
            `<rect width="${drawingWidth}" height="${drawingHeight}" fill="#FFFFFF"/>`,
            `<g aria-label="Net faces">${faces}</g>`,
            `<g aria-label="Cut edges">${cuts}</g>`,
            `<g aria-label="Fold lines">${folds}</g>`
        ].join('');
        return {
            supported: true,
            kind: 'polyhedral',
            layout,
            width: drawingWidth,
            height: drawingHeight,
            label,
            content,
            status: `${layout.faces.length} faces, ${layout.foldEdges.length} fold lines, ${layout.cutEdges.length} cut edges`
        };
    }

    buildCurvedNetDrawing(netResult, { width, height } = {}) {
        const layout = netResult.layout;
        const drawingWidth = Number.isFinite(width) ? width : 1000;
        const drawingHeight = Number.isFinite(height) ? height : 760;
        const fit = fitProjectedBounds(layout.bounds, { width: drawingWidth, height: drawingHeight, padding: 88 });
        const mapPoint = (point) => mapProjectedPointToViewport(point, fit);
        const formatPoint = (point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
        const lineMarkup = (start, end, attributes) => {
            const mappedStart = mapPoint(start);
            const mappedEnd = mapPoint(end);
            return `<line x1="${mappedStart.x.toFixed(3)}" y1="${mappedStart.y.toFixed(3)}" x2="${mappedEnd.x.toFixed(3)}" y2="${mappedEnd.y.toFixed(3)}" ${attributes}/>`;
        };
        const sectorGeometry = (component) => {
            const centre = mapPoint(component.center);
            const start = {
                x: component.center.x + component.radius * Math.cos(component.startAngle),
                y: component.center.y + component.radius * Math.sin(component.startAngle)
            };
            const end = {
                x: component.center.x + component.radius * Math.cos(component.endAngle),
                y: component.center.y + component.radius * Math.sin(component.endAngle)
            };
            const mappedStart = mapPoint(start);
            const mappedEnd = mapPoint(end);
            const radius = component.radius * fit.scale;
            const largeArcFlag = component.centralAngleRadians > Math.PI ? 1 : 0;
            // mapProjectedPointToViewport flips Y, so an increasing model-space
            // angle follows SVG's counter-clockwise (sweep=0) arc direction.
            const arc = `M ${mappedStart.x.toFixed(3)} ${mappedStart.y.toFixed(3)} A ${radius.toFixed(3)} ${radius.toFixed(3)} 0 ${largeArcFlag} 0 ${mappedEnd.x.toFixed(3)} ${mappedEnd.y.toFixed(3)}`;
            return {
                centre,
                start,
                end,
                mappedStart,
                mappedEnd,
                radius,
                arc,
                closedPath: `M ${centre.x.toFixed(3)} ${centre.y.toFixed(3)} L ${mappedStart.x.toFixed(3)} ${mappedStart.y.toFixed(3)} A ${radius.toFixed(3)} ${radius.toFixed(3)} 0 ${largeArcFlag} 0 ${mappedEnd.x.toFixed(3)} ${mappedEnd.y.toFixed(3)} Z`
            };
        };
        const faceColours = ['#EAF4FB', '#FDF1D6', '#E9F6EA'];
        const componentById = new Map(layout.components.map((component) => [component.id, component]));
        const components = layout.components.map((component, index) => {
            let shape = '';
            if (component.type === 'rectangle') {
                const points = component.points.map(mapPoint)
                    .map(formatPoint)
                    .join(' ');
                shape = `<polygon data-net-component="${this.escapeXmlText(component.id)}" points="${points}" fill="${faceColours[index % faceColours.length]}" stroke="#8B9CAB" stroke-width="3" vector-effect="non-scaling-stroke"/>`;
            } else if (component.type === 'circle') {
                const centre = mapPoint(component.center);
                shape = `<circle data-net-component="${this.escapeXmlText(component.id)}" cx="${centre.x.toFixed(3)}" cy="${centre.y.toFixed(3)}" r="${(component.radius * fit.scale).toFixed(3)}" fill="${faceColours[index % faceColours.length]}" stroke="#8B9CAB" stroke-width="3" vector-effect="non-scaling-stroke"/>`;
            } else if (component.type === 'sector') {
                const geometry = sectorGeometry(component);
                shape = `<path data-net-component="${this.escapeXmlText(component.id)}" d="${geometry.closedPath}" fill="${faceColours[index % faceColours.length]}" stroke="#8B9CAB" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
            }
            const labelPoint = mapPoint({ x: component.bounds.centerX, y: component.bounds.centerY });
            const componentLabel = this.escapeXmlText((component.role || component.id).replace(/-/g, ' '));
            return [
                `<g aria-label="${componentLabel}">${shape}</g>`,
                `<text x="${labelPoint.x.toFixed(3)}" y="${labelPoint.y.toFixed(3)}" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#29445D">${componentLabel}</text>`
            ].join('');
        }).join('');
        const boundaryGeometry = (boundary) => {
            const component = componentById.get(boundary.componentId);
            if (!component) return null;
            if (boundary.type === 'circle-circumference' && component.type === 'circle') {
                const centre = mapPoint(component.center);
                return {
                    shape: (attributes) => `<circle cx="${centre.x.toFixed(3)}" cy="${centre.y.toFixed(3)}" r="${(component.radius * fit.scale).toFixed(3)}" fill="none" ${attributes}/>` ,
                    labelPoint: { x: centre.x, y: centre.y - component.radius * fit.scale - 13 }
                };
            }
            if (boundary.type === 'rectangle-edge' && component.type === 'rectangle') {
                const edgePoints = {
                    'bottom-long-edge': [component.points[0], component.points[1]],
                    'right-short-edge': [component.points[1], component.points[2]],
                    'top-long-edge': [component.points[3], component.points[2]],
                    'left-short-edge': [component.points[0], component.points[3]]
                }[boundary.edge];
                if (!edgePoints) return null;
                const mapped = edgePoints.map(mapPoint);
                return {
                    shape: (attributes) => lineMarkup(edgePoints[0], edgePoints[1], attributes),
                    labelPoint: {
                        x: (mapped[0].x + mapped[1].x) / 2,
                        y: (mapped[0].y + mapped[1].y) / 2 - 11
                    }
                };
            }
            if (boundary.type === 'sector-arc' && component.type === 'sector') {
                const geometry = sectorGeometry(component);
                const middleAngle = (component.startAngle + component.endAngle) / 2;
                const labelPoint = mapPoint({
                    x: component.center.x + component.radius * Math.cos(middleAngle),
                    y: component.center.y + component.radius * Math.sin(middleAngle)
                });
                return {
                    shape: (attributes) => `<path d="${geometry.arc}" fill="none" ${attributes}/>` ,
                    labelPoint: { x: labelPoint.x, y: labelPoint.y - 11 }
                };
            }
            if (boundary.type === 'sector-radial-edge' && component.type === 'sector') {
                const angle = Number.isFinite(boundary.angle)
                    ? boundary.angle
                    : (boundary.edge === 'start-radial-edge' ? component.startAngle : component.endAngle);
                const end = {
                    x: component.center.x + component.radius * Math.cos(angle),
                    y: component.center.y + component.radius * Math.sin(angle)
                };
                const mapped = [component.center, end].map(mapPoint);
                return {
                    shape: (attributes) => lineMarkup(component.center, end, attributes),
                    labelPoint: {
                        x: (mapped[0].x + mapped[1].x) / 2,
                        y: (mapped[0].y + mapped[1].y) / 2 - 11
                    }
                };
            }
            return null;
        };
        const assemblyColours = ['#1B7F5A', '#7B4AB5', '#A55613'];
        const assemblyBoundaries = layout.joins.map((join, index) => {
            const colour = assemblyColours[index % assemblyColours.length];
            const matchLabel = `Match ${String.fromCharCode(65 + index)}`;
            const safeJoinId = this.escapeXmlText(join.id);
            const safeMatchLabel = this.escapeXmlText(matchLabel);
            return [join.from, join.to].map((boundary) => {
                const geometry = boundaryGeometry(boundary);
                if (!geometry) return '';
                return [
                    geometry.shape(`data-net-join-id="${safeJoinId}" stroke="${colour}" stroke-width="6" stroke-linecap="round" vector-effect="non-scaling-stroke"`),
                    `<text x="${geometry.labelPoint.x.toFixed(3)}" y="${geometry.labelPoint.y.toFixed(3)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="${colour}">${safeMatchLabel}</text>`
                ].join('');
            }).join('');
        }).join('');
        const cutSeams = layout.cutBoundaries.flatMap((boundary) => boundary.sides || []).map((side) => {
            const geometry = boundaryGeometry(side);
            if (!geometry) return '';
            return geometry.shape(`data-net-seam-id="${this.escapeXmlText(side.id)}" stroke="#C33A32" stroke-width="5" stroke-dasharray="11 8" stroke-linecap="round" vector-effect="non-scaling-stroke"`);
        }).join('');
        const primitiveLabel = this.primitiveMeta[netResult.slot.primitive]?.label || netResult.slot.primitive;
        const label = `${primitiveLabel} Net`;
        const content = [
            `<title>${this.escapeXmlText(label)}</title>`,
            `<desc>An exact curved-surface development. Boundaries with the same Match label assemble together; dashed red lines are the two matching seam sides.</desc>`,
            `<rect width="${drawingWidth}" height="${drawingHeight}" fill="#FFFFFF"/>`,
            `<g aria-label="Net pieces">${components}</g>`,
            `<g aria-label="Assembly boundaries">${assemblyBoundaries}</g>`,
            `<g aria-label="Cut seams">${cutSeams}</g>`
        ].join('');
        return {
            supported: true,
            kind: 'curved',
            layout,
            width: drawingWidth,
            height: drawingHeight,
            label,
            content,
            status: `${layout.components.length} exact pieces; matching labels assemble the solid and dashed red sides close the seam`
        };
    }

    buildNetViewDrawing(options = {}) {
        const netResult = this.getNetLayout();
        if (!netResult.supported) {
            return {
                supported: false,
                netResult,
                width: Number.isFinite(options.width) ? options.width : 1000,
                height: Number.isFinite(options.height) ? options.height : 760,
                label: 'Net',
                message: this.getNetUnsupportedMessage(netResult)
            };
        }
        return netResult.kind === 'curved'
            ? this.buildCurvedNetDrawing(netResult, options)
            : this.buildPolyhedralNetDrawing(netResult, options);
    }

    buildNetViewSvgMarkup(options = {}) {
        const drawing = this.buildNetViewDrawing(options);
        if (!drawing.supported) return null;
        const safeLabel = this.escapeXmlText(drawing.label);
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${drawing.width}" height="${drawing.height}" viewBox="0 0 ${drawing.width} ${drawing.height}" role="img" aria-label="${safeLabel}">${drawing.content}</svg>`;
    }

    isTwoDViewsOpen() {
        return this.twoDViewsOverlay?.classList.contains('show') === true;
    }

    clearOrbitControlsMotion() {
        if (!this.controls || !this.camera) return;
        const position = this.camera.position.clone();
        const target = this.controls.target.clone();
        const dampingEnabled = this.controls.enableDamping;
        const autoRotateEnabled = this.controls.autoRotate;

        // OrbitControls exposes no public "clear inertia" API. One update with
        // damping disabled consumes its pending spherical/pan/zoom deltas; a
        // second update after restoring the captured state synchronizes its
        // internal spherical coordinates without retaining that motion.
        this.controls.autoRotate = false;
        this.controls.enableDamping = false;
        this.controls.update();
        this.camera.position.copy(position);
        this.controls.target.copy(target);
        this.controls.update();
        this.controls.enableDamping = dampingEnabled;
        this.controls.autoRotate = autoRotateEnabled;
        this.camera.position.copy(position);
        this.controls.target.copy(target);
        this.camera.lookAt(target);
        this.camera.updateMatrixWorld(true);
    }

    openTwoDViews() {
        if (!this.twoDViewsOverlay || !this.twoDViewsDialog) return;
        const preview = this.getCompositeOrthographicProjection('front');
        if (preview.reason === 'empty-diagram') {
            this.showAlertModal(this.getTwoDViewsUnsupportedMessage(preview));
            return;
        }
        this.autoTurnRightWasActiveBeforeTwoDViews = this.autoTurnRightActive || this.controls?.autoRotate === true;
        this.cameraStateBeforeTwoDViews = this.camera && this.controls ? {
            position: this.camera.position.clone(),
            target: this.controls.target.clone()
        } : null;
        if (this._cameraAnim) {
            const elapsed = Math.max(0, performance.now() - this._cameraAnim.startTime);
            const remainingDuration = Math.max(0, this._cameraAnim.duration - elapsed);
            this.cameraAnimationBeforeTwoDViews = remainingDuration > 0 ? {
                toPos: this._cameraAnim.toPos.clone(),
                toTarget: this._cameraAnim.toTarget.clone(),
                duration: remainingDuration
            } : null;
            this._cameraAnim = null;
        } else {
            this.cameraAnimationBeforeTwoDViews = null;
        }
        this.autoTurnRightActive = false;
        if (this.controls) {
            this.controls.autoRotate = false;
            this.clearOrbitControlsMotion();
        }
        this._keysHeld?.clear();
        this.lastFocusedElementBeforeTwoDViews = document.activeElement;
        this.controlsEnabledBeforeTwoDViews = this.controls?.enabled !== false;
        if (this.controls) this.controls.enabled = false;
        mainApp.inert = true;
        this.twoDViewsOverlay.classList.add('show');
        this.twoDViewsOverlay.setAttribute('aria-hidden', 'false');
        this.setActiveTwoDView(this.activeTwoDView || 'front', { focus: false });
        window.requestAnimationFrame(() => {
            const activeTab = this.twoDViewTabButtons.find((tab) => tab.dataset.view === this.activeTwoDView);
            (activeTab || this.twoDViewsCloseBtn)?.focus();
        });
    }

    closeTwoDViews({ restoreFocus: shouldRestoreFocus = true } = {}) {
        if (!this.twoDViewsOverlay) return;
        this.twoDViewsOverlay.classList.remove('show');
        this.twoDViewsOverlay.setAttribute('aria-hidden', 'true');
        mainApp.inert = false;
        if (this.controls) {
            if (this.cameraStateBeforeTwoDViews) {
                this.camera.position.copy(this.cameraStateBeforeTwoDViews.position);
                this.controls.target.copy(this.cameraStateBeforeTwoDViews.target);
                this.camera.lookAt(this.controls.target);
                this.camera.updateMatrixWorld(true);
            }
            this.controls.enabled = this.controlsEnabledBeforeTwoDViews;
            if (this.autoTurnRightWasActiveBeforeTwoDViews) {
                this.controls.autoRotate = true;
                this.controls.autoRotateSpeed = AUTO_TURN_RIGHT_SPEED;
            }
        }
        this.autoTurnRightActive = this.autoTurnRightWasActiveBeforeTwoDViews;
        this.autoTurnRightWasActiveBeforeTwoDViews = false;
        this.cameraStateBeforeTwoDViews = null;
        if (!this.isShuttingDown && this.cameraAnimationBeforeTwoDViews && this.camera && this.controls) {
            this._cameraAnim = {
                fromPos: this.camera.position.clone(),
                fromTarget: this.controls.target.clone(),
                toPos: this.cameraAnimationBeforeTwoDViews.toPos,
                toTarget: this.cameraAnimationBeforeTwoDViews.toTarget,
                startTime: performance.now(),
                duration: this.cameraAnimationBeforeTwoDViews.duration
            };
        }
        this.cameraAnimationBeforeTwoDViews = null;
        const focusTarget = this.lastFocusedElementBeforeTwoDViews || this.openTwoDViewsBtn;
        this.lastFocusedElementBeforeTwoDViews = null;
        if (shouldRestoreFocus) restoreFocus(focusTarget);
    }

    setActiveTwoDView(viewId, { focus = true } = {}) {
        const allowed = new Set(['front', 'top', 'right', 'three', 'net']);
        if (!allowed.has(viewId)) return;
        this.activeTwoDView = viewId;
        this.twoDViewTabButtons.forEach((tab) => {
            const active = tab.dataset.view === viewId;
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.tabIndex = active ? 0 : -1;
            if (active && focus) tab.focus();
        });
        const activeTab = this.twoDViewTabButtons.find((tab) => tab.dataset.view === viewId);
        if (this.twoDViewsStage && activeTab) {
            this.twoDViewsStage.setAttribute('aria-labelledby', activeTab.id);
        }
        if (this.twoDShowHiddenEdgesLabel) {
            this.twoDShowHiddenEdgesLabel.hidden = viewId === 'net';
        }
        this.renderTwoDViews();
    }

    handleTwoDViewTabKeydown(event) {
        const current = event.target.closest('[data-view][role="tab"]');
        if (!current) return;
        const index = this.twoDViewTabButtons.indexOf(current);
        if (index < 0) return;
        let nextIndex = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % this.twoDViewTabButtons.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + this.twoDViewTabButtons.length) % this.twoDViewTabButtons.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = this.twoDViewTabButtons.length - 1;
        if (nextIndex == null) return;
        event.preventDefault();
        this.setActiveTwoDView(this.twoDViewTabButtons[nextIndex].dataset.view);
    }

    renderTwoDViews() {
        if (!this.twoDViewSvg) return;
        const showHiddenEdges = this.twoDShowHiddenEdges?.checked === true;
        const isNet = this.activeTwoDView === 'net';
        const drawing = isNet
            ? this.buildNetViewDrawing()
            : (this.activeTwoDView === 'three'
                ? this.buildOrthographicViewSheetDrawing({ showHiddenEdges })
                : this.buildOrthographicViewDrawing(this.activeTwoDView, { showHiddenEdges }));
        const sheetDrawing = isNet
            ? this.buildOrthographicViewSheetDrawing({ showHiddenEdges })
            : null;
        if (this.twoDViewsTitle) this.twoDViewsTitle.textContent = drawing.label;
        this.twoDViewSvg.setAttribute('viewBox', `0 0 ${drawing.width} ${drawing.height}`);
        this.twoDViewSvg.setAttribute('aria-label', drawing.label);
        if (!drawing.supported) {
            const message = drawing.message || 'This diagram cannot be shown as a 2-D view.';
            this.twoDViewSvg.innerHTML = `<rect width="${drawing.width}" height="${drawing.height}" fill="#FFFFFF"/><text x="${drawing.width / 2}" y="${drawing.height / 2}" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="#53697D">${this.escapeXmlText(message)}</text>`;
            if (this.twoDViewsStatus) this.twoDViewsStatus.textContent = message;
            if (this.twoDViewExportCurrentBtn) this.twoDViewExportCurrentBtn.disabled = true;
            if (this.twoDViewExportSheetBtn) this.twoDViewExportSheetBtn.disabled = isNet ? !sheetDrawing?.supported : true;
            return;
        }
        this.twoDViewSvg.innerHTML = drawing.content;
        if (this.twoDViewsStatus) {
            this.twoDViewsStatus.textContent = isNet
                ? drawing.status
                : (this.activeTwoDView === 'three'
                    ? 'Front, Top, and Right Side views at the same scale'
                    : `${drawing.label}${showHiddenEdges ? ' with hidden edges' : ''}`);
        }
        if (this.twoDViewExportCurrentBtn) this.twoDViewExportCurrentBtn.disabled = false;
        if (this.twoDViewExportSheetBtn) this.twoDViewExportSheetBtn.disabled = isNet ? !sheetDrawing?.supported : false;
    }

    getTwoDViewFileName(viewId) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const name = viewId === 'three'
            ? 'three-view-sheet'
            : (viewId === 'net' ? 'net' : `${viewId}-view`);
        return `3DGeoGon-${name}-${stamp}.svg`;
    }

    handleExportCurrentTwoDView() {
        const showHiddenEdges = this.twoDShowHiddenEdges?.checked === true;
        const markup = this.activeTwoDView === 'net'
            ? this.buildNetViewSvgMarkup()
            : this.buildOrthographicViewSvgMarkup(this.activeTwoDView, { showHiddenEdges });
        if (!markup) return;
        this.downloadTextFile(this.getTwoDViewFileName(this.activeTwoDView), markup, 'image/svg+xml;charset=utf-8');
    }

    handleExportTwoDViewSheet() {
        const showHiddenEdges = this.twoDShowHiddenEdges?.checked === true;
        const markup = this.buildOrthographicViewSvgMarkup('three', { showHiddenEdges });
        if (!markup) return;
        this.downloadTextFile(this.getTwoDViewFileName('three'), markup, 'image/svg+xml;charset=utf-8');
    }

    updateCanvasEmptyState() {
        if (!this.canvasEmptyStateEl) return;
        const shouldShow = this.compositeSlots.length === 0;
        this.canvasEmptyStateEl.classList.toggle('show', shouldShow);
        this.canvasEmptyStateEl.hidden = !shouldShow;
        this.canvasEmptyStateEl.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
        this.canvasEmptyStateEl.style.display = shouldShow ? '' : 'none';
        if (this.openTwoDViewsBtn) {
            this.openTwoDViewsBtn.disabled = shouldShow;
            this.openTwoDViewsBtn.setAttribute('aria-disabled', shouldShow ? 'true' : 'false');
        }
    }

    getPrimitiveLocalPointMap(primitiveKey, params) {
        if (primitiveKey === 'right-triangle-prism') {
            const zFront = params.length / 2;
            const zBack = -params.length / 2;
            const [posA, posB, posC] = getTriangularPrismProfilePoints(params, zFront);
            return {
                A: posA,
                B: posB,
                C: posC,
                D: new THREE.Vector3(posA.x, posA.y, zBack),
                E: new THREE.Vector3(posB.x, posB.y, zBack),
                F: new THREE.Vector3(posC.x, posC.y, zBack)
            };
        }

        if (primitiveKey === 'tetrahedron') {
            return getTetrahedronPointMap(params);
        }

        return null;
    }

    getAttachmentFaceLocalVertices(slot, faceDef) {
        if (!slot || !faceDef || !Array.isArray(faceDef.vertexIds) || faceDef.vertexIds.length !== 3) {
            return null;
        }

        const pointMap = this.getPrimitiveLocalPointMap(slot.primitive, slot.params);
        if (!pointMap) {
            return null;
        }

        const vertices = faceDef.vertexIds.map((id) => pointMap[id]?.clone()).filter(Boolean);
        return vertices.length === 3 ? vertices : null;
    }

    orientTriangleVerticesToNormal(vertices, targetNormal) {
        if (!Array.isArray(vertices) || vertices.length !== 3) {
            return null;
        }

        const oriented = vertices.map((vertex) => vertex.clone());
        const currentNormal = new THREE.Vector3()
            .crossVectors(
                oriented[1].clone().sub(oriented[0]),
                oriented[2].clone().sub(oriented[0])
            )
            .normalize();

        if (currentNormal.dot(targetNormal) < 0) {
            [oriented[1], oriented[2]] = [oriented[2], oriented[1]];
        }

        return oriented;
    }

    buildTriangleBasis(vertices) {
        const origin = vertices[0].clone();
        const u = vertices[1].clone().sub(vertices[0]).normalize();
        const n = new THREE.Vector3().crossVectors(
            vertices[1].clone().sub(vertices[0]),
            vertices[2].clone().sub(vertices[0])
        ).normalize();
        const v = new THREE.Vector3().crossVectors(n, u).normalize();
        const basis = new THREE.Matrix4().makeBasis(u, v, n);
        return { origin, basis };
    }

    getTriangleVertexSignatures(vertices) {
        return vertices.map((vertex, index) => {
            const distances = vertices
                .filter((_, otherIndex) => otherIndex !== index)
                .map((other) => vertex.distanceToSquared(other))
                .sort((left, right) => left - right);
            return distances;
        });
    }

    chooseBestTriangleVertexAlignment(guestVertices, hostVertices, targetNormal) {
        const guestSignatures = this.getTriangleVertexSignatures(guestVertices);
        const permutations = [
            [0, 1, 2],
            [0, 2, 1],
            [1, 2, 0],
            [1, 0, 2],
            [2, 0, 1],
            [2, 1, 0]
        ];

        let bestVertices = hostVertices;
        let bestScore = Number.POSITIVE_INFINITY;

        permutations.forEach((permutation) => {
            const candidate = permutation.map((index) => hostVertices[index]);
            const candidateNormal = new THREE.Vector3()
                .crossVectors(
                    candidate[1].clone().sub(candidate[0]),
                    candidate[2].clone().sub(candidate[0])
                )
                .normalize();
            if (candidateNormal.dot(targetNormal) <= 1e-8) {
                return;
            }

            const candidateSignatures = this.getTriangleVertexSignatures(candidate);
            const score = guestSignatures.reduce((total, signature, index) => {
                return total
                    + Math.abs(signature[0] - candidateSignatures[index][0])
                    + Math.abs(signature[1] - candidateSignatures[index][1]);
            }, 0);

            if (score < bestScore) {
                bestScore = score;
                bestVertices = candidate;
            }
        });

        return bestVertices.map((vertex) => vertex.clone());
    }

    computeBestTriangleAttachmentTransform(guestVertices, hostVertices, targetGuestNormal, isCandidateValid = null) {
        const guestOrders = [
            [0, 1, 2],
            [0, 2, 1]
        ];
        const hostOrders = [
            [0, 1, 2], [0, 2, 1],
            [1, 0, 2], [1, 2, 0],
            [2, 0, 1], [2, 1, 0]
        ];

        let best = null;

        guestOrders.forEach((guestOrder) => {
            const src = guestOrder.map((index) => guestVertices[index].clone());
            const srcBasis = this.buildTriangleBasis(src);
            const srcNormal = new THREE.Vector3()
                .crossVectors(
                    src[1].clone().sub(src[0]),
                    src[2].clone().sub(src[0])
                )
                .normalize();

            hostOrders.forEach((hostOrder) => {
                const dst = hostOrder.map((index) => hostVertices[index].clone());
                const dstBasis = this.buildTriangleBasis(dst);

                const transformMatrix = dstBasis.basis.clone().multiply(srcBasis.basis.clone().invert());
                const quaternion = new THREE.Quaternion().setFromRotationMatrix(transformMatrix);
                const position = dstBasis.origin.clone().sub(srcBasis.origin.clone().applyQuaternion(quaternion));

                const rotatedNormal = srcNormal.clone().applyQuaternion(quaternion).normalize();
                if (rotatedNormal.dot(targetGuestNormal) < 0.999) {
                    return;
                }

                if (typeof isCandidateValid === 'function' && !isCandidateValid(quaternion, position, dst)) {
                    return;
                }

                const error = src.reduce((total, vertex, index) => {
                    const transformed = vertex.clone().applyQuaternion(quaternion).add(position);
                    return total + transformed.distanceToSquared(dst[index]);
                }, 0);

                if (!best || error < best.error) {
                    best = { quaternion, position, error };
                }
            });
        });

        return best;
    }

    tryApplyExactTriangleFaceTransform(slotGroup, slot, hostFaceNormal, options = {}) {
        const { hostSlot, hostFaceDef, hostGroupQuaternion, hostGroupPosition } = options;
        if (!hostSlot || !hostFaceDef || hostFaceDef.type !== 'triangle') {
            return null;
        }

        const guestFaceDef = this.getGuestAttachFaceDef(slot, hostFaceNormal, hostFaceDef.type);
        if (!guestFaceDef || guestFaceDef.type !== 'triangle') {
            return null;
        }

        const guestLocalVertices = this.getAttachmentFaceLocalVertices(slot, guestFaceDef);
        const hostLocalVertices = this.getAttachmentFaceLocalVertices(hostSlot, hostFaceDef);
        if (!guestLocalVertices || !hostLocalVertices) {
            return null;
        }

        const guestOrientQ = this.getOrientationQuaternion(slot.primitive, slot.orientation);
        const hostOrientQ = this.getOrientationQuaternion(hostSlot.primitive, hostSlot.orientation);
        const targetGuestNormal = hostFaceNormal.clone().negate().normalize();

        const guestOrientedVertices = guestLocalVertices.map((vertex) => vertex.applyQuaternion(guestOrientQ));
        const hostWorldVertices = hostLocalVertices.map((vertex) => vertex.applyQuaternion(hostOrientQ).applyQuaternion(hostGroupQuaternion).add(hostGroupPosition));

        const pointMap = this.getPrimitiveLocalPointMap(slot.primitive, slot.params);
        const apexLocal = slot.primitive === 'tetrahedron' ? pointMap?.D?.clone().applyQuaternion(guestOrientQ) : null;

        const bestTransform = this.computeBestTriangleAttachmentTransform(
            guestOrientedVertices,
            hostWorldVertices,
            targetGuestNormal,
            (quaternion, position, dstVertices) => {
                if (!apexLocal) {
                    return true;
                }

                const transformedApex = apexLocal.clone().applyQuaternion(quaternion).add(position);
                const facePoint = dstVertices[0];
                const signedDistance = transformedApex.clone().sub(facePoint).dot(hostFaceNormal.clone().normalize());
                return signedDistance > 1e-5;
            }
        );
        if (!bestTransform) {
            return null;
        }

        slotGroup.quaternion.copy(bestTransform.quaternion);
        slotGroup.position.copy(bestTransform.position);
        return guestFaceDef;
    }

    applySlotTransform(slotGroup, slot, hostFaceCenter, hostFaceNormal, hostFaceUWorld = null, options = {}) {
        const exactTriangleGuestFaceDef = this.tryApplyExactTriangleFaceTransform(slotGroup, slot, hostFaceNormal, options);
        if (exactTriangleGuestFaceDef) {
            return exactTriangleGuestFaceDef;
        }

        const { hostFaceDef: _hostFaceDef } = options;
        const guestFaceDef = this.getGuestAttachFaceDef(slot, hostFaceNormal, _hostFaceDef?.type ?? null);
        if (!guestFaceDef) return null;

        const targetGuestNormal = hostFaceNormal.clone().negate();

        // Apply guest's orientation rotation to its face normal (which is in standard space)
        const guestOrientQ = this.getOrientationQuaternion(slot.primitive, slot.orientation);
        const guestFaceNormal = this.resolveFaceNormal(guestFaceDef, slot.params).applyQuaternion(guestOrientQ);

        const Q = new THREE.Quaternion();
        const dot = guestFaceNormal.dot(targetGuestNormal);

        if (dot > 0.9999) {
            Q.identity();
        } else if (dot < -0.9999) {
            const perp = Math.abs(guestFaceNormal.x) < 0.9
                ? new THREE.Vector3(1, 0, 0).cross(guestFaceNormal).normalize()
                : new THREE.Vector3(0, 1, 0).cross(guestFaceNormal).normalize();
            Q.setFromAxisAngle(perp, Math.PI);
        } else {
            Q.setFromUnitVectors(guestFaceNormal, targetGuestNormal);
        }

        // After normal alignment, align in-plane axis too (prevents left/right face mismatch).
        if (hostFaceUWorld && guestFaceDef.uAxis) {
            const guestUAfterNormalAlign = this.resolveFaceUAxis(guestFaceDef, slot.params)
                .applyQuaternion(guestOrientQ)
                .applyQuaternion(Q);

            const projectToPlane = (vec, normal) => vec.clone().sub(normal.clone().multiplyScalar(vec.dot(normal)));
            const guestUProj = projectToPlane(guestUAfterNormalAlign, targetGuestNormal).normalize();
            const hostUProj = projectToPlane(hostFaceUWorld, targetGuestNormal).normalize();

            if (guestUProj.lengthSq() > 1e-8 && hostUProj.lengthSq() > 1e-8) {
                const cross = new THREE.Vector3().crossVectors(guestUProj, hostUProj);
                const sin = targetGuestNormal.dot(cross);
                const cos = THREE.MathUtils.clamp(guestUProj.dot(hostUProj), -1, 1);
                const twistAngle = Math.atan2(sin, cos);
                const twist = new THREE.Quaternion().setFromAxisAngle(targetGuestNormal, twistAngle);
                Q.premultiply(twist);
            }
        }

        const quarterTurns = this.getAttachmentQuarterTurns(slot, guestFaceDef, _hostFaceDef);
        if (quarterTurns !== 0) {
            const extraTwist = new THREE.Quaternion().setFromAxisAngle(targetGuestNormal, quarterTurns * (Math.PI / 2));
            Q.premultiply(extraTwist);
        }

        slotGroup.quaternion.copy(Q);
        const guestLocalCenter = guestFaceDef.center(slot.params)
            .clone()
            .applyQuaternion(guestOrientQ);  // Apply orientation first
        const guestRotatedCenter = guestLocalCenter.applyQuaternion(Q);
        slotGroup.position.copy(hostFaceCenter).sub(guestRotatedCenter);
        return guestFaceDef;
    }

    addLinkages(hostInfo, guestInfo) {
        const hostSlot = this.compositeSlots.find((s) => s.id === hostInfo.slotId);
        const guestSlot = this.compositeSlots.find((s) => s.id === guestInfo.slotId);
        if (!hostSlot || !guestSlot) return;

        const len = Math.min(hostInfo.dims.length, guestInfo.dims.length);
        for (let i = 0; i < len; i++) {
            const hostDim = hostInfo.dims[i];
            const guestDim = guestInfo.dims[i];
            const hostHasParam = hostDim && Object.prototype.hasOwnProperty.call(hostSlot.params, hostDim);
            const guestHasParam = guestDim && Object.prototype.hasOwnProperty.call(guestSlot.params, guestDim);
            if (hostHasParam && guestHasParam) {
                this.slotLinkages.push({ fromSlotId: hostInfo.slotId, fromParam: hostDim, toSlotId: guestInfo.slotId, toParam: guestDim });
                this.slotLinkages.push({ fromSlotId: guestInfo.slotId, fromParam: guestDim, toSlotId: hostInfo.slotId, toParam: hostDim });
            }
        }
    }

    getUniqueDisplayLabel(preferredLabel, usedLabels) {
        if (preferredLabel && !usedLabels.has(preferredLabel)) {
            usedLabels.add(preferredLabel);
            return preferredLabel;
        }

        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        for (const letter of alphabet) {
            if (!usedLabels.has(letter)) {
                usedLabels.add(letter);
                return letter;
            }
        }

        let index = 1;
        while (usedLabels.has(`P${index}`)) {
            index += 1;
        }
        const fallback = `P${index}`;
        usedLabels.add(fallback);
        return fallback;
    }

    mergeCoincidentBasePoints(rawPoints, threshold = 0.02) {
        const merged = [];
        const usedLabels = new Set();
        let mergedIndex = 1;

        rawPoints.forEach((point) => {
            const existing = merged.find((candidate) => candidate.position.distanceTo(point.position) <= threshold);
            if (existing) {
                existing.sourceIds.push(point.id);
                return;
            }

            const preferredLabel = this.baseLabelOverrides.get(point.id) || point.label;
            const label = this.getUniqueDisplayLabel(preferredLabel, usedLabels);
            merged.push({
                id: `p${mergedIndex}`,
                label,
                description: point.description,
                position: point.position.clone(),
                sourceIds: [point.id]
            });
            mergedIndex += 1;
        });

        return merged;
    }

    formatPointSequence(pointIds) {
        return pointIds
            .map((pointId) => this.getPointById(pointId)?.label || pointId)
            .join('');
    }

    normalizePointPairIds(pointIds) {
        if (!Array.isArray(pointIds) || pointIds.length !== 2) {
            return null;
        }

        return [...pointIds].sort((left, right) => String(left).localeCompare(String(right)));
    }

    getPrimitiveEdgeSet(primitiveKey) {
        const edgePairsByPrimitive = {
            cuboid: [
                ['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A'],
                ['E', 'F'], ['F', 'G'], ['G', 'H'], ['H', 'E'],
                ['A', 'E'], ['B', 'F'], ['C', 'G'], ['D', 'H']
            ],
            'right-triangle-prism': [
                ['A', 'B'], ['B', 'C'], ['C', 'A'],
                ['D', 'E'], ['E', 'F'], ['F', 'D'],
                ['A', 'D'], ['B', 'E'], ['C', 'F']
            ],
            tetrahedron: [
                ['A', 'B'], ['B', 'C'], ['C', 'A'],
                ['A', 'D'], ['B', 'D'], ['C', 'D']
            ],
            sphere: [],
            hemisphere: [],
            cylinder: [],
            cone: [],
            'rectangular-pyramid': [
                ['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A'],
                ['A', 'E'], ['B', 'E'], ['C', 'E'], ['D', 'E']
            ]
        };

        const pairs = [...(edgePairsByPrimitive[primitiveKey] || [])];
        const polygonal = getPolygonalPrimitiveConfig(primitiveKey);
        if (polygonal?.kind === 'prism') {
            const bottomLabels = POINT_LABELS.slice(0, polygonal.sides);
            const topLabels = POINT_LABELS.slice(polygonal.sides, polygonal.sides * 2);
            for (let index = 0; index < polygonal.sides; index += 1) {
                const nextIndex = (index + 1) % polygonal.sides;
                pairs.push([bottomLabels[index], bottomLabels[nextIndex]]);
                pairs.push([topLabels[index], topLabels[nextIndex]]);
                pairs.push([bottomLabels[index], topLabels[index]]);
            }
            pairs.push(['O1', 'M1'], ['A', 'M1'], ['B', 'M1']);
            pairs.push(['O2', 'M2'], [topLabels[0], 'M2'], [topLabels[1], 'M2']);
        }
        if (polygonal?.kind === 'pyramid') {
            const baseLabels = POINT_LABELS.slice(0, polygonal.sides);
            const apexLabel = POINT_LABELS[polygonal.sides];
            for (let index = 0; index < polygonal.sides; index += 1) {
                const nextIndex = (index + 1) % polygonal.sides;
                pairs.push([baseLabels[index], baseLabels[nextIndex]]);
                pairs.push([baseLabels[index], apexLabel]);
            }
            pairs.push(['A', 'M'], ['B', 'M']);
        }
        return new Set(pairs.map((pair) => pair.slice().sort().join('|')));
    }

    getPrimitiveFacePointSets(primitiveKey) {
        const facePointSetsByPrimitive = {
            cuboid: [
                ['A', 'B', 'C', 'D'],
                ['E', 'F', 'G', 'H'],
                ['A', 'B', 'F', 'E'],
                ['B', 'C', 'G', 'F'],
                ['C', 'D', 'H', 'G'],
                ['D', 'A', 'E', 'H']
            ],
            'right-triangle-prism': [
                ['A', 'B', 'C'],
                ['D', 'E', 'F'],
                ['A', 'B', 'E', 'D'],
                ['B', 'C', 'F', 'E'],
                ['C', 'A', 'D', 'F']
            ],
            tetrahedron: [
                ['A', 'B', 'C'],
                ['A', 'B', 'D'],
                ['B', 'C', 'D'],
                ['C', 'A', 'D']
            ],
            'rectangular-pyramid': [
                ['A', 'B', 'C', 'D'],
                ['A', 'B', 'E'],
                ['B', 'C', 'E'],
                ['C', 'D', 'E'],
                ['D', 'A', 'E']
            ],
            sphere: [
                ['A', 'B', 'C', 'D', 'E', 'F']
            ],
            hemisphere: [
                ['A', 'B', 'C', 'D', 'E'],
                ['B', 'C', 'D', 'E', 'F']
            ],
            cylinder: [
                ['A', 'C', 'D'],
                ['B', 'E', 'F'],
                ['C', 'D', 'E', 'F']
            ],
            cone: [
                ['A', 'C', 'D', 'E', 'F'],
                ['B', 'C', 'D', 'E', 'F']
            ]
        };

        return (facePointSetsByPrimitive[primitiveKey] || []).map((face) => new Set(face));
    }

    parsePointSourceId(sourceId) {
        const match = /^s(\d+)_(.+)$/.exec(String(sourceId));
        if (!match) return null;
        return { slotId: match[1], localId: match[2] };
    }

    pointHasSourceLocalId(point, slotId, localId) {
        if (!point || !Array.isArray(point.sourceIds)) {
            return false;
        }

        const slotKey = String(slotId);
        return point.sourceIds.some((sourceId) => {
            const parsed = this.parsePointSourceId(sourceId);
            return parsed?.slotId === slotKey && parsed.localId === localId;
        });
    }

    getPointBySlotLocalId(slotId, localId) {
        return this.getAllPoints().find((point) => this.pointHasSourceLocalId(point, slotId, localId)) || null;
    }

    getBaseHighlightFaceCandidates() {
        const candidates = [];

        this.compositeSlots.forEach((slot) => {
            const polygonal = getPolygonalPrimitiveConfig(slot.primitive);
            if (polygonal?.kind === 'prism') {
                const bottomLabels = POINT_LABELS.slice(0, polygonal.sides);
                const topLabels = POINT_LABELS.slice(polygonal.sides, polygonal.sides * 2);
                candidates.push(
                    {
                        shape: 'polygon',
                        sourceSlotId: slot.id,
                        sourceFaceId: 'bottom-base',
                        pointLocalIds: bottomLabels,
                        boundaryLocalIds: bottomLabels
                    },
                    {
                        shape: 'polygon',
                        sourceSlotId: slot.id,
                        sourceFaceId: 'top-base',
                        pointLocalIds: topLabels,
                        boundaryLocalIds: topLabels
                    }
                );
            }

            if (polygonal?.kind === 'pyramid') {
                const baseLabels = POINT_LABELS.slice(0, polygonal.sides);
                candidates.push({
                    shape: 'polygon',
                    sourceSlotId: slot.id,
                    sourceFaceId: 'base',
                    pointLocalIds: baseLabels,
                    boundaryLocalIds: baseLabels
                });
            }

            if (slot.primitive === 'cylinder') {
                candidates.push(
                    {
                        shape: 'circle',
                        sourceSlotId: slot.id,
                        sourceFaceId: 'cylinder-end-a',
                        pointLocalIds: ['A', 'C', 'D'],
                        boundaryLocalIds: ['C', 'D'],
                        centerLocalId: 'A'
                    },
                    {
                        shape: 'circle',
                        sourceSlotId: slot.id,
                        sourceFaceId: 'cylinder-end-b',
                        pointLocalIds: ['B', 'E', 'F'],
                        boundaryLocalIds: ['E', 'F'],
                        centerLocalId: 'B'
                    }
                );
            }

            if (slot.primitive === 'cone') {
                candidates.push({
                    shape: 'circle',
                    sourceSlotId: slot.id,
                    sourceFaceId: 'cone-base',
                    pointLocalIds: ['B', 'C', 'D', 'E', 'F'],
                    boundaryLocalIds: ['C', 'D', 'E', 'F'],
                    centerLocalId: 'B'
                });
            }

            if (slot.primitive === 'hemisphere') {
                candidates.push({
                    shape: 'circle',
                    sourceSlotId: slot.id,
                    sourceFaceId: 'hemisphere-flat',
                    pointLocalIds: ['F', 'B', 'C', 'D', 'E'],
                    boundaryLocalIds: ['B', 'C', 'D', 'E'],
                    centerLocalId: 'F'
                });
            }

            if (slot.primitive === 'sphere') {
                const surfaceLocalIds = ['A', 'B', 'C', 'D', 'E', 'F'];
                candidates.push(...this.getSphereBasePresetCandidates(slot.id));
                for (let left = 0; left < surfaceLocalIds.length - 1; left += 1) {
                    for (let right = left + 1; right < surfaceLocalIds.length; right += 1) {
                        const first = surfaceLocalIds[left];
                        const second = surfaceLocalIds[right];
                        if (this.areOppositeSphereSurfaceLocalIds(first, second)) {
                            continue;
                        }
                        candidates.push({
                            shape: 'circle',
                            sourceSlotId: slot.id,
                            sourceFaceId: `sphere-great-${first}-${second}`,
                            pointLocalIds: ['O', first, second],
                            boundaryLocalIds: [first, second],
                            centerLocalId: 'O',
                            actionLabel: this.isHorizontalSphereGreatCircle(first, second)
                                ? 'Add Horizontal Base Highlight'
                                : 'Add Vertical Base Highlight'
                        });
                    }
                }

                for (let firstIndex = 0; firstIndex < surfaceLocalIds.length - 2; firstIndex += 1) {
                    for (let secondIndex = firstIndex + 1; secondIndex < surfaceLocalIds.length - 1; secondIndex += 1) {
                        for (let thirdIndex = secondIndex + 1; thirdIndex < surfaceLocalIds.length; thirdIndex += 1) {
                            const first = surfaceLocalIds[firstIndex];
                            const second = surfaceLocalIds[secondIndex];
                            const third = surfaceLocalIds[thirdIndex];
                            candidates.push({
                                shape: 'circle',
                                sourceSlotId: slot.id,
                                sourceFaceId: `sphere-circle-${first}-${second}-${third}`,
                                pointLocalIds: [first, second, third],
                                boundaryLocalIds: [first, second, third]
                            });
                        }
                    }
                }
            }
        });

        return candidates;
    }

    getConeBasePresetCandidates(sourceSlotId) {
        return [
            {
                shape: 'circle',
                sourceSlotId,
                sourceFaceId: 'cone-base',
                pointLocalIds: ['B', 'C', 'D', 'E', 'F'],
                boundaryLocalIds: ['C', 'D', 'E', 'F'],
                centerLocalId: 'B',
                actionKey: 'base-highlight:cone-base',
                actionLabel: 'Add Base Highlight',
                objectName: 'Base Highlight',
                subtitle: 'Circular base highlight'
            }
        ];
    }

    getSphereBasePresetCandidates(sourceSlotId) {
        return [
            {
                shape: 'circle',
                sourceSlotId,
                sourceFaceId: 'sphere-horizontal-base',
                pointLocalIds: ['O', 'C', 'D', 'E', 'F'],
                boundaryLocalIds: ['C', 'D', 'E', 'F'],
                centerLocalId: 'O',
                actionKey: 'base-highlight:sphere-horizontal-base',
                actionLabel: 'Add Horizontal Base Highlight',
                objectName: 'Horizontal Base Highlight',
                subtitle: 'Horizontal circular base highlight'
            },
            {
                shape: 'circle',
                sourceSlotId,
                sourceFaceId: 'sphere-vertical-base',
                pointLocalIds: ['O', 'A', 'C', 'B', 'E'],
                boundaryLocalIds: ['A', 'C', 'B', 'E'],
                centerLocalId: 'O',
                actionKey: 'base-highlight:sphere-vertical-base',
                actionLabel: 'Add Vertical Base Highlight',
                objectName: 'Vertical Base Highlight',
                subtitle: 'Vertical circular base highlight'
            }
        ];
    }

    areOppositeSphereSurfaceLocalIds(first, second) {
        const pairKey = [first, second].sort().join('');
        return pairKey === 'AB' || pairKey === 'CE' || pairKey === 'DF';
    }

    isHorizontalSphereGreatCircle(first, second) {
        const horizontalLocalIds = new Set(['C', 'D', 'E', 'F']);
        return horizontalLocalIds.has(first) && horizontalLocalIds.has(second);
    }

    getSelectedPrimitiveLocalIds(primitiveKey) {
        const selected = this.selectedPoints
            .map((pointId) => this.getPointById(pointId))
            .filter(Boolean);
        if (selected.length === 0 || selected.length !== this.selectedPoints.length) {
            return null;
        }

        const matchingSlotIds = new Set(this.compositeSlots
            .filter((slot) => slot.primitive === primitiveKey)
            .map((slot) => String(slot.id)));
        if (matchingSlotIds.size === 0) {
            return null;
        }

        let selectedSlotId = null;
        const localIds = [];
        for (const point of selected) {
            const parsedSource = (point.sourceIds || [])
                .map((sourceId) => this.parsePointSourceId(sourceId))
                .find((source) => source && matchingSlotIds.has(String(source.slotId)));
            if (!parsedSource) {
                return null;
            }

            const slotId = String(parsedSource.slotId);
            if (selectedSlotId == null) {
                selectedSlotId = slotId;
            } else if (selectedSlotId !== slotId) {
                return null;
            }
            localIds.push(parsedSource.localId);
        }

        return { sourceSlotId: selectedSlotId, localIds };
    }

    getSelectedSphereLocalIds() {
        return this.getSelectedPrimitiveLocalIds('sphere');
    }

    getSelectedConeLocalIds() {
        return this.getSelectedPrimitiveLocalIds('cone');
    }

    getConeBaseHighlightActionCandidatesForSelection() {
        const coneSelection = this.getSelectedConeLocalIds();
        if (!coneSelection || !coneSelection.localIds.includes('B')) {
            return [];
        }

        return this.getConeBasePresetCandidates(coneSelection.sourceSlotId).filter((candidate) => (
            coneSelection.localIds.length < candidate.pointLocalIds.length
            && coneSelection.localIds.every((localId) => candidate.pointLocalIds.includes(localId))
        ));
    }

    getSphereBaseHighlightActionCandidatesForSelection() {
        const sphereSelection = this.getSelectedSphereLocalIds();
        if (!sphereSelection || !sphereSelection.localIds.includes('O')) {
            return [];
        }

        const surfaceLocalIds = sphereSelection.localIds.filter((localId) => localId !== 'O');
        const hasOppositePair = surfaceLocalIds.some((localId, index) => (
            surfaceLocalIds.slice(index + 1).some((otherLocalId) => this.areOppositeSphereSurfaceLocalIds(localId, otherLocalId))
        ));
        if (sphereSelection.localIds.length >= 3 && !hasOppositePair) {
            return [];
        }

        return this.getSphereBasePresetCandidates(sphereSelection.sourceSlotId).filter((candidate) => (
            sphereSelection.localIds.every((localId) => candidate.pointLocalIds.includes(localId))
        ));
    }

    buildBaseHighlightSelectionFromCandidate(candidate, pointByLocalId = null) {
        const resolvedPoints = pointByLocalId || new Map();
        for (const localId of candidate.pointLocalIds) {
            if (!resolvedPoints.has(localId)) {
                const point = this.getPointBySlotLocalId(candidate.sourceSlotId, localId);
                if (!point) {
                    return null;
                }
                resolvedPoints.set(localId, point);
            }
        }

        return {
            shape: candidate.shape,
            pointIds: candidate.pointLocalIds.map((localId) => resolvedPoints.get(localId).id),
            boundaryPointIds: candidate.boundaryLocalIds.map((localId) => resolvedPoints.get(localId).id),
            centerPointId: candidate.centerLocalId ? resolvedPoints.get(candidate.centerLocalId)?.id || null : null,
            sourceSlotId: candidate.sourceSlotId,
            sourceFaceId: candidate.sourceFaceId,
            actionLabel: candidate.actionLabel,
            objectName: candidate.objectName,
            subtitle: candidate.subtitle
        };
    }

    getBaseHighlightSelection() {
        const selected = this.selectedPoints
            .map((pointId) => this.getPointById(pointId))
            .filter(Boolean);
        if (selected.length < 3 || selected.length !== this.selectedPoints.length) {
            return null;
        }

        for (const candidate of this.getBaseHighlightFaceCandidates()) {
            if (selected.length !== candidate.pointLocalIds.length) {
                continue;
            }

            const pointByLocalId = new Map();
            const usedPointIds = new Set();
            let validCandidate = true;

            for (const localId of candidate.pointLocalIds) {
                const point = selected.find((selectedPoint) => (
                    !usedPointIds.has(selectedPoint.id)
                    && this.pointHasSourceLocalId(selectedPoint, candidate.sourceSlotId, localId)
                ));

                if (!point) {
                    validCandidate = false;
                    break;
                }

                pointByLocalId.set(localId, point);
                usedPointIds.add(point.id);
            }

            if (!validCandidate || usedPointIds.size !== selected.length) {
                continue;
            }

            return this.buildBaseHighlightSelectionFromCandidate(candidate, pointByLocalId);
        }

        return null;
    }

    getBaseHighlightSelectionForAction(actionKey) {
        if (actionKey === 'base-highlight:cone-base') {
            const candidate = this.getConeBaseHighlightActionCandidatesForSelection()
                .find((entry) => entry.actionKey === actionKey);
            return candidate ? this.buildBaseHighlightSelectionFromCandidate(candidate) : null;
        }

        if (typeof actionKey === 'string' && actionKey.startsWith('base-highlight:sphere-')) {
            const candidate = this.getSphereBaseHighlightActionCandidatesForSelection()
                .find((entry) => entry.actionKey === actionKey);
            return candidate ? this.buildBaseHighlightSelectionFromCandidate(candidate) : null;
        }

        return this.getBaseHighlightSelection();
    }

    hasPrimitiveEdgeBetween(pointIds) {
        const normalized = this.normalizePointPairIds(pointIds);
        if (!normalized) {
            return false;
        }

        const pointA = this.getPointById(normalized[0]);
        const pointB = this.getPointById(normalized[1]);
        if (!pointA?.sourceIds?.length || !pointB?.sourceIds?.length) {
            return false;
        }

        const slotPrimitiveMap = new Map(this.compositeSlots.map((slot) => [String(slot.id), slot.primitive]));
        const sourceA = pointA.sourceIds.map((sourceId) => this.parsePointSourceId(sourceId)).filter(Boolean);
        const sourceB = pointB.sourceIds.map((sourceId) => this.parsePointSourceId(sourceId)).filter(Boolean);

        for (const left of sourceA) {
            for (const right of sourceB) {
                if (left.slotId !== right.slotId || left.localId === right.localId) {
                    continue;
                }

                const primitiveKey = slotPrimitiveMap.get(left.slotId);
                if (!primitiveKey) {
                    continue;
                }

                const edgeKey = [left.localId, right.localId].sort().join('|');
                if (this.getPrimitiveEdgeSet(primitiveKey).has(edgeKey)) {
                    return true;
                }
            }
        }

        return false;
    }

    hasPrimitiveFaceBetween(pointIds) {
        const normalized = this.normalizePointPairIds(pointIds);
        if (!normalized) {
            return false;
        }

        const pointA = this.getPointById(normalized[0]);
        const pointB = this.getPointById(normalized[1]);
        if (!pointA?.sourceIds?.length || !pointB?.sourceIds?.length) {
            return false;
        }

        const slotPrimitiveMap = new Map(this.compositeSlots.map((slot) => [String(slot.id), slot.primitive]));
        const sourceA = pointA.sourceIds.map((sourceId) => this.parsePointSourceId(sourceId)).filter(Boolean);
        const sourceB = pointB.sourceIds.map((sourceId) => this.parsePointSourceId(sourceId)).filter(Boolean);

        for (const left of sourceA) {
            for (const right of sourceB) {
                if (left.slotId !== right.slotId || left.localId === right.localId) {
                    continue;
                }

                const primitiveKey = slotPrimitiveMap.get(left.slotId);
                if (!primitiveKey) {
                    continue;
                }

                const faceSets = this.getPrimitiveFacePointSets(primitiveKey);
                const isSameFacePair = faceSets.some((faceSet) => faceSet.has(left.localId) && faceSet.has(right.localId));
                if (isSameFacePair) {
                    return true;
                }
            }
        }

        return false;
    }

    hasSceneSegmentBetween(pointIds) {
        const normalized = this.normalizePointPairIds(pointIds);
        if (!normalized) {
            return false;
        }

        const matchesPair = (pairCandidate) => {
            const pair = this.normalizePointPairIds(pairCandidate);
            return !!pair && pair[0] === normalized[0] && pair[1] === normalized[1];
        };

        return this.sceneObjects.some((entry) => {
            const definition = entry.definition;
            if (!definition || !Array.isArray(definition.pointIds)) {
                return false;
            }

            if (definition.kind === 'segment' && definition.pointIds.length === 2) {
                return matchesPair(definition.pointIds);
            }

            if (definition.kind === 'triangle' && definition.pointIds.length === 3) {
                const ids = definition.pointIds;
                return matchesPair([ids[0], ids[1]])
                    || matchesPair([ids[1], ids[2]])
                    || matchesPair([ids[2], ids[0]]);
            }

            if (definition.kind === 'plane' && definition.pointIds.length === 4) {
                const ids = definition.pointIds;
                return matchesPair([ids[0], ids[1]])
                    || matchesPair([ids[1], ids[2]])
                    || matchesPair([ids[2], ids[3]])
                    || matchesPair([ids[3], ids[0]]);
            }

            return false;
        });
    }

    hasExplicitSceneSegmentBetween(pointIds) {
        const normalized = this.normalizePointPairIds(pointIds);
        if (!normalized) {
            return false;
        }

        const matchesPair = (pairCandidate) => {
            const pair = this.normalizePointPairIds(pairCandidate);
            return !!pair && pair[0] === normalized[0] && pair[1] === normalized[1];
        };

        return this.sceneObjects.some((entry) => {
            const definition = entry.definition;
            return !!definition
                && definition.kind === 'segment'
                && definition.hidden !== true
                && Array.isArray(definition.pointIds)
                && definition.pointIds.length === 2
                && matchesPair(definition.pointIds);
        });
    }

    canAttachLabelToPointPair(pointIds) {
        // Labels can attach to any valid edge connection, including raw primitive edges.
        return this.hasPrimitiveEdgeBetween(pointIds)
            || this.hasSceneSegmentBetween(pointIds)
            || this.hasSharedDerivedEdgeParent(pointIds);
    }

    canAttachMidpointToPointPair(pointIds) {
        return this.hasSegmentLikeConnection(pointIds);
    }

    canMaterializeEdgeDivisionPoint(pointIds, leftValue = 1, rightValue = 1) {
        const vectors = this.getVectorsByPointIds(pointIds);
        const ratio = this.reduceRatio(leftValue, rightValue);
        if (!vectors || vectors.length !== 2 || !ratio) {
            return false;
        }

        const distanceRatio = ratio.left / (ratio.left + ratio.right);
        const candidate = vectors[0].clone().lerp(vectors[1], distanceRatio);
        return !this.getAllPoints().some((point) => (
            point.position.distanceTo(candidate) <= DERIVED_POINT_PROXIMITY_THRESHOLD
        ));
    }

    hasSegmentLikeConnection(pointIds) {
        return this.hasPrimitiveEdgeBetween(pointIds)
            || this.hasSceneSegmentBetween(pointIds)
            || this.hasSharedDerivedEdgeParent(pointIds);
    }

    hasSharedDerivedEdgeParent(pointIds) {
        if (!Array.isArray(pointIds) || pointIds.length !== 2 || pointIds[0] === pointIds[1]) {
            return false;
        }

        const firstPair = this.getDerivedEdgeBasePairForPointId(pointIds[0]);
        const secondPair = this.getDerivedEdgeBasePairForPointId(pointIds[1]);
        if (!firstPair || !secondPair) {
            return false;
        }

        return firstPair[0] === secondPair[0] && firstPair[1] === secondPair[1];
    }

    canAttachAngleFromOrderedPoints(pointIds) {
        if (!Array.isArray(pointIds) || pointIds.length !== 3) {
            return false;
        }

        if (new Set(pointIds).size !== 3) {
            return false;
        }

        const leftLeg = [pointIds[0], pointIds[1]];
        const rightLeg = [pointIds[1], pointIds[2]];
        return this.hasSegmentLikeConnection(leftLeg) && this.hasSegmentLikeConnection(rightLeg);
    }

    findEdgeLabelObject(pointIds) {
        const normalized = this.normalizePointPairIds(pointIds);
        if (!normalized) {
            return null;
        }

        return this.sceneObjects.find((entry) => {
            const definition = entry.definition;
            if (!definition || (definition.kind !== 'edge-label' && definition.kind !== 'length-label') || !Array.isArray(definition.pointIds) || definition.pointIds.length !== 2) {
                return false;
            }

            const pair = this.normalizePointPairIds(definition.pointIds);
            return !!pair && pair[0] === normalized[0] && pair[1] === normalized[1];
        }) || null;
    }

    getShapeLabelKey(pointIds) {
        if (!Array.isArray(pointIds) || (pointIds.length !== 3 && pointIds.length !== 4)) {
            return null;
        }

        const normalized = [...pointIds].sort((left, right) => String(left).localeCompare(String(right)));
        if (new Set(normalized).size !== normalized.length) {
            return null;
        }

        return normalized.join('|');
    }

    findShapeLabelObject(pointIds) {
        const targetKey = this.getShapeLabelKey(pointIds);
        if (!targetKey) {
            return null;
        }

        return this.sceneObjects.find((entry) => {
            const definition = entry.definition;
            if (!definition || definition.kind !== 'shape-label') {
                return false;
            }
            return this.getShapeLabelKey(definition.pointIds) === targetKey;
        }) || null;
    }

    isShapeCenterLabelTarget(item) {
        if (!item || !item.definition || item.definition.hidden) {
            return false;
        }

        const pointIds = item.definition.pointIds;
        if (item.type === 'triangle') {
            return item.definition.kind === 'triangle'
                && Array.isArray(pointIds)
                && pointIds.length === 3;
        }

        if (item.type === 'plane') {
            return item.definition.kind === 'plane'
                && Array.isArray(pointIds)
                && pointIds.length === 4;
        }

        return false;
    }

    getShapeLabelPosition(pointIds) {
        const vectors = this.getVectorsByPointIds(pointIds || []);
        if (!vectors || (vectors.length !== 3 && vectors.length !== 4)) {
            return null;
        }

        const centroid = vectors
            .reduce((sum, vector) => sum.add(vector), new THREE.Vector3())
            .multiplyScalar(1 / vectors.length);
        const normal = new THREE.Vector3().crossVectors(
            vectors[1].clone().sub(vectors[0]),
            vectors[2].clone().sub(vectors[0])
        );

        if (normal.lengthSq() > 1e-8) {
            centroid.add(normal.normalize().multiplyScalar(0.04));
        }

        return centroid;
    }

    isShapeLabelAnchorVisible(definition) {
        const targetKey = this.getShapeLabelKey(definition?.pointIds);
        if (!targetKey) {
            return false;
        }

        return this.sceneObjects.some((entry) => {
            if (!this.isShapeCenterLabelTarget(entry) || entry.visible === false) {
                return false;
            }
            return this.getShapeLabelKey(entry.definition.pointIds) === targetKey;
        });
    }

    findAngleObject(pointIds) {
        if (!Array.isArray(pointIds) || pointIds.length !== 3) {
            return null;
        }

        const vertexId = pointIds[1];
        const endpointPair = this.normalizePointPairIds([pointIds[0], pointIds[2]]);
        if (!vertexId || !endpointPair) {
            return null;
        }

        return this.sceneObjects.find((entry) => {
            const definition = entry.definition;
            if (!definition || definition.kind !== 'angle' || !Array.isArray(definition.pointIds) || definition.pointIds.length !== 3) {
                return false;
            }

            if (definition.pointIds[1] !== vertexId) {
                return false;
            }

            const candidatePair = this.normalizePointPairIds([definition.pointIds[0], definition.pointIds[2]]);
            return !!candidatePair && candidatePair[0] === endpointPair[0] && candidatePair[1] === endpointPair[1];
        }) || null;
    }

    findAngleLabelObjectsForPolygon(pointIds) {
        return this.sceneObjects.filter((entry) => {
            const def = entry.definition;
            if (!def || def.kind !== 'angle' || !Array.isArray(def.pointIds) || def.pointIds.length !== 3) return false;
            return def.pointIds.every((id) => pointIds.includes(id));
        });
    }

    hasMidpointForPair(pointIds) {
        const signature = this.makeMidpointSignature(pointIds);
        if (!signature) {
            return false;
        }

        return this.sceneObjects.some((entry) => entry.definition?.kind === 'midpoint-point' && entry.definition.signature === signature);
    }

    getMidpointSignatureForPointId(pointId) {
        const point = this.getPointById(pointId);
        if (!point || !point.isDerived) {
            return null;
        }

        if (typeof point.signature === 'string' && point.signature.startsWith('midpoint|')) {
            return point.signature;
        }

        if (typeof point.id === 'string' && point.id.startsWith('derived-midpoint|')) {
            return point.id.replace('derived-', '');
        }

        return null;
    }

    getRatioSignatureForPointId(pointId) {
        const point = this.getPointById(pointId);
        if (!point || !point.isDerived) {
            return null;
        }

        if (typeof point.signature === 'string' && point.signature.startsWith('ratio|')) {
            return point.signature;
        }

        if (typeof point.id === 'string' && point.id.startsWith('derived-ratio|')) {
            return point.id.replace('derived-', '');
        }

        return null;
    }

    findMidpointObjectByPointId(pointId) {
        const signature = this.getMidpointSignatureForPointId(pointId);
        if (!signature) {
            return null;
        }

        return this.sceneObjects.find((entry) => entry.definition?.kind === 'midpoint-point' && entry.definition.signature === signature) || null;
    }

    findRatioPointObjectByPointId(pointId) {
        const signature = this.getRatioSignatureForPointId(pointId);
        if (!signature) {
            return null;
        }

        return this.sceneObjects.find((entry) => entry.definition?.kind === 'ratio-point' && entry.definition.signature === signature) || null;
    }

    findDerivedEdgePointObjectByPointId(pointId) {
        return this.findMidpointObjectByPointId(pointId) || this.findRatioPointObjectByPointId(pointId);
    }

    hasRatioPointForSignature(signature) {
        if (!signature) {
            return false;
        }

        return this.sceneObjects.some((entry) => entry.definition?.kind === 'ratio-point' && entry.definition.signature === signature);
    }

    removeEdgeLabelsForPointPair(pointIds, options = {}) {
        const normalized = this.normalizePointPairIds(pointIds);
        if (!normalized) {
            return;
        }

        const onlyIfDisconnected = options.onlyIfDisconnected === true;
        if (onlyIfDisconnected && this.canAttachLabelToPointPair(normalized)) {
            return;
        }

        const survivors = [];
        this.sceneObjects.forEach((entry) => {
            const definition = entry.definition;
            const isEdgeLabel = definition && (definition.kind === 'edge-label' || definition.kind === 'length-label') && Array.isArray(definition.pointIds) && definition.pointIds.length === 2;
            if (!isEdgeLabel) {
                survivors.push(entry);
                return;
            }

            const pair = this.normalizePointPairIds(definition.pointIds);
            const isTargetPair = !!pair && pair[0] === normalized[0] && pair[1] === normalized[1];
            if (!isTargetPair) {
                survivors.push(entry);
                return;
            }

            this.scene.remove(entry.object3D);
            this.disposeObject3D(entry.object3D);
        });

        this.sceneObjects = survivors;
    }

    removeShapeLabelsForPointSet(pointIds) {
        const targetKey = this.getShapeLabelKey(pointIds);
        if (!targetKey) {
            return;
        }

        const survivors = [];
        this.sceneObjects.forEach((entry) => {
            const definition = entry.definition;
            const isTargetShapeLabel = definition?.kind === 'shape-label'
                && this.getShapeLabelKey(definition.pointIds) === targetKey;
            if (!isTargetShapeLabel) {
                survivors.push(entry);
                return;
            }

            if (this.openLabelColorPickerId === entry.id) {
                this.openLabelColorPickerId = null;
            }
            this.scene.remove(entry.object3D);
            this.disposeObject3D(entry.object3D);
        });

        this.sceneObjects = survivors;
    }

    removeMidpointPointsForPair(pointIds, options = {}) {
        const normalized = this.normalizePointPairIds(pointIds);
        if (!normalized) {
            return;
        }

        const onlyIfDisconnected = options.onlyIfDisconnected === true;
        if (onlyIfDisconnected && this.canAttachMidpointToPointPair(normalized)) {
            return;
        }

        const signature = this.makeMidpointSignature(normalized);
        const survivors = [];
        this.sceneObjects.forEach((entry) => {
            if (entry.definition?.kind !== 'midpoint-point' || entry.definition.signature !== signature) {
                survivors.push(entry);
                return;
            }

            this.scene.remove(entry.object3D);
            this.disposeObject3D(entry.object3D);
        });

        this.sceneObjects = survivors;
    }

    removeRatioPointsForPair(pointIds, options = {}) {
        const normalized = this.normalizePointPairIds(pointIds);
        if (!normalized) {
            return;
        }

        const onlyIfDisconnected = options.onlyIfDisconnected === true;
        if (onlyIfDisconnected && this.canAttachMidpointToPointPair(normalized)) {
            return;
        }

        const survivors = [];
        this.sceneObjects.forEach((entry) => {
            if (entry.definition?.kind !== 'ratio-point') {
                survivors.push(entry);
                return;
            }

            const pair = this.normalizePointPairIds(entry.definition.pointIds || []);
            const isTargetPair = !!pair && pair[0] === normalized[0] && pair[1] === normalized[1];
            if (!isTargetPair) {
                survivors.push(entry);
                return;
            }

            this.scene.remove(entry.object3D);
            this.disposeObject3D(entry.object3D);
        });

        this.sceneObjects = survivors;
    }

    getTriangleEdgePairs(pointIds) {
        if (!Array.isArray(pointIds) || pointIds.length !== 3) {
            return [];
        }

        return [
            [pointIds[0], pointIds[1]],
            [pointIds[1], pointIds[2]],
            [pointIds[2], pointIds[0]]
        ];
    }

    getPlaneEdgePairs(pointIds) {
        if (!Array.isArray(pointIds) || pointIds.length !== 4) {
            return [];
        }

        return [
            [pointIds[0], pointIds[1]],
            [pointIds[1], pointIds[2]],
            [pointIds[2], pointIds[3]],
            [pointIds[3], pointIds[0]]
        ];
    }

    getPolygonEdgePairsInOrder(pointIds) {
        if (!Array.isArray(pointIds)) {
            return [];
        }

        if (pointIds.length < 3) {
            return [];
        }

        return pointIds.map((pointId, index) => [pointId, pointIds[(index + 1) % pointIds.length]]);
    }

    ensureHiddenSupportSegment(pointIds, reasonLabel = 'Support edge', ownerId = null) {
        const normalized = this.normalizePointPairIds(pointIds);
        if (!normalized) {
            return;
        }

        if (this.canAttachLabelToPointPair(normalized)) {
            return;
        }

        this.addSceneObject({
            type: 'segment',
            name: `Ghost ${this.formatPointSequence(normalized)}`,
            subtitle: reasonLabel,
            object3D: new THREE.Group(),
            definition: {
                kind: 'segment',
                pointIds: normalized,
                hidden: true,
                supportOwnerId: ownerId
            }
        });
    }

    ensureHiddenSupportSegmentsForPairs(pairs, reasonLabel = 'Support edge', ownerId = null) {
        if (!Array.isArray(pairs) || pairs.length === 0) {
            return;
        }

        pairs.forEach((pair) => {
            this.ensureHiddenSupportSegment(pair, reasonLabel, ownerId);
        });
    }

    removeHiddenSupportSegmentsForOwner(ownerId) {
        if (!Number.isFinite(ownerId)) {
            return;
        }

        const survivors = [];
        const removedPairs = [];
        this.sceneObjects.forEach((entry) => {
            const definition = entry.definition;
            const isOwnedHiddenSupportSegment = !!definition
                && definition.kind === 'segment'
                && definition.hidden === true
                && definition.supportOwnerId === ownerId;

            if (!isOwnedHiddenSupportSegment) {
                survivors.push(entry);
                return;
            }

            const pair = this.normalizePointPairIds(definition.pointIds || []);
            if (pair) {
                removedPairs.push(pair);
            }

            this.scene.remove(entry.object3D);
            this.disposeObject3D(entry.object3D);
        });

        this.sceneObjects = survivors;

        removedPairs.forEach((pair) => {
            this.removeEdgeLabelsForPointPair(pair, { onlyIfDisconnected: true });
            this.removeMidpointPointsForPair(pair, { onlyIfDisconnected: true });
            this.removeRatioPointsForPair(pair, { onlyIfDisconnected: true });
        });
    }

    normalizePointLabelInput(rawLabel) {
        if (typeof rawLabel !== 'string') {
            return null;
        }

        const trimmed = rawLabel.trim().toUpperCase();
        if (!/^[A-Z](?:\d)?$/.test(trimmed)) {
            return null;
        }

        return trimmed;
    }

    isPointLabelAvailable(label, excludePointId = null) {
        return !this.getAllPoints().some((point) => point.id !== excludePointId && point.label === label);
    }

    makeDerivedSignature(firstSegment, secondSegment, intersectionPoint) {
        const firstKey = [...firstSegment.pointIds].sort().join('-');
        const secondKey = [...secondSegment.pointIds].sort().join('-');
        const [leftKey, rightKey] = [firstKey, secondKey].sort();
        const x = intersectionPoint.x.toFixed(3);
        const y = intersectionPoint.y.toFixed(3);
        const z = intersectionPoint.z.toFixed(3);
        return `${leftKey}|${rightKey}|${x}|${y}|${z}`;
    }

    makeMidpointSignature(pointIds) {
        const normalized = this.normalizePointPairIds(pointIds);
        return normalized ? `midpoint|${normalized[0]}|${normalized[1]}` : null;
    }

    makeRatioPointSignature(pointIds, leftValue, rightValue) {
        const normalizedPair = this.normalizePointPairIds(pointIds);
        const ratio = this.reduceRatio(leftValue, rightValue);
        if (!normalizedPair || !ratio) {
            return null;
        }

        const usesNormalizedOrder = normalizedPair[0] === pointIds[0] && normalizedPair[1] === pointIds[1];
        const left = usesNormalizedOrder ? ratio.left : ratio.right;
        const right = usesNormalizedOrder ? ratio.right : ratio.left;
        return `ratio|${normalizedPair[0]}|${normalizedPair[1]}|${left}|${right}`;
    }

    getDerivedEdgeBasePairFromSignature(signature) {
        if (typeof signature !== 'string') {
            return null;
        }

        const midpointMatch = /^midpoint\|([^|]+)\|([^|]+)$/.exec(signature);
        if (midpointMatch) {
            return this.normalizePointPairIds([midpointMatch[1], midpointMatch[2]]);
        }

        const ratioMatch = /^ratio\|([^|]+)\|([^|]+)\|([1-9]\d*)\|([1-9]\d*)$/.exec(signature);
        if (ratioMatch) {
            return this.normalizePointPairIds([ratioMatch[1], ratioMatch[2]]);
        }

        return null;
    }

    getDerivedEdgeBasePairForPointId(pointId) {
        const midpointSignature = this.getMidpointSignatureForPointId(pointId);
        if (midpointSignature) {
            return this.getDerivedEdgeBasePairFromSignature(midpointSignature);
        }

        const ratioSignature = this.getRatioSignatureForPointId(pointId);
        if (ratioSignature) {
            return this.getDerivedEdgeBasePairFromSignature(ratioSignature);
        }

        return null;
    }

    async changeSelectedPointLabel() {
        const pointId = this.selectedPoints[0];
        const point = this.getPointById(pointId);
        if (!point) {
            return;
        }

        const nextLabelRaw = await this.showPromptModal(`Change label for point ${point.label}`, point.label);
        if (nextLabelRaw == null) {
            return;
        }

        const nextLabel = this.normalizePointLabelInput(nextLabelRaw);
        if (!nextLabel) {
            await this.showAlertModal('Use label format A or A1 (single letter, optional single digit).');
            return;
        }

        if (!this.isPointLabelAvailable(nextLabel, point.id)) {
            await this.showAlertModal(`Label ${nextLabel} is already in use.`);
            return;
        }

        if (point.isDerived) {
            point.label = nextLabel;
            if (point.signature) {
                this.derivedLabelOverrides.set(point.signature, nextLabel);
            }
        } else {
            point.label = nextLabel;
            if (Array.isArray(point.sourceIds) && point.sourceIds.length > 0) {
                point.sourceIds.forEach((sourceId) => {
                    this.baseLabelOverrides.set(sourceId, nextLabel);
                });
            }
            this.refreshDerivedPoints();
        }

        this.buildPointMarkers();
        this.renderObjectsList({ persist: true });
        this.clearSelection();
    }

    updatePanelCopy() {
        if (!this.primitiveChip || !this.orientationChip) {
            return;
        }

        if (this.compositeSlots.length === 0) {
            this.primitiveChip.textContent = '-';
            this.orientationChip.textContent = '-';
            return;
        }
        const slot0 = this.compositeSlots[0];
        const extra = this.compositeSlots.length - 1;
        this.primitiveChip.textContent = extra > 0
            ? `${this.primitiveMeta[slot0.primitive].label} +${extra}`
            : this.primitiveMeta[slot0.primitive].label;
        const orientationLabel = this.orientations[slot0.primitive].find((o) => o.value === slot0.orientation)?.label || 'Standard';
        this.orientationChip.textContent = extra > 0 ? 'Composite' : orientationLabel;
    }

    createSlotDefinition(slot) {
        const group = new THREE.Group();
        const primitiveKey = slot.primitive;
        const params = slot.params;
        let points = [];
        let geometry;
        let boundsRadius = 6;
        let guideCircles = [];
        let guideSegments = [];
        let intrinsicRightAngleEdgePairs = [];

        if (primitiveKey === 'cuboid') {
            const { width, depth, height } = params;
            geometry = new THREE.BoxGeometry(width, height, depth);
            points = [
                { id: 'A', label: 'A', description: 'bottom front left', position: new THREE.Vector3(-width / 2, -height / 2, depth / 2) },
                { id: 'B', label: 'B', description: 'bottom front right', position: new THREE.Vector3(width / 2, -height / 2, depth / 2) },
                { id: 'C', label: 'C', description: 'bottom back right', position: new THREE.Vector3(width / 2, -height / 2, -depth / 2) },
                { id: 'D', label: 'D', description: 'bottom back left', position: new THREE.Vector3(-width / 2, -height / 2, -depth / 2) },
                { id: 'E', label: 'E', description: 'top front left', position: new THREE.Vector3(-width / 2, height / 2, depth / 2) },
                { id: 'F', label: 'F', description: 'top front right', position: new THREE.Vector3(width / 2, height / 2, depth / 2) },
                { id: 'G', label: 'G', description: 'top back right', position: new THREE.Vector3(width / 2, height / 2, -depth / 2) },
                { id: 'H', label: 'H', description: 'top back left', position: new THREE.Vector3(-width / 2, height / 2, -depth / 2) }
            ];
            intrinsicRightAngleEdgePairs = [
                ['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A'],
                ['E', 'F'], ['F', 'G'], ['G', 'H'], ['H', 'E'],
                ['A', 'E'], ['B', 'F'], ['C', 'G'], ['D', 'H']
            ];

            const centersMode = this.getCuboidFaceCentersMode(params);
            if (centersMode === 'front-back' || centersMode === 'all') {
                points.push(
                    { id: 'I', label: 'I', description: 'front centre', position: new THREE.Vector3(0, 0, depth / 2) },
                    { id: 'J', label: 'J', description: 'back centre', position: new THREE.Vector3(0, 0, -depth / 2) }
                );
            }
            if (centersMode === 'left-right' || centersMode === 'all') {
                points.push(
                    { id: 'K', label: 'K', description: 'left centre', position: new THREE.Vector3(-width / 2, 0, 0) },
                    { id: 'L', label: 'L', description: 'right centre', position: new THREE.Vector3(width / 2, 0, 0) }
                );
            }
            if (centersMode === 'top-bottom' || centersMode === 'all') {
                points.push(
                    { id: 'M', label: 'M', description: 'top centre', position: new THREE.Vector3(0, height / 2, 0) },
                    { id: 'N', label: 'N', description: 'bottom centre', position: new THREE.Vector3(0, -height / 2, 0) }
                );
            }

            boundsRadius = Math.max(width, depth, height) * 1.15;
        } else if (primitiveKey === 'right-triangle-prism') {
            const { legA, legB, length, triangleMode } = params;
            const zFront = length / 2;
            const zBack = -length / 2;

            const mode = normalizeTriangularPrismMode(triangleMode);
            const [posA, posB, posC] = getTriangularPrismProfilePoints(params, zFront);

            const posD = new THREE.Vector3(posA.x, posA.y, zBack);
            const posE = new THREE.Vector3(posB.x, posB.y, zBack);
            const posF = new THREE.Vector3(posC.x, posC.y, zBack);

            const vertices = [
                posA.x, posA.y, posA.z,
                posB.x, posB.y, posB.z,
                posC.x, posC.y, posC.z,
                posD.x, posD.y, posD.z,
                posE.x, posE.y, posE.z,
                posF.x, posF.y, posF.z
            ];

            const indices = [
                0, 1, 2,
                3, 5, 4,
                0, 1, 4,
                0, 4, 3,
                0, 3, 5,
                0, 5, 2,
                1, 2, 5,
                1, 5, 4
            ];

            geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
            geometry.setIndex(indices);
            geometry.computeVertexNormals();

            const modeDesc = mode === 'isosceles' ? 'isosceles' : mode === 'right-above-B' ? 'right angle at B' : 'right angle at A';
            points = [
                { id: 'A', label: 'A', description: `front base A (${modeDesc})`, position: posA },
                { id: 'B', label: 'B', description: `front base B (${modeDesc})`, position: posB },
                { id: 'C', label: 'C', description: `front apex C (${modeDesc})`, position: posC },
                { id: 'D', label: 'D', description: `back base A (${modeDesc})`, position: posD },
                { id: 'E', label: 'E', description: `back base B (${modeDesc})`, position: posE },
                { id: 'F', label: 'F', description: `back apex C (${modeDesc})`, position: posF }
            ];
            intrinsicRightAngleEdgePairs = [
                ['A', 'B'], ['B', 'C'], ['C', 'A'],
                ['D', 'E'], ['E', 'F'], ['F', 'D'],
                ['A', 'D'], ['B', 'E'], ['C', 'F']
            ];

            boundsRadius = Math.max(legA, legB, length) * 1.2;
        } else if (getPolygonalPrimitiveConfig(primitiveKey)?.kind === 'prism') {
            const polygonal = buildRegularPolygonPrismDefinition(getPolygonalPrimitiveConfig(primitiveKey).sides, params);
            geometry = polygonal.geometry;
            points = polygonal.points;
            guideSegments = polygonal.guideSegments || [];
            boundsRadius = polygonal.boundsRadius;
        } else if (getPolygonalPrimitiveConfig(primitiveKey)?.kind === 'pyramid') {
            const polygonal = buildRegularPolygonPyramidDefinition(getPolygonalPrimitiveConfig(primitiveKey).sides, params);
            geometry = polygonal.geometry;
            points = polygonal.points;
            guideSegments = polygonal.guideSegments || [];
            boundsRadius = polygonal.boundsRadius;
        } else if (primitiveKey === 'tetrahedron') {
            const { height, baseTriangleMode, apexPosition } = params;
            const tetrahedronPoints = getTetrahedronPointMap(params);
            const { A: baseA, B: baseB, C: baseC, D: apex } = tetrahedronPoints;
            const apexTargetKey = apexPosition || 'A';

            const vertices = [
                baseA.x, baseA.y, baseA.z,
                baseB.x, baseB.y, baseB.z,
                baseC.x, baseC.y, baseC.z,
                apex.x, apex.y, apex.z
            ];

            const indices = [
                0, 2, 1,
                0, 1, 3,
                1, 2, 3,
                2, 0, 3
            ];

            geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
            geometry.setIndex(indices);
            geometry.computeVertexNormals();

            const baseMode = normalizeTetrahedronBaseMode(baseTriangleMode);
            const modeDesc = baseMode === 'right-angled'
                ? 'right-angled base'
                : baseMode === 'equilateral'
                    ? 'equilateral base'
                    : 'isosceles base';
            const apexDesc = apexTargetKey === 'center'
                ? 'apex vertically above base centroid'
                : `apex ${this.tetrahedronApexPositions.find((opt) => opt.value === apexTargetKey)?.label?.toLowerCase() || 'above A'}`;
            points = [
                { id: 'A', label: 'A', description: `base vertex A (${modeDesc})`, position: baseA },
                { id: 'B', label: 'B', description: `base vertex B (${modeDesc})`, position: baseB },
                { id: 'C', label: 'C', description: `base vertex C (${modeDesc})`, position: baseC },
                { id: 'D', label: 'D', description: apexDesc, position: apex }
            ];
            intrinsicRightAngleEdgePairs = [
                ['A', 'B'], ['B', 'C'], ['C', 'A'],
                ['A', 'D'], ['B', 'D'], ['C', 'D']
            ];

            boundsRadius = Math.max(params.base, getTetrahedronBaseTriangleHeight(params), height) * 1.2;
        } else if (primitiveKey === 'sphere') {
            const { radius } = params;
            geometry = new THREE.SphereGeometry(radius, 48, 32);
            points = [
                { id: 'A', label: 'A', description: 'top', position: new THREE.Vector3(0, radius, 0) },
                { id: 'B', label: 'B', description: 'bottom', position: new THREE.Vector3(0, -radius, 0) },
                { id: 'C', label: 'C', description: 'front', position: new THREE.Vector3(0, 0, radius) },
                { id: 'D', label: 'D', description: 'right', position: new THREE.Vector3(radius, 0, 0) },
                { id: 'E', label: 'E', description: 'back', position: new THREE.Vector3(0, 0, -radius) },
                { id: 'F', label: 'F', description: 'left', position: new THREE.Vector3(-radius, 0, 0) },
                { id: 'O', label: 'O', description: 'centre', position: new THREE.Vector3(0, 0, 0) }
            ];

            const segments = 128;
            const equator = [];
            const meridianYZ = [];
            const meridianXY = [];
            for (let i = 0; i < segments; i += 1) {
                const t = (i / segments) * Math.PI * 2;
                equator.push(new THREE.Vector3(radius * Math.cos(t), 0, radius * Math.sin(t)));
                meridianYZ.push(new THREE.Vector3(0, radius * Math.sin(t), radius * Math.cos(t)));
                meridianXY.push(new THREE.Vector3(radius * Math.cos(t), radius * Math.sin(t), 0));
            }
            guideCircles = [equator, meridianYZ, meridianXY];

            boundsRadius = radius * 1.35;
        } else if (primitiveKey === 'hemisphere') {
            const { radius } = params;
            geometry = new THREE.SphereGeometry(radius, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
            geometry.translate(0, -radius / 2, 0);
            points = [
                { id: 'A', label: 'A', description: 'dome top', position: new THREE.Vector3(0, radius / 2, 0) },
                { id: 'B', label: 'B', description: 'rim front', position: new THREE.Vector3(0, -radius / 2, radius) },
                { id: 'C', label: 'C', description: 'rim right', position: new THREE.Vector3(radius, -radius / 2, 0) },
                { id: 'D', label: 'D', description: 'rim back', position: new THREE.Vector3(0, -radius / 2, -radius) },
                { id: 'E', label: 'E', description: 'rim left', position: new THREE.Vector3(-radius, -radius / 2, 0) },
                { id: 'F', label: 'F', description: 'flat face centre', position: new THREE.Vector3(0, -radius / 2, 0) }
            ];
            boundsRadius = radius * 1.35;
        } else if (primitiveKey === 'cylinder') {
            const { radius, height } = params;
            geometry = new THREE.CylinderGeometry(radius, radius, height, 48, 1, false);
            if (slot.orientation === 'horizontal') {
                geometry.rotateZ(Math.PI / 2);
                points = [
                    { id: 'C', label: 'C', description: 'right top', position: new THREE.Vector3(height / 2, radius, 0) },
                    { id: 'D', label: 'D', description: 'right bottom', position: new THREE.Vector3(height / 2, -radius, 0) },
                    { id: 'E', label: 'E', description: 'left top', position: new THREE.Vector3(-height / 2, radius, 0) },
                    { id: 'F', label: 'F', description: 'left bottom', position: new THREE.Vector3(-height / 2, -radius, 0) }
                ];
                if (this.isCylinderEndCentersVisible(params)) {
                    points.unshift(
                        { id: 'A', label: 'A', description: 'right centre', position: new THREE.Vector3(height / 2, 0, 0) },
                        { id: 'B', label: 'B', description: 'left centre', position: new THREE.Vector3(-height / 2, 0, 0) }
                    );
                }
            } else {
                points = [
                    { id: 'C', label: 'C', description: 'top front', position: new THREE.Vector3(0, height / 2, radius) },
                    { id: 'D', label: 'D', description: 'top back', position: new THREE.Vector3(0, height / 2, -radius) },
                    { id: 'E', label: 'E', description: 'bottom front', position: new THREE.Vector3(0, -height / 2, radius) },
                    { id: 'F', label: 'F', description: 'bottom back', position: new THREE.Vector3(0, -height / 2, -radius) }
                ];
                if (this.isCylinderEndCentersVisible(params)) {
                    points.unshift(
                        { id: 'A', label: 'A', description: 'top centre', position: new THREE.Vector3(0, height / 2, 0) },
                        { id: 'B', label: 'B', description: 'bottom centre', position: new THREE.Vector3(0, -height / 2, 0) }
                    );
                }
            }
            if (this.isCylinderCenterVisible(params)) {
                points.push({ id: 'O', label: 'O', description: 'midpoint', position: new THREE.Vector3(0, 0, 0) });
            }
            boundsRadius = Math.max(radius * 2, height) * 1.15;
        } else if (primitiveKey === 'cone') {
            const { radius, height } = params;
            geometry = new THREE.ConeGeometry(radius, height, 48, 1, false);
            if (slot.orientation === 'apex-down') {
                geometry.rotateZ(Math.PI);
                points = [
                    { id: 'A', label: 'A', description: 'apex', position: new THREE.Vector3(0, -height / 2, 0) },
                    { id: 'B', label: 'B', description: 'base centre', position: new THREE.Vector3(0, height / 2, 0) },
                    { id: 'C', label: 'C', description: 'base front', position: new THREE.Vector3(0, height / 2, radius) },
                    { id: 'D', label: 'D', description: 'base right', position: new THREE.Vector3(radius, height / 2, 0) },
                    { id: 'E', label: 'E', description: 'base back', position: new THREE.Vector3(0, height / 2, -radius) },
                    { id: 'F', label: 'F', description: 'base left', position: new THREE.Vector3(-radius, height / 2, 0) }
                ];
            } else if (slot.orientation === 'sideways-right') {
                geometry.rotateZ(-Math.PI / 2);
                points = [
                    { id: 'A', label: 'A', description: 'apex', position: new THREE.Vector3(height / 2, 0, 0) },
                    { id: 'B', label: 'B', description: 'base centre', position: new THREE.Vector3(-height / 2, 0, 0) },
                    { id: 'C', label: 'C', description: 'base top', position: new THREE.Vector3(-height / 2, radius, 0) },
                    { id: 'D', label: 'D', description: 'base front', position: new THREE.Vector3(-height / 2, 0, radius) },
                    { id: 'E', label: 'E', description: 'base bottom', position: new THREE.Vector3(-height / 2, -radius, 0) },
                    { id: 'F', label: 'F', description: 'base back', position: new THREE.Vector3(-height / 2, 0, -radius) }
                ];
            } else {
                points = [
                    { id: 'A', label: 'A', description: 'apex', position: new THREE.Vector3(0, height / 2, 0) },
                    { id: 'B', label: 'B', description: 'base centre', position: new THREE.Vector3(0, -height / 2, 0) },
                    { id: 'C', label: 'C', description: 'base front', position: new THREE.Vector3(0, -height / 2, radius) },
                    { id: 'D', label: 'D', description: 'base right', position: new THREE.Vector3(radius, -height / 2, 0) },
                    { id: 'E', label: 'E', description: 'base back', position: new THREE.Vector3(0, -height / 2, -radius) },
                    { id: 'F', label: 'F', description: 'base left', position: new THREE.Vector3(-radius, -height / 2, 0) }
                ];
            }
            boundsRadius = Math.max(radius * 2, height) * 1.18;
        } else if (primitiveKey === 'rectangular-pyramid') {
            const { length, width, height } = params;
            const yBase = -height / 2;
            const yApex = height / 2;
            const baseA = new THREE.Vector3(-length / 2, yBase, width / 2);
            const baseB = new THREE.Vector3(length / 2, yBase, width / 2);
            const baseC = new THREE.Vector3(length / 2, yBase, -width / 2);
            const baseD = new THREE.Vector3(-length / 2, yBase, -width / 2);
            const apexTargets = {
                center: new THREE.Vector3(0, yApex, 0),
                A: new THREE.Vector3(baseA.x, yApex, baseA.z),
                B: new THREE.Vector3(baseB.x, yApex, baseB.z),
                C: new THREE.Vector3(baseC.x, yApex, baseC.z),
                D: new THREE.Vector3(baseD.x, yApex, baseD.z)
            };
            const selectedApexPosition = params.apexPosition || 'center';
            const apex = (apexTargets[selectedApexPosition] || apexTargets.center).clone();

            const localPoints = [baseA.clone(), baseB.clone(), baseC.clone(), baseD.clone(), apex.clone()];
            if (slot.orientation === 'apex-down') {
                localPoints.forEach((pt) => {
                    pt.x *= -1;
                    pt.y *= -1;
                });
            }

            const [A, B, C, D, E] = localPoints;
            const flatVertices = [
                A.x, A.y, A.z,
                B.x, B.y, B.z,
                C.x, C.y, C.z,
                D.x, D.y, D.z,
                E.x, E.y, E.z
            ];

            const indices = [
                0, 2, 1,
                0, 3, 2,
                0, 1, 4,
                1, 2, 4,
                2, 3, 4,
                3, 0, 4
            ];

            geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(flatVertices, 3));
            geometry.setIndex(indices);
            geometry.computeVertexNormals();

            const baseCentre = new THREE.Vector3(0, yBase, 0);
            if (slot.orientation === 'apex-down') {
                baseCentre.x *= -1;
                baseCentre.y *= -1;
            }

            const baseDescPrefix = slot.orientation === 'apex-down' ? 'top' : 'base';
            points = [
                { id: 'A', label: 'A', description: `${baseDescPrefix} front left`, position: A },
                { id: 'B', label: 'B', description: `${baseDescPrefix} front right`, position: B },
                { id: 'C', label: 'C', description: `${baseDescPrefix} back right`, position: C },
                { id: 'D', label: 'D', description: `${baseDescPrefix} back left`, position: D },
                { id: 'E', label: 'E', description: 'apex', position: E }
            ];
            if (this.isRectangularPyramidBaseCenterVisible(params)) {
                points.push({ id: 'O', label: 'O', description: 'base centre', position: baseCentre });
            }
            intrinsicRightAngleEdgePairs = [
                ['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A'],
                ['A', 'E'], ['B', 'E'], ['C', 'E'], ['D', 'E']
            ];
            boundsRadius = Math.max(length, width, height) * 1.15;
        } else {
            throw new Error(`Unknown primitive key: ${primitiveKey}`);
        }

        const material = new THREE.MeshPhongMaterial({
            color: 0x7db3e8,
            transparent: true,
            opacity: this.ghostFaces ? 0.14 : 0.46,
            side: THREE.DoubleSide,
            shininess: 90,
            specular: 0x315579,
            depthWrite: false
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.primitiveKey = primitiveKey;
        mesh.userData.slotId = slot.id;
        mesh.renderOrder = 5;
        const edgeGeometry = (primitiveKey === 'cone' || primitiveKey === 'cylinder' || primitiveKey === 'sphere' || primitiveKey === 'hemisphere')
            ? new THREE.EdgesGeometry(geometry, 30)
            : new THREE.EdgesGeometry(geometry);
        const edges = new THREE.LineSegments(
            edgeGeometry,
            new THREE.LineBasicMaterial({ color: this.getEdgeColor(), transparent: false, opacity: 1 })
        );
        edges.renderOrder = 6;
        group.add(mesh, edges);

        if (intrinsicRightAngleEdgePairs.length > 0) {
            const pointMap = new Map(points.map((point) => [point.id, point.position]));
            const intrinsicRightAngleTriples = this.collectRightAngleTriples(pointMap, intrinsicRightAngleEdgePairs);
            const sharedMarkerSizeByVertex = new Map();
            const primitiveCenterLocal = new THREE.Vector3();
            if (points.length > 0) {
                points.forEach((point) => primitiveCenterLocal.add(point.position));
                primitiveCenterLocal.multiplyScalar(1 / points.length);
            }

            intrinsicRightAngleTriples.forEach(([vertexId, armId1, armId2]) => {
                const vertex = pointMap.get(vertexId);
                const armPoint1 = pointMap.get(armId1);
                const armPoint2 = pointMap.get(armId2);
                if (!vertex || !armPoint1 || !armPoint2) return;

                const len1 = armPoint1.distanceTo(vertex);
                const len2 = armPoint2.distanceTo(vertex);
                if (len1 < 1e-6 || len2 < 1e-6) return;

                const candidateSize = THREE.MathUtils.clamp(Math.min(len1, len2) * 0.16, 0.15, 0.9);
                const existingSize = sharedMarkerSizeByVertex.get(vertexId);
                if (existingSize == null || candidateSize < existingSize) {
                    sharedMarkerSizeByVertex.set(vertexId, candidateSize);
                }
            });

            intrinsicRightAngleTriples.forEach(([vertexId, armId1, armId2]) => {
                const vertex = pointMap.get(vertexId);
                const armPoint1 = pointMap.get(armId1);
                const armPoint2 = pointMap.get(armId2);
                if (!vertex || !armPoint1 || !armPoint2) return;

                const arm1 = armPoint1.clone().sub(vertex);
                const arm2 = armPoint2.clone().sub(vertex);
                const faceNormalLocal = new THREE.Vector3().crossVectors(arm1, arm2);
                if (faceNormalLocal.lengthSq() < 1e-10) return;
                faceNormalLocal.normalize();

                const facePointLocal = vertex.clone().add(armPoint1).add(armPoint2).multiplyScalar(1 / 3);
                const outwardRef = facePointLocal.clone().sub(primitiveCenterLocal);
                if (faceNormalLocal.dot(outwardRef) < 0) {
                    faceNormalLocal.multiplyScalar(-1);
                }

                const marker = this.createRightAngleMarker(
                    vertex,
                    armPoint1,
                    armPoint2,
                    sharedMarkerSizeByVertex.get(vertexId),
                    true,
                    this.getEdgeColor()
                );
                if (marker) {
                    marker.userData.isIntrinsicRightAngleMarker = true;
                    marker.userData.faceNormalLocal = faceNormalLocal;
                    marker.userData.facePointLocal = facePointLocal;
                    group.add(marker);
                }
            });
        }

        if (guideCircles.length > 0) {
            guideCircles.forEach((circlePoints) => {
                const circleGeometry = new THREE.BufferGeometry().setFromPoints(circlePoints);
                const circle = new THREE.LineLoop(
                    circleGeometry,
                    new THREE.LineBasicMaterial({ color: this.getEdgeColor(), transparent: false, opacity: 1 })
                );
                circle.renderOrder = 7;
                group.add(circle);
            });
        }

        if (guideSegments.length > 0) {
            const segmentVertices = [];
            guideSegments.forEach(([start, end]) => {
                segmentVertices.push(start.x, start.y, start.z, end.x, end.y, end.z);
            });
            const apothemGeometry = new THREE.BufferGeometry();
            apothemGeometry.setAttribute('position', new THREE.Float32BufferAttribute(segmentVertices, 3));
            const apothemLines = new THREE.LineSegments(
                apothemGeometry,
                new THREE.LineBasicMaterial({
                    color: APOTHEM_LINE_COLOR,
                    transparent: false,
                    opacity: 1,
                    depthTest: false
                })
            );
            apothemLines.renderOrder = 8;
            apothemLines.userData.isApothemGuide = true;
            group.add(apothemLines);
        }

        return { group, mesh, points, boundsRadius };
    }

    updatePrimitiveMaterial() {
        this.primitiveMeshes.forEach((mesh) => {
            mesh.material.opacity = this.ghostFaces ? 0.14 : 0.46;
            mesh.material.needsUpdate = true;
        });
    }

    updateIntrinsicRightAngleMarkerVisibility() {
        if (!this.scene || !this.camera) return;

        this.scene.updateMatrixWorld(true);

        const facePointWorld = new THREE.Vector3();
        const faceNormalWorld = new THREE.Vector3();
        const toCamera = new THREE.Vector3();
        const hostWorldQ = new THREE.Quaternion();

        this.scene.traverse((obj) => {
            if (!obj.userData?.isIntrinsicRightAngleMarker) return;

            const facePointLocal = obj.userData.facePointLocal;
            const faceNormalLocal = obj.userData.faceNormalLocal;
            const hostGroup = obj.parent;
            if (!facePointLocal || !faceNormalLocal || !hostGroup) {
                obj.visible = true;
                return;
            }

            facePointWorld.copy(facePointLocal).applyMatrix4(hostGroup.matrixWorld);
            hostGroup.getWorldQuaternion(hostWorldQ);
            faceNormalWorld.copy(faceNormalLocal).applyQuaternion(hostWorldQ).normalize();
            toCamera.copy(this.camera.position).sub(facePointWorld);
            obj.visible = faceNormalWorld.dot(toCamera) >= 0;
        });
    }

    buildPointMarkers() {
        this.pointMarkers.forEach((marker) => {
            if (marker.parent) {
                marker.parent.remove(marker);
            }
            this.disposeObject3D(marker);
        });
        this.pointMarkers.clear();

        this.pointSprites.forEach((sprite) => {
            if (sprite.parent) {
                sprite.parent.remove(sprite);
            }
            this.disposeObject3D(sprite);
        });
        this.pointSprites = [];

        this.pointMarkers.clear();

        const markerRadius = this.getDisplayWorldMarkerRadius();
        const markerGeometry = new THREE.SphereGeometry(markerRadius, 18, 18);
        this.getAllPoints().forEach((point) => {
            const markerColor = 0x000000;
            const marker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: markerColor }));
            marker.position.copy(point.position);
            marker.visible = this.pointMarkersVisible && !this.isPointHidden(point);
            this.primitiveGroup.add(marker);
            this.pointMarkers.set(point.id, marker);

            const sprite = this.createTextSprite(point.label, {
                fontSize: 52,
                textColor: this.getLabelTextColor(),
                background: this.getPointColorHex(point),
                borderColor: '#000000'
            });
            sprite.position.copy(point.position.clone().add(new THREE.Vector3(0.18, 0.22, 0.18)));
            sprite.userData.pointId = point.id;
            this.primitiveGroup.add(sprite);
            this.pointSprites.push(sprite);
        });
        this.syncAllLabelVisibility();
    }

    renderPointsList() {
        this.pointsListEl.innerHTML = '';
        const allPoints = this.getAllPoints();
        allPoints.forEach((point) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'point-btn';
            if (point.isDerived) {
                button.classList.add('is-derived');
            }
            if (this.isPointHidden(point)) {
                button.classList.add('is-hidden');
            }
            button.dataset.pointId = point.id;
            if (this.selectedPoints.includes(point.id)) {
                button.classList.add('is-selected');
            }
            button.style.borderColor = this.getPointColorHex(point);
            const hiddenSuffix = this.isPointHidden(point) ? ', hidden' : '';
            button.setAttribute('aria-label', point.isDerived ? `${point.label}, derived point${hiddenSuffix}` : `Point ${point.label}${hiddenSuffix}`);
            button.title = `${point.isDerived ? `${point.label} - derived point` : point.label}${this.isPointHidden(point) ? ' (hidden)' : ''}`;
            const pointName = document.createElement('span');
            pointName.className = 'point-name';
            pointName.textContent = point.label;
            button.appendChild(pointName);
            this.pointsListEl.appendChild(button);
        });
        if (allPoints.length > 0 && this.selectedPoints.length === 0 && !this.pointsHintDismissed) {
            const hint = document.createElement('p');
            hint.className = 'section-note points-select-hint';
            hint.textContent = 'Select 1-8 labelled points in order to reveal available actions.';
            this.pointsListEl.appendChild(hint);
        }
        this.updatePrimarySectionCounts();
        this.updatePointMarkerStyles();
    }

    updatePrimarySectionCounts() {
        const updateSectionTitleCount = (titleEl, baseTitle, count) => {
            if (!titleEl) return;
            titleEl.textContent = baseTitle;
            if (count > 0) {
                const countEl = document.createElement('span');
                countEl.className = 'section-object-count';
                countEl.textContent = `${count}`;
                titleEl.appendChild(countEl);
            }
        };

        updateSectionTitleCount(this.primitiveSectionTitle, this.primitiveSectionBaseTitle, this.compositeSlots.length);
        updateSectionTitleCount(this.pointsSectionTitle, this.pointsSectionBaseTitle, this.getAllPoints().length);
    }

    updatePointMarkerStyles() {
        this.getAllPoints().forEach((point) => {
            const marker = this.pointMarkers.get(point.id);
            if (!marker) return;

            const isSelected = this.selectedPoints.includes(point.id);
            marker.material.color.set(0x000000);
            marker.scale.setScalar(isSelected ? 1.45 : 1);
            marker.visible = this.pointMarkersVisible && !this.isPointHidden(point);
        });
    }

    isPointHidden(point) {
        if (!point) {
            return false;
        }

        if (point.isDerived) {
            const signature = point.signature || point.id;
            return !!signature && this.hiddenDerivedPointSignatures.has(signature);
        }

        return Array.isArray(point.sourceIds)
            && point.sourceIds.some((sourceId) => this.hiddenPointSourceIds.has(sourceId));
    }

    setPointHidden(point, hidden) {
        if (!point) {
            return;
        }

        if (point.isDerived) {
            const signature = point.signature || point.id;
            if (!signature) {
                return;
            }
            if (hidden) {
                this.hiddenDerivedPointSignatures.add(signature);
            } else {
                this.hiddenDerivedPointSignatures.delete(signature);
            }
            return;
        }

        (point.sourceIds || []).forEach((sourceId) => {
            if (hidden) {
                this.hiddenPointSourceIds.add(sourceId);
            } else {
                this.hiddenPointSourceIds.delete(sourceId);
            }
        });
    }

    pruneHiddenPointState() {
        const validSourceIds = new Set();
        this.pointDefinitions.forEach((point) => {
            (point.sourceIds || []).forEach((sourceId) => validSourceIds.add(sourceId));
        });
        this.hiddenPointSourceIds = new Set([...this.hiddenPointSourceIds].filter((sourceId) => validSourceIds.has(sourceId)));

        const validDerivedSignatures = new Set(this.derivedPoints
            .map((point) => point.signature || point.id)
            .filter(Boolean));
        this.hiddenDerivedPointSignatures = new Set([...this.hiddenDerivedPointSignatures].filter((signature) => validDerivedSignatures.has(signature)));
        this.basePointColorOverrides = new Map([...this.basePointColorOverrides].filter(([sourceId]) => validSourceIds.has(sourceId)));
        this.derivedPointColorOverrides = new Map([...this.derivedPointColorOverrides].filter(([signature]) => validDerivedSignatures.has(signature)));
    }

    hiddenPointCount() {
        return this.getAllPoints().filter((point) => this.isPointHidden(point)).length;
    }

    applyPointVisibilityChange() {
        this.pruneHiddenPointState();
        this.buildPointMarkers();
        this.renderPointsList();
        this.renderSelectionSummary();
        this.renderActions();
        this.renderObjectsList();
        this.scheduleLocalStateSave();
    }

    hideSelectedPoints() {
        this.selectedPoints
            .map((pointId) => this.getPointById(pointId))
            .filter(Boolean)
            .forEach((point) => this.setPointHidden(point, true));
        this.clearSelection();
        this.applyPointVisibilityChange();
    }

    showSelectedPoints() {
        this.selectedPoints
            .map((pointId) => this.getPointById(pointId))
            .filter(Boolean)
            .forEach((point) => this.setPointHidden(point, false));
        this.clearSelection();
        this.applyPointVisibilityChange();
    }

    showAllPoints() {
        this.hiddenPointSourceIds.clear();
        this.hiddenDerivedPointSignatures.clear();
        this.clearSelection();
        this.applyPointVisibilityChange();
    }

    togglePointSelection(pointId) {
        this.pointsHintDismissed = true;
        const existingIndex = this.selectedPoints.indexOf(pointId);
        if (existingIndex >= 0) {
            this.selectedPoints.splice(existingIndex, 1);
        } else {
            if (this.selectedPoints.length >= 8) {
                return;
            }
            this.selectedPoints.push(pointId);
        }

        if (this.openPointColorPickerId && !this.selectedPoints.includes(this.openPointColorPickerId)) {
            this.openPointColorPickerId = null;
        }

        this.renderPointsList();
        this.renderSelectionSummary();
        this.renderActions();
    }

    clearSelection() {
        this.selectedPoints = [];
        this.openPointColorPickerId = null;
        this.renderPointsList();
        this.renderSelectionSummary();
        this.renderActions();
    }

    renderSelectionSummary() {
        this.selectionSummaryEl.innerHTML = '';
        if (this.selectedPoints.length === 0) {
            this.selectionSummaryEl.classList.add('empty');
            return;
        }

        this.selectionSummaryEl.classList.remove('empty');
        this.selectedPoints.forEach((pointId, index) => {
            const pill = document.createElement('span');
            pill.className = 'selection-pill';
            pill.textContent = this.getPointById(pointId)?.label || pointId;
            this.selectionSummaryEl.appendChild(pill);

            if (index < this.selectedPoints.length - 1) {
                const arrow = document.createElement('span');
                arrow.className = 'selection-arrow';
                arrow.textContent = '->';
                this.selectionSummaryEl.appendChild(arrow);
            }
        });
    }

    renderActions() {
        this.actionsListEl.innerHTML = '';
        const actions = this.getValidActionsForSelection();

        if (actions.length === 0 && this.selectedPoints.length !== 1) {
            return;
        }

        actions.forEach((action) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'action-btn';
            button.dataset.actionKey = action.key;
            button.textContent = action.label;
            this.actionsListEl.appendChild(button);
        });

        if (this.selectedPoints.length === 1) {
            const point = this.getPointById(this.selectedPoints[0]);
            const picker = this.createPointColorPicker(point);
            if (picker) {
                this.actionsListEl.appendChild(picker);
            }
        }
    }

    createPointColorPicker(point) {
        if (!point) {
            return null;
        }

        const currentColor = this.getPointColor(point);
        const currentColorHex = this.getConstructionColorHex(currentColor);
        const isOpen = this.openPointColorPickerId === point.id;
        const picker = document.createElement('div');
        picker.className = 'point-color-picker';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'segment-color-toggle point-color-toggle';
        toggle.dataset.pointColorTogglePointId = point.id;
        toggle.dataset.currentPointColor = String(currentColor);
        toggle.style.backgroundColor = currentColorHex;
        toggle.setAttribute('aria-label', `Choose color for point ${point.label}`);
        toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        toggle.title = `Choose point color (${currentColorHex})`;
        picker.appendChild(toggle);

        if (isOpen) {
            const palette = document.createElement('div');
            palette.className = 'segment-color-palette point-color-palette';
            palette.setAttribute('aria-label', `Point ${point.label} color`);
            this.getConstructionColorPalette().forEach((paletteColor) => {
                const normalizedColor = this.normalizeConstructionColor(paletteColor);
                const hex = this.getConstructionColorHex(normalizedColor);
                const swatch = document.createElement('button');
                swatch.type = 'button';
                swatch.className = 'segment-color-swatch point-color-swatch';
                swatch.dataset.pointColorPointId = point.id;
                swatch.dataset.pointColor = String(normalizedColor);
                swatch.style.backgroundColor = hex;
                swatch.setAttribute('aria-label', `Set point ${point.label} color to ${hex}`);
                swatch.setAttribute('aria-pressed', normalizedColor === currentColor ? 'true' : 'false');
                swatch.title = `Set point color to ${hex}`;
                palette.appendChild(swatch);
            });
            picker.appendChild(palette);
        }

        return picker;
    }

    togglePointColorPicker(pointId) {
        const point = this.getPointById(pointId);
        if (!point || this.selectedPoints.length !== 1 || this.selectedPoints[0] !== point.id) {
            return;
        }

        this.openPointColorPickerId = this.openPointColorPickerId === point.id ? null : point.id;
        this.renderActions();
    }

    changePointColor(pointId, color) {
        const point = this.getPointById(pointId);
        if (!point || this.selectedPoints.length !== 1 || this.selectedPoints[0] !== point.id) {
            return;
        }

        const nextColor = this.normalizeConstructionColor(color, this.getPointColor(point));
        if (nextColor === this.getPointColor(point)) {
            return;
        }

        if (!this.applyPointColorOverride(point, nextColor)) {
            return;
        }

        this.openPointColorPickerId = point.id;
        this.buildPointMarkers();
        this.renderPointsList();
        this.renderActions();
        this.scheduleLocalStateSave();
    }

    getValidActionsForSelection() {
        const baseActions = [...(this.actionsByCount[this.selectedPoints.length] || [])];
        const selectedPointObjects = this.selectedPoints
            .map((pointId) => this.getPointById(pointId))
            .filter(Boolean);
        const visibleSelectedCount = selectedPointObjects.filter((point) => !this.isPointHidden(point)).length;
        const hiddenSelectedCount = selectedPointObjects.filter((point) => this.isPointHidden(point)).length;

        if (visibleSelectedCount > 0) {
            baseActions.push({
                key: 'hide-selected-points',
                label: visibleSelectedCount === 1 ? 'Hide Point' : 'Hide Selected Points'
            });
        }
        if (hiddenSelectedCount > 0) {
            baseActions.push({
                key: 'show-selected-points',
                label: hiddenSelectedCount === 1 ? 'Show Point' : 'Show Selected Points'
            });
        }
        if (this.selectedPoints.length === 0 && this.hiddenPointCount() > 0) {
            baseActions.push({ key: 'show-all-points', label: 'Show All Points' });
        }

        const baseHighlightSelection = this.getBaseHighlightSelection();
        if (baseHighlightSelection) {
            baseActions.push({ key: 'base-highlight', label: baseHighlightSelection.actionLabel || 'Add Base Highlight' });
        }
        this.getConeBaseHighlightActionCandidatesForSelection().forEach((candidate) => {
            baseActions.push({ key: candidate.actionKey, label: candidate.actionLabel });
        });
        this.getSphereBaseHighlightActionCandidatesForSelection().forEach((candidate) => {
            baseActions.push({ key: candidate.actionKey, label: candidate.actionLabel });
        });

        if (this.selectedPoints.length === 1) {
            const derivedPointObject = this.findDerivedEdgePointObjectByPointId(this.selectedPoints[0]);
            if (derivedPointObject) {
                const label = derivedPointObject.definition?.kind === 'ratio-point' ? 'Delete Ratio Point' : 'Delete Midpoint';
                baseActions.push({ key: 'delete-derived-point', label });
            }
        }

        if (this.selectedPoints.length === 2) {
            const hasExistingSegment = this.hasExplicitSceneSegmentBetween(this.selectedPoints);
            const filteredActions = baseActions.filter((action) => action.key !== 'segment' || !hasExistingSegment);

            if (this.canAttachLabelToPointPair(this.selectedPoints)) {
                const hasExistingLabel = !!this.findEdgeLabelObject(this.selectedPoints);
                filteredActions.push({ key: 'edge-label', label: hasExistingLabel ? 'Change Label' : 'Add Label' });
            }

            if (this.canAttachMidpointToPointPair(this.selectedPoints)
                && this.canMaterializeEdgeDivisionPoint(this.selectedPoints)
                && !this.hasMidpointForPair(this.selectedPoints)) {
                filteredActions.push({ key: 'add-midpoint', label: 'Add Midpoint' });
            }

            if (this.canAttachMidpointToPointPair(this.selectedPoints)) {
                filteredActions.push({ key: 'add-ratio-point', label: 'Add Ratio Point' });
            }

            return filteredActions;
        }

        if (this.selectedPoints.length === 3) {
            return baseActions
                .filter((action) => {
                    if (action.key !== 'angle') {
                        return true;
                    }
                    return this.canAttachAngleFromOrderedPoints(this.selectedPoints);
                })
                .map((action) => {
                    if (action.key !== 'angle') {
                        return action;
                    }
                    const hasExistingAngle = !!this.findAngleObject(this.selectedPoints);
                    return {
                        ...action,
                        label: hasExistingAngle ? 'Change Angle' : 'Add Angle'
                    };
                });
        }

        if (this.selectedPoints.length !== 4) {
            return baseActions;
        }

        return baseActions.filter((action) => {
            if (action.key !== 'plane') {
                return true;
            }
            return this.areSelectedPointsCoplanar(this.selectedPoints);
        });
    }

    areSelectedPointsCoplanar(pointIds) {
        const vectors = this.getVectorsByPointIds(pointIds);
        if (!vectors || vectors.length !== 4) {
            return false;
        }

        const [p0, p1, p2, p3] = vectors;
        const v1 = p1.clone().sub(p0);
        const v2 = p2.clone().sub(p0);
        const normal = new THREE.Vector3().crossVectors(v1, v2);
        const normalLength = normal.length();

        // Degenerate quadruples (collinear/duplicate picks) do not define a plane region.
        if (normalLength < 1e-6) {
            return false;
        }

        const scale = Math.max(v1.length(), v2.length(), p3.distanceTo(p0), 1);
        const distanceToPlane = Math.abs(p3.clone().sub(p0).dot(normal.clone().normalize()));
        return distanceToPlane <= scale * 1e-4;
    }

    orderCoplanarPointIds(pointIds) {
        const points = pointIds.map((pointId) => this.getPointById(pointId)).filter(Boolean);
        if (points.length !== 4) {
            return pointIds;
        }

        const centroid = new THREE.Vector3();
        points.forEach((point) => centroid.add(point.position));
        centroid.multiplyScalar(1 / points.length);

        const baseVector = points[0].position.clone().sub(centroid);
        let normal = new THREE.Vector3();
        for (let index = 1; index < points.length - 1; index += 1) {
            const v1 = points[index].position.clone().sub(points[0].position);
            const v2 = points[index + 1].position.clone().sub(points[0].position);
            normal = new THREE.Vector3().crossVectors(v1, v2);
            if (normal.lengthSq() > 1e-8) {
                normal.normalize();
                break;
            }
        }

        if (normal.lengthSq() <= 1e-8 || baseVector.lengthSq() <= 1e-8) {
            return pointIds;
        }

        const axisX = baseVector.normalize();
        const axisY = new THREE.Vector3().crossVectors(normal, axisX).normalize();

        const ordered = points
            .map((point) => {
                const offset = point.position.clone().sub(centroid);
                const x = offset.dot(axisX);
                const y = offset.dot(axisY);
                return {
                    id: point.id,
                    angle: Math.atan2(y, x)
                };
            })
            .sort((left, right) => left.angle - right.angle)
            .map((entry) => entry.id);

        const originalFirstIndex = ordered.indexOf(pointIds[0]);
        if (originalFirstIndex <= 0) {
            return ordered;
        }

        return ordered.slice(originalFirstIndex).concat(ordered.slice(0, originalFirstIndex));
    }

    getPointById(pointId) {
        return this.getAllPoints().find((point) => point.id === pointId);
    }

    getAllPoints() {
        return [...this.pointDefinitions, ...this.derivedPoints];
    }

    refreshDerivedPoints() {
        const basePoints = new Map();
        this.pointDefinitions.forEach((point) => {
            basePoints.set(point.id, point.position.clone());
        });

        const usedLabels = new Set(this.pointDefinitions.map((point) => point.label));
        const candidateLetters = 'IJKLMNOPQRSTUVWXYZ'.split('').filter((letter) => !usedLabels.has(letter));
        let fallbackIndex = 1;

        const existingPointNear = (point, threshold = DERIVED_POINT_PROXIMITY_THRESHOLD) => {
            for (const [, existingPoint] of basePoints.entries()) {
                if (existingPoint.distanceTo(point) <= threshold) {
                    return true;
                }
            }
            return false;
        };

        const nextDerivedLabel = () => {
            if (candidateLetters.length > 0) {
                const label = candidateLetters.shift();
                usedLabels.add(label);
                return label;
            }
            const label = `P${fallbackIndex}`;
            fallbackIndex += 1;
            return label;
        };

        const derived = [];
        const activeDerivedSignatures = new Set();
        const edgeDivisionDefinitions = this.sceneObjects
            .map((entry) => entry.definition)
            .filter((definition) => (definition?.kind === 'midpoint-point' || definition?.kind === 'ratio-point') && Array.isArray(definition.pointIds) && definition.pointIds.length === 2);
        const seenEdgeDivisionSignatures = new Set();

        let pendingEdgeDivisions = edgeDivisionDefinitions;
        const maxEdgeDivisionPasses = Math.max(1, edgeDivisionDefinitions.length);
        for (let pass = 0; pass < maxEdgeDivisionPasses && pendingEdgeDivisions.length > 0; pass += 1) {
            const remaining = [];
            let resolvedThisPass = 0;

            pendingEdgeDivisions.forEach((definition) => {
                if (!this.canAttachMidpointToPointPair(definition.pointIds)) {
                    remaining.push(definition);
                    return;
                }

                const start = basePoints.get(definition.pointIds[0]);
                const end = basePoints.get(definition.pointIds[1]);
                if (!start || !end) {
                    remaining.push(definition);
                    return;
                }

                let signature = null;
                let position = null;
                let description = 'derived point';

                if (definition.kind === 'midpoint-point') {
                    signature = definition.signature || this.makeMidpointSignature(definition.pointIds);
                    position = start.clone().lerp(end, 0.5);
                    description = 'derived midpoint';
                }

                if (definition.kind === 'ratio-point') {
                    const ratio = this.reduceRatio(definition.ratioA, definition.ratioB);
                    if (!ratio || ratio.left === ratio.right) {
                        return;
                    }

                    signature = definition.signature || this.makeRatioPointSignature(definition.pointIds, ratio.left, ratio.right);
                    const distanceRatio = ratio.left / (ratio.left + ratio.right);
                    position = start.clone().lerp(end, distanceRatio);
                    description = `derived point in ratio ${ratio.left}:${ratio.right}`;
                }

                // Once an edge division has been created, keep it materialized even if a later
                // primitive resize moves it close to another point. The creation path prevents
                // new near-duplicate points; dropping a saved helper here would make an otherwise
                // valid diagram impossible to restore after a dimension change.
                if (!signature || !position || seenEdgeDivisionSignatures.has(signature)) {
                    return;
                }

                seenEdgeDivisionSignatures.add(signature);
                activeDerivedSignatures.add(signature);

                let label = this.derivedLabelOverrides.get(signature);
                if (label && usedLabels.has(label)) {
                    this.derivedLabelOverrides.delete(signature);
                    label = null;
                }

                if (!label) {
                    label = nextDerivedLabel();
                } else {
                    usedLabels.add(label);
                }

                const id = `derived-${signature}`;
                basePoints.set(id, position.clone());
                derived.push({
                    id,
                    label,
                    signature,
                    description,
                    position,
                    isDerived: true
                });
                resolvedThisPass += 1;
            });

            if (resolvedThisPass === 0) {
                break;
            }
            pendingEdgeDivisions = remaining;
        }

        const segments = this.getConstructionSegments(basePoints);

        for (let i = 0; i < segments.length; i += 1) {
            for (let j = i + 1; j < segments.length; j += 1) {
                const first = segments[i];
                const second = segments[j];

                const sharesEndpoint = first.pointIds.some((pointId) => second.pointIds.includes(pointId));
                if (sharesEndpoint) {
                    continue;
                }

                const intersection = this.findSegmentIntersection(first.start, first.end, second.start, second.end);
                if (!intersection) {
                    continue;
                }

                if (existingPointNear(intersection)) {
                    continue;
                }

                const signature = this.makeDerivedSignature(first, second, intersection);
                activeDerivedSignatures.add(signature);

                let label = this.derivedLabelOverrides.get(signature);
                if (label && usedLabels.has(label)) {
                    this.derivedLabelOverrides.delete(signature);
                    label = null;
                }

                if (!label) {
                    label = nextDerivedLabel();
                } else {
                    usedLabels.add(label);
                }

                const id = `derived-${signature}`;
                basePoints.set(id, intersection.clone());
                derived.push({
                    id,
                    label,
                    signature,
                    description: 'derived intersection',
                    position: intersection,
                    isDerived: true
                });
            }
        }

        if (!this.isRestoringSharedState) {
            Array.from(this.derivedLabelOverrides.keys()).forEach((signature) => {
                if (!activeDerivedSignatures.has(signature)) {
                    this.derivedLabelOverrides.delete(signature);
                }
            });
        }

        this.derivedPoints = derived;
        const validPointIds = new Set(this.getAllPoints().map((point) => point.id));
        this.selectedPoints = this.selectedPoints.filter((pointId) => validPointIds.has(pointId));
    }

    getConstructionSegments(pointMap) {
        const segments = [];

        const resolvePoint = (pointId) => pointMap.get(pointId);
        const pushSegment = (pointIdA, pointIdB) => {
            const start = resolvePoint(pointIdA);
            const end = resolvePoint(pointIdB);
            if (!start || !end) {
                return;
            }
            segments.push({ pointIds: [pointIdA, pointIdB], start, end });
        };

        this.sceneObjects.forEach((entry) => {
            const definition = entry.definition;
            if (!definition) {
                return;
            }

            if (definition.kind === 'segment' && definition.pointIds?.length === 2) {
                pushSegment(definition.pointIds[0], definition.pointIds[1]);
                return;
            }

            if (definition.kind === 'triangle' && definition.pointIds?.length === 3) {
                const ids = definition.pointIds;
                pushSegment(ids[0], ids[1]);
                pushSegment(ids[1], ids[2]);
                pushSegment(ids[2], ids[0]);
                return;
            }

            if (definition.kind === 'base-highlight' && definition.shape === 'polygon') {
                const ids = Array.isArray(definition.boundaryPointIds)
                    ? definition.boundaryPointIds
                    : definition.pointIds;
                if (Array.isArray(ids) && ids.length >= 3) {
                    for (let index = 0; index < ids.length; index += 1) {
                        pushSegment(ids[index], ids[(index + 1) % ids.length]);
                    }
                }
                return;
            }

            if (definition.kind === 'plane' && definition.pointIds?.length === 4) {
                const ids = definition.pointIds;
                pushSegment(ids[0], ids[1]);
                pushSegment(ids[1], ids[2]);
                pushSegment(ids[2], ids[3]);
                pushSegment(ids[3], ids[0]);
            }
        });

        return segments;
    }

    findSegmentIntersection(p1, p2, q1, q2) {
        const u = p2.clone().sub(p1);
        const v = q2.clone().sub(q1);
        const w0 = p1.clone().sub(q1);
        const a = u.dot(u);
        const b = u.dot(v);
        const c = v.dot(v);
        const d = u.dot(w0);
        const e = v.dot(w0);
        const denom = (a * c) - (b * b);

        if (Math.abs(denom) < 1e-8) {
            return null;
        }

        const s = ((b * e) - (c * d)) / denom;
        const t = ((a * e) - (b * d)) / denom;
        if (s < -1e-4 || s > 1 + 1e-4 || t < -1e-4 || t > 1 + 1e-4) {
            return null;
        }

        const pointOnFirst = p1.clone().add(u.multiplyScalar(s));
        const pointOnSecond = q1.clone().add(v.multiplyScalar(t));
        if (pointOnFirst.distanceTo(pointOnSecond) > 0.02) {
            return null;
        }

        return pointOnFirst.clone().add(pointOnSecond).multiplyScalar(0.5);
    }

    getSelectedVectors() {
        return this.selectedPoints.map((pointId) => this.getPointById(pointId)?.position.clone());
    }

    nextConstructionColor() {
        const color = this.constructionPalette[this.constructionColorIndex % this.constructionPalette.length];
        this.constructionColorIndex += 1;
        return color;
    }

    async runAction(actionKey) {
        const vectors = this.getSelectedVectors();
        if (vectors.some((value) => !value)) {
            return;
        }

        const selectedLabels = this.selectedPoints.map((pointId) => this.getPointById(pointId)?.label || pointId);

        if (actionKey === 'hide-selected-points') {
            this.hideSelectedPoints();
            this.closePanelOnMobile();
            return;
        }

        if (actionKey === 'show-selected-points') {
            this.showSelectedPoints();
            this.closePanelOnMobile();
            return;
        }

        if (actionKey === 'show-all-points') {
            this.showAllPoints();
            this.closePanelOnMobile();
            return;
        }

        if (actionKey === 'change-point-label') {
            await this.changeSelectedPointLabel();
            this.closePanelOnMobile();
            return;
        }

        if (actionKey === 'delete-derived-point') {
            if (this.selectedPoints.length !== 1) {
                return;
            }

            const derivedPointObject = this.findDerivedEdgePointObjectByPointId(this.selectedPoints[0]);
            if (!derivedPointObject) {
                return;
            }

            this.deleteObject(derivedPointObject.id);
            this.clearSelection();
            this.closePanelOnMobile();
            return;
        }

        if (actionKey === 'segment') {
            const ids = [...this.selectedPoints];
            if (this.hasExplicitSceneSegmentBetween(ids)) {
                this.clearSelection();
                this.closePanelOnMobile();
                return;
            }

            const color = this.nextConstructionColor();
            const segment = this.createSegment(vectors[0], vectors[1], color);
            this.addSceneObject({
                type: 'segment',
                name: `Segment ${this.formatPointSequence(ids)}`,
                subtitle: 'Two-point construction',
                object3D: segment,
                definition: {
                    kind: 'segment',
                    pointIds: ids,
                    color
                }
            });
        }

        if (actionKey === 'edge-label') {
            const ids = this.normalizePointPairIds([...this.selectedPoints]);
            if (!ids || !this.canAttachLabelToPointPair(ids)) {
                return;
            }

            const existingLabel = this.findEdgeLabelObject(ids);
            const currentText = existingLabel?.definition?.text || '';
            const promptText = existingLabel
                ? `Change label for ${this.formatPointSequence(ids)}`
                : `Label for ${this.formatPointSequence(ids)}`;
            const promptResult = await this.showPromptModal(promptText, currentText, {
                quickSymbols: true,
                colorPicker: this.getLabelColorPromptOptions(existingLabel?.definition || { kind: 'edge-label' })
            });
            if (promptResult == null) {
                return;
            }
            const nextText = typeof promptResult === 'object' ? promptResult.value : promptResult;
            if (!nextText.trim()) {
                return;
            }

            const normalizedText = nextText.trim();
            const selectedColor = typeof promptResult === 'object'
                ? this.normalizeConstructionColor(promptResult.color, this.getLabelDefinitionColor(existingLabel?.definition || { kind: 'edge-label' }))
                : this.getLabelDefinitionColor(existingLabel?.definition || { kind: 'edge-label' });
            const labelDefinition = this.applyLabelDefinitionColor({
                ...(existingLabel?.definition || {}),
                kind: 'edge-label',
                pointIds: ids,
                text: normalizedText
            }, selectedColor);
            const midpoint = vectors[0].clone().lerp(vectors[1], 0.5).add(new THREE.Vector3(0.2, 0.2, 0.2));
            const labelBackground = this.getLabelDefinitionColorHex(labelDefinition);
            const sprite = this.createTextSprite(normalizedText, {
                fontSize: 46,
                textColor: this.getLabelTextColor(),
                background: labelBackground,
                borderColor: '#000000'
            });
            sprite.position.copy(midpoint);

            if (existingLabel) {
                existingLabel.definition = labelDefinition;
                existingLabel.name = `Label ${this.formatPointSequence(ids)}`;
                existingLabel.subtitle = normalizedText;
                this.scene.remove(existingLabel.object3D);
                this.disposeObject3D(existingLabel.object3D);
                sprite.userData.sceneObjectId = existingLabel.id;
                existingLabel.object3D = sprite;
                existingLabel.object3D.visible = existingLabel.visible;
                this.scene.add(existingLabel.object3D);
                this.focusObjectSectionForType(existingLabel.type, existingLabel.definition);
                this.renderObjectsList({ persist: true });
                this.refreshDerivedPoints();
                this.buildPointMarkers();
                this.renderPointsList();
                this.renderSelectionSummary();
                this.renderActions();
            } else {
                this.addSceneObject({
                    type: 'label',
                    name: `Label ${this.formatPointSequence(ids)}`,
                    subtitle: normalizedText,
                    object3D: sprite,
                    definition: labelDefinition
                });
            }
        }

        if (actionKey === 'add-midpoint') {
            const ids = this.normalizePointPairIds([...this.selectedPoints]);
            if (!ids || !this.canAttachMidpointToPointPair(ids) || this.hasMidpointForPair(ids)) {
                return;
            }
            if (!this.canMaterializeEdgeDivisionPoint(ids)) {
                this.showToast('That midpoint would be too close to an existing point.');
                return;
            }
            if (!this.canAddSceneObjects(3)) {
                return;
            }

            const signature = this.makeMidpointSignature(ids);
            this.addSceneObject({
                type: 'label',
                name: `Midpoint ${this.formatPointSequence(ids)}`,
                subtitle: 'Derived midpoint',
                object3D: new THREE.Group(),
                definition: {
                    kind: 'midpoint-point',
                    pointIds: ids,
                    signature
                }
            });
            const derivedId = `derived-${signature}`;
            this.addSceneObject({
                type: 'segment',
                name: 'Ghost sub-segment A',
                subtitle: 'Midpoint sub-segment',
                object3D: new THREE.Group(),
                definition: { kind: 'segment', pointIds: [ids[0], derivedId], hidden: true }
            });
            this.addSceneObject({
                type: 'segment',
                name: 'Ghost sub-segment B',
                subtitle: 'Midpoint sub-segment',
                object3D: new THREE.Group(),
                definition: { kind: 'segment', pointIds: [derivedId, ids[1]], hidden: true }
            });
        }

        if (actionKey === 'add-ratio-point') {
            const orderedIds = [...this.selectedPoints];
            if (orderedIds.length !== 2 || !this.canAttachMidpointToPointPair(orderedIds)) {
                return;
            }

            const ratio = await this.showRatioPromptModal(`Split ${selectedLabels[0]} : ${selectedLabels[1]} in ratio`, 1, 2);
            if (!ratio) {
                return;
            }

            if (ratio.left === ratio.right) {
                await this.showAlertModal('Use Add Midpoint for a 1:1 split.');
                return;
            }

            const signature = this.makeRatioPointSignature(orderedIds, ratio.left, ratio.right);
            if (!signature || this.hasRatioPointForSignature(signature)) {
                await this.showAlertModal('That ratio point already exists on this edge.');
                return;
            }
            if (!this.canMaterializeEdgeDivisionPoint(orderedIds, ratio.left, ratio.right)) {
                this.showToast('That ratio point would be too close to an existing point.');
                return;
            }
            if (!this.canAddSceneObjects(3)) {
                return;
            }

            this.addSceneObject({
                type: 'label',
                name: `Ratio Point ${this.formatPointSequence(orderedIds)}`,
                subtitle: `Ratio ${ratio.left}:${ratio.right}`,
                object3D: new THREE.Group(),
                definition: {
                    kind: 'ratio-point',
                    pointIds: orderedIds,
                    ratioA: ratio.left,
                    ratioB: ratio.right,
                    signature
                }
            });
            const derivedId = `derived-${signature}`;
            this.addSceneObject({
                type: 'segment',
                name: 'Ghost sub-segment A',
                subtitle: 'Ratio-point sub-segment',
                object3D: new THREE.Group(),
                definition: { kind: 'segment', pointIds: [orderedIds[0], derivedId], hidden: true }
            });
            this.addSceneObject({
                type: 'segment',
                name: 'Ghost sub-segment B',
                subtitle: 'Ratio-point sub-segment',
                object3D: new THREE.Group(),
                definition: { kind: 'segment', pointIds: [derivedId, orderedIds[1]], hidden: true }
            });
        }

        if (actionKey === 'triangle') {
            const ids = [...this.selectedPoints];
            const color = this.nextConstructionColor();
            const triangle = this.createTriangle(vectors[0], vectors[1], vectors[2], color, 0.28);
            const triangleObject = this.addSceneObject({
                type: 'triangle',
                name: `Triangle ${this.formatPointSequence(ids)}`,
                subtitle: 'Three-point section',
                object3D: triangle,
                definition: {
                    kind: 'triangle',
                    pointIds: ids,
                    color,
                    opacity: 0.28
                }
            });
            this.ensureHiddenSupportSegmentsForPairs(this.getTriangleEdgePairs(ids), 'Triangle support edge', triangleObject?.id ?? null);
        }

        if (actionKey === 'angle') {
            const ids = [...this.selectedPoints];
            if (!this.canAttachAngleFromOrderedPoints(ids)) {
                return;
            }

            const existingAngle = this.findAngleObject(ids);
            let angleLabelInput = existingAngle
                ? this.getAngleLabelText(existingAngle.definition)
                : this.formatPointSequence(ids);
            const promptText = existingAngle
                ? `Change label for angle at ${selectedLabels[1]}`
                : `Label for angle at ${selectedLabels[1]}`;
            const promptResult = await this.showPromptModal(promptText, angleLabelInput, {
                quickSymbols: true,
                colorPicker: this.getAngleLabelColorPromptOptions(existingAngle?.definition)
            });
            if (promptResult == null) {
                return;
            }

            angleLabelInput = (typeof promptResult === 'object' ? promptResult.value : promptResult).trim();
            const labelColor = typeof promptResult === 'object'
                ? this.normalizeConstructionColor(promptResult.color, this.getAngleLabelColor(existingAngle?.definition))
                : this.getAngleLabelColor(existingAngle?.definition);
            const color = existingAngle?.definition?.color ?? this.nextConstructionColor();
            const angleDefinition = this.applyAngleLabelDefinitionColor({
                kind: 'angle',
                pointIds: ids,
                text: angleLabelInput,
                color
            }, labelColor);
            const angleGroup = this.createAngleMarker(
                vectors[0],
                vectors[1],
                vectors[2],
                this.getAngleLabelText(angleDefinition),
                color,
                this.getAngleLabelColor(angleDefinition)
            );
            const angleName = `Angle ${this.formatPointSequence(ids)}`;

            if (existingAngle) {
                existingAngle.name = angleName;
                existingAngle.subtitle = `Angle at ${selectedLabels[1]}`;
                existingAngle.definition = angleDefinition;
                this.scene.remove(existingAngle.object3D);
                this.disposeObject3D(existingAngle.object3D);
                angleGroup.userData.sceneObjectId = existingAngle.id;
                existingAngle.object3D = angleGroup;
                existingAngle.object3D.visible = existingAngle.visible;
                this.scene.add(existingAngle.object3D);
                this.focusObjectSectionForType(existingAngle.type, existingAngle.definition);
                this.renderObjectsList({ persist: true });
                this.renderSelectionSummary();
                this.renderActions();
            } else {
                this.addSceneObject({
                    type: 'angle',
                    name: angleName,
                    subtitle: `Angle at ${selectedLabels[1]}`,
                    object3D: angleGroup,
                    definition: angleDefinition
                });
            }
        }

        if (actionKey === 'plane') {
            const ids = [...this.selectedPoints];
            if (!this.areSelectedPointsCoplanar(ids)) {
                return;
            }
            const orderedIds = this.orderCoplanarPointIds(ids);
            const orderedVectors = this.getVectorsByPointIds(orderedIds);
            const color = this.nextConstructionColor();
            const plane = this.createQuad(orderedVectors, color, 0.2);
            const planeObject = this.addSceneObject({
                type: 'plane',
                name: `Quadrilateral ${this.formatPointSequence(orderedIds)}`,
                subtitle: 'Four-point coplanar patch',
                object3D: plane,
                definition: {
                    kind: 'plane',
                    pointIds: orderedIds,
                    color,
                    opacity: 0.2
                }
            });
            this.ensureHiddenSupportSegmentsForPairs(this.getPlaneEdgePairs(orderedIds), 'Quadrilateral support edge', planeObject?.id ?? null);
        }

        if (actionKey === 'base-highlight' || actionKey.startsWith('base-highlight:')) {
            const selection = this.getBaseHighlightSelectionForAction(actionKey);
            if (!selection) {
                return;
            }

            const color = this.nextConstructionColor();
            const definition = {
                kind: 'base-highlight',
                shape: selection.shape,
                pointIds: selection.pointIds,
                boundaryPointIds: selection.boundaryPointIds,
                centerPointId: selection.centerPointId || null,
                sourceSlotId: selection.sourceSlotId,
                sourceFaceId: selection.sourceFaceId,
                color,
                opacity: 0.2
            };
            const highlight = this.createBaseHighlightFromDefinition(definition);
            if (!highlight) {
                return;
            }

            this.addSceneObject({
                type: 'plane',
                name: `${selection.objectName || 'Base Highlight'} ${this.formatPointSequence(selection.pointIds)}`,
                subtitle: selection.subtitle || (selection.shape === 'circle' ? 'Circular base highlight' : 'Polygon base highlight'),
                object3D: highlight,
                definition
            });
        }

        this.clearSelection();
        this.closePanelOnMobile();
    }

    createSegment(start, end, color) {
        const segment = this.createThickPolyline([start, end], color, 5);
        segment.renderOrder = 21;
        return segment;
    }

    createThickPolyline(points, color, width = 5) {
        const geometry = new LineGeometry();
        geometry.setPositions(points.flatMap((point) => [point.x, point.y, point.z]));

        const material = new LineMaterial({
            color,
            linewidth: width,
            worldUnits: false,
            transparent: false,
            depthTest: false,
            depthWrite: false
        });
        material.resolution.set(this.canvas.clientWidth, this.canvas.clientHeight);
        this.constructionLineMaterials.add(material);

        const line = new Line2(geometry, material);
        line.computeLineDistances();
        return line;
    }

    createTriangle(a, b, c, color, opacity) {
        const geometry = new THREE.BufferGeometry();
        const vertices = new Float32Array([
            a.x, a.y, a.z,
            b.x, b.y, b.z,
            c.x, c.y, c.z
        ]);
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex([0, 1, 2]);
        geometry.computeVertexNormals();

        const material = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 20;

        const outline = this.createSegment(a, b, color);
        const outline2 = this.createSegment(b, c, color);
        const outline3 = this.createSegment(c, a, color);
        outline.renderOrder = 21;
        outline2.renderOrder = 21;
        outline3.renderOrder = 21;

        const triangleMarkerBaseSize = THREE.MathUtils.clamp(
            Math.min(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) * 0.16,
            0.15,
            0.9
        );

        const rightAngleMarkers = [
            this.createRightAngleMarker(a, b, c, triangleMarkerBaseSize, false, color, 5, 1.5),
            this.createRightAngleMarker(b, c, a, triangleMarkerBaseSize, false, color, 5, 1.5),
            this.createRightAngleMarker(c, a, b, triangleMarkerBaseSize, false, color, 5, 1.5)
        ].filter(Boolean);

        const group = new THREE.Group();
        group.add(mesh, outline, outline2, outline3, ...rightAngleMarkers);
        return group;
    }

    collectRightAngleTriples(pointMap, edgePairs) {
        const adjacency = new Map();
        const addNeighbor = (fromId, toId) => {
            if (!adjacency.has(fromId)) adjacency.set(fromId, new Set());
            adjacency.get(fromId).add(toId);
        };

        edgePairs.forEach(([idA, idB]) => {
            if (!pointMap.has(idA) || !pointMap.has(idB)) return;
            addNeighbor(idA, idB);
            addNeighbor(idB, idA);
        });

        const rightAngleTriples = [];
        const rightAngleToleranceRadians = THREE.MathUtils.degToRad(2);

        adjacency.forEach((neighborSet, vertexId) => {
            const neighbors = Array.from(neighborSet);
            const vertex = pointMap.get(vertexId);
            if (!vertex || neighbors.length < 2) return;

            for (let i = 0; i < neighbors.length; i += 1) {
                for (let j = i + 1; j < neighbors.length; j += 1) {
                    const armPoint1 = pointMap.get(neighbors[i]);
                    const armPoint2 = pointMap.get(neighbors[j]);
                    if (!armPoint1 || !armPoint2) continue;

                    const arm1 = armPoint1.clone().sub(vertex);
                    const arm2 = armPoint2.clone().sub(vertex);
                    if (arm1.lengthSq() < 1e-8 || arm2.lengthSq() < 1e-8) continue;

                    const cosTheta = THREE.MathUtils.clamp(arm1.normalize().dot(arm2.normalize()), -1, 1);
                    const angle = Math.acos(cosTheta);
                    if (Math.abs(angle - Math.PI / 2) <= rightAngleToleranceRadians) {
                        rightAngleTriples.push([vertexId, neighbors[i], neighbors[j]]);
                    }
                }
            }
        });

        return rightAngleTriples;
    }

    createRightAngleMarker(vertex, armPoint1, armPoint2, markerSizeOverride = null, useThinLine = false, markerColor = 0x000000, markerLineWidth = 5, sizeScale = 1) {
        const arm1 = armPoint1.clone().sub(vertex);
        const arm2 = armPoint2.clone().sub(vertex);
        const len1 = arm1.length();
        const len2 = arm2.length();
        if (len1 < 1e-6 || len2 < 1e-6) {
            return null;
        }

        const u = arm1.clone().normalize();
        const v = arm2.clone().normalize();
        const cosTheta = THREE.MathUtils.clamp(u.dot(v), -1, 1);
        const angle = Math.acos(cosTheta);
        const rightAngleToleranceRadians = THREE.MathUtils.degToRad(2);
        if (Math.abs(angle - Math.PI / 2) > rightAngleToleranceRadians) {
            return null;
        }

        const markerSize = typeof markerSizeOverride === 'number' && Number.isFinite(markerSizeOverride)
            ? markerSizeOverride
            : THREE.MathUtils.clamp(Math.min(len1, len2) * 0.16, 0.15, 0.9);
        const finalMarkerSize = markerSize * 0.5 * sizeScale;
        const p1 = vertex.clone().add(u.clone().multiplyScalar(finalMarkerSize));
        const p2 = p1.clone().add(v.clone().multiplyScalar(finalMarkerSize));
        const p3 = vertex.clone().add(v.clone().multiplyScalar(finalMarkerSize));

        if (useThinLine) {
            const markerGeometry = new THREE.BufferGeometry().setFromPoints([p1, p2, p3]);
            const markerLine = new THREE.Line(
                markerGeometry,
                new THREE.LineBasicMaterial({ color: markerColor, transparent: false, opacity: 1 })
            );
            markerLine.renderOrder = 22;
            return markerLine;
        }

        const markerLine = this.createThickPolyline([p1, p2, p3], markerColor, markerLineWidth);
        markerLine.renderOrder = 22;
        return markerLine;
    }

    createQuad(points, color, opacity) {
        const geometry = new THREE.BufferGeometry();
        const vertices = new Float32Array(points.flatMap((point) => [point.x, point.y, point.z]));
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity,
                side: THREE.DoubleSide,
                depthTest: false,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -2,
                polygonOffsetUnits: -2
            })
        );
        mesh.renderOrder = 20;

        const outline = new THREE.Group();
        outline.add(mesh);
        for (let index = 0; index < points.length; index += 1) {
            const nextIndex = (index + 1) % points.length;
            const edge = this.createSegment(points[index], points[nextIndex], color);
            edge.renderOrder = 21;
            outline.add(edge);
        }
        return outline;
    }

    createPolygonHighlight(points, color, opacity) {
        if (!Array.isArray(points) || points.length < 3) {
            return null;
        }

        const geometry = new THREE.BufferGeometry();
        const vertices = new Float32Array(points.flatMap((point) => [point.x, point.y, point.z]));
        const indices = [];
        for (let index = 1; index < points.length - 1; index += 1) {
            indices.push(0, index, index + 1);
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity,
                side: THREE.DoubleSide,
                depthTest: false,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -2,
                polygonOffsetUnits: -2
            })
        );
        mesh.renderOrder = 20;

        const group = new THREE.Group();
        group.add(mesh);
        for (let index = 0; index < points.length; index += 1) {
            const nextIndex = (index + 1) % points.length;
            const edge = this.createSegment(points[index], points[nextIndex], color);
            edge.renderOrder = 21;
            group.add(edge);
        }
        return group;
    }

    createCircleHighlight(center, ringPoints, color, opacity) {
        if (!center || !Array.isArray(ringPoints) || ringPoints.length < 3) {
            return null;
        }

        const allPoints = [center, ...ringPoints];
        const geometry = new THREE.BufferGeometry();
        const vertices = new Float32Array(allPoints.flatMap((point) => [point.x, point.y, point.z]));
        const indices = [];
        for (let index = 1; index <= ringPoints.length; index += 1) {
            const nextIndex = index === ringPoints.length ? 1 : index + 1;
            indices.push(0, index, nextIndex);
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity,
                side: THREE.DoubleSide,
                depthTest: false,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -2,
                polygonOffsetUnits: -2
            })
        );
        mesh.renderOrder = 20;

        const outline = this.createThickPolyline([...ringPoints, ringPoints[0]], color, 5);
        outline.renderOrder = 21;

        const group = new THREE.Group();
        group.add(mesh, outline);
        return group;
    }

    getCircleBaseOppositeLocalId(sourceFaceId) {
        return {
            'cylinder-end-a': 'B',
            'cylinder-end-b': 'A',
            'cone-base': 'A',
            'hemisphere-flat': 'A'
        }[sourceFaceId] || null;
    }

    getPerpendicularUnitVector(vector) {
        const axis = Math.abs(vector.y) < 0.9
            ? new THREE.Vector3(0, 1, 0)
            : new THREE.Vector3(1, 0, 0);
        let perpendicular = new THREE.Vector3().crossVectors(vector, axis);
        if (perpendicular.lengthSq() <= 1e-12) {
            perpendicular = new THREE.Vector3().crossVectors(vector, new THREE.Vector3(0, 0, 1));
        }
        return perpendicular.normalize();
    }

    getCircleBaseFallbackNormal(definition, center) {
        const oppositeLocalId = this.getCircleBaseOppositeLocalId(definition.sourceFaceId);
        const oppositePoint = oppositeLocalId
            ? this.getPointBySlotLocalId(definition.sourceSlotId, oppositeLocalId)
            : null;
        if (!oppositePoint) {
            return null;
        }

        const normal = center.clone().sub(oppositePoint.position);
        return normal.lengthSq() > 1e-12 ? normal.normalize() : null;
    }

    getCircleThroughBoundaryPoints(points) {
        if (!Array.isArray(points) || points.length < 3) {
            return null;
        }

        for (let first = 0; first < points.length - 2; first += 1) {
            for (let second = first + 1; second < points.length - 1; second += 1) {
                for (let third = second + 1; third < points.length; third += 1) {
                    const a = points[first];
                    const b = points[second];
                    const c = points[third];
                    const ab = b.clone().sub(a);
                    const ac = c.clone().sub(a);
                    const baseLength = ab.length();
                    if (baseLength <= 1e-8) {
                        continue;
                    }

                    const normal = new THREE.Vector3().crossVectors(ab, ac);
                    if (normal.lengthSq() <= 1e-10) {
                        continue;
                    }
                    normal.normalize();

                    const uAxis = ab.clone().normalize();
                    const vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();
                    const cLocalX = ac.dot(uAxis);
                    const cLocalY = ac.dot(vAxis);
                    if (Math.abs(cLocalY) <= 1e-8) {
                        continue;
                    }

                    const centerX = baseLength / 2;
                    const centerY = ((cLocalX * cLocalX) + (cLocalY * cLocalY) - (baseLength * cLocalX)) / (2 * cLocalY);
                    const center = a.clone()
                        .add(uAxis.clone().multiplyScalar(centerX))
                        .add(vAxis.clone().multiplyScalar(centerY));
                    const radius = center.distanceTo(a);
                    if (!Number.isFinite(radius) || radius <= 1e-6) {
                        continue;
                    }

                    let u = points[0].clone().sub(center);
                    u.addScaledVector(normal, -u.dot(normal));
                    if (u.lengthSq() <= 1e-10) {
                        u = uAxis.clone();
                    } else {
                        u.normalize();
                    }
                    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
                    return { center, normal, radius, u, v };
                }
            }
        }

        return null;
    }

    getCircleBaseSamplePoints(definition, sampleCount = 96) {
        const boundaryPointIds = Array.isArray(definition.boundaryPointIds) ? definition.boundaryPointIds : [];
        const rimPoints = this.getVectorsByPointIds(boundaryPointIds);
        const hasExplicitCenter = !!definition.centerPointId;
        const centerPoint = hasExplicitCenter ? this.getPointById(definition.centerPointId) : null;
        if ((hasExplicitCenter && !centerPoint) || !rimPoints || rimPoints.length < 2) {
            return null;
        }

        let center;
        let radius;
        let u;
        let v;
        let normal;

        if (centerPoint) {
            center = centerPoint.position.clone();
            const rimVectors = rimPoints
                .map((point) => point.clone().sub(center))
                .filter((vector) => vector.lengthSq() > 1e-12);
            if (rimVectors.length < 1) {
                return null;
            }

            const radiusValues = rimVectors.map((vector) => vector.length()).filter((value) => value > 1e-6);
            if (radiusValues.length === 0) {
                return null;
            }

            radius = radiusValues.reduce((sum, value) => sum + value, 0) / radiusValues.length;
            u = rimVectors[0].clone().normalize();
            normal = new THREE.Vector3();
            for (let left = 0; left < rimVectors.length - 1; left += 1) {
                for (let right = left + 1; right < rimVectors.length; right += 1) {
                    const candidate = new THREE.Vector3().crossVectors(rimVectors[left], rimVectors[right]);
                    if (candidate.lengthSq() > 1e-10) {
                        normal = candidate.normalize();
                        break;
                    }
                }
                if (normal.lengthSq() > 1e-10) {
                    break;
                }
            }

            if (normal.lengthSq() <= 1e-10) {
                normal = this.getCircleBaseFallbackNormal(definition, center) || this.getPerpendicularUnitVector(u);
            }
            normal.normalize();

            u.addScaledVector(normal, -u.dot(normal));
            if (u.lengthSq() <= 1e-10) {
                u = this.getPerpendicularUnitVector(normal);
            } else {
                u.normalize();
            }
            v = new THREE.Vector3().crossVectors(normal, u).normalize();
        } else {
            const derivedCircle = this.getCircleThroughBoundaryPoints(rimPoints);
            if (!derivedCircle) {
                return null;
            }
            ({ center, normal, radius, u, v } = derivedCircle);
        }

        const ringPoints = [];
        const segments = Math.max(12, Math.floor(sampleCount));
        for (let index = 0; index < segments; index += 1) {
            const theta = (index / segments) * Math.PI * 2;
            ringPoints.push(center.clone()
                .add(u.clone().multiplyScalar(Math.cos(theta) * radius))
                .add(v.clone().multiplyScalar(Math.sin(theta) * radius)));
        }

        return { center, ringPoints, normal, radius, u, v };
    }

    createBaseHighlightFromDefinition(definition) {
        const color = definition.color || 0xff595e;
        const opacity = definition.opacity || 0.2;

        if (definition.shape === 'polygon') {
            const boundaryPointIds = Array.isArray(definition.boundaryPointIds)
                ? definition.boundaryPointIds
                : definition.pointIds;
            const vectors = this.getVectorsByPointIds(boundaryPointIds || []);
            if (!vectors || vectors.length < 3) return null;
            return this.createPolygonHighlight(vectors, color, opacity);
        }

        if (definition.shape === 'circle') {
            const sample = this.getCircleBaseSamplePoints(definition);
            if (!sample) return null;
            return this.createCircleHighlight(sample.center, sample.ringPoints, color, opacity);
        }

        return null;
    }

    createAngleMarker(a, vertex, c, angleText, arcColor = 0x00d1b2, labelColor = this.getLabelDefaultColor()) {
        const radius = Math.min(a.distanceTo(vertex), c.distanceTo(vertex)) * 0.22;
        const dir1 = a.clone().sub(vertex).normalize();
        const dir2 = c.clone().sub(vertex).normalize();
        const normal = new THREE.Vector3().crossVectors(dir1, dir2).normalize();
        const tangent = new THREE.Vector3().crossVectors(normal, dir1).normalize();
        const rawAngle = Math.acos(THREE.MathUtils.clamp(dir1.dot(dir2), -1, 1));
        const sampleCount = 28;
        const points = [];

        for (let step = 0; step <= sampleCount; step += 1) {
            const theta = (rawAngle * step) / sampleCount;
            const arcPoint = vertex.clone()
                .add(dir1.clone().multiplyScalar(Math.cos(theta) * radius))
                .add(tangent.clone().multiplyScalar(Math.sin(theta) * radius));
            points.push(arcPoint);
        }

        const line = this.createThickPolyline(points, arcColor, 5);

        const group = new THREE.Group();
        group.add(line);

        const labelText = typeof angleText === 'string' ? angleText.trim() : '';
        if (labelText) {
            const labelRadius = radius * 0.6;
            const labelPoint = vertex.clone()
                .add(dir1.clone().multiplyScalar(Math.cos(rawAngle / 2) * labelRadius))
                .add(tangent.clone().multiplyScalar(Math.sin(rawAngle / 2) * labelRadius));
            const label = this.createTextSprite(labelText, {
                fontSize: 42,
                textColor: this.getLabelTextColor(),
                background: this.getConstructionColorHex(labelColor, this.getLabelDefaultColor()),
                borderColor: '#000000'
            });
            label.position.copy(labelPoint);
            group.add(label);
        }

        return group;
    }

    createTextSprite(text, options = {}) {
        const displayText = this.applyEmbedVariableSubstitutions(text);
        const baseFontSize = options.fontSize || 48;
        const displayScale = this.getDisplayTextScale();
        const fontSize = Math.max(12, Math.round(baseFontSize * displayScale));
        const badgeVisible = options.forceBadge === true || this.labelMode === 'badge';
        const paddingX = badgeVisible
            ? Math.max(8, Math.round(14 * displayScale))
            : Math.max(2, Math.round(4 * displayScale));
        const paddingY = badgeVisible
            ? Math.max(5, Math.round(9 * displayScale))
            : Math.max(2, Math.round(4 * displayScale));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.font = `700 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        const metrics = context.measureText(displayText);
        const logicalWidth = Math.ceil(metrics.width + paddingX * 2);
        const logicalHeight = Math.ceil(fontSize + paddingY * 2);
        canvas.width = Math.ceil(logicalWidth * dpr);
        canvas.height = Math.ceil(logicalHeight * dpr);

        const drawContext = canvas.getContext('2d');
        drawContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawContext.clearRect(0, 0, logicalWidth, logicalHeight);
        drawContext.font = `700 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        drawContext.textBaseline = 'middle';
        drawContext.textAlign = 'center';
        drawContext.lineJoin = 'round';
        drawContext.lineCap = 'round';

        const background = options.background || LABEL_BADGE_BACKGROUND_COLOR;
        const borderColor = options.borderColor || '#000000';
        const borderWidth = badgeVisible
            ? Math.max(2, Math.round((options.borderWidth || 4) * displayScale))
            : 0;
        const radius = badgeVisible
            ? Math.max(8, Math.round((options.cornerRadius || 16) * displayScale))
            : 0;

        if (badgeVisible) {
            drawContext.fillStyle = background;
            this.drawRoundedRect(drawContext, borderWidth / 2, borderWidth / 2, logicalWidth - borderWidth, logicalHeight - borderWidth, radius);
            drawContext.fill();

            drawContext.lineWidth = borderWidth;
            drawContext.strokeStyle = borderColor;
            drawContext.stroke();
        }

        drawContext.fillStyle = options.textColor || '#ffffff';
        drawContext.fillText(displayText, logicalWidth / 2, logicalHeight / 2 + 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
        material.alphaTest = 0.08;
        material.depthTest = true;
        material.depthWrite = false;
        const sprite = new THREE.Sprite(material);
        const scaleFactor = 0.0055;
        sprite.scale.set(logicalWidth * scaleFactor, logicalHeight * scaleFactor, 1);
        sprite.renderOrder = 40;
        return sprite;
    }

    drawRoundedRect(context, x, y, width, height, radius) {
        context.beginPath();
        context.moveTo(x + radius, y);
        context.lineTo(x + width - radius, y);
        context.quadraticCurveTo(x + width, y, x + width, y + radius);
        context.lineTo(x + width, y + height - radius);
        context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        context.lineTo(x + radius, y + height);
        context.quadraticCurveTo(x, y + height, x, y + height - radius);
        context.lineTo(x, y + radius);
        context.quadraticCurveTo(x, y, x + radius, y);
        context.closePath();
    }

    setObjectSectionCollapsedState(sectionKey, collapsed) {
        const section = this.objectSections[sectionKey];
        if (!section) {
            return;
        }

        this.objectGroupCollapsed[sectionKey] = collapsed;
        section.content.classList.toggle('collapsed', collapsed);
        section.header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        section.arrow.textContent = collapsed ? '\u25B6\uFE0E' : '\u25BC\uFE0E';
    }

    focusObjectSectionForType(type, definition = null) {
        if (definition?.kind === 'base-highlight') {
            Object.keys(this.objectSections).forEach((key) => {
                this.setObjectSectionCollapsedState(key, key !== 'baseHighlights');
            });
            return;
        }

        const sectionByType = {
            triangle: 'triangles',
            segment: 'segments',
            angle: 'angles',
            plane: 'planes',
            label: 'labels'
        };

        const sectionKey = sectionByType[type];
        if (!sectionKey) {
            return;
        }

        if (definition?.hidden || definition?.kind === 'midpoint-point' || definition?.kind === 'ratio-point') {
            return;
        }

        Object.keys(this.objectSections).forEach((key) => {
            this.setObjectSectionCollapsedState(key, key !== sectionKey);
        });
    }

    canAddSceneObjects(count = 1, { notify = true } = {}) {
        const required = Math.max(1, Math.trunc(Number(count) || 1));
        const hasObjectCapacity = this.sceneObjects.length + required <= MAX_SCENE_OBJECTS;
        const hasIdentifierCapacity = Number.isSafeInteger(this.nextObjectId)
            && this.nextObjectId > 0
            && this.nextObjectId <= Number.MAX_SAFE_INTEGER - required;
        if (hasObjectCapacity && hasIdentifierCapacity) {
            return true;
        }
        if (notify) {
            this.showToast(
                hasObjectCapacity
                    ? 'Unable to assign another diagram object identifier.'
                    : `Diagram object limit reached (${MAX_SCENE_OBJECTS}).`
            );
        }
        return false;
    }

    addSceneObject({ type, name, subtitle, object3D, definition = null }) {
        if (!this.canAddSceneObjects(1)) {
            this.disposeObject3D(object3D);
            return null;
        }
        object3D.userData.sceneObjectId = this.nextObjectId;
        this.scene.add(object3D);
        const entry = {
            id: this.nextObjectId,
            type,
            name,
            subtitle,
            object3D,
            definition,
            visible: true
        };
        this.sceneObjects.unshift(entry);
        this.nextObjectId += 1;
        this.focusObjectSectionForType(type, definition);
        this.renderObjectsList({ persist: true });
        this.refreshDerivedPoints();
        this.buildPointMarkers();
        this.renderPointsList();
        this.renderSelectionSummary();
        this.renderActions();
        return entry;
    }

    getVectorsByPointIds(pointIds) {
        if (!Array.isArray(pointIds)) {
            return null;
        }
        const points = pointIds.map((pointId) => this.getPointById(pointId));
        if (points.some((point) => !point)) {
            return null;
        }
        return points.map((point) => point.position.clone());
    }

    rebuildConstructions() {
        if (this.sceneObjects.length === 0) {
            return;
        }

        const survivingObjects = [];
        this.sceneObjects.forEach((entry) => {
            if (!entry.definition) {
                survivingObjects.push(entry);
                return;
            }

            const rebuiltObject = this.createObjectFromDefinition(entry.definition);
            if (!rebuiltObject) {
                if (entry.object3D) {
                    this.scene.remove(entry.object3D);
                    this.disposeObject3D(entry.object3D);
                }
                return;
            }

            if (entry.object3D) {
                this.scene.remove(entry.object3D);
                this.disposeObject3D(entry.object3D);
            }

            rebuiltObject.userData.sceneObjectId = entry.id;
            rebuiltObject.visible = entry.visible;
            entry.object3D = rebuiltObject;
            this.scene.add(rebuiltObject);
            survivingObjects.push(entry);
        });

        this.sceneObjects = survivingObjects;
        this.renderObjectsList();
        this.syncAllLabelVisibility();
    }

    createObjectFromDefinition(definition) {
        if (!definition || !definition.kind) {
            return null;
        }

        if (definition.hidden) {
            return new THREE.Group();
        }

        if (definition.kind === 'point-label') {
            const point = this.getPointById(definition.pointId);
            if (!point) return null;
            const sprite = this.createTextSprite(definition.text, {
                fontSize: 46,
                textColor: '#000000',
                background: this.getLabelDefinitionColorHex(definition),
                borderColor: '#000000'
            });
            sprite.position.copy(point.position.clone().add(new THREE.Vector3(0.34, 0.46, 0.18)));
            sprite.visible = this.labelMode !== 'off' && !this.isPointHidden(point);
            return sprite;
        }

        if (definition.kind === 'length-label' || definition.kind === 'edge-label') {
            const vectors = this.getVectorsByPointIds(definition.pointIds || []);
            if (!vectors || vectors.length !== 2) return null;
            if (!this.canAttachLabelToPointPair(definition.pointIds || [])) return null;
            const sprite = this.createTextSprite(definition.text, {
                fontSize: 46,
                textColor: this.getLabelTextColor(),
                background: this.getLabelDefinitionColorHex(definition),
                borderColor: '#000000'
            });
            const midpoint = vectors[0].clone().lerp(vectors[1], 0.5).add(new THREE.Vector3(0.2, 0.2, 0.2));
            sprite.position.copy(midpoint);
            return sprite;
        }

        if (definition.kind === 'shape-label') {
            const position = this.getShapeLabelPosition(definition.pointIds || []);
            if (!position) return null;
            const sprite = this.createTextSprite(definition.text, {
                fontSize: 52,
                textColor: this.getLabelTextColor(),
                background: this.getLabelDefinitionColorHex(definition),
                borderColor: '#000000'
            });
            sprite.position.copy(position);
            sprite.visible = this.labelMode !== 'off' && this.isShapeLabelAnchorVisible(definition);
            return sprite;
        }

        if (definition.kind === 'midpoint-point' || definition.kind === 'ratio-point') {
            const midpointHolder = new THREE.Group();
            midpointHolder.visible = false;
            return midpointHolder;
        }

        if (definition.kind === 'segment') {
            const vectors = this.getVectorsByPointIds(definition.pointIds || []);
            if (!vectors || vectors.length !== 2) return null;
            return this.createSegment(vectors[0], vectors[1], definition.color ?? 0xff595e);
        }

        if (definition.kind === 'triangle') {
            const vectors = this.getVectorsByPointIds(definition.pointIds || []);
            if (!vectors || vectors.length !== 3) return null;
            return this.createTriangle(vectors[0], vectors[1], vectors[2], definition.color ?? 0xff595e, definition.opacity || 0.28);
        }

        if (definition.kind === 'angle') {
            const vectors = this.getVectorsByPointIds(definition.pointIds || []);
            if (!vectors || vectors.length !== 3) return null;
            return this.createAngleMarker(
                vectors[0],
                vectors[1],
                vectors[2],
                this.getAngleLabelText(definition),
                definition.color ?? 0xff595e,
                this.getAngleLabelColor(definition)
            );
        }

        if (definition.kind === 'base-highlight') {
            return this.createBaseHighlightFromDefinition(definition);
        }

        if (definition.kind === 'plane') {
            const vectors = this.getVectorsByPointIds(definition.pointIds || []);
            if (!vectors || vectors.length !== 4) return null;
            return this.createQuad(vectors, definition.color ?? 0xff595e, definition.opacity || 0.2);
        }

        return null;
    }

    renderObjectsList({ persist = false } = {}) {
        const sectionFilters = {
            triangles: (item) => item.type === 'triangle',
            segments: (item) => item.type === 'segment',
            angles: (item) => item.type === 'angle',
            planes: (item) => item.type === 'plane' && item.definition?.kind !== 'base-highlight',
            baseHighlights: (item) => item.definition?.kind === 'base-highlight',
            labels: (item) => item.type === 'label'
        };
        for (const [key, filterItem] of Object.entries(sectionFilters)) {
            const sec = this.objectSections[key];
            const items = this.sceneObjects.filter((item) => {
                if (item.definition?.hidden) return false;
                if (item.definition?.kind === 'midpoint-point' || item.definition?.kind === 'ratio-point') return false;
                return filterItem(item);
            });
            sec.list.innerHTML = '';
            items.forEach((item) => sec.list.appendChild(this.renderObjectItem(item)));
            if (sec.title) {
                sec.title.textContent = sec.baseTitle;
                if (items.length > 0) {
                    const countEl = document.createElement('span');
                    countEl.className = 'section-object-count';
                    countEl.textContent = `${items.length}`;
                    sec.title.appendChild(countEl);
                }
            }
        }

        if (persist) {
            this.scheduleLocalStateSave();
        }
    }



    escapeHtmlAttribute(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    normalizeConstructionColor(value, fallback = 0xff595e) {
        const parseColor = (input) => {
            if (typeof input === 'string') {
                const trimmed = input.trim();
                const match = trimmed.match(/^#?([0-9a-f]{6})$/i);
                if (match) {
                    return parseInt(match[1], 16);
                }
            }
            const numericValue = Number(input);
            return Number.isFinite(numericValue) ? numericValue : NaN;
        };
        const numeric = parseColor(value);
        const fallbackNumeric = parseColor(fallback);
        const selected = Number.isFinite(numeric)
            ? numeric
            : (Number.isFinite(fallbackNumeric) ? fallbackNumeric : 0xff595e);
        return Math.max(0, Math.min(0xffffff, Math.trunc(selected)));
    }

    getConstructionColorHex(value, fallback = 0xff595e) {
        return `#${this.normalizeConstructionColor(value, fallback).toString(16).padStart(6, '0')}`;
    }

    getConstructionColorPalette() {
        return this.constructionPalette
            .map((color) => this.normalizeConstructionColor(color))
            .filter((color, index, colors) => colors.indexOf(color) === index)
            .slice(0, 10);
    }

    normalizePointColorOverrideEntries(entries) {
        const overrides = new Map();
        if (!Array.isArray(entries)) {
            return overrides;
        }

        entries.forEach((entry) => {
            if (!Array.isArray(entry) || entry.length < 2) {
                return;
            }

            const key = String(entry[0] || '').trim();
            if (!key) {
                return;
            }

            const rawColor = entry[1];
            const isValidColor = Number.isFinite(Number(rawColor))
                || (typeof rawColor === 'string' && /^#?[0-9a-f]{6}$/i.test(rawColor.trim()));
            if (!isValidColor) {
                return;
            }

            overrides.set(key, this.normalizeConstructionColor(rawColor));
        });

        return overrides;
    }

    getLabelDefaultColor(definition = null) {
        const kind = definition?.kind || '';
        const defaultColor = kind === 'edge-label' || kind === 'length-label' || kind === 'shape-label'
            ? EDGE_LABEL_BACKGROUND_COLOR
            : LABEL_BADGE_BACKGROUND_COLOR;
        return this.normalizeConstructionColor(defaultColor);
    }

    getLabelDefinitionColor(definition) {
        return this.normalizeConstructionColor(definition?.color, this.getLabelDefaultColor(definition));
    }

    getLabelDefinitionColorHex(definition) {
        return this.getConstructionColorHex(this.getLabelDefinitionColor(definition));
    }

    getLabelColorPalette(definition = null) {
        const defaultColor = this.getLabelDefaultColor(definition);
        const colors = [
            defaultColor,
            ...this.getConstructionColorPalette()
                .filter((color) => color !== defaultColor)
        ];
        return colors.filter((color, index) => colors.indexOf(color) === index).slice(0, 10);
    }

    getLabelColorPromptOptions(definition = null) {
        return {
            colors: this.getLabelColorPalette(definition),
            value: this.getLabelDefinitionColor(definition)
        };
    }

    getAngleLabelText(definition) {
        if (typeof definition?.text === 'string') {
            return definition.text.trim();
        }

        return this.formatPointSequence(definition?.pointIds || []);
    }

    getAngleLabelColor(definition) {
        return this.normalizeConstructionColor(definition?.labelColor, this.getLabelDefaultColor());
    }

    getAngleLabelColorHex(definition) {
        return this.getConstructionColorHex(this.getAngleLabelColor(definition), this.getLabelDefaultColor());
    }

    getAngleLabelColorPromptOptions(definition = null) {
        return {
            colors: this.getLabelColorPalette(),
            value: this.getAngleLabelColor(definition)
        };
    }

    applyLabelDefinitionColor(definition, color) {
        const nextDefinition = { ...definition };
        const defaultColor = this.getLabelDefaultColor(definition);
        const nextColor = this.normalizeConstructionColor(color, defaultColor);
        if (nextColor === defaultColor) {
            delete nextDefinition.color;
        } else {
            nextDefinition.color = nextColor;
        }
        return nextDefinition;
    }

    applyAngleLabelDefinitionColor(definition, color) {
        const nextDefinition = { ...definition };
        const nextColor = this.normalizeConstructionColor(color, this.getLabelDefaultColor());
        if (nextColor === this.getLabelDefaultColor()) {
            delete nextDefinition.labelColor;
        } else {
            nextDefinition.labelColor = nextColor;
        }
        return nextDefinition;
    }

    isEditableLabelColorObject(item) {
        if (!item || !item.definition || item.definition.hidden) {
            return false;
        }

        if (item.type === 'label') {
            return item.definition.kind === 'edge-label'
                || item.definition.kind === 'length-label'
                || item.definition.kind === 'point-label'
                || item.definition.kind === 'shape-label';
        }

        return item.type === 'angle'
            && item.definition.kind === 'angle'
            && Array.isArray(item.definition.pointIds)
            && item.definition.pointIds.length === 3;
    }

    isEditableConstructionColorObject(item) {
        if (!item || !item.definition || item.definition.hidden) {
            return false;
        }

        if (item.type === 'segment') {
            return item.definition.kind === 'segment'
                && Array.isArray(item.definition.pointIds)
                && item.definition.pointIds.length === 2;
        }

        if (item.type === 'triangle') {
            return item.definition.kind === 'triangle'
                && Array.isArray(item.definition.pointIds)
                && item.definition.pointIds.length === 3;
        }

        if (item.type === 'angle') {
            return item.definition.kind === 'angle'
                && Array.isArray(item.definition.pointIds)
                && item.definition.pointIds.length === 3;
        }

        if (item.type === 'plane') {
            return item.definition.kind === 'plane'
                && Array.isArray(item.definition.pointIds)
                && item.definition.pointIds.length === 4;
        }

        return false;
    }

    renderObjectItem(item) {
        const row = document.createElement('div');
        row.className = item.visible ? 'object-item' : 'object-item disabled';
        const rawColor = item.definition?.color;
        const displayName = this.getSceneObjectDisplayName(item);
        const isAngle = item.type === 'angle' && item.definition?.kind === 'angle' && Array.isArray(item.definition?.pointIds) && item.definition.pointIds.length === 3;
        const isEditableLabel = item.type === 'label'
            && (item.definition?.kind === 'edge-label'
                || item.definition?.kind === 'length-label'
                || item.definition?.kind === 'point-label'
                || item.definition?.kind === 'shape-label');
        const isEditableLabelColor = this.isEditableLabelColorObject(item);
        const currentLabelColor = isEditableLabel
            ? this.getLabelDefinitionColor(item.definition)
            : (isAngle ? this.getAngleLabelColor(item.definition) : null);
        const currentLabelColorHex = isEditableLabelColor ? this.getConstructionColorHex(currentLabelColor) : null;
        const isLabelColorPickerOpen = isEditableLabelColor && this.openLabelColorPickerId === item.id;
        const hasRawColor = rawColor != null && (
            Number.isFinite(Number(rawColor))
            || (typeof rawColor === 'string' && /^#?[0-9a-f]{6}$/i.test(rawColor.trim()))
        );
        const itemColor = hasRawColor
            ? this.getConstructionColorHex(rawColor)
            : null;
        const displayColor = currentLabelColorHex || itemColor;
        const visibilityColor = item.type === 'label' ? displayColor : itemColor;
        const isEditableConstructionColor = this.isEditableConstructionColorObject(item);
        const isEditableSegment = isEditableConstructionColor && item.type === 'segment';
        const currentConstructionColor = isEditableConstructionColor ? this.normalizeConstructionColor(item.definition.color) : null;
        const currentConstructionColorHex = isEditableConstructionColor ? this.getConstructionColorHex(currentConstructionColor) : null;
        const isConstructionColorPickerOpen = isEditableConstructionColor && this.openSegmentColorPickerId === item.id;
        const constructionColorLabel = item.type === 'angle'
            ? 'angle'
            : (item.type === 'triangle'
                ? 'triangle'
                : (item.type === 'plane' ? 'quadrilateral' : 'segment'));
        const displayNameText = isAngle ? this.getAngleDisplayHtml(item) : displayName;
        const showSubtitle = item.type === 'label';
        const subtitleText = typeof item.subtitle === 'string' ? item.subtitle : '';
        const currentLabelText = isEditableLabel ? String(item.definition?.text ?? '').trim() : '';
        const labelButtonTooltip = currentLabelText ? `Change label: ${currentLabelText}` : 'Change label text';
        const isInspectablePolygon = this.isInspectableSceneObject(item);
        const inspectObjectName = this.getInspectionObjectName(item);
        const isShapeLabelTarget = this.isShapeCenterLabelTarget(item);
        if (item.type === 'label') {
            row.style.borderLeftColor = displayColor || LABEL_BADGE_BACKGROUND_COLOR;
        } else if (itemColor) {
            row.style.borderLeftColor = itemColor;
        }

        const nameWrap = document.createElement('div');
        nameWrap.className = 'object-name';
        const strong = document.createElement('strong');
        strong.textContent = displayNameText;
        nameWrap.appendChild(strong);

        if (isAngle) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'object-label-edit';
            button.dataset.editAngleObjectId = String(item.id);
            button.title = 'Change angle label';
            button.textContent = 'Change Angle';
            nameWrap.appendChild(button);
        } else if (isEditableLabel) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'object-label-edit';
            button.dataset.editLabelObjectId = String(item.id);
            button.setAttribute('aria-label', labelButtonTooltip);
            button.title = labelButtonTooltip;
            button.textContent = 'Change Label';
            nameWrap.appendChild(button);
        } else if (showSubtitle && subtitleText) {
            const subtitle = document.createElement('span');
            subtitle.textContent = subtitleText;
            nameWrap.appendChild(subtitle);
        }

        const angleColorControls = isAngle ? document.createElement('div') : null;
        if (angleColorControls) {
            angleColorControls.className = 'angle-color-controls';
        }
        const colorPickerHost = angleColorControls || nameWrap;

        if (isEditableLabelColor) {
            const picker = document.createElement('div');
            picker.className = `segment-color-picker label-color-picker${isAngle ? ' angle-label-color-picker' : ''}`;

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = `segment-color-toggle label-color-toggle${isAngle ? ' angle-label-color-toggle' : ''}`;
            toggle.dataset.labelColorToggleObjectId = String(item.id);
            toggle.dataset.currentLabelColor = String(currentLabelColor);
            toggle.style.backgroundColor = currentLabelColorHex;
            toggle.setAttribute('aria-label', `Choose label color for ${displayName}`);
            toggle.setAttribute('aria-expanded', isLabelColorPickerOpen ? 'true' : 'false');
            toggle.title = `Choose label color (${currentLabelColorHex})`;
            if (isAngle) {
                toggle.textContent = 'A';
            }
            picker.appendChild(toggle);

            if (isLabelColorPickerOpen) {
                const palette = document.createElement('div');
                palette.className = 'segment-color-palette label-color-palette';
                palette.setAttribute('aria-label', `Label color for ${displayName}`);
                this.getLabelColorPalette(item.definition).forEach((paletteColor) => {
                    const normalizedColor = this.normalizeConstructionColor(paletteColor);
                    const hex = this.getConstructionColorHex(normalizedColor);
                    const swatch = document.createElement('button');
                    swatch.type = 'button';
                    swatch.className = 'segment-color-swatch label-color-swatch';
                    swatch.dataset.labelColorObjectId = String(item.id);
                    swatch.dataset.labelColor = String(normalizedColor);
                    swatch.style.backgroundColor = hex;
                    swatch.setAttribute('aria-label', `Set ${displayName} color to ${hex}`);
                    swatch.setAttribute('aria-pressed', normalizedColor === currentLabelColor ? 'true' : 'false');
                    swatch.title = `Set label color to ${hex}`;
                    palette.appendChild(swatch);
                });
                picker.appendChild(palette);
            }

            colorPickerHost.appendChild(picker);
        }

        if (isEditableConstructionColor) {
            const picker = document.createElement('div');
            picker.className = 'segment-color-picker';

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'segment-color-toggle';
            toggle.dataset.constructionColorToggleObjectId = String(item.id);
            toggle.dataset.currentConstructionColor = String(currentConstructionColor);
            if (isEditableSegment) {
                toggle.dataset.segmentColorToggleObjectId = String(item.id);
                toggle.dataset.currentSegmentColor = String(currentConstructionColor);
            }
            toggle.style.backgroundColor = currentConstructionColorHex;
            toggle.setAttribute('aria-label', `Choose color for ${displayName}`);
            toggle.setAttribute('aria-expanded', isConstructionColorPickerOpen ? 'true' : 'false');
            toggle.title = `Choose ${constructionColorLabel} color (${currentConstructionColorHex})`;
            picker.appendChild(toggle);

            if (isConstructionColorPickerOpen) {
                const palette = document.createElement('div');
                palette.className = 'segment-color-palette';
                palette.setAttribute('aria-label', `${constructionColorLabel} color for ${displayName}`);
                this.getConstructionColorPalette().forEach((paletteColor) => {
                    const normalizedColor = this.normalizeConstructionColor(paletteColor);
                    const hex = this.getConstructionColorHex(normalizedColor);
                    const swatch = document.createElement('button');
                    swatch.type = 'button';
                    swatch.className = 'segment-color-swatch';
                    swatch.dataset.constructionColorObjectId = String(item.id);
                    swatch.dataset.constructionColor = String(normalizedColor);
                    if (isEditableSegment) {
                        swatch.dataset.segmentColorObjectId = String(item.id);
                        swatch.dataset.segmentColor = String(normalizedColor);
                    }
                    swatch.style.backgroundColor = hex;
                    swatch.setAttribute('aria-label', `Set ${displayName} color to ${hex}`);
                    swatch.setAttribute('aria-pressed', normalizedColor === currentConstructionColor ? 'true' : 'false');
                    swatch.title = `Set ${constructionColorLabel} color to ${hex}`;
                    palette.appendChild(swatch);
                });
                picker.appendChild(palette);
            }

            colorPickerHost.appendChild(picker);
        }

        if (angleColorControls && angleColorControls.childElementCount > 0) {
            nameWrap.appendChild(angleColorControls);
        }

        if (isShapeLabelTarget) {
            const existingShapeLabel = this.findShapeLabelObject(item.definition.pointIds);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'object-label-edit';
            button.dataset.editShapeLabelObjectId = String(item.id);
            button.title = existingShapeLabel ? 'Change center label' : 'Add center label';
            button.textContent = existingShapeLabel ? 'Change Label' : 'Add Label';
            nameWrap.appendChild(button);
        }

        if (isInspectablePolygon) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'object-extract';
            button.dataset.extractObjectId = String(item.id);
            button.setAttribute('aria-label', `Inspect ${inspectObjectName} in a 2D view`);
            button.title = `Open this ${inspectObjectName} in a 2D teaching view showing its true shape, edge labels, and angle markers`;
            button.disabled = !item.visible;
            button.textContent = 'Inspect';
            nameWrap.appendChild(button);
        }

        const controls = document.createElement('div');
        controls.className = 'object-controls';
        const visibilityButton = document.createElement('button');
        visibilityButton.type = 'button';
        visibilityButton.className = 'object-visibility-btn';
        visibilityButton.dataset.toggleObjectId = String(item.id);
        visibilityButton.setAttribute('aria-label', item.visible ? 'Hide object' : 'Show object');
        visibilityButton.title = `Click to ${item.visible ? 'hide' : 'show'} object`;
        visibilityButton.style.backgroundColor = item.visible && visibilityColor ? visibilityColor : 'transparent';
        controls.appendChild(visibilityButton);

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'object-delete';
        deleteButton.dataset.deleteObjectId = String(item.id);
        deleteButton.setAttribute('aria-label', 'Delete object');
        deleteButton.title = 'Delete object';
        deleteButton.textContent = 'X';
        controls.appendChild(deleteButton);

        row.appendChild(nameWrap);
        row.appendChild(controls);
        return row;
    }

    async editLabelFromObjectCard(objectId) {
        const item = this.sceneObjects.find((entry) => entry.id === objectId && entry.type === 'label');
        if (!item || !item.definition) {
            return;
        }

        const def = item.definition;
        const currentText = def.text || '';
        let promptText = 'Change label text';

        if ((def.kind === 'edge-label' || def.kind === 'length-label') && Array.isArray(def.pointIds) && def.pointIds.length === 2) {
            promptText = `Change label for ${this.formatPointSequence(def.pointIds)}`;
        }
        if (def.kind === 'shape-label' && Array.isArray(def.pointIds) && (def.pointIds.length === 3 || def.pointIds.length === 4)) {
            promptText = `Change center label for ${this.formatPointSequence(def.pointIds)}`;
        }
        if (def.kind === 'point-label') {
            const point = this.getPointById(def.pointId);
            promptText = `Change label for point ${point?.label || def.pointId || ''}`.trim();
        }

        const promptResult = await this.showPromptModal(promptText, currentText, {
            quickSymbols: true,
            colorPicker: this.getLabelColorPromptOptions(def)
        });
        if (promptResult == null) {
            return;
        }
        const nextText = typeof promptResult === 'object' ? promptResult.value : promptResult;
        if (!nextText.trim()) {
            return;
        }

        const normalizedText = nextText.trim();
        const selectedColor = typeof promptResult === 'object'
            ? this.normalizeConstructionColor(promptResult.color, this.getLabelDefinitionColor(def))
            : this.getLabelDefinitionColor(def);
        item.definition = this.applyLabelDefinitionColor({
            ...def,
            text: normalizedText
        }, selectedColor);
        item.subtitle = normalizedText;

        const rebuiltObject = this.createObjectFromDefinition(item.definition);
        if (!rebuiltObject) {
            return;
        }

        if (item.object3D) {
            this.scene.remove(item.object3D);
            this.disposeObject3D(item.object3D);
        }
        rebuiltObject.userData.sceneObjectId = item.id;
        rebuiltObject.visible = item.visible;
        item.object3D = rebuiltObject;
        this.scene.add(rebuiltObject);

        this.focusObjectSectionForType(item.type, item.definition);
        this.renderObjectsList({ persist: true });
        this.syncAllLabelVisibility();
    }

    async editAngleFromObjectCard(objectId) {
        const item = this.sceneObjects.find((entry) => entry.id === objectId && entry.type === 'angle');
        if (!item || !item.definition) {
            return;
        }

        const def = item.definition;
        if (!Array.isArray(def.pointIds) || def.pointIds.length !== 3) {
            return;
        }

        const vertexLabel = this.getPointById(def.pointIds[1])?.label || def.pointIds[1];
        const vectors = this.getVectorsByPointIds(def.pointIds);
        if (!vectors || vectors.some((v) => !v)) {
            return;
        }

        let angleLabelInput = this.getAngleLabelText(def);
        const promptResult = await this.showPromptModal(`Change label for angle at ${vertexLabel}`, angleLabelInput, {
            quickSymbols: true,
            colorPicker: this.getAngleLabelColorPromptOptions(def)
        });
        if (promptResult == null) {
            return;
        }

        angleLabelInput = (typeof promptResult === 'object' ? promptResult.value : promptResult).trim();
        const selectedLabelColor = typeof promptResult === 'object'
            ? this.normalizeConstructionColor(promptResult.color, this.getAngleLabelColor(def))
            : this.getAngleLabelColor(def);
        const nextDefinition = this.applyAngleLabelDefinitionColor({ ...def, text: angleLabelInput }, selectedLabelColor);
        const color = nextDefinition.color ?? 0xff595e;
        const angleGroup = this.createAngleMarker(
            vectors[0],
            vectors[1],
            vectors[2],
            this.getAngleLabelText(nextDefinition),
            color,
            this.getAngleLabelColor(nextDefinition)
        );
        item.name = `Angle ${this.formatPointSequence(def.pointIds)}`;
        item.subtitle = `Angle at ${vertexLabel}`;
        item.definition = nextDefinition;
        this.scene.remove(item.object3D);
        this.disposeObject3D(item.object3D);
        angleGroup.userData.sceneObjectId = item.id;
        item.object3D = angleGroup;
        item.object3D.visible = item.visible;
        this.scene.add(item.object3D);
        this.focusObjectSectionForType(item.type, item.definition);
        this.renderObjectsList({ persist: true });
        this.renderSelectionSummary();
        this.renderActions();
    }

    async editShapeCenterLabelFromObjectCard(objectId) {
        const shapeItem = this.sceneObjects.find((entry) => entry.id === objectId && this.isShapeCenterLabelTarget(entry));
        if (!shapeItem || !shapeItem.definition) {
            return;
        }

        const pointIds = [...(shapeItem.definition.pointIds || [])];
        const existingLabel = this.findShapeLabelObject(pointIds);
        const currentText = existingLabel?.definition?.text || '';
        const shapeName = this.getSceneObjectDisplayName(shapeItem);
        const promptText = existingLabel ? `Change center label for ${shapeName}` : `Center label for ${shapeName}`;
        const fallbackDefinition = existingLabel?.definition || { kind: 'shape-label', pointIds };
        const promptResult = await this.showPromptModal(promptText, currentText, {
            quickSymbols: true,
            colorPicker: this.getLabelColorPromptOptions(fallbackDefinition)
        });
        if (promptResult == null) {
            return;
        }

        const nextText = typeof promptResult === 'object' ? promptResult.value : promptResult;
        if (!nextText.trim()) {
            return;
        }

        const normalizedText = nextText.trim();
        const selectedColor = typeof promptResult === 'object'
            ? this.normalizeConstructionColor(promptResult.color, this.getLabelDefinitionColor(fallbackDefinition))
            : this.getLabelDefinitionColor(fallbackDefinition);
        const labelDefinition = this.applyLabelDefinitionColor({
            ...fallbackDefinition,
            kind: 'shape-label',
            pointIds,
            text: normalizedText
        }, selectedColor);
        const labelObject = this.createObjectFromDefinition(labelDefinition);
        if (!labelObject) {
            return;
        }

        if (existingLabel) {
            existingLabel.definition = labelDefinition;
            existingLabel.name = `Label ${this.formatPointSequence(pointIds)}`;
            existingLabel.subtitle = normalizedText;
            this.scene.remove(existingLabel.object3D);
            this.disposeObject3D(existingLabel.object3D);
            labelObject.userData.sceneObjectId = existingLabel.id;
            existingLabel.object3D = labelObject;
            existingLabel.object3D.visible = existingLabel.visible && this.labelMode !== 'off' && this.isShapeLabelAnchorVisible(labelDefinition);
            this.scene.add(existingLabel.object3D);
            this.focusObjectSectionForType(existingLabel.type, existingLabel.definition);
            this.renderObjectsList({ persist: true });
            this.syncAllLabelVisibility();
            return;
        }

        this.addSceneObject({
            type: 'label',
            name: `Label ${this.formatPointSequence(pointIds)}`,
            subtitle: normalizedText,
            object3D: labelObject,
            definition: labelDefinition
        });
        this.syncAllLabelVisibility();
    }

    toggleLabelColorPicker(objectId) {
        const item = this.sceneObjects.find((entry) => entry.id === objectId && this.isEditableLabelColorObject(entry));
        if (!item) {
            return;
        }

        this.openLabelColorPickerId = this.openLabelColorPickerId === objectId ? null : objectId;
        this.renderObjectsList();
    }

    changeLabelColor(objectId, color) {
        const item = this.sceneObjects.find((entry) => entry.id === objectId && this.isEditableLabelColorObject(entry));
        if (!item || !item.definition) {
            return;
        }

        const defaultColor = item.type === 'angle'
            ? this.getLabelDefaultColor()
            : this.getLabelDefaultColor(item.definition);
        const nextColor = this.normalizeConstructionColor(color, defaultColor);
        const currentColor = item.type === 'angle'
            ? this.getAngleLabelColor(item.definition)
            : this.getLabelDefinitionColor(item.definition);
        const hasStoredColor = item.type === 'angle'
            ? item.definition.labelColor != null
            : item.definition.color != null;
        if (nextColor === currentColor && !(hasStoredColor && nextColor === defaultColor)) {
            return;
        }

        const nextDefinition = item.type === 'angle'
            ? this.applyAngleLabelDefinitionColor(item.definition, nextColor)
            : this.applyLabelDefinitionColor(item.definition, nextColor);

        const rebuiltObject = this.createObjectFromDefinition(nextDefinition);
        if (!rebuiltObject) {
            return;
        }

        if (item.object3D) {
            this.scene.remove(item.object3D);
            this.disposeObject3D(item.object3D);
        }

        rebuiltObject.userData.sceneObjectId = item.id;
        rebuiltObject.visible = item.visible;
        item.definition = nextDefinition;
        item.object3D = rebuiltObject;
        this.scene.add(rebuiltObject);
        this.renderObjectsList({ persist: true });
        this.syncAllLabelVisibility();
    }

    toggleConstructionColorPicker(objectId) {
        const item = this.sceneObjects.find((entry) => entry.id === objectId && this.isEditableConstructionColorObject(entry));
        if (!item) {
            return;
        }

        this.openSegmentColorPickerId = this.openSegmentColorPickerId === objectId ? null : objectId;
        this.renderObjectsList();
    }

    changeConstructionColor(objectId, color) {
        const item = this.sceneObjects.find((entry) => entry.id === objectId && this.isEditableConstructionColorObject(entry));
        if (!item || !item.definition) {
            return;
        }

        const nextColor = this.normalizeConstructionColor(color, item.definition.color);
        if (nextColor === this.normalizeConstructionColor(item.definition.color)) {
            return;
        }

        const nextDefinition = {
            ...item.definition,
            color: nextColor
        };
        const rebuiltObject = this.createObjectFromDefinition(nextDefinition);
        if (!rebuiltObject) {
            return;
        }

        if (item.object3D) {
            this.scene.remove(item.object3D);
            this.disposeObject3D(item.object3D);
        }

        rebuiltObject.userData.sceneObjectId = item.id;
        rebuiltObject.visible = item.visible;
        item.definition = nextDefinition;
        item.object3D = rebuiltObject;
        this.scene.add(rebuiltObject);
        this.renderObjectsList({ persist: true });
        this.syncAllLabelVisibility();
    }

    toggleSegmentColorPicker(objectId) {
        this.toggleConstructionColorPicker(objectId);
    }

    changeSegmentColor(objectId, color) {
        this.changeConstructionColor(objectId, color);
    }

    getAngleDisplayHtml(item) {
        const def = item?.definition;
        if (!def || def.kind !== 'angle' || !Array.isArray(def.pointIds) || def.pointIds.length !== 3) {
            return item.name;
        }

        const [aLabel, bLabel, cLabel] = def.pointIds.map((id) => this.getPointById(id)?.label || id);
        return `Angle ${aLabel}${bLabel}\u0302${cLabel}`;
    }

    getSceneObjectDisplayName(item) {
        const definition = item?.definition;
        if (!definition || !Array.isArray(definition.pointIds) || definition.pointIds.length === 0) {
            return item.name;
        }

        if (definition.kind === 'segment' && definition.pointIds.length === 2) {
            return `Segment ${this.formatPointSequence(definition.pointIds)}`;
        }

        if (definition.kind === 'triangle' && definition.pointIds.length === 3) {
            return `Triangle ${this.formatPointSequence(definition.pointIds)}`;
        }

        if (definition.kind === 'angle' && definition.pointIds.length === 3) {
            return `Angle ${this.formatPointSequence(definition.pointIds)}`;
        }

        if (definition.kind === 'base-highlight') {
            return `Base Highlight ${this.formatPointSequence(definition.pointIds)}`;
        }

        if (definition.kind === 'plane' && definition.pointIds.length === 4) {
            return `Quadrilateral ${this.formatPointSequence(definition.pointIds)}`;
        }

        if ((definition.kind === 'edge-label' || definition.kind === 'length-label') && definition.pointIds.length === 2) {
            return `Label ${this.formatPointSequence(definition.pointIds)}`;
        }

        if (definition.kind === 'point-label' && definition.pointIds.length === 1) {
            return `Label ${this.formatPointSequence(definition.pointIds)}`;
        }

        if (definition.kind === 'shape-label' && (definition.pointIds.length === 3 || definition.pointIds.length === 4)) {
            return `Label ${this.formatPointSequence(definition.pointIds)}`;
        }

        return item.name;
    }

    toggleObjectVisibility(objectId) {
        const item = this.sceneObjects.find((entry) => entry.id === objectId);
        if (!item) return;

        item.visible = !item.visible;
        item.object3D.visible = item.visible;
        this.renderObjectsList({ persist: true });
        this.syncAllLabelVisibility();
    }

    isEdgePairVisible(pointIds) {
        if (this.hasPrimitiveEdgeBetween(pointIds)) {
            return true;
        }
        if (this.hasSharedDerivedEdgeParent(pointIds)) {
            return true;
        }
        const normalized = this.normalizePointPairIds(pointIds);
        if (!normalized) return false;
        const matchesPair = (pairCandidate) => {
            const pair = this.normalizePointPairIds(pairCandidate);
            return !!pair && pair[0] === normalized[0] && pair[1] === normalized[1];
        };
        return this.sceneObjects.some((entry) => {
            const def = entry.definition;
            if (!def || !Array.isArray(def.pointIds)) return false;
            if (def.kind === 'segment' && def.pointIds.length === 2) {
                if (def.hidden === true) {
                    return matchesPair(def.pointIds);
                }
                if (!entry.visible) return false;
                return matchesPair(def.pointIds);
            }
            if (!entry.visible || def.hidden) return false;
            if (def.kind === 'triangle' && def.pointIds.length === 3) {
                const ids = def.pointIds;
                return matchesPair([ids[0], ids[1]]) || matchesPair([ids[1], ids[2]]) || matchesPair([ids[2], ids[0]]);
            }
            if (def.kind === 'plane' && def.pointIds.length === 4) {
                const ids = def.pointIds;
                return matchesPair([ids[0], ids[1]]) || matchesPair([ids[1], ids[2]]) || matchesPair([ids[2], ids[3]]) || matchesPair([ids[3], ids[0]]);
            }
            return false;
        });
    }

    syncEdgeLabelVisibility() {
        const labelsOn = this.labelMode !== 'off';
        for (const obj of this.sceneObjects) {
            if (obj.type !== 'label') continue;
            const def = obj.definition;
            if (!def || (def.kind !== 'edge-label' && def.kind !== 'length-label')) continue;
            if (!Array.isArray(def.pointIds) || def.pointIds.length !== 2) continue;
            obj.object3D.visible = labelsOn && obj.visible && this.isEdgePairVisible(def.pointIds);
        }
    }

    syncAllLabelVisibility() {
        const labelsOn = this.labelMode !== 'off';
        this.syncEdgeLabelVisibility();
        for (const sprite of (this.pointSprites || [])) {
            const point = sprite.userData?.pointId ? this.getPointById(sprite.userData.pointId) : null;
            sprite.visible = labelsOn && !this.isPointHidden(point);
        }
        for (const obj of this.sceneObjects) {
            if (obj.type === 'label' && obj.definition?.kind === 'point-label') {
                const point = this.getPointById(obj.definition.pointId);
                obj.object3D.visible = labelsOn && obj.visible && !!point && !this.isPointHidden(point);
                continue;
            }
            if (obj.type === 'label' && obj.definition?.kind === 'shape-label') {
                obj.object3D.visible = labelsOn && obj.visible && this.isShapeLabelAnchorVisible(obj.definition);
                continue;
            }
            if (obj.type !== 'angle') continue;
            const group = obj.object3D;
            if (group && group.children && group.children.length >= 2) {
                group.children[1].visible = labelsOn;
            }
        }
    }

    pruneOrphanedSceneObjects() {
        const validPointIds = new Set(this.getAllPoints().map((p) => p.id));
        const orphaned = [];
        const remaining = [];
        this.sceneObjects.forEach((entry) => {
            const def = entry.definition;
            if (def && Array.isArray(def.pointIds) && def.pointIds.length > 0) {
                if (def.pointIds.some((id) => !validPointIds.has(id))) {
                    orphaned.push(entry);
                    return;
                }
            }
            remaining.push(entry);
        });
        if (orphaned.length === 0) return;
        this.sceneObjects = remaining;
        orphaned.forEach((entry) => {
            this.scene.remove(entry.object3D);
            this.disposeObject3D(entry.object3D);
        });
    }

    deleteObject(objectId) {
        const index = this.sceneObjects.findIndex((entry) => entry.id === objectId);
        if (index === -1) return;

        const [item] = this.sceneObjects.splice(index, 1);
        if (this.openSegmentColorPickerId === objectId) {
            this.openSegmentColorPickerId = null;
        }
        if (this.openLabelColorPickerId === objectId) {
            this.openLabelColorPickerId = null;
        }
        if (this.activeTriangleExtraction?.objectId === objectId) {
            this.closeTriangleExtraction({ force: true });
        }
        if (item.definition?.kind === 'segment' && Array.isArray(item.definition.pointIds) && item.definition.pointIds.length === 2) {
            this.removeEdgeLabelsForPointPair(item.definition.pointIds, { onlyIfDisconnected: true });
            this.removeMidpointPointsForPair(item.definition.pointIds, { onlyIfDisconnected: true });
            this.removeRatioPointsForPair(item.definition.pointIds, { onlyIfDisconnected: true });
        }
        if ((item.definition?.kind === 'triangle' || item.definition?.kind === 'plane')
            && Array.isArray(item.definition.pointIds)
            && (item.definition.pointIds.length === 3 || item.definition.pointIds.length === 4)) {
            this.removeShapeLabelsForPointSet(item.definition.pointIds);
        }
        this.scene.remove(item.object3D);
        this.disposeObject3D(item.object3D);
        this.removeHiddenSupportSegmentsForOwner(item.id);
        this.refreshDerivedPoints();
        this.pruneOrphanedSceneObjects();
        this.renderObjectsList({ persist: true });
        this.buildPointMarkers();
        this.renderPointsList();
        this.renderSelectionSummary();
        this.renderActions();
    }

    clearObjects() {
        // Internal method: clear the 3D scene representation only (not the data)
        if (this.isTriangleExtractionOpen()) {
            this.closeTriangleExtraction({ force: true });
        }

        this.sceneObjects.forEach((item) => {
            this.scene.remove(item.object3D);
            this.disposeObject3D(item.object3D);
        });
        this.sceneObjects = [];
        this.selectedPoints = [];
        this.openSegmentColorPickerId = null;
        this.openLabelColorPickerId = null;

        this.renderObjectsList();
        this.buildPointMarkers();
        this.renderPointsList();
        this.renderSelectionSummary();
        this.renderActions();
    }

    async clearAllObjects() {
        // User-initiated: clear everything with confirmation
        const confirmed = await this.showConfirmModal(
            'Delete all objects? This cannot be undone.',
            { confirmText: 'Delete', cancelText: 'Cancel' }
        );
        if (!confirmed) {
            return;
        }

        if (this.isTriangleExtractionOpen()) {
            this.closeTriangleExtraction({ force: true });
        }

        // Remove all composite slots properly
        while (this.compositeSlots.length > 0) {
            this.removeSlot(this.compositeSlots[0].id);
        }

        // Clear any remaining scene objects and selections
        this.sceneObjects.forEach((item) => {
            this.scene.remove(item.object3D);
            this.disposeObject3D(item.object3D);
        });
        this.sceneObjects = [];
        this.selectedPoints = [];
        this.pointDefinitions = [];
        this.openSegmentColorPickerId = null;
        this.openLabelColorPickerId = null;

        // Rebuild UI to show clean state
        this.renderObjectsList({ persist: true });
        this.renderCompositeCards();
        this.buildPointMarkers();
        this.renderPointsList();
        this.renderSelectionSummary();
        this.renderActions();
    }

    resetSceneObjects() {
        this.clearObjects();
        this.clearSelection();
    }

    fitCameraToPrimitive(radius) {
        const distance = Math.max(radius * 2.1, 8);
        this.camera.position.set(distance, distance * 0.72, distance * 0.94);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    _fitCameraParams(object3D, padding = 1.38, preferredDirection = null) {
        if (!object3D) return null;
        const bounds = new THREE.Box3().setFromObject(object3D);
        if (bounds.isEmpty()) return null;
        const center = bounds.getCenter(new THREE.Vector3());
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(0.001, sphere.radius);
        const vFov = THREE.MathUtils.degToRad(this.camera.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
        const fitHeightDistance = radius / Math.tan(vFov / 2);
        const fitWidthDistance = radius / Math.tan(hFov / 2);
        const distance = Math.max(6, padding * Math.max(fitHeightDistance, fitWidthDistance));
        const viewDir = preferredDirection
            ? preferredDirection.clone()
            : this.camera.position.clone().sub(this.controls.target);
        if (viewDir.lengthSq() < 1e-8) viewDir.set(1, 0.72, 0.94);
        viewDir.normalize();
        return { cameraPos: center.clone().add(viewDir.multiplyScalar(distance)), target: center };
    }

    fitCameraToObject(object3D, padding = 1.38, preferredDirection = null) {
        const params = this._fitCameraParams(object3D, padding, preferredDirection);
        if (!params) {
            this.fitCameraToPrimitive(6);
            return;
        }
        this.controls.target.copy(params.target);
        this.camera.position.copy(params.cameraPos);
        this.controls.update();
    }

    getEmbedFrameElement() {
        try {
            const frame = window.frameElement;
            return frame?.tagName?.toLowerCase?.() === 'iframe' ? frame : null;
        } catch {
            return null;
        }
    }

    scheduleEmbedViewportFit(delay = 0) {
        if (!this.embedMode || !this.embedAutoFit || this.isShuttingDown) {
            return;
        }

        if (this.embedViewportFitTimer) {
            clearTimeout(this.embedViewportFitTimer);
        }

        this.embedViewportFitTimer = window.setTimeout(() => {
            this.embedViewportFitTimer = null;
            window.requestAnimationFrame(() => this.applyEmbedViewportFit());
        }, delay);
    }

    getVisibleFitRoots() {
        const roots = [];
        if (this.compositeGroup && this.compositeGroup.visible !== false) {
            roots.push(this.compositeGroup);
        }

        this.sceneObjects.forEach((item) => {
            if (item?.visible !== false && item?.object3D?.visible !== false) {
                roots.push(item.object3D);
            }
        });

        return roots;
    }

    getVisibleContentWorldBounds() {
        const roots = this.getVisibleFitRoots();
        const bounds = new THREE.Box3();
        roots.forEach((root) => {
            const rootBounds = new THREE.Box3().setFromObject(root);
            if (!rootBounds.isEmpty()) {
                bounds.union(rootBounds);
            }
        });
        return bounds.isEmpty() ? null : bounds;
    }

    expandProjectedBoundsWithWorldPoint(bounds, point) {
        const cameraPoint = point.clone().applyMatrix4(this.camera.matrixWorldInverse);
        if (cameraPoint.z >= -this.camera.near) {
            return;
        }

        const projected = point.clone().project(this.camera);
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || !Number.isFinite(projected.z)) {
            return;
        }

        bounds.minX = Math.min(bounds.minX, projected.x);
        bounds.maxX = Math.max(bounds.maxX, projected.x);
        bounds.minY = Math.min(bounds.minY, projected.y);
        bounds.maxY = Math.max(bounds.maxY, projected.y);
        bounds.count += 1;
    }

    expandProjectedBoundsWithBox(bounds, box) {
        if (!box || box.isEmpty()) {
            return;
        }

        const min = box.min;
        const max = box.max;
        [
            new THREE.Vector3(min.x, min.y, min.z),
            new THREE.Vector3(min.x, min.y, max.z),
            new THREE.Vector3(min.x, max.y, min.z),
            new THREE.Vector3(min.x, max.y, max.z),
            new THREE.Vector3(max.x, min.y, min.z),
            new THREE.Vector3(max.x, min.y, max.z),
            new THREE.Vector3(max.x, max.y, min.z),
            new THREE.Vector3(max.x, max.y, max.z),
        ].forEach((corner) => this.expandProjectedBoundsWithWorldPoint(bounds, corner));
    }

    expandProjectedBoundsWithGeometryAttribute(bounds, object, attribute) {
        if (!attribute || typeof attribute.count !== 'number' || attribute.itemSize < 3) {
            return 0;
        }

        const point = new THREE.Vector3();
        let expanded = 0;
        for (let index = 0; index < attribute.count; index += 1) {
            point.fromBufferAttribute(attribute, index).applyMatrix4(object.matrixWorld);
            const previousCount = bounds.count;
            this.expandProjectedBoundsWithWorldPoint(bounds, point);
            if (bounds.count > previousCount) {
                expanded += 1;
            }
        }
        return expanded;
    }

    expandProjectedBoundsWithGeometry(bounds, object) {
        const geometry = object.geometry;
        if (!geometry?.attributes) {
            return false;
        }

        let expanded = 0;
        expanded += this.expandProjectedBoundsWithGeometryAttribute(bounds, object, geometry.attributes.position);
        expanded += this.expandProjectedBoundsWithGeometryAttribute(bounds, object, geometry.attributes.instanceStart);
        expanded += this.expandProjectedBoundsWithGeometryAttribute(bounds, object, geometry.attributes.instanceEnd);
        return expanded > 0;
    }

    expandProjectedBoundsWithSprite(bounds, sprite, cameraRight, cameraUp) {
        const center = new THREE.Vector3().setFromMatrixPosition(sprite.matrixWorld);
        const scale = new THREE.Vector3();
        sprite.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
        const halfWidth = Math.max(0.001, Math.abs(scale.x) / 2);
        const halfHeight = Math.max(0.001, Math.abs(scale.y) / 2);
        const right = cameraRight.clone().multiplyScalar(halfWidth);
        const up = cameraUp.clone().multiplyScalar(halfHeight);

        [
            center.clone().sub(right).sub(up),
            center.clone().sub(right).add(up),
            center.clone().add(right).sub(up),
            center.clone().add(right).add(up),
        ].forEach((corner) => this.expandProjectedBoundsWithWorldPoint(bounds, corner));
    }

    collectProjectedContentBounds() {
        if (!this.camera || !this.scene) {
            return null;
        }

        this.scene.updateMatrixWorld(true);
        this.camera.updateMatrixWorld(true);
        this.camera.updateProjectionMatrix();

        const bounds = {
            minX: Infinity,
            maxX: -Infinity,
            minY: Infinity,
            maxY: -Infinity,
            count: 0
        };
        const cameraRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
        const cameraUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();

        this.getVisibleFitRoots().forEach((root) => {
            root.traverse((object) => {
                if (!object.visible || object === this.grid || object.isLight) {
                    return;
                }

                if (object instanceof THREE.Sprite) {
                    this.expandProjectedBoundsWithSprite(bounds, object, cameraRight, cameraUp);
                    return;
                }

                if (!object.geometry) {
                    return;
                }

                if (this.expandProjectedBoundsWithGeometry(bounds, object)) {
                    return;
                }

                let objectBounds = null;
                try {
                    if (!object.geometry.boundingBox && typeof object.geometry.computeBoundingBox === 'function') {
                        object.geometry.computeBoundingBox();
                    }
                    if (object.geometry.boundingBox) {
                        objectBounds = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
                    }
                } catch {
                    objectBounds = null;
                }

                if (!objectBounds || objectBounds.isEmpty()) {
                    objectBounds = new THREE.Box3().setFromObject(object);
                }

                this.expandProjectedBoundsWithBox(bounds, objectBounds);
            });
        });

        return bounds.count > 0 ? bounds : null;
    }

    fitCameraToProjectedContent(options = {}) {
        const worldBounds = this.getVisibleContentWorldBounds();
        if (!worldBounds) {
            return null;
        }

        const center = worldBounds.getCenter(new THREE.Vector3());
        const sphere = worldBounds.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(0.001, sphere.radius);
        const viewDir = this.camera.position.clone().sub(this.controls.target);
        if (viewDir.lengthSq() < 1e-8) {
            viewDir.set(1, 0.72, 0.94);
        }
        viewDir.normalize();

        const vFov = THREE.MathUtils.degToRad(this.camera.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
        const fitHeightDistance = radius / Math.tan(vFov / 2);
        const fitWidthDistance = radius / Math.tan(hFov / 2);
        const paddingNdc = THREE.MathUtils.clamp(options.paddingNdc ?? EMBED_FIT_PADDING_NDC, 0.02, 0.3);
        const allowedWidth = 2 - paddingNdc * 2;
        const allowedHeight = 2 - paddingNdc * 2;
        let target = center.clone();
        let distance = Math.max(2.5, Math.max(fitHeightDistance, fitWidthDistance));
        const maxDistance = Math.max(100, radius * 18);

        for (let pass = 0; pass < 8; pass += 1) {
            this.controls.target.copy(target);
            this.camera.position.copy(target).add(viewDir.clone().multiplyScalar(distance));
            this.controls.update();
            this.camera.updateMatrixWorld(true);
            this.camera.updateProjectionMatrix();

            const projectedBounds = this.collectProjectedContentBounds();
            if (!projectedBounds) {
                return null;
            }

            const centerX = (projectedBounds.minX + projectedBounds.maxX) / 2;
            const centerY = (projectedBounds.minY + projectedBounds.maxY) / 2;
            const cameraRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
            const cameraUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
            const targetDepth = Math.max(0.1, this.camera.position.distanceTo(target));
            const halfViewHeight = Math.tan(vFov / 2) * targetDepth;
            const halfViewWidth = halfViewHeight * this.camera.aspect;
            target = target
                .add(cameraRight.multiplyScalar(centerX * halfViewWidth))
                .add(cameraUp.multiplyScalar(centerY * halfViewHeight));

            const projectedWidth = Math.max(0.001, projectedBounds.maxX - projectedBounds.minX);
            const projectedHeight = Math.max(0.001, projectedBounds.maxY - projectedBounds.minY);
            const scale = Math.max(projectedWidth / allowedWidth, projectedHeight / allowedHeight);
            if (Number.isFinite(scale) && scale > 0) {
                distance = THREE.MathUtils.clamp(distance * scale * 1.015, 2.5, maxDistance);
            }
        }

        this.controls.target.copy(target);
        this.camera.position.copy(target).add(viewDir.clone().multiplyScalar(distance));
        this.controls.update();
        this.camera.updateMatrixWorld(true);
        this.camera.updateProjectionMatrix();
        return this.collectProjectedContentBounds();
    }

    resizeEmbedFrameToProjectedBounds(bounds) {
        const frame = this.getEmbedFrameElement();
        if (!this.embedAutoFit || !frame || this.embedFrameAutoSizeDone || !bounds || bounds.count <= 0 || !this.canvas?.clientHeight) {
            return false;
        }

        const frameRect = frame.getBoundingClientRect?.();
        const currentWidth = Math.max(1, Math.round(frameRect?.width || this.canvas.clientWidth));
        const currentHeight = Math.max(1, Math.round(frameRect?.height || this.canvas.clientHeight));
        const projectedWidth = Math.max(0.001, bounds.maxX - bounds.minX);
        const projectedHeight = Math.max(0.001, bounds.maxY - bounds.minY);
        const desiredWidthRatio = THREE.MathUtils.clamp(
            (projectedWidth + EMBED_FIT_PADDING_NDC * 2) / 2,
            0.2,
            1
        );
        const desiredRatio = THREE.MathUtils.clamp(
            (projectedHeight + EMBED_FIT_PADDING_NDC * 2) / 2,
            0.2,
            1
        );
        const nextWidth = Math.round(THREE.MathUtils.clamp(
            currentWidth * desiredWidthRatio,
            Math.min(currentWidth, EMBED_MIN_WIDTH),
            currentWidth
        ));
        const nextHeight = Math.round(THREE.MathUtils.clamp(
            currentHeight * desiredRatio,
            EMBED_MIN_HEIGHT,
            EMBED_MAX_HEIGHT
        ));

        const widthChanged = Math.abs(nextWidth - currentWidth) >= 6;
        const heightChanged = Math.abs(nextHeight - currentHeight) >= 6
            && Math.abs(nextHeight - this.embedLastRequestedHeight) >= 3;
        if (!widthChanged && !heightChanged) {
            this.embedFrameAutoSizeDone = true;
            return false;
        }

        frame.style.maxWidth = '100%';
        frame.style.marginInline = 'auto';
        if (widthChanged) {
            frame.style.width = `${nextWidth}px`;
        }
        if (heightChanged) {
            this.embedLastRequestedHeight = nextHeight;
            frame.style.height = `${nextHeight}px`;
        }
        this.embedFrameAutoSizeDone = true;
        return true;
    }

    applyEmbedViewportFit() {
        if (!this.embedMode || !this.embedAutoFit || this.embedViewportFitInProgress || this.isShuttingDown) {
            return;
        }

        if (!this.compositeSlots.length && !this.sceneObjects.length) {
            return;
        }

        this.embedViewportFitInProgress = true;
        try {
            const bounds = this.fitCameraToProjectedContent({ paddingNdc: EMBED_FIT_PADDING_NDC })
                || this.collectProjectedContentBounds();
            const resized = this.resizeEmbedFrameToProjectedBounds(bounds);
            this.renderer.render(this.scene, this.camera);
            if (resized) {
                this.scheduleEmbedViewportFit(120);
            }
        } finally {
            this.embedViewportFitInProgress = false;
        }
    }

    startAutoTurnRight() {
        if (!this.controls) {
            return;
        }

        this._cameraAnim = null;
        this.autoTurnRightActive = true;
        this.controls.autoRotate = true;
        this.controls.autoRotateSpeed = AUTO_TURN_RIGHT_SPEED;
    }

    stopAutoTurnRight() {
        const wasActive = this.autoTurnRightActive || this.controls?.autoRotate;
        this.autoTurnRightActive = false;
        if (this.controls) {
            this.controls.autoRotate = false;
        }
        if (wasActive) {
            this.scheduleLocalStateSave({ viewOnly: true });
        }
    }

    toggleAutoTurnRight() {
        if (this.autoTurnRightActive || this.controls?.autoRotate) {
            this.stopAutoTurnRight();
        } else {
            this.startAutoTurnRight();
        }
    }

    resetView() {
        this.stopAutoTurnRight();
        const params = this._fitCameraParams(this.compositeGroup, 1.38, new THREE.Vector3(1, 0.72, 0.94));
        if (!params) {
            this.fitCameraToPrimitive(6);
            this.scheduleLocalStateSave({ viewOnly: true });
            return;
        }
        this._cameraAnim = {
            fromPos: this.camera.position.clone(),
            fromTarget: this.controls.target.clone(),
            toPos: params.cameraPos,
            toTarget: params.target,
            startTime: performance.now(),
            duration: 600
        };
    }

    clearComposite() {
        if (this.compositeGroup) {
            this.scene.remove(this.compositeGroup);
            this.disposeObject3D(this.compositeGroup);
            this.compositeGroup = null;
            this.primitiveGroup = null;
        }
        this.slotGroupMap = new Map();
        this.slotTopologyMap = new Map();
        this.slotCurvedDescriptorMap = new Map();
        this.slotTopologyErrors = new Map();
        this.slotAttachmentFaceMap = new Map();
        this.primitiveMeshes = [];
        this.slotLinkages = [];
        this.pointMarkers.clear();
        this.pointDefinitions = [];
        this.derivedPoints = [];
    }

    clearPrimitive() {
        this.clearComposite();
    }

    disposeSprites(sprites) {
        sprites.forEach((sprite) => this.disposeObject3D(sprite));
    }

    disposeObject3D(object3D) {
        object3D.traverse?.((child) => {
            if (child.geometry) {
                child.geometry.dispose();
            }
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach((material) => {
                        material.map?.dispose?.();
                        if (this.constructionLineMaterials.has(material)) {
                            this.constructionLineMaterials.delete(material);
                        }
                        material.dispose();
                    });
                } else {
                    child.material.map?.dispose?.();
                    if (this.constructionLineMaterials.has(child.material)) {
                        this.constructionLineMaterials.delete(child.material);
                    }
                    child.material.dispose();
                }
            }
        });
    }

    animate() {
        if (!this.renderer) return;
        this.animationFrameId = window.requestAnimationFrame(() => this.animate());
        if (this._cameraAnim) {
            const { fromPos, fromTarget, toPos, toTarget, startTime, duration } = this._cameraAnim;
            const raw = Math.min(1, (performance.now() - startTime) / duration);
            const t = 1 - Math.pow(1 - raw, 3); // ease-out cubic
            this.camera.position.lerpVectors(fromPos, toPos, t);
            this.controls.target.lerpVectors(fromTarget, toTarget, t);
            if (raw >= 1) {
                this._cameraAnim = null;
                this.scheduleLocalStateSave({ viewOnly: true });
            }
        }
        // OrbitControls keeps applying damping even when input is disabled.
        // openTwoDViews clears that inertia, and no camera update should run
        // while the read-only modal owns focus.
        if (!this.isTwoDViewsOpen()) {
            this.controls.update();
        }
        this.updateIntrinsicRightAngleMarkerVisibility();
        this.applyKeyboardCameraInput();
        this.updateEdgeLabelRotations();
        this.renderer.render(this.scene, this.camera);
    }

    applyKeyboardCameraInput() {
        if (!this._keysHeld || this._keysHeld.size === 0) return;
        if (helpOverlay.classList.contains('show')
                || activeCustomModalDismiss
                || this.isCrashReportOpen()
                || this.isTwoDViewsOpen()
                || this.triangleExtractOverlay?.classList.contains('show')) return;

        const rotateSpeed = 0.022;
        const zoomSpeed = 0.04;
        const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
        const spherical = new THREE.Spherical().setFromVector3(offset);

        if (this._keysHeld.has('ArrowLeft'))  spherical.theta -= rotateSpeed;
        if (this._keysHeld.has('ArrowRight')) spherical.theta += rotateSpeed;
        if (this._keysHeld.has('ArrowUp'))    spherical.phi   = Math.max(0.05, spherical.phi - rotateSpeed);
        if (this._keysHeld.has('ArrowDown'))  spherical.phi   = Math.min(Math.PI - 0.05, spherical.phi + rotateSpeed);

        if (this.embedZoomEnabled) {
            if (this._keysHeld.has('Equal') || this._keysHeld.has('NumpadAdd')) {
                spherical.radius = Math.max(this.controls.minDistance, spherical.radius * (1 - zoomSpeed));
            }
            if (this._keysHeld.has('Minus') || this._keysHeld.has('NumpadSubtract')) {
                spherical.radius = Math.min(this.controls.maxDistance, spherical.radius * (1 + zoomSpeed));
            }
        }

        offset.setFromSpherical(spherical);
        this.camera.position.copy(this.controls.target).add(offset);
        this.controls.update();
    }

    updateEdgeLabelRotations() {
        const aspect = this.canvas.clientWidth / this.canvas.clientHeight;
        const projA = new THREE.Vector3();
        const projB = new THREE.Vector3();
        for (const obj of this.sceneObjects) {
            const def = obj.definition;
            if (!def || (def.kind !== 'edge-label' && def.kind !== 'length-label')) continue;
            const sprite = obj.object3D;
            if (!(sprite instanceof THREE.Sprite)) continue;
            const vectors = this.getVectorsByPointIds(def.pointIds || []);
            if (!vectors || vectors.length !== 2) continue;
            projA.copy(vectors[0]).project(this.camera);
            projB.copy(vectors[1]).project(this.camera);
            const dx = (projB.x - projA.x) * aspect;
            const dy = projB.y - projA.y;
            if (dx * dx + dy * dy < 1e-6) continue;
            let angle = Math.atan2(dy, dx);
            if (angle > Math.PI / 2) angle -= Math.PI;
            if (angle < -Math.PI / 2) angle += Math.PI;
            sprite.material.rotation = angle;
        }
    }

    disposeRuntimeScene() {
        const detachedObjects = (this.sceneObjects || [])
            .map((entry) => entry?.object3D)
            .filter((object3D) => object3D && !object3D.parent);

        if (this.scene) {
            this.disposeObject3D(this.scene);
            this.scene.clear();
        }
        detachedObjects.forEach((object3D) => this.disposeObject3D(object3D));

        this.sceneObjects = [];
        this.selectedPoints = [];
        this.compositeGroup = null;
        this.primitiveGroup = null;
        this.slotGroupMap = new Map();
        this.slotTopologyMap = new Map();
        this.slotCurvedDescriptorMap = new Map();
        this.slotTopologyErrors = new Map();
        this.slotAttachmentFaceMap = new Map();
        this.primitiveMeshes = [];
        this.slotLinkages = [];
        this.pointMarkers.clear();
        this.pointSprites = [];
        this.labelSprites = [];
        this.constructionLineMaterials.clear();
        this.scene = null;
        this.grid = null;
    }

    cleanup() {
        this.scheduleLocalStateSave({ viewOnly: true });
        this.flushPendingLocalStateSave();
        this.isShuttingDown = true;
        if (this.toastHideTimer) {
            clearTimeout(this.toastHideTimer);
            this.toastHideTimer = null;
        }
        this.toastEl?.remove();
        this.toastEl = null;
        this.removeManagedEventListeners();
        this._handleAddBtnClick = null;
        this._handleAddDropdownClick = null;
        this._handleDocumentClickCloseAddDropdown = null;
        this._handleKeyDown = null;
        this._handleKeyUp = null;
        this._handleOrbitControlsStart = null;
        this._handleOrbitControlsEnd = null;
        if (this.embedViewportFitTimer) {
            clearTimeout(this.embedViewportFitTimer);
            this.embedViewportFitTimer = null;
        }
        this.stopAutoTurnRight();
        this._handleCrashReportRefreshClick = null;
        this._handleCrashReportCopyClick = null;
        this._handleCrashReportCloseClick = null;
        this._handleCrashReportOverlayClick = null;
        this.closeTwoDViews({ restoreFocus: false });
        this.closeCrashReport();
        this.teardownCrashDiagnostics();
        if (this.triangleExtractSettleTimer) {
            window.clearTimeout(this.triangleExtractSettleTimer);
            this.triangleExtractSettleTimer = null;
        }
        if (this.triangleExtractAnimationFrame) {
            window.cancelAnimationFrame(this.triangleExtractAnimationFrame);
            this.triangleExtractAnimationFrame = null;
        }
        this.closeTriangleExtraction({ force: true });
        if (this.animationFrameId) {
            window.cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        this.controls?.dispose();
        this.renderer?.dispose();
        this.controls = null;
        this.renderer = null;
        this.disposeRuntimeScene();
        this.embedFullViewerButton?.remove();
        this.embedFullViewerButton = null;
        this.canvasEmptyStateEl?.remove();
        this.canvasEmptyStateEl = null;
        this._initialized = false;
    }
}
