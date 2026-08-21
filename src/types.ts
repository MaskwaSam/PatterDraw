import { createLocalId } from "./lib/id";
import { DEFAULT_SLIDE_MORPH_DURATION_MS } from "./lib/slide-transition";

export const CLASSROOM_PROJECT_VERSION = 1 as const;
export const DEFAULT_PROJECT_TITLE = "Untitled PatterDraw canvas";

export type SceneId = string;
export type SlideId = string;
export type PdfDocumentId = string;
export type PdfInsertionPlacement = "before" | "after" | "end";

export interface SerializedScene {
  id: SceneId;
  name: string;
  elements: readonly Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, Record<string, unknown>>;
  pdfPage?: PdfPageWorkspace;
}

export interface PdfPageWorkspace {
  documentId: PdfDocumentId;
  /**
   * Identifies one user-selected source occurrence independently of the
   * deduplicated immutable PDF document. Optional only for legacy v1 projects.
   */
  sourceInstanceId?: string;
  /** Original local file name for this source occurrence. */
  sourceName?: string;
  pageIndex: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  backgroundElementId: string;
}

export interface PdfDocumentSource {
  id: PdfDocumentId;
  name: string;
  mimeType: "application/pdf";
  byteLength: number;
  /** SHA-256 of the immutable source bytes. Optional only for legacy v1 projects. */
  sha256?: string;
  pageCount: number;
  archivePath: string;
}

export interface ClassroomSlide {
  id: SlideId;
  sceneId: SceneId;
  frameId: string;
  title: string;
  /** Explicit title ownership. Optional only for legacy v1 project files. */
  titleMode?: "automatic" | "custom";
}

export type SlideFrameAspectRatio = "freeform" | "16:9" | "4:3";

export interface ClassroomProject {
  schemaVersion: typeof CLASSROOM_PROJECT_VERSION;
  id: string;
  title: string;
  /** Explicit title ownership. Optional only for legacy v1 project files. */
  titleMode?: "default" | "custom";
  createdAt: string;
  updatedAt: string;
  activeSceneId: SceneId;
  scenes: Record<SceneId, SerializedScene>;
  slideOrder: ClassroomSlide[];
  /** Wrapper-owned frame visibility preference. Optional only for legacy v1 project files. */
  slideFramesVisible?: boolean;
  /** Shape used for newly drawn slide frames. Optional only for legacy v1 project files. */
  slideFrameAspectRatio?: SlideFrameAspectRatio;
  /** @deprecated Legacy preference migrated to slideFrameAspectRatio when loading. */
  slideWidescreenFrames?: boolean;
  /** Smooth presentation navigation preference. Optional only for legacy v1 project files. */
  slideMorphEnabled?: boolean;
  /** Morph duration in milliseconds. Optional only for legacy v1 project files. */
  slideMorphDurationMs?: number;
  /** Ordered PDF page scene IDs. Optional only for legacy v1 project files. */
  pdfPageOrder?: SceneId[];
  pdfDocuments: Record<PdfDocumentId, PdfDocumentSource>;
}

export interface LoadedClassroomProject {
  project: ClassroomProject;
  pdfBytes: Record<PdfDocumentId, Uint8Array>;
}

export interface ExportBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export function createBlankProject(now = new Date()): ClassroomProject {
  const timestamp = now.toISOString();
  const sceneId = createLocalId();
  return {
    schemaVersion: CLASSROOM_PROJECT_VERSION,
    id: createLocalId(),
    title: DEFAULT_PROJECT_TITLE,
    titleMode: "default",
    createdAt: timestamp,
    updatedAt: timestamp,
    activeSceneId: sceneId,
    scenes: {
      [sceneId]: {
        id: sceneId,
        name: "Canvas",
        elements: [],
        appState: {},
        files: {},
      },
    },
    slideOrder: [],
    slideFramesVisible: true,
    slideFrameAspectRatio: "freeform",
    slideMorphEnabled: false,
    slideMorphDurationMs: DEFAULT_SLIDE_MORPH_DURATION_MS,
    pdfPageOrder: [],
    pdfDocuments: {},
  };
}
