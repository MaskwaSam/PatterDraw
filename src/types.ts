import { createLocalId } from "./lib/id";

export const CLASSROOM_PROJECT_VERSION = 1 as const;

export type SceneId = string;
export type SlideId = string;
export type PdfDocumentId = string;

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
  pageCount: number;
  archivePath: string;
}

export interface ClassroomSlide {
  id: SlideId;
  sceneId: SceneId;
  frameId: string;
  title: string;
}

export interface ClassroomProject {
  schemaVersion: typeof CLASSROOM_PROJECT_VERSION;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activeSceneId: SceneId;
  scenes: Record<SceneId, SerializedScene>;
  slideOrder: ClassroomSlide[];
  /** Wrapper-owned frame visibility preference. Optional only for legacy v1 project files. */
  slideFramesVisible?: boolean;
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
    title: "Untitled classroom canvas",
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
    pdfPageOrder: [],
    pdfDocuments: {},
  };
}
