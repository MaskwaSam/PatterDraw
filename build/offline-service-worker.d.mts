export interface OfflineAppShellEntry {
  bytes: number;
  mime: string;
  path: string;
  sha256: string;
}

export interface OfflineContinuityEntry extends OfflineAppShellEntry {
  offset: number;
}

export interface OfflineContinuityPack {
  bytes: number;
  path: string;
  sha256: string;
  uncompressedBytes: number;
}

export interface GeneratedOfflineServiceWorker {
  code: string;
  continuityBytes: number;
  continuityEntries: OfflineContinuityEntry[];
  continuityPack: OfflineContinuityPack | null;
  continuityPackSource: Uint8Array | null;
  entries: OfflineAppShellEntry[];
  totalBytes: number;
  version: string;
}

export interface OfflineAppShellManifest {
  continuityBytes: number;
  continuityEntries: OfflineContinuityEntry[];
  continuityPack: OfflineContinuityPack | null;
  entries: OfflineAppShellEntry[];
  totalBytes: number;
  version: string;
}

export const APP_SHELL_CACHE_PREFIX: string;
export const APP_SHELL_CACHE_POLICY_VERSION: string;
export const APP_SHELL_MAX_BYTES: number;
export const CONTINUITY_CACHE_MAX_BYTES: number;
export const CONTINUITY_CACHE_MAX_ENTRIES: number;
export const CONTINUITY_PACK_MAX_BYTES: number;
export const OFFLINE_CACHE_MAX_BYTES: number;
export const ROUTING_STATE_RESERVED_BYTES: number;
export const APP_SHELL_PROTOCOL_HEADER: string;
export const APP_SHELL_PROTOCOL_VERSION: string;
export const GEOGON_RELEASE_AUTHORITY: string;

export function collectOfflineAppShellPaths(bundle: Record<string, unknown>): string[];

export function collectOfflineContinuityPathsFromFiles(input: {
  outputDirectory: string;
  shellPaths?: string[];
}): Promise<string[]>;

export function collectOfflineAppShell(bundle: Record<string, unknown>): OfflineAppShellManifest;

export function createOfflineServiceWorkerAssetFromFiles(input: {
  continuityPaths?: string[];
  outputDirectory: string;
  paths: string[];
}): Promise<GeneratedOfflineServiceWorker>;

export function renderOfflineServiceWorker(input: {
  continuityEntries?: OfflineContinuityEntry[];
  continuityPack?: OfflineContinuityPack | null;
  entries: OfflineAppShellEntry[];
  version: string;
}): string;

export function createOfflineServiceWorkerAsset(
  bundle: Record<string, unknown>,
): GeneratedOfflineServiceWorker;
