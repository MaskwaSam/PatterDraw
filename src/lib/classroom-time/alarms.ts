import {
  ALARM_REPEAT_INTERVAL_MS,
  MAX_ACTIVE_ALARM_JOBS,
  MAX_ALARM_REPEAT_WINDOW_MS,
  MAX_CLASSROOM_TIME_LABEL_LENGTH,
  MAX_TIMER_DURATION_MS,
} from "./constants";
import {
  ALARM_TONES,
  isClassroomTimeId,
  type ClassroomAlarmTone,
} from "./types";

export const CLASSROOM_ALARM_REGISTRY_STORAGE_KEY = "patterdraw:classroom-alarm-registry:v1";
export const CLASSROOM_ALARM_CLAIM_STORAGE_KEY_PREFIX = "patterdraw:classroom-alarm-claim:v1:";
const CLASSROOM_ALARM_REGISTRY_EVENT = "patterdraw:classroom-alarm-registry-change";
export const CLASSROOM_ALARM_CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const CLASSROOM_ALARM_CLAIM_LEASE_MS = 5_000;
export const CLASSROOM_ALARM_DELIVERY_LEASE_MS = 30_000;
export const MAX_BLOCKED_ALARM_REPLAY_ATTEMPTS = 3;
export const CLASSROOM_ALARM_TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_CLASSROOM_ALARM_DELIVERY_TOMBSTONES = 256;
export const MAX_CLASSROOM_ALARM_TOMBSTONE_BYTES = 64 * 1_024;
export const CLASSROOM_ALARM_CANCELLATION_RETENTION_MS =
  MAX_TIMER_DURATION_MS + CLASSROOM_ALARM_CATCHUP_WINDOW_MS;
export const CLASSROOM_ALARM_STAGED_TRANSACTION_RETENTION_MS =
  CLASSROOM_ALARM_CATCHUP_WINDOW_MS;
export const CLASSROOM_ALARM_STAGED_RESTORE_RETENTION_MS =
  CLASSROOM_ALARM_STAGED_TRANSACTION_RETENTION_MS;
export const MAX_CLASSROOM_ALARM_STAGED_TRANSACTIONS = MAX_ACTIVE_ALARM_JOBS;
export const MAX_CLASSROOM_ALARM_STAGED_TRANSACTION_BYTES = 256 * 1_024;
export const MAX_CLASSROOM_ALARM_CANCELLATION_TOMBSTONES = 256;
export const MAX_CLASSROOM_ALARM_CANCELLATION_BYTES = 64 * 1_024;

export type ClassroomAlarmDeliveryResult = "acknowledged" | "audio-blocked";
export type ClassroomAlarmTarget = "timer" | "pomodoro";

export interface ClassroomAlarmIdentity {
  sourceProjectId: string;
  ownerId: string;
  target: ClassroomAlarmTarget;
}

export interface ClassroomAlarmDeadlineIdentity extends ClassroomAlarmIdentity {
  deadlineMs: number;
}

export interface ClassroomAlarmGenerationIdentity extends ClassroomAlarmDeadlineIdentity {
  createdAtMs: number;
}

export interface ClassroomAlarmJobV1 {
  version: 1;
  id: string;
  sourceProjectId: string;
  ownerId: string;
  widgetKind: "timer" | "pomodoro" | "dashboard";
  target: ClassroomAlarmTarget;
  label: string;
  deadlineMs: number;
  tone: ClassroomAlarmTone;
  repeat: boolean;
  createdAtMs: number;
  soundWindowStartedAtMs: number | null;
  lastSoundAtMs: number | null;
  soundCount: number;
  deliveryState: "staged" | "pending" | "delivering" | "blocked";
  deliveryStateAtMs: number | null;
  blockedAttempts: number;
}

export interface ClassroomAlarmDeliveryTombstoneV1 extends ClassroomAlarmGenerationIdentity {
  version: 1;
  deliveredAtMs: number;
}

export interface ClassroomAlarmCancelledGenerationV1 {
  jobId: string;
  createdAtMs: number;
  deadlineMs: number;
}

export interface ClassroomAlarmCancellationTombstoneV1 extends ClassroomAlarmIdentity {
  version: 1;
  cancelledAtMs: number;
  cancelledGeneration: ClassroomAlarmCancelledGenerationV1 | null;
  restoredAtMs: number | null;
  /** Present on cancellation events that issued an exact Undo receipt. */
  receiptId?: string | null;
  /** Exact pending snapshot bound to that receipt identity; null means no job was removed. */
  receiptJob?: ClassroomAlarmJobV1 | null;
}

export type ClassroomAlarmStageMode =
  | "trusted-start"
  | "scheduler-start"
  | "recovery"
  | "cancelled-restore";

export interface ClassroomAlarmStagedTransactionV1 {
  version: 1;
  id: string;
  mode: ClassroomAlarmStageMode;
  stagedAtMs: number;
  stagedJobs: ClassroomAlarmJobV1[];
  previousJobs: ClassroomAlarmJobV1[];
  previousCancellationTombstones: ClassroomAlarmCancellationTombstoneV1[];
  stagedCancellationTombstones: ClassroomAlarmCancellationTombstoneV1[];
}

export interface ClassroomAlarmTransactionReceiptV1 {
  version: 1;
  transactionId: string;
  mode: ClassroomAlarmStageMode;
  stagedAtMs: number;
  stagedJobs: ClassroomAlarmJobV1[];
}

export interface ClassroomAlarmCancellationReceiptV1 {
  version: 1;
  receiptId: string;
  cancelledAtMs: number;
  identities: ClassroomAlarmIdentity[];
  cancelledJobs: ClassroomAlarmJobV1[];
}

export interface ClassroomAlarmRegistryV1 {
  version: 1;
  revision: number;
  jobs: ClassroomAlarmJobV1[];
  deliveredTombstones: ClassroomAlarmDeliveryTombstoneV1[];
  cancellationTombstones: ClassroomAlarmCancellationTombstoneV1[];
  stagedTransactions?: ClassroomAlarmStagedTransactionV1[];
}

export interface ClassroomAlarmClaimV1 {
  version: 1;
  jobId: string;
  claimantId: string;
  claimedAtMs: number;
  expiresAtMs: number;
}

export type ClassroomAlarmStorage = Pick<Storage, "getItem" | "setItem">
  & Partial<Pick<Storage, "removeItem">>;
export type ClassroomAlarmPersistenceStatus =
  | "persisted"
  | "memory-only"
  | "rolled-back"
  | "indeterminate"
  | "conflicted";

export interface ClassroomAlarmRegistryWriteResult {
  registry: ClassroomAlarmRegistryV1;
  status: ClassroomAlarmPersistenceStatus;
  error?: unknown;
}

export interface ClassroomAlarmTransactionWriteResult
  extends ClassroomAlarmRegistryWriteResult {
  receipt: ClassroomAlarmTransactionReceiptV1 | null;
}

export interface ClassroomAlarmCancellationWriteResult
  extends ClassroomAlarmRegistryWriteResult {
  receipt: ClassroomAlarmCancellationReceiptV1 | null;
}

export interface ClassroomAlarmTransactionRollbackResult
  extends ClassroomAlarmRegistryWriteResult {
  /** Rotated Undo authority; replace the caller's stale receipt when present. */
  cancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null;
}

export interface ClassroomAlarmStartOptions {
  preservePendingDelivery?: boolean;
}

function browserStorage(): ClassroomAlarmStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length
    && Object.keys(record).every((key) => keys.includes(key));
}

function normalizeClassroomAlarmStartOptions(
  value: ClassroomAlarmStartOptions,
): Required<ClassroomAlarmStartOptions> {
  if (!isRecord(value)) throw new TypeError("Classroom alarm start options are invalid.");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "preservePendingDelivery")
    || (value.preservePendingDelivery !== undefined
      && typeof value.preservePendingDelivery !== "boolean")) {
    throw new TypeError("Classroom alarm start options are invalid.");
  }
  return { preservePendingDelivery: value.preservePendingDelivery ?? false };
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function cloneJob(job: ClassroomAlarmJobV1): ClassroomAlarmJobV1 {
  return { ...job };
}

function cloneTombstone(
  tombstone: ClassroomAlarmDeliveryTombstoneV1,
): ClassroomAlarmDeliveryTombstoneV1 {
  return { ...tombstone };
}

function cloneCancellationTombstone(
  tombstone: ClassroomAlarmCancellationTombstoneV1,
): ClassroomAlarmCancellationTombstoneV1 {
  return {
    ...tombstone,
    cancelledGeneration: tombstone.cancelledGeneration === null
      ? null
      : { ...tombstone.cancelledGeneration },
    ...(Object.hasOwn(tombstone, "receiptJob")
      ? { receiptJob: tombstone.receiptJob === null ? null : cloneJob(tombstone.receiptJob!) }
      : {}),
  };
}

function cloneStagedTransaction(
  transaction: ClassroomAlarmStagedTransactionV1,
): ClassroomAlarmStagedTransactionV1 {
  return {
    ...transaction,
    stagedJobs: transaction.stagedJobs.map(cloneJob),
    previousJobs: transaction.previousJobs.map(cloneJob),
    previousCancellationTombstones: transaction.previousCancellationTombstones.map(
      cloneCancellationTombstone,
    ),
    stagedCancellationTombstones: transaction.stagedCancellationTombstones.map(
      cloneCancellationTombstone,
    ),
  };
}

function cloneTransactionReceipt(
  receipt: ClassroomAlarmTransactionReceiptV1,
): ClassroomAlarmTransactionReceiptV1 {
  return { ...receipt, stagedJobs: receipt.stagedJobs.map(cloneJob) };
}

function cloneAlarmIdentity(identity: ClassroomAlarmIdentity): ClassroomAlarmIdentity {
  return { ...identity };
}

function cloneCancellationReceipt(
  receipt: ClassroomAlarmCancellationReceiptV1,
): ClassroomAlarmCancellationReceiptV1 {
  return {
    ...receipt,
    identities: receipt.identities.map(cloneAlarmIdentity),
    cancelledJobs: receipt.cancelledJobs.map(cloneJob),
  };
}

function alarmIdentityKey(identity: ClassroomAlarmIdentity): string {
  return `${identity.sourceProjectId}\u0000${identity.ownerId}\u0000${identity.target}`;
}

function alarmDeadlineIdentityKey(identity: ClassroomAlarmDeadlineIdentity): string {
  return `${alarmIdentityKey(identity)}\u0000${identity.deadlineMs}`;
}

function serializedTombstoneBytes(
  tombstones: readonly ClassroomAlarmDeliveryTombstoneV1[],
): number {
  return new TextEncoder().encode(JSON.stringify(tombstones)).byteLength;
}

function serializedCancellationTombstoneBytes(
  tombstones: readonly ClassroomAlarmCancellationTombstoneV1[],
): number {
  return new TextEncoder().encode(JSON.stringify(tombstones)).byteLength;
}

function serializedStagedTransactionBytes(
  transactions: readonly ClassroomAlarmStagedTransactionV1[],
): number {
  return new TextEncoder().encode(JSON.stringify(transactions)).byteLength;
}

export function parseClassroomAlarmJob(value: unknown): ClassroomAlarmJobV1 | null {
  const keys = [
    "version", "id", "sourceProjectId", "ownerId", "widgetKind", "target", "label", "deadlineMs",
    "tone", "repeat", "createdAtMs", "soundWindowStartedAtMs", "lastSoundAtMs", "soundCount",
    "deliveryState", "deliveryStateAtMs", "blockedAttempts",
  ];
  if (!isRecord(value) || !exactKeys(value, keys)) return null;
  if (value.version !== 1
    || !isClassroomTimeId(value.id)
    || !isClassroomTimeId(value.sourceProjectId)
    || !isClassroomTimeId(value.ownerId)
    || (value.widgetKind !== "timer" && value.widgetKind !== "pomodoro" && value.widgetKind !== "dashboard")
    || (value.target !== "timer" && value.target !== "pomodoro")
    || typeof value.label !== "string"
    || value.label.length > MAX_CLASSROOM_TIME_LABEL_LENGTH
    || !isTimestamp(value.deadlineMs)
    || !ALARM_TONES.includes(value.tone as ClassroomAlarmTone)
    || typeof value.repeat !== "boolean"
    || !isTimestamp(value.createdAtMs)
    || !(value.soundWindowStartedAtMs === null || isTimestamp(value.soundWindowStartedAtMs))
    || !(value.lastSoundAtMs === null || isTimestamp(value.lastSoundAtMs))
    || typeof value.soundCount !== "number"
    || !Number.isSafeInteger(value.soundCount)
    || value.soundCount < 0
    || value.soundCount > 7
    || (value.deliveryState !== "staged"
      && value.deliveryState !== "pending"
      && value.deliveryState !== "delivering"
      && value.deliveryState !== "blocked")
    || !(value.deliveryStateAtMs === null || isTimestamp(value.deliveryStateAtMs))
    || typeof value.blockedAttempts !== "number"
    || !Number.isSafeInteger(value.blockedAttempts)
    || value.blockedAttempts < 0
    || value.blockedAttempts > MAX_BLOCKED_ALARM_REPLAY_ATTEMPTS) return null;
  if ((value.widgetKind === "timer" && value.target !== "timer")
    || (value.widgetKind === "pomodoro" && value.target !== "pomodoro")) return null;
  if (value.createdAtMs > value.deadlineMs
    || value.deadlineMs - value.createdAtMs > MAX_TIMER_DURATION_MS) return null;
  if (Array.from(value.label).length > MAX_CLASSROOM_TIME_LABEL_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value.label)
    || (value.label.length > 0 && value.label.trim() !== value.label)) return null;
  if ((value.soundCount === 0) !== (value.lastSoundAtMs === null)) return null;
  if ((value.soundCount === 0) !== (value.soundWindowStartedAtMs === null)) return null;
  if (value.lastSoundAtMs !== null && value.soundWindowStartedAtMs !== null
    && (value.lastSoundAtMs < value.soundWindowStartedAtMs || value.lastSoundAtMs < value.deadlineMs)) return null;
  if (value.deliveryState === "staged") {
    if (value.deliveryStateAtMs === null
      || value.deliveryStateAtMs < value.createdAtMs
      || value.soundCount !== 0
      || value.soundWindowStartedAtMs !== null
      || value.lastSoundAtMs !== null
      || value.blockedAttempts !== 0) return null;
  } else if (value.deliveryState === "pending") {
    if (value.deliveryStateAtMs !== null || value.blockedAttempts !== 0) return null;
  } else if (value.deliveryState === "delivering") {
    if (value.deliveryStateAtMs === null || value.deliveryStateAtMs < value.deadlineMs) return null;
  } else if (value.deliveryStateAtMs === null
    || value.deliveryStateAtMs < value.deadlineMs
    || value.blockedAttempts < 1) return null;
  return cloneJob(value as unknown as ClassroomAlarmJobV1);
}

function parseLegacyClassroomAlarmJob(value: unknown): ClassroomAlarmJobV1 | null {
  if (!isRecord(value)) return null;
  const legacyKeys = [
    "version", "id", "sourceProjectId", "ownerId", "widgetKind", "label", "deadlineMs",
    "tone", "repeat", "createdAtMs", "soundWindowStartedAtMs", "lastSoundAtMs", "soundCount",
    "deliveryState", "deliveryStateAtMs", "blockedAttempts",
  ];
  if (!exactKeys(value, legacyKeys)) return null;
  const target = value.widgetKind === "timer"
    ? "timer"
    : value.widgetKind === "pomodoro"
      ? "pomodoro"
      : value.id === `${String(value.ownerId)}:timer`
        ? "timer"
        : value.id === `${String(value.ownerId)}:pomodoro`
          ? "pomodoro"
          : null;
  return target === null ? null : parseClassroomAlarmJob({ ...value, target });
}

export function parseClassroomAlarmDeliveryTombstone(
  value: unknown,
): ClassroomAlarmDeliveryTombstoneV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "sourceProjectId", "ownerId", "target", "createdAtMs", "deadlineMs",
    "deliveredAtMs",
  ])) return null;
  if (value.version !== 1
    || !isClassroomTimeId(value.sourceProjectId)
    || !isClassroomTimeId(value.ownerId)
    || (value.target !== "timer" && value.target !== "pomodoro")
    || !isTimestamp(value.createdAtMs)
    || !isTimestamp(value.deadlineMs)
    || !isTimestamp(value.deliveredAtMs)
    || value.createdAtMs > value.deadlineMs
    || value.deadlineMs - value.createdAtMs > MAX_TIMER_DURATION_MS
    || value.deliveredAtMs < value.deadlineMs
    || value.deliveredAtMs - value.deadlineMs > CLASSROOM_ALARM_CATCHUP_WINDOW_MS) return null;
  return cloneTombstone(value as unknown as ClassroomAlarmDeliveryTombstoneV1);
}

function parseLegacyClassroomAlarmDeliveryTombstone(
  value: unknown,
): ClassroomAlarmDeliveryTombstoneV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "sourceProjectId", "ownerId", "target", "deadlineMs", "deliveredAtMs",
  ])) return null;
  if (value.version !== 1
    || !isClassroomTimeId(value.sourceProjectId)
    || !isClassroomTimeId(value.ownerId)
    || (value.target !== "timer" && value.target !== "pomodoro")
    || !isTimestamp(value.deadlineMs)
    || !isTimestamp(value.deliveredAtMs)
    || value.deliveredAtMs < value.deadlineMs
    || value.deliveredAtMs - value.deadlineMs > CLASSROOM_ALARM_CATCHUP_WINDOW_MS) return null;
  // Older envelopes did not retain the generation start. Inferring the
  // earliest valid start keeps exact-deadline suppression intact without
  // claiming authority over a genuinely later Start.
  return {
    version: 1,
    sourceProjectId: value.sourceProjectId,
    ownerId: value.ownerId,
    target: value.target,
    createdAtMs: Math.max(0, value.deadlineMs - MAX_TIMER_DURATION_MS),
    deadlineMs: value.deadlineMs,
    deliveredAtMs: value.deliveredAtMs,
  };
}

export function parseClassroomAlarmCancellationTombstone(
  value: unknown,
): ClassroomAlarmCancellationTombstoneV1 | null {
  if (!isRecord(value)) return null;
  const previousShape = exactKeys(value, [
    "version", "sourceProjectId", "ownerId", "target", "cancelledAtMs",
    "cancelledGeneration", "restoredAtMs",
  ]);
  const receiptShape = exactKeys(value, [
    "version", "sourceProjectId", "ownerId", "target", "cancelledAtMs",
    "cancelledGeneration", "restoredAtMs", "receiptId",
  ]);
  const exactReceiptShape = exactKeys(value, [
    "version", "sourceProjectId", "ownerId", "target", "cancelledAtMs",
    "cancelledGeneration", "restoredAtMs", "receiptId", "receiptJob",
  ]);
  if (!previousShape && !receiptShape && !exactReceiptShape) return null;
  let cancelledGeneration: ClassroomAlarmCancelledGenerationV1 | null = null;
  if (value.cancelledGeneration !== null) {
    const candidate = value.cancelledGeneration;
    if (!isRecord(candidate)
      || !exactKeys(candidate, ["jobId", "createdAtMs", "deadlineMs"])
      || !isClassroomTimeId(candidate.jobId)
      || !isTimestamp(candidate.createdAtMs)
      || !isTimestamp(candidate.deadlineMs)
      || candidate.createdAtMs > candidate.deadlineMs
      || candidate.deadlineMs - candidate.createdAtMs > MAX_TIMER_DURATION_MS) return null;
    cancelledGeneration = {
      jobId: candidate.jobId,
      createdAtMs: candidate.createdAtMs,
      deadlineMs: candidate.deadlineMs,
    };
  }
  const receiptJob = exactReceiptShape && value.receiptJob !== null
    ? parseClassroomAlarmJob(value.receiptJob)
    : null;
  if (exactReceiptShape && value.receiptJob !== null && receiptJob === null) return null;
  if (value.version !== 1
    || !isClassroomTimeId(value.sourceProjectId)
    || !isClassroomTimeId(value.ownerId)
    || (value.target !== "timer" && value.target !== "pomodoro")
    || !isTimestamp(value.cancelledAtMs)
    || ((receiptShape || exactReceiptShape)
      && !(value.receiptId === null || isClassroomTimeId(value.receiptId)))
    || !(value.restoredAtMs === null || isTimestamp(value.restoredAtMs))
    || (cancelledGeneration !== null
      && cancelledGeneration.createdAtMs > value.cancelledAtMs)
    || (value.restoredAtMs !== null
      && (cancelledGeneration === null || value.restoredAtMs < value.cancelledAtMs))
    || (exactReceiptShape && value.receiptId === null && receiptJob !== null)
    || (receiptJob !== null
      && (receiptJob.deliveryState !== "pending"
        || receiptJob.createdAtMs > value.cancelledAtMs
        || receiptJob.sourceProjectId !== value.sourceProjectId
        || receiptJob.ownerId !== value.ownerId
        || receiptJob.target !== value.target
        || !cancelledGenerationMatchesJob(cancelledGeneration, receiptJob)))) return null;
  return {
    version: 1,
    sourceProjectId: value.sourceProjectId,
    ownerId: value.ownerId,
    target: value.target,
    cancelledAtMs: value.cancelledAtMs,
    cancelledGeneration,
    restoredAtMs: value.restoredAtMs,
    ...(receiptShape || exactReceiptShape
      ? { receiptId: value.receiptId as string | null }
      : {}),
    ...(exactReceiptShape ? { receiptJob } : {}),
  };
}

function parseLegacyClassroomAlarmCancellationTombstone(
  value: unknown,
): ClassroomAlarmCancellationTombstoneV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "sourceProjectId", "ownerId", "target", "cancelledAtMs",
  ])) return null;
  if (value.version !== 1
    || !isClassroomTimeId(value.sourceProjectId)
    || !isClassroomTimeId(value.ownerId)
    || (value.target !== "timer" && value.target !== "pomodoro")
    || !isTimestamp(value.cancelledAtMs)) return null;
  return {
    version: 1,
    sourceProjectId: value.sourceProjectId,
    ownerId: value.ownerId,
    target: value.target,
    cancelledAtMs: value.cancelledAtMs,
    cancelledGeneration: null,
    restoredAtMs: null,
  };
}

function isClassroomAlarmStageMode(value: unknown): value is ClassroomAlarmStageMode {
  return value === "trusted-start"
    || value === "scheduler-start"
    || value === "recovery"
    || value === "cancelled-restore";
}

export function parseClassroomAlarmStagedTransaction(
  value: unknown,
): ClassroomAlarmStagedTransactionV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "id", "mode", "stagedAtMs", "stagedJobs", "previousJobs",
    "previousCancellationTombstones", "stagedCancellationTombstones",
  ])) return null;
  if (value.version !== 1
    || !isClassroomTimeId(value.id)
    || !isClassroomAlarmStageMode(value.mode)
    || !isTimestamp(value.stagedAtMs)
    || !Array.isArray(value.stagedJobs)
    || value.stagedJobs.length === 0
    || value.stagedJobs.length > MAX_ACTIVE_ALARM_JOBS
    || !Array.isArray(value.previousJobs)
    || value.previousJobs.length > MAX_ACTIVE_ALARM_JOBS
    || !Array.isArray(value.previousCancellationTombstones)
    || value.previousCancellationTombstones.length
      > MAX_CLASSROOM_ALARM_CANCELLATION_TOMBSTONES
    || !Array.isArray(value.stagedCancellationTombstones)
    || value.stagedCancellationTombstones.length
      > MAX_CLASSROOM_ALARM_CANCELLATION_TOMBSTONES) return null;
  const stagedJobs = value.stagedJobs.map(parseClassroomAlarmJob);
  const previousJobs = value.previousJobs.map(parseClassroomAlarmJob);
  const previousCancellationTombstones = value.previousCancellationTombstones.map(
    parseClassroomAlarmCancellationTombstone,
  );
  const stagedCancellationTombstones = value.stagedCancellationTombstones.map(
    parseClassroomAlarmCancellationTombstone,
  );
  if (stagedJobs.some((job) => job === null
      || job.deliveryState !== "staged"
      || job.deliveryStateAtMs !== value.stagedAtMs)
    || previousJobs.some((job) => job === null || job.deliveryState === "staged")
    || previousCancellationTombstones.some((tombstone) => tombstone === null)
    || stagedCancellationTombstones.some((tombstone) => tombstone === null)) return null;
  const parsedStagedJobs = stagedJobs as ClassroomAlarmJobV1[];
  const parsedPreviousJobs = previousJobs as ClassroomAlarmJobV1[];
  const stagedIdentityKeys = parsedStagedJobs.map(alarmIdentityKey);
  if (new Set(parsedStagedJobs.map(({ id }) => id)).size !== parsedStagedJobs.length
    || new Set(stagedIdentityKeys).size !== stagedIdentityKeys.length
    || new Set(parsedPreviousJobs.map(({ id }) => id)).size !== parsedPreviousJobs.length
    || new Set(parsedPreviousJobs.map(alarmIdentityKey)).size !== parsedPreviousJobs.length) {
    return null;
  }
  const affectedIdentityKeys = new Set([
    ...stagedIdentityKeys,
    ...parsedPreviousJobs.map(alarmIdentityKey),
  ]);
  const previousCancellationKeys = (
    previousCancellationTombstones as ClassroomAlarmCancellationTombstoneV1[]
  ).map(alarmIdentityKey);
  const stagedCancellationKeys = (
    stagedCancellationTombstones as ClassroomAlarmCancellationTombstoneV1[]
  ).map(alarmIdentityKey);
  if (new Set(previousCancellationKeys).size !== previousCancellationKeys.length
    || new Set(stagedCancellationKeys).size !== stagedCancellationKeys.length
    || previousCancellationKeys.some((key) => !affectedIdentityKeys.has(key))
    || stagedCancellationKeys.some((key) => !affectedIdentityKeys.has(key))) return null;
  return cloneStagedTransaction({
    version: 1,
    id: value.id,
    mode: value.mode,
    stagedAtMs: value.stagedAtMs,
    stagedJobs: parsedStagedJobs,
    previousJobs: parsedPreviousJobs,
    previousCancellationTombstones:
      previousCancellationTombstones as ClassroomAlarmCancellationTombstoneV1[],
    stagedCancellationTombstones:
      stagedCancellationTombstones as ClassroomAlarmCancellationTombstoneV1[],
  });
}

export function parseClassroomAlarmTransactionReceipt(
  value: unknown,
): ClassroomAlarmTransactionReceiptV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "transactionId", "mode", "stagedAtMs", "stagedJobs",
  ])
    || value.version !== 1
    || !isClassroomTimeId(value.transactionId)
    || !isClassroomAlarmStageMode(value.mode)
    || !isTimestamp(value.stagedAtMs)
    || !Array.isArray(value.stagedJobs)
    || value.stagedJobs.length === 0
    || value.stagedJobs.length > MAX_ACTIVE_ALARM_JOBS) return null;
  const stagedJobs = value.stagedJobs.map(parseClassroomAlarmJob);
  if (stagedJobs.some((job) => job === null
      || job.deliveryState !== "staged"
      || job.deliveryStateAtMs !== value.stagedAtMs)) return null;
  const parsed = stagedJobs as ClassroomAlarmJobV1[];
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length
    || new Set(parsed.map(alarmIdentityKey)).size !== parsed.length) return null;
  return cloneTransactionReceipt({
    version: 1,
    transactionId: value.transactionId,
    mode: value.mode,
    stagedAtMs: value.stagedAtMs,
    stagedJobs: parsed,
  });
}

export function parseClassroomAlarmCancellationReceipt(
  value: unknown,
): ClassroomAlarmCancellationReceiptV1 | null {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "receiptId", "cancelledAtMs", "identities", "cancelledJobs",
  ])
    || value.version !== 1
    || !isClassroomTimeId(value.receiptId)
    || !isTimestamp(value.cancelledAtMs)
    || !Array.isArray(value.identities)
    || value.identities.length === 0
    || value.identities.length > MAX_CLASSROOM_ALARM_CANCELLATION_TOMBSTONES
    || !Array.isArray(value.cancelledJobs)
    || value.cancelledJobs.length > MAX_ACTIVE_ALARM_JOBS) return null;
  const identities = value.identities.map(parseClassroomAlarmIdentity);
  const cancelledJobs = value.cancelledJobs.map(parseClassroomAlarmJob);
  if (identities.some((identity) => identity === null)
    || cancelledJobs.some((job) => job === null || job.deliveryState !== "pending")) return null;
  const parsedIdentities = identities as ClassroomAlarmIdentity[];
  const parsedJobs = cancelledJobs as ClassroomAlarmJobV1[];
  const identityKeys = parsedIdentities.map(alarmIdentityKey);
  if (new Set(identityKeys).size !== identityKeys.length
    || new Set(parsedJobs.map(({ id }) => id)).size !== parsedJobs.length
    || new Set(parsedJobs.map(alarmIdentityKey)).size !== parsedJobs.length
    || parsedJobs.some((job) => !identityKeys.includes(alarmIdentityKey(job)))) return null;
  return cloneCancellationReceipt({
    version: 1,
    receiptId: value.receiptId,
    cancelledAtMs: value.cancelledAtMs,
    identities: parsedIdentities,
    cancelledJobs: parsedJobs,
  });
}

export function parseClassroomAlarmRegistry(value: unknown): ClassroomAlarmRegistryV1 | null {
  if (!isRecord(value)) return null;
  const legacy = exactKeys(value, ["version", "revision", "jobs"]);
  const deliveryOnly = exactKeys(value, [
    "version", "revision", "jobs", "deliveredTombstones",
  ]);
  const current = exactKeys(value, [
    "version", "revision", "jobs", "deliveredTombstones", "cancellationTombstones",
  ]);
  const stagedCurrent = exactKeys(value, [
    "version", "revision", "jobs", "deliveredTombstones", "cancellationTombstones",
    "stagedTransactions",
  ]);
  if (!legacy && !deliveryOnly && !current && !stagedCurrent) return null;
  if (value.version !== 1
    || typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !Array.isArray(value.jobs)
    || value.jobs.length > MAX_ACTIVE_ALARM_JOBS) return null;
  const jobs = value.jobs.map((job) => legacy
    ? parseClassroomAlarmJob(job) ?? parseLegacyClassroomAlarmJob(job)
    : parseClassroomAlarmJob(job));
  if (jobs.some((job) => job === null)) return null;
  const ids = new Set((jobs as ClassroomAlarmJobV1[]).map((job) => job.id));
  if (ids.size !== jobs.length) return null;
  const jobIdentityKeys = new Set((jobs as ClassroomAlarmJobV1[]).map(alarmIdentityKey));
  if (jobIdentityKeys.size !== jobs.length) return null;
  const rawTombstones = legacy ? [] : value.deliveredTombstones;
  if (!Array.isArray(rawTombstones)
    || rawTombstones.length > MAX_CLASSROOM_ALARM_DELIVERY_TOMBSTONES) return null;
  const deliveredTombstones = rawTombstones.map((tombstone) => (
    parseClassroomAlarmDeliveryTombstone(tombstone)
      ?? (deliveryOnly ? parseLegacyClassroomAlarmDeliveryTombstone(tombstone) : null)
  ));
  if (deliveredTombstones.some((tombstone) => tombstone === null)) return null;
  if (serializedTombstoneBytes(deliveredTombstones as ClassroomAlarmDeliveryTombstoneV1[])
    > MAX_CLASSROOM_ALARM_TOMBSTONE_BYTES) return null;
  const tombstoneKeys = new Set((deliveredTombstones as ClassroomAlarmDeliveryTombstoneV1[])
    .map(alarmDeadlineIdentityKey));
  if (tombstoneKeys.size !== deliveredTombstones.length) return null;
  const rawCancellations = current || stagedCurrent ? value.cancellationTombstones : [];
  if (!Array.isArray(rawCancellations)
    || rawCancellations.length > MAX_CLASSROOM_ALARM_CANCELLATION_TOMBSTONES) return null;
  const cancellationTombstones = rawCancellations.map((tombstone) => (
    parseClassroomAlarmCancellationTombstone(tombstone)
      ?? parseLegacyClassroomAlarmCancellationTombstone(tombstone)
  ));
  if (cancellationTombstones.some((tombstone) => tombstone === null)) return null;
  if (serializedCancellationTombstoneBytes(
    cancellationTombstones as ClassroomAlarmCancellationTombstoneV1[],
  ) > MAX_CLASSROOM_ALARM_CANCELLATION_BYTES) return null;
  const cancellationKeys = new Set((
    cancellationTombstones as ClassroomAlarmCancellationTombstoneV1[]
  ).map(alarmIdentityKey));
  if (cancellationKeys.size !== cancellationTombstones.length) return null;
  const rawStagedTransactions = stagedCurrent ? value.stagedTransactions : [];
  if (!Array.isArray(rawStagedTransactions)
    || rawStagedTransactions.length > MAX_CLASSROOM_ALARM_STAGED_TRANSACTIONS) return null;
  const stagedTransactions = rawStagedTransactions.map(
    parseClassroomAlarmStagedTransaction,
  );
  if (stagedTransactions.some((transaction) => transaction === null)
    || serializedStagedTransactionBytes(
      stagedTransactions as ClassroomAlarmStagedTransactionV1[],
    ) > MAX_CLASSROOM_ALARM_STAGED_TRANSACTION_BYTES) return null;
  const parsedTransactions = stagedTransactions as ClassroomAlarmStagedTransactionV1[];
  if (new Set(parsedTransactions.map(({ id }) => id)).size !== parsedTransactions.length) {
    return null;
  }
  const transactionStagedJobs = parsedTransactions.flatMap(({ stagedJobs }) => stagedJobs);
  const transactionStagedIds = transactionStagedJobs.map(({ id }) => id);
  const registryStagedJobs = (jobs as ClassroomAlarmJobV1[]).filter(
    ({ deliveryState }) => deliveryState === "staged",
  );
  if (new Set(transactionStagedIds).size !== transactionStagedIds.length
    || transactionStagedJobs.length !== registryStagedJobs.length
    || transactionStagedJobs.some((stagedJob) => !registryStagedJobs.some(
      (registryJob) => exactClassroomAlarmJobMatch(registryJob, stagedJob),
    ))) return null;
  const reservedRollbackCapacity = parsedTransactions.reduce((total, transaction) => (
    total + Math.max(0, transaction.previousJobs.length - transaction.stagedJobs.length)
  ), 0);
  if ((jobs as ClassroomAlarmJobV1[]).length + reservedRollbackCapacity
    > MAX_ACTIVE_ALARM_JOBS) return null;
  const transactionAffectedOwners = new Map<string, string>();
  const transactionReservedIdOwners = new Map<string, string>();
  for (const transaction of parsedTransactions) {
    const affectedKeys = new Set([
      ...transaction.stagedJobs.map(alarmIdentityKey),
      ...transaction.previousJobs.map(alarmIdentityKey),
    ]);
    for (const key of affectedKeys) {
      const owner = transactionAffectedOwners.get(key);
      if (owner && owner !== transaction.id) return null;
      transactionAffectedOwners.set(key, transaction.id);
    }
    const reservedIds = new Set([
      ...transaction.stagedJobs.map(({ id }) => id),
      ...transaction.previousJobs.map(({ id }) => id),
    ]);
    for (const id of reservedIds) {
      const owner = transactionReservedIdOwners.get(id);
      if (owner && owner !== transaction.id) return null;
      transactionReservedIdOwners.set(id, transaction.id);
    }
    for (const previous of transaction.previousJobs) {
      const activeById = (jobs as ClassroomAlarmJobV1[]).find(({ id }) => id === previous.id);
      const activeByIdentity = (jobs as ClassroomAlarmJobV1[]).find((candidate) => (
        jobMatchesAlarmIdentity(candidate, previous)
      ));
      if ((activeById && !transaction.stagedJobs.some(({ id }) => id === activeById.id))
        || (activeByIdentity && !transaction.stagedJobs.some((staged) => (
          jobMatchesAlarmIdentity(staged, activeByIdentity)
        )))) return null;
    }
    if (!exactCancellationTombstoneArraysMatch(
      affectedCancellationTombstones(
        cancellationTombstones as ClassroomAlarmCancellationTombstoneV1[],
        affectedKeys,
      ),
      transaction.stagedCancellationTombstones,
    )) return null;
  }
  return {
    version: 1,
    revision: value.revision,
    jobs: jobs as ClassroomAlarmJobV1[],
    deliveredTombstones: deliveredTombstones as ClassroomAlarmDeliveryTombstoneV1[],
    cancellationTombstones:
      cancellationTombstones as ClassroomAlarmCancellationTombstoneV1[],
    ...(parsedTransactions.length === 0
      ? {}
      : { stagedTransactions: parsedTransactions.map(cloneStagedTransaction) }),
  };
}

export function createEmptyClassroomAlarmRegistry(): ClassroomAlarmRegistryV1 {
  return {
    version: 1,
    revision: 0,
    jobs: [],
    deliveredTombstones: [],
    cancellationTombstones: [],
  };
}

export function createClassroomAlarmJob(input: {
  id: string;
  sourceProjectId: string;
  ownerId: string;
  widgetKind: ClassroomAlarmJobV1["widgetKind"];
  target: ClassroomAlarmTarget;
  label: string;
  deadlineMs: number;
  tone: ClassroomAlarmTone;
  repeat: boolean;
  createdAtMs: number;
}): ClassroomAlarmJobV1 {
  const parsed = parseClassroomAlarmJob({
    version: 1,
    ...input,
    soundWindowStartedAtMs: null,
    lastSoundAtMs: null,
    soundCount: 0,
    deliveryState: "pending",
    deliveryStateAtMs: null,
    blockedAttempts: 0,
  });
  if (!parsed) throw new TypeError("Classroom alarm job is invalid.");
  return parsed;
}

export function readClassroomAlarmRegistry(
  storage: ClassroomAlarmStorage | null = browserStorage(),
): ClassroomAlarmRegistryV1 {
  if (!storage) return createEmptyClassroomAlarmRegistry();
  try {
    const serialized = storage.getItem(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY);
    if (serialized === null) return createEmptyClassroomAlarmRegistry();
    return parseClassroomAlarmRegistry(JSON.parse(serialized) as unknown)
      ?? createEmptyClassroomAlarmRegistry();
  } catch {
    return createEmptyClassroomAlarmRegistry();
  }
}

function notify(registry: ClassroomAlarmRegistryV1): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ClassroomAlarmRegistryV1>(CLASSROOM_ALARM_REGISTRY_EVENT, {
    detail: registry,
  }));
}

type AlarmStorageLockKey = ClassroomAlarmStorage;
const alarmStorageWriteQueues = new WeakMap<AlarmStorageLockKey, Promise<void>>();

async function withClassroomAlarmWriteLock<T>(
  storage: ClassroomAlarmStorage,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (typeof navigator !== "undefined"
    && navigator.locks
    && typeof navigator.locks.request === "function") {
    return navigator.locks.request(
      `${CLASSROOM_ALARM_REGISTRY_STORAGE_KEY}:write`,
      { mode: "exclusive" },
      operation,
    );
  }
  const previous = alarmStorageWriteQueues.get(storage) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  alarmStorageWriteQueues.set(storage, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (alarmStorageWriteQueues.get(storage) === tail) alarmStorageWriteQueues.delete(storage);
  }
}

function browserAlarmStorageLacksTransactionalLock(storage: ClassroomAlarmStorage): boolean {
  if (typeof window === "undefined") return false;
  try {
    return storage === window.localStorage
      && !(typeof navigator !== "undefined"
        && !!navigator.locks
        && typeof navigator.locks.request === "function");
  } catch {
    return false;
  }
}

interface RawAlarmRegistrySnapshot {
  registry: ClassroomAlarmRegistryV1;
  raw: string | null;
  error?: unknown;
}

function readRawAlarmRegistry(storage: ClassroomAlarmStorage): RawAlarmRegistrySnapshot {
  try {
    const raw = storage.getItem(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY);
    if (raw === null) return { registry: createEmptyClassroomAlarmRegistry(), raw };
    const registry = parseClassroomAlarmRegistry(JSON.parse(raw) as unknown);
    return registry
      ? { registry, raw }
      : { registry: createEmptyClassroomAlarmRegistry(), raw };
  } catch (error) {
    return { registry: createEmptyClassroomAlarmRegistry(), raw: null, error };
  }
}

function restoreAlarmStorageValue(storage: ClassroomAlarmStorage, previous: string | null): void {
  if (previous === null) {
    if (!storage.removeItem) throw new TypeError("Alarm storage cannot exactly restore an absent key.");
    storage.removeItem(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY);
  } else {
    storage.setItem(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY, previous);
  }
}

function rollbackAlarmRegistryWrite(
  storage: ClassroomAlarmStorage,
  expected: RawAlarmRegistrySnapshot,
  error: unknown,
): ClassroomAlarmRegistryWriteResult {
  try {
    restoreAlarmStorageValue(storage, expected.raw);
  } catch {
    // Read-back below distinguishes exact rollback from an uncertain write.
  }
  const restored = readRawAlarmRegistry(storage);
  return restored.error === undefined && restored.raw === expected.raw
    ? { registry: restored.registry, status: "rolled-back", error }
    : { registry: restored.registry, status: "indeterminate", error };
}

function writeAlarmRegistryCas(
  storage: ClassroomAlarmStorage,
  expected: RawAlarmRegistrySnapshot,
  requested: ClassroomAlarmRegistryV1,
): ClassroomAlarmRegistryWriteResult {
  if (expected.error !== undefined) {
    return { registry: expected.registry, status: "rolled-back", error: expected.error };
  }
  let actualRaw: string | null;
  try {
    actualRaw = storage.getItem(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY);
  } catch (error) {
    return { registry: expected.registry, status: "rolled-back", error };
  }
  if (actualRaw !== expected.raw) {
    return { registry: readClassroomAlarmRegistry(storage), status: "conflicted" };
  }
  const serialized = JSON.stringify(requested);
  try {
    storage.setItem(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY, serialized);
  } catch (error) {
    return rollbackAlarmRegistryWrite(storage, expected, error);
  }
  const verified = readRawAlarmRegistry(storage);
  if (verified.error !== undefined) {
    return rollbackAlarmRegistryWrite(storage, expected, verified.error);
  }
  return verified.raw === serialized
    ? { registry: requested, status: "persisted" }
    : { registry: verified.registry, status: "conflicted" };
}

async function runAlarmWriteTransaction(
  storage: ClassroomAlarmStorage,
  operation: () => ClassroomAlarmRegistryWriteResult | Promise<ClassroomAlarmRegistryWriteResult>,
): Promise<ClassroomAlarmRegistryWriteResult> {
  try {
    return await withClassroomAlarmWriteLock(storage, operation);
  } catch (error) {
    return { registry: readClassroomAlarmRegistry(storage), status: "rolled-back", error };
  }
}

export async function persistClassroomAlarmRegistry(
  requested: ClassroomAlarmRegistryV1,
  expectedRevision: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  const next = parseClassroomAlarmRegistry(requested);
  if (!next) throw new TypeError("Classroom alarm registry is invalid.");
  if (!storage || browserAlarmStorageLacksTransactionalLock(storage)) {
    return { registry: next, status: "memory-only" };
  }
  const result = await runAlarmWriteTransaction(storage, () => {
    const current = readRawAlarmRegistry(storage);
    if (current.error !== undefined) {
      return { registry: current.registry, status: "rolled-back" as const, error: current.error };
    }
    if (current.registry.revision !== expectedRevision
      || next.revision !== expectedRevision + 1) {
      return { registry: current.registry, status: "conflicted" as const };
    }
    return writeAlarmRegistryCas(storage, current, next);
  });
  notify(result.registry);
  return result;
}

export interface ClassroomAlarmRegistryStateV1 {
  jobs: readonly ClassroomAlarmJobV1[];
  deliveredTombstones: readonly ClassroomAlarmDeliveryTombstoneV1[];
  cancellationTombstones: readonly ClassroomAlarmCancellationTombstoneV1[];
  stagedTransactions?: readonly ClassroomAlarmStagedTransactionV1[];
}

export async function mutateClassroomAlarmRegistryState(
  mutate: (current: ClassroomAlarmRegistryV1) => ClassroomAlarmRegistryStateV1,
  storage: ClassroomAlarmStorage | null = browserStorage(),
  attempts = 3,
): Promise<ClassroomAlarmRegistryWriteResult> {
  const applyMutation = (current: ClassroomAlarmRegistryV1): ClassroomAlarmRegistryV1 => {
    const state = mutate({
      ...current,
      jobs: current.jobs.map(cloneJob),
      deliveredTombstones: current.deliveredTombstones.map(cloneTombstone),
      cancellationTombstones: current.cancellationTombstones.map(
        cloneCancellationTombstone,
      ),
      ...(current.stagedTransactions
        ? { stagedTransactions: current.stagedTransactions.map(cloneStagedTransaction) }
        : {}),
    });
    const stagedTransactions = state.stagedTransactions
      ?? current.stagedTransactions
      ?? [];
    const next = parseClassroomAlarmRegistry({
      version: 1,
      revision: current.revision + 1,
      jobs: [...state.jobs],
      deliveredTombstones: [...state.deliveredTombstones],
      cancellationTombstones: [...state.cancellationTombstones],
      ...(stagedTransactions.length === 0
        ? {}
        : { stagedTransactions: [...stagedTransactions] }),
    });
    if (!next) throw new TypeError("Classroom alarm registry mutation is invalid.");
    return next;
  };
  if (!storage || browserAlarmStorageLacksTransactionalLock(storage)) {
    const next = applyMutation(readClassroomAlarmRegistry(storage));
    return { registry: next, status: "memory-only" };
  }
  const result = await runAlarmWriteTransaction(storage, () => {
    let latest = readRawAlarmRegistry(storage);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (latest.error !== undefined) {
        return { registry: latest.registry, status: "rolled-back" as const, error: latest.error };
      }
      const next = applyMutation(latest.registry);
      const write = writeAlarmRegistryCas(storage, latest, next);
      if (write.status !== "conflicted") return write;
      latest = readRawAlarmRegistry(storage);
    }
    return { registry: latest.registry, status: "conflicted" as const };
  });
  notify(result.registry);
  return result;
}

export async function mutateClassroomAlarmRegistry(
  mutate: (current: ClassroomAlarmRegistryV1) => readonly ClassroomAlarmJobV1[],
  storage: ClassroomAlarmStorage | null = browserStorage(),
  attempts = 3,
): Promise<ClassroomAlarmRegistryWriteResult> {
  return mutateClassroomAlarmRegistryState((current) => ({
    jobs: mutate(current),
    deliveredTombstones: current.deliveredTombstones,
    cancellationTombstones: current.cancellationTombstones,
  }), storage, attempts);
}

export function upsertClassroomAlarmJob(
  currentJobs: readonly ClassroomAlarmJobV1[],
  requested: ClassroomAlarmJobV1,
  nowMs = requested.createdAtMs,
): ClassroomAlarmJobV1[] {
  const job = parseClassroomAlarmJob(requested);
  if (!job) throw new TypeError("Classroom alarm job is invalid.");
  const jobs = pruneClassroomAlarmJobs(currentJobs, nowMs);
  const index = jobs.findIndex((candidate) => candidate.id === job.id);
  if (index < 0) {
    if (jobs.length >= MAX_ACTIVE_ALARM_JOBS) throw new RangeError("The device already has 32 active classroom alarms.");
    jobs.push(job);
  } else {
    jobs[index] = job;
  }
  return jobs.sort((left, right) => left.deadlineMs - right.deadlineMs || left.id.localeCompare(right.id));
}

export function removeClassroomAlarmJob(
  currentJobs: readonly ClassroomAlarmJobV1[],
  jobId: string,
): ClassroomAlarmJobV1[] {
  return currentJobs.filter((job) => job.id !== jobId).map(cloneJob);
}

function isClassroomAlarmIdentity(value: ClassroomAlarmIdentity): boolean {
  return isClassroomTimeId(value.sourceProjectId)
    && isClassroomTimeId(value.ownerId)
    && (value.target === "timer" || value.target === "pomodoro");
}

export function parseClassroomAlarmIdentity(value: unknown): ClassroomAlarmIdentity | null {
  if (!isRecord(value) || !exactKeys(value, [
    "sourceProjectId", "ownerId", "target",
  ])) return null;
  const identity = value as unknown as ClassroomAlarmIdentity;
  return isClassroomAlarmIdentity(identity) ? { ...identity } : null;
}

function isClassroomAlarmDeadlineIdentity(
  value: ClassroomAlarmDeadlineIdentity,
): boolean {
  return isClassroomAlarmIdentity(value) && isTimestamp(value.deadlineMs);
}

function isClassroomAlarmGenerationIdentity(
  value: ClassroomAlarmGenerationIdentity,
): boolean {
  return isClassroomAlarmDeadlineIdentity(value)
    && isTimestamp(value.createdAtMs)
    && value.createdAtMs <= value.deadlineMs
    && value.deadlineMs - value.createdAtMs <= MAX_TIMER_DURATION_MS;
}

function compareClassroomAlarmGenerations(
  left: ClassroomAlarmGenerationIdentity,
  right: ClassroomAlarmGenerationIdentity,
): number {
  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs < right.createdAtMs ? -1 : 1;
  }
  if (left.deadlineMs !== right.deadlineMs) {
    return left.deadlineMs < right.deadlineMs ? -1 : 1;
  }
  return 0;
}

export function pruneClassroomAlarmDeliveryTombstones(
  currentTombstones: readonly ClassroomAlarmDeliveryTombstoneV1[],
  nowMs: number,
): ClassroomAlarmDeliveryTombstoneV1[] {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  const byIdentity = new Map<string, ClassroomAlarmDeliveryTombstoneV1>();
  for (const candidate of currentTombstones) {
    const tombstone = parseClassroomAlarmDeliveryTombstone(candidate);
    if (!tombstone) throw new TypeError("Classroom alarm delivery tombstone is invalid.");
    if (nowMs >= tombstone.deliveredAtMs
      && nowMs - tombstone.deliveredAtMs > CLASSROOM_ALARM_TOMBSTONE_RETENTION_MS) continue;
    const key = alarmDeadlineIdentityKey(tombstone);
    const previous = byIdentity.get(key);
    if (!previous || tombstone.deliveredAtMs > previous.deliveredAtMs) {
      byIdentity.set(key, tombstone);
    }
  }
  const bounded = [...byIdentity.values()].sort((left, right) => (
    left.deliveredAtMs - right.deliveredAtMs
    || left.deadlineMs - right.deadlineMs
    || alarmDeadlineIdentityKey(left).localeCompare(alarmDeadlineIdentityKey(right))
  ));
  while (bounded.length > MAX_CLASSROOM_ALARM_DELIVERY_TOMBSTONES
    || serializedTombstoneBytes(bounded) > MAX_CLASSROOM_ALARM_TOMBSTONE_BYTES) {
    bounded.shift();
  }
  return bounded.map(cloneTombstone);
}

export function hasClassroomAlarmDeliveredTombstone(
  registry: ClassroomAlarmRegistryV1,
  identity: ClassroomAlarmDeadlineIdentity,
  nowMs: number,
): boolean {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  if (!isClassroomAlarmDeadlineIdentity(identity)) return false;
  const key = alarmDeadlineIdentityKey(identity);
  return registry.deliveredTombstones.some((tombstone) => (
    alarmDeadlineIdentityKey(tombstone) === key
    && (nowMs < tombstone.deliveredAtMs
      || nowMs - tombstone.deliveredAtMs <= CLASSROOM_ALARM_TOMBSTONE_RETENTION_MS)
  ));
}

/**
 * Returns true when this identity has already published a visible delivery for
 * the requested generation or a later one. Recovery must never recreate an
 * older/equal generation; a trusted Start must create a strictly later one.
 */
export function hasClassroomAlarmDeliveredGeneration(
  registry: ClassroomAlarmRegistryV1,
  generation: ClassroomAlarmGenerationIdentity,
  nowMs: number,
): boolean {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  if (!isClassroomAlarmGenerationIdentity(generation)) return false;
  const identityKey = alarmIdentityKey(generation);
  return pruneClassroomAlarmDeliveryTombstones(
    registry.deliveredTombstones,
    nowMs,
  ).some((tombstone) => (
    alarmIdentityKey(tombstone) === identityKey
    && (tombstone.deadlineMs === generation.deadlineMs
      || compareClassroomAlarmGenerations(tombstone, generation) >= 0)
  ));
}

function recordClassroomAlarmDeliveredTombstones(
  currentTombstones: readonly ClassroomAlarmDeliveryTombstoneV1[],
  deliveredJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
): ClassroomAlarmDeliveryTombstoneV1[] {
  const additions = deliveredJobs.map((job) => ({
    version: 1 as const,
    sourceProjectId: job.sourceProjectId,
    ownerId: job.ownerId,
    target: job.target,
    createdAtMs: job.createdAtMs,
    deadlineMs: job.deadlineMs,
    deliveredAtMs: nowMs,
  }));
  return pruneClassroomAlarmDeliveryTombstones([...currentTombstones, ...additions], nowMs);
}

export function pruneClassroomAlarmCancellationTombstones(
  currentTombstones: readonly ClassroomAlarmCancellationTombstoneV1[],
  nowMs: number,
): ClassroomAlarmCancellationTombstoneV1[] {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  const byIdentity = new Map<string, ClassroomAlarmCancellationTombstoneV1>();
  for (const candidate of currentTombstones) {
    const tombstone = parseClassroomAlarmCancellationTombstone(candidate);
    if (!tombstone) throw new TypeError("Classroom alarm cancellation tombstone is invalid.");
    if (nowMs >= tombstone.cancelledAtMs
      && nowMs - tombstone.cancelledAtMs > CLASSROOM_ALARM_CANCELLATION_RETENTION_MS) continue;
    const key = alarmIdentityKey(tombstone);
    const previous = byIdentity.get(key);
    if (!previous || tombstone.cancelledAtMs >= previous.cancelledAtMs) {
      byIdentity.set(key, tombstone);
    }
  }
  const bounded = [...byIdentity.values()].sort((left, right) => (
    left.cancelledAtMs - right.cancelledAtMs
    || alarmIdentityKey(left).localeCompare(alarmIdentityKey(right))
  ));
  while (bounded.length > MAX_CLASSROOM_ALARM_CANCELLATION_TOMBSTONES
    || serializedCancellationTombstoneBytes(bounded)
      > MAX_CLASSROOM_ALARM_CANCELLATION_BYTES) {
    bounded.shift();
  }
  return bounded.map(cloneCancellationTombstone);
}

export function hasClassroomAlarmCancellationTombstone(
  registry: ClassroomAlarmRegistryV1,
  identity: ClassroomAlarmIdentity,
  nowMs: number,
): boolean {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  if (!isClassroomAlarmIdentity(identity)) return false;
  const key = alarmIdentityKey(identity);
  return registry.cancellationTombstones.some((tombstone) => (
    alarmIdentityKey(tombstone) === key
    && (nowMs < tombstone.cancelledAtMs
      || nowMs - tombstone.cancelledAtMs <= CLASSROOM_ALARM_CANCELLATION_RETENTION_MS)
  ));
}

function latestClassroomAlarmCancellationTombstone(
  currentTombstones: readonly ClassroomAlarmCancellationTombstoneV1[],
  identity: ClassroomAlarmIdentity,
  nowMs: number,
): ClassroomAlarmCancellationTombstoneV1 | null {
  const identityKey = alarmIdentityKey(identity);
  return pruneClassroomAlarmCancellationTombstones(
    currentTombstones,
    nowMs,
  ).find((tombstone) => alarmIdentityKey(tombstone) === identityKey) ?? null;
}

/**
 * Resolves the logical timestamp for an explicit Start so a same-millisecond
 * click is still a strictly newer generation than every retained authority.
 * Use the returned value for both runtime creation and alarm-job creation.
 */
export function nextClassroomAlarmGenerationStartMs(
  registry: ClassroomAlarmRegistryV1,
  identity: ClassroomAlarmIdentity,
  nowMs: number,
): number {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  const parsedIdentity = parseClassroomAlarmIdentity(identity);
  if (!parsedIdentity) {
    throw new TypeError("Classroom alarm identity is invalid.");
  }
  const identityKey = alarmIdentityKey(parsedIdentity);
  const cancellationCutoff = latestClassroomAlarmCancellationTombstone(
    registry.cancellationTombstones,
    parsedIdentity,
    nowMs,
  )?.cancelledAtMs ?? -1;
  const deliveredCreatedAtMs = pruneClassroomAlarmDeliveryTombstones(
    registry.deliveredTombstones,
    nowMs,
  ).filter((tombstone) => alarmIdentityKey(tombstone) === identityKey)
    .reduce((latest, tombstone) => Math.max(latest, tombstone.createdAtMs), -1);
  const activeCreatedAtMs = pruneClassroomAlarmJobs(registry.jobs, nowMs)
    .filter((job) => alarmIdentityKey(job) === identityKey)
    .reduce((latest, job) => Math.max(latest, job.createdAtMs), -1);
  const authorityCutoff = Math.max(
    cancellationCutoff,
    deliveredCreatedAtMs,
    activeCreatedAtMs,
  );
  const resolved = Math.max(nowMs, authorityCutoff + 1);
  if (!Number.isSafeInteger(resolved)) {
    throw new RangeError("No safe classroom alarm generation timestamp remains.");
  }
  return resolved;
}

/** A cancellation fence suppresses generations created at or before it. */
export function isClassroomAlarmJobCancelled(
  registry: ClassroomAlarmRegistryV1,
  requested: ClassroomAlarmJobV1,
  nowMs: number,
): boolean {
  const job = parseClassroomAlarmJob(requested);
  if (!job) throw new TypeError("Classroom alarm job is invalid.");
  const cancellation = latestClassroomAlarmCancellationTombstone(
    registry.cancellationTombstones,
    job,
    nowMs,
  );
  return cancellation !== null && job.createdAtMs <= cancellation.cancelledAtMs;
}

function jobMatchesAlarmIdentity(
  job: ClassroomAlarmJobV1,
  identity: ClassroomAlarmIdentity,
): boolean {
  return job.sourceProjectId === identity.sourceProjectId
    && job.ownerId === identity.ownerId
    && job.target === identity.target;
}

function cancelledGenerationMatchesJob(
  generation: ClassroomAlarmCancelledGenerationV1 | null,
  job: ClassroomAlarmJobV1,
): boolean {
  return generation !== null
    && generation.jobId === job.id
    && generation.createdAtMs === job.createdAtMs
    && generation.deadlineMs === job.deadlineMs;
}

function cancellationAuthorizesRestoredJob(
  tombstone: ClassroomAlarmCancellationTombstoneV1,
  job: ClassroomAlarmJobV1,
): boolean {
  return tombstone.restoredAtMs !== null
    && cancelledGenerationMatchesJob(tombstone.cancelledGeneration, job);
}

/**
 * Cancellation blocks future/pending delivery while retaining an in-flight or
 * audio-blocked job so the already-published notice can still offer sound
 * replay. Once replay settles, the cancellation removes any pending repeat.
 */
export function applyClassroomAlarmCancellationAuthority(
  currentJobs: readonly ClassroomAlarmJobV1[],
  currentTombstones: readonly ClassroomAlarmCancellationTombstoneV1[],
  nowMs: number,
): ClassroomAlarmJobV1[] {
  const tombstones = pruneClassroomAlarmCancellationTombstones(
    currentTombstones,
    nowMs,
  );
  const byIdentity = new Map(tombstones.map((tombstone) => [
    alarmIdentityKey(tombstone),
    tombstone,
  ]));
  return pruneClassroomAlarmJobs(currentJobs, nowMs).filter((job) => {
    const cancellation = byIdentity.get(alarmIdentityKey(job));
    if (job.deliveryState === "staged") {
      return cancellation === undefined
        || job.createdAtMs > cancellation.cancelledAtMs
        || cancellationAuthorizesRestoredJob(cancellation, job);
    }
    return cancellation === undefined
      || job.createdAtMs > cancellation.cancelledAtMs
      || cancellationAuthorizesRestoredJob(cancellation, job)
      || job.deliveryState === "delivering"
      || job.deliveryState === "blocked";
  });
}

/** Recovery-only reconciliation. It never clears cancellation authority. */
export function recoverClassroomAlarmJob(
  registry: ClassroomAlarmRegistryV1,
  requested: ClassroomAlarmJobV1,
  nowMs: number,
): ClassroomAlarmJobV1[] {
  const job = parseClassroomAlarmJob(requested);
  if (!job) throw new TypeError("Classroom alarm job is invalid.");
  const jobs = applyClassroomAlarmCancellationAuthority(
    registry.jobs,
    registry.cancellationTombstones,
    nowMs,
  );
  if (isClassroomAlarmJobCancelled(registry, job, nowMs)
    || hasClassroomAlarmDeliveredGeneration(registry, job, nowMs)) return jobs;
  const sameIdentity = jobs.filter((candidate) => jobMatchesAlarmIdentity(candidate, job));
  if (sameIdentity.some((candidate) => candidate.deliveryState !== "pending"
    || compareClassroomAlarmGenerations(candidate, job) >= 0)) return jobs;
  return upsertClassroomAlarmJob(
    jobs.filter((candidate) => !jobMatchesAlarmIdentity(candidate, job)),
    job,
    nowMs,
  );
}

export async function cancelClassroomAlarmIdentitiesWithReceipt(
  requestedIdentities: readonly ClassroomAlarmIdentity[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmCancellationWriteResult> {
  const identities = requestedIdentities.map(parseClassroomAlarmIdentity);
  if (!isTimestamp(nowMs)
    || identities.length === 0
    || identities.length > MAX_CLASSROOM_ALARM_CANCELLATION_TOMBSTONES
    || identities.some((identity) => identity === null)) {
    throw new TypeError("Classroom alarm cancellation identity is invalid.");
  }
  const uniqueIdentities = [...new Map((identities as ClassroomAlarmIdentity[])
    .map((identity) => [alarmIdentityKey(identity), identity])).values()];
  const requestedIdentityKeys = new Set(uniqueIdentities.map(alarmIdentityKey));
  const receiptId = createClassroomAlarmOpaqueId("cancel", nowMs);
  let exactCancelledJobs: ClassroomAlarmJobV1[] = [];
  const result = await mutateClassroomAlarmRegistryState((current) => {
    let base = current;
    const overlappingTransactions = (current.stagedTransactions ?? []).filter(
      (transaction) => [...transactionAffectedIdentityKeys(transaction)].some(
        (key) => requestedIdentityKeys.has(key),
      ),
    );
    for (const transaction of overlappingTransactions) {
      const rolledBack = rollbackStagedTransactionState(base, transaction);
      base = {
        ...base,
        jobs: [...rolledBack.jobs],
        deliveredTombstones: [...rolledBack.deliveredTombstones],
        cancellationTombstones: [...rolledBack.cancellationTombstones],
        ...(rolledBack.stagedTransactions?.length
          ? { stagedTransactions: [...rolledBack.stagedTransactions] }
          : { stagedTransactions: undefined }),
      };
    }
    exactCancelledJobs = base.jobs.filter((job) => (
      requestedIdentityKeys.has(alarmIdentityKey(job))
      && job.deliveryState === "pending"
    )).map(cloneJob);
    if (exactCancelledJobs.some((job) => job.createdAtMs > nowMs)) {
      throw new RangeError("Cancellation time precedes an active alarm generation.");
    }
    const additions = uniqueIdentities.map((identity) => {
      const cancelledJob = base.jobs
        .filter((job) => jobMatchesAlarmIdentity(job, identity)
          && job.deliveryState === "pending")
        .sort((left, right) => compareClassroomAlarmGenerations(right, left))[0];
      return {
        version: 1 as const,
        sourceProjectId: identity.sourceProjectId,
        ownerId: identity.ownerId,
        target: identity.target,
        cancelledAtMs: nowMs,
        cancelledGeneration: cancelledJob ? {
          jobId: cancelledJob.id,
          createdAtMs: cancelledJob.createdAtMs,
          deadlineMs: cancelledJob.deadlineMs,
        } : null,
        restoredAtMs: null,
        receiptId,
        receiptJob: cancelledJob ? cloneJob(cancelledJob) : null,
      };
    });
    const cancellationTombstones = pruneClassroomAlarmCancellationTombstones([
      ...base.cancellationTombstones,
      ...additions,
    ], nowMs);
    if (!exactCancellationReceiptAuthority(cancellationTombstones, {
      version: 1,
      receiptId,
      cancelledAtMs: nowMs,
      identities: uniqueIdentities,
      cancelledJobs: exactCancelledJobs,
    })) {
      throw new RangeError("The complete classroom alarm cancellation receipt cannot be retained.");
    }
    return {
      jobs: applyClassroomAlarmCancellationAuthority(
        base.jobs,
        cancellationTombstones,
        nowMs,
      ),
      deliveredTombstones: pruneClassroomAlarmDeliveryTombstones(
        base.deliveredTombstones,
        nowMs,
      ),
      cancellationTombstones,
      stagedTransactions: base.stagedTransactions ?? [],
    };
  }, storage);
  return {
    ...result,
    receipt: result.status === "persisted" ? cloneCancellationReceipt({
      version: 1,
      receiptId,
      cancelledAtMs: nowMs,
      identities: uniqueIdentities,
      cancelledJobs: exactCancelledJobs,
    }) : null,
  };
}

export async function cancelClassroomAlarmIdentities(
  requestedIdentities: readonly ClassroomAlarmIdentity[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  const { receipt: _receipt, ...result } = await cancelClassroomAlarmIdentitiesWithReceipt(
    requestedIdentities,
    nowMs,
    storage,
  );
  return result;
}

export async function cancelClassroomAlarmIdentityWithReceipt(
  identity: ClassroomAlarmIdentity,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmCancellationWriteResult> {
  return cancelClassroomAlarmIdentitiesWithReceipt([identity], nowMs, storage);
}

export async function cancelClassroomAlarmIdentity(
  identity: ClassroomAlarmIdentity,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  return cancelClassroomAlarmIdentities([identity], nowMs, storage);
}

/**
 * Trusted wrapper-Undo path. It restores only the exact pending generation
 * captured by the latest cancellation transaction. Automatic recovery never
 * consumes this authority, and the cancellation fence remains in place.
 */
export async function restoreCancelledClassroomAlarmJobs(
  requestedJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  const jobsToRestore = requestedJobs.map(parseClassroomAlarmJob);
  if (jobsToRestore.length === 0
    || jobsToRestore.length > MAX_ACTIVE_ALARM_JOBS
    || jobsToRestore.some((job) => job === null || job.deliveryState !== "pending")
    || !isTimestamp(nowMs)
    || jobsToRestore.some((job) => job !== null && job.createdAtMs > nowMs)) {
    throw new TypeError("Cancelled classroom alarm job is invalid.");
  }
  const requested = jobsToRestore as ClassroomAlarmJobV1[];
  const identityKeys = requested.map(alarmIdentityKey);
  if (new Set(identityKeys).size !== identityKeys.length
    || new Set(requested.map(({ id }) => id)).size !== requested.length) {
    throw new TypeError("Cancelled classroom alarm jobs contain duplicate identities.");
  }
  return mutateClassroomAlarmRegistryState((current) => {
    let cancellationTombstones = pruneClassroomAlarmCancellationTombstones(
      current.cancellationTombstones,
      nowMs,
    );
    const deliveredTombstones = pruneClassroomAlarmDeliveryTombstones(
      current.deliveredTombstones,
      nowMs,
    );
    let jobs = applyClassroomAlarmCancellationAuthority(
      current.jobs,
      cancellationTombstones,
      nowMs,
    );
    const authorityRegistry: ClassroomAlarmRegistryV1 = {
      version: 1,
      revision: current.revision,
      jobs,
      deliveredTombstones,
      cancellationTombstones,
    };
    for (const job of requested) {
      const cancellation = cancellationTombstones.find((tombstone) => (
        alarmIdentityKey(tombstone) === alarmIdentityKey(job)
      ));
      if (!cancellation
        || cancellation.restoredAtMs !== null
        || !cancelledGenerationMatchesJob(cancellation.cancelledGeneration, job)) {
        throw new RangeError("No matching cancelled alarm generation can be restored.");
      }
      if (jobs.some((candidate) => jobMatchesAlarmIdentity(candidate, job))) {
        throw new RangeError("A classroom alarm for this identity is already active.");
      }
      if (hasClassroomAlarmDeliveredGeneration(authorityRegistry, job, nowMs)) {
        throw new RangeError("A delivered or newer alarm generation cannot be restored.");
      }
    }
    const restoreIdentityKeys = new Set(identityKeys);
    cancellationTombstones = cancellationTombstones.map((tombstone) => (
      restoreIdentityKeys.has(alarmIdentityKey(tombstone))
        ? { ...tombstone, restoredAtMs: Math.max(nowMs, tombstone.cancelledAtMs) }
        : tombstone
    ));
    for (const job of requested) jobs = upsertClassroomAlarmJob(jobs, job, nowMs);
    return {
      jobs,
      deliveredTombstones,
      cancellationTombstones,
    };
  }, storage);
}

export async function restoreCancelledClassroomAlarmJob(
  requested: ClassroomAlarmJobV1,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  return restoreCancelledClassroomAlarmJobs([requested], nowMs, storage);
}

/**
 * Explicit trusted Start batch. Every requested generation is validated before
 * any replacement is constructed, so a conflict or capacity failure writes
 * none of the batch. Cancellation fences intentionally remain persisted.
 */
export async function startClassroomAlarmJobs(
  requestedJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
  options: ClassroomAlarmStartOptions = {},
): Promise<ClassroomAlarmRegistryWriteResult> {
  const { preservePendingDelivery } = normalizeClassroomAlarmStartOptions(options);
  const parsedJobs = requestedJobs.map(parseClassroomAlarmJob);
  if (parsedJobs.length === 0
    || parsedJobs.length > MAX_ACTIVE_ALARM_JOBS
    || !isTimestamp(nowMs)
    || parsedJobs.some((job) => job === null
      || job.deliveryState !== "pending"
      || job.createdAtMs > nowMs)) {
    throw new TypeError("Classroom alarm job is invalid.");
  }
  const requested = parsedJobs as ClassroomAlarmJobV1[];
  const requestedIdentityKeys = requested.map(alarmIdentityKey);
  if (new Set(requestedIdentityKeys).size !== requestedIdentityKeys.length
    || new Set(requested.map(({ id }) => id)).size !== requested.length) {
    throw new TypeError("Classroom alarm batch contains duplicate identities or IDs.");
  }
  return mutateClassroomAlarmRegistryState((current) => {
    if (requested.some((job) => current.jobs.some((candidate) => (
      jobMatchesAlarmIdentity(candidate, job) && candidate.deliveryState === "staged"
    )))) {
      throw new RangeError("A classroom alarm transaction is still staged for this identity.");
    }
    if (preservePendingDelivery && requested.some((job) => (
      current.jobs.some((candidate) => (
        jobMatchesAlarmIdentity(candidate, job)
        && (candidate.deliveryState === "staged"
          || candidate.deliveryState === "blocked"
          || candidate.deliveryState === "delivering")
      ))
    ))) {
      throw new RangeError("A classroom alarm delivery is still pending for this identity.");
    }
    let cancellationTombstones = pruneClassroomAlarmCancellationTombstones(
      current.cancellationTombstones,
      nowMs,
    );
    const deliveredTombstones = pruneClassroomAlarmDeliveryTombstones(
      current.deliveredTombstones,
      nowMs,
    );
    const jobs = applyClassroomAlarmCancellationAuthority(
      current.jobs,
      cancellationTombstones,
      nowMs,
    );
    const authorityRegistry: ClassroomAlarmRegistryV1 = {
      version: 1,
      revision: current.revision,
      jobs,
      deliveredTombstones,
      cancellationTombstones,
    };
    for (const job of requested) {
      if (jobs.some((candidate) => candidate.id === job.id
        && !jobMatchesAlarmIdentity(candidate, job))) {
        throw new RangeError("A classroom alarm ID belongs to another identity.");
      }
      const sameIdentity = jobs.filter((candidate) => (
        jobMatchesAlarmIdentity(candidate, job)
      ));
      const cancellation = latestClassroomAlarmCancellationTombstone(
        cancellationTombstones,
        job,
        nowMs,
      );
      const replacesOnlyAuthorizedRestoredJobs = cancellation !== null
        && sameIdentity.length > 0
        && sameIdentity.every((candidate) => (
          cancellationAuthorizesRestoredJob(cancellation, candidate)
          && compareClassroomAlarmGenerations(candidate, job) < 0
        ));
      if (isClassroomAlarmJobCancelled(authorityRegistry, job, nowMs)
        && !replacesOnlyAuthorizedRestoredJobs) {
        throw new RangeError("A trusted Start must create a generation after its cancellation fence.");
      }
      if (hasClassroomAlarmDeliveredGeneration(authorityRegistry, job, nowMs)) {
        throw new RangeError("A trusted Start must create a generation after its delivered fence.");
      }
      if (sameIdentity.some((candidate) => (
        compareClassroomAlarmGenerations(candidate, job) >= 0
      ))) {
        throw new RangeError("A trusted Start must create a later alarm generation.");
      }
    }
    const identityKeySet = new Set(requestedIdentityKeys);
    let nextJobs = jobs.filter((candidate) => (
      !identityKeySet.has(alarmIdentityKey(candidate))
    ));
    if (nextJobs.length + requested.length > MAX_ACTIVE_ALARM_JOBS) {
      throw new RangeError("The device already has 32 active classroom alarms.");
    }
    cancellationTombstones = cancellationTombstones.map((tombstone) => (
      identityKeySet.has(alarmIdentityKey(tombstone))
        ? { ...tombstone, restoredAtMs: null, receiptId: null, receiptJob: null }
        : tombstone
    ));
    for (const job of requested) {
      nextJobs = upsertClassroomAlarmJob(nextJobs, job, nowMs);
    }
    return {
      jobs: nextJobs,
      deliveredTombstones,
      cancellationTombstones,
    };
  }, storage);
}

export async function startClassroomAlarmJob(
  requested: ClassroomAlarmJobV1,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  return startClassroomAlarmJobs([requested], nowMs, storage);
}

/** Scheduler-only reservation that never supersedes blocked/in-flight delivery. */
export async function startSchedulerClassroomAlarmJobs(
  requestedJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  return startClassroomAlarmJobs(requestedJobs, nowMs, storage, {
    preservePendingDelivery: true,
  });
}

function exactClassroomAlarmJobMatch(
  current: ClassroomAlarmJobV1,
  requested: ClassroomAlarmJobV1,
): boolean {
  return current.version === requested.version
    && current.id === requested.id
    && current.sourceProjectId === requested.sourceProjectId
    && current.ownerId === requested.ownerId
    && current.widgetKind === requested.widgetKind
    && current.target === requested.target
    && current.label === requested.label
    && current.deadlineMs === requested.deadlineMs
    && current.tone === requested.tone
    && current.repeat === requested.repeat
    && current.createdAtMs === requested.createdAtMs
    && current.soundWindowStartedAtMs === requested.soundWindowStartedAtMs
    && current.lastSoundAtMs === requested.lastSoundAtMs
    && current.soundCount === requested.soundCount
    && current.deliveryState === requested.deliveryState
    && current.deliveryStateAtMs === requested.deliveryStateAtMs
    && current.blockedAttempts === requested.blockedAttempts;
}

function exactPristinePendingAlarmJobMatch(
  current: ClassroomAlarmJobV1,
  requested: ClassroomAlarmJobV1,
): boolean {
  return current.deliveryState === "pending"
    && requested.deliveryState === "pending"
    && exactClassroomAlarmJobMatch(current, requested);
}

function exactCancellationReceiptAuthority(
  currentTombstones: readonly ClassroomAlarmCancellationTombstoneV1[],
  receipt: ClassroomAlarmCancellationReceiptV1,
): boolean {
  const receiptIdentityKeys = new Set(receipt.identities.map(alarmIdentityKey));
  const receiptJobsByIdentity = new Map(receipt.cancelledJobs.map((job) => [
    alarmIdentityKey(job),
    job,
  ]));
  const authority = currentTombstones.filter(
    (tombstone) => tombstone.receiptId === receipt.receiptId,
  );
  if (authority.length !== receipt.identities.length
    || new Set(authority.map(alarmIdentityKey)).size !== receiptIdentityKeys.size
    || authority.some((tombstone) => (
      !receiptIdentityKeys.has(alarmIdentityKey(tombstone))
      || tombstone.cancelledAtMs !== receipt.cancelledAtMs
      || !Object.hasOwn(tombstone, "receiptJob")
    ))) return false;
  let matchedJobs = 0;
  for (const tombstone of authority) {
    const requestedJob = receiptJobsByIdentity.get(alarmIdentityKey(tombstone));
    if (tombstone.receiptJob === null) {
      if (requestedJob !== undefined) return false;
      continue;
    }
    if (tombstone.receiptJob === undefined
      || requestedJob === undefined
      || !exactPristinePendingAlarmJobMatch(tombstone.receiptJob, requestedJob)) {
      return false;
    }
    matchedJobs += 1;
  }
  return matchedJobs === receipt.cancelledJobs.length;
}

function exactStagedAlarmJobMatchesPending(
  staged: ClassroomAlarmJobV1,
  pending: ClassroomAlarmJobV1,
): boolean {
  return staged.deliveryState === "staged"
    && staged.deliveryStateAtMs !== null
    && pending.deliveryState === "pending"
    && exactClassroomAlarmJobMatch({
      ...staged,
      deliveryState: "pending",
      deliveryStateAtMs: null,
    }, pending);
}

function validateUniqueClassroomAlarmJobBatch(
  requestedJobs: readonly ClassroomAlarmJobV1[],
  requiredState: "staged" | "pending",
  nowMs: number,
  message: string,
): ClassroomAlarmJobV1[] {
  const parsedJobs = requestedJobs.map(parseClassroomAlarmJob);
  if (parsedJobs.length === 0
    || parsedJobs.length > MAX_ACTIVE_ALARM_JOBS
    || !isTimestamp(nowMs)
    || parsedJobs.some((job) => job === null
      || job.deliveryState !== requiredState
      || job.createdAtMs > nowMs
      || (requiredState === "staged"
        && (job.deliveryStateAtMs === null || job.deliveryStateAtMs > nowMs)))) {
    throw new TypeError(message);
  }
  const requested = parsedJobs as ClassroomAlarmJobV1[];
  const identityKeys = requested.map(alarmIdentityKey);
  if (new Set(identityKeys).size !== identityKeys.length
    || new Set(requested.map(({ id }) => id)).size !== requested.length) {
    throw new TypeError(`${message} The batch contains duplicate identities or IDs.`);
  }
  return requested;
}

let classroomAlarmTransactionSequence = 0;

function createClassroomAlarmOpaqueId(prefix: "cancel" | "stage", nowMs: number): string {
  classroomAlarmTransactionSequence = (classroomAlarmTransactionSequence + 1) % 0x1_000_000;
  const randomPart = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replaceAll("-", "")
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${nowMs.toString(36)}-${classroomAlarmTransactionSequence.toString(36)}-${randomPart}`
    .slice(0, 128);
}

function transactionReceipt(
  transaction: ClassroomAlarmStagedTransactionV1,
): ClassroomAlarmTransactionReceiptV1 {
  return cloneTransactionReceipt({
    version: 1,
    transactionId: transaction.id,
    mode: transaction.mode,
    stagedAtMs: transaction.stagedAtMs,
    stagedJobs: transaction.stagedJobs,
  });
}

function transactionMatchesReceipt(
  transaction: ClassroomAlarmStagedTransactionV1,
  receipt: ClassroomAlarmTransactionReceiptV1,
): boolean {
  return transaction.id === receipt.transactionId
    && transaction.mode === receipt.mode
    && transaction.stagedAtMs === receipt.stagedAtMs
    && transaction.stagedJobs.length === receipt.stagedJobs.length
    && transaction.stagedJobs.every((job, index) => (
      exactClassroomAlarmJobMatch(job, receipt.stagedJobs[index])
    ));
}

function transactionAffectedIdentityKeys(
  transaction: ClassroomAlarmStagedTransactionV1,
): Set<string> {
  return new Set([
    ...transaction.stagedJobs.map(alarmIdentityKey),
    ...transaction.previousJobs.map(alarmIdentityKey),
  ]);
}

function exactCancellationTombstoneArraysMatch(
  left: readonly ClassroomAlarmCancellationTombstoneV1[],
  right: readonly ClassroomAlarmCancellationTombstoneV1[],
): boolean {
  const normalize = (items: readonly ClassroomAlarmCancellationTombstoneV1[]) => (
    [...items].sort((a, b) => alarmIdentityKey(a).localeCompare(alarmIdentityKey(b)))
  );
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function affectedCancellationTombstones(
  tombstones: readonly ClassroomAlarmCancellationTombstoneV1[],
  affectedIdentityKeys: ReadonlySet<string>,
): ClassroomAlarmCancellationTombstoneV1[] {
  return tombstones.filter((tombstone) => (
    affectedIdentityKeys.has(alarmIdentityKey(tombstone))
  )).map(cloneCancellationTombstone);
}

function exactStagedTransactionIsCurrent(
  registry: ClassroomAlarmRegistryV1,
  transaction: ClassroomAlarmStagedTransactionV1,
): boolean {
  const affectedKeys = transactionAffectedIdentityKeys(transaction);
  return transaction.stagedJobs.every((staged) => registry.jobs.some((candidate) => (
    exactClassroomAlarmJobMatch(candidate, staged)
  ))) && exactCancellationTombstoneArraysMatch(
    affectedCancellationTombstones(registry.cancellationTombstones, affectedKeys),
    transaction.stagedCancellationTombstones,
  );
}

type ClassroomAlarmTransactionActivationFailure = "transaction" | "authority";

/**
 * Shared activation fence for persisted staged transactions. Keep this pure so
 * publication-time safety views can ask the same question as durable
 * activation without making a staged alarm deliverable.
 */
function classroomAlarmTransactionActivationFailure(
  registry: ClassroomAlarmRegistryV1,
  transaction: ClassroomAlarmStagedTransactionV1,
  nowMs: number,
): ClassroomAlarmTransactionActivationFailure | null {
  if (!exactStagedTransactionIsCurrent(registry, transaction)
    || (nowMs >= transaction.stagedAtMs
      && nowMs - transaction.stagedAtMs > CLASSROOM_ALARM_STAGED_TRANSACTION_RETENTION_MS)) {
    return "transaction";
  }
  const authorityRegistry: ClassroomAlarmRegistryV1 = {
    ...registry,
    deliveredTombstones: pruneClassroomAlarmDeliveryTombstones(
      registry.deliveredTombstones,
      nowMs,
    ),
  };
  for (const staged of transaction.stagedJobs) {
    const cancellation = latestClassroomAlarmCancellationTombstone(
      registry.cancellationTombstones,
      staged,
      nowMs,
    );
    if (hasClassroomAlarmDeliveredGeneration(authorityRegistry, staged, nowMs)
      || (transaction.mode === "recovery" && cancellation !== null)
      || (transaction.mode === "cancelled-restore"
        && (!cancellation || !cancellationAuthorizesRestoredJob(cancellation, staged)))
      || (nowMs > staged.deadlineMs
        && nowMs - staged.deadlineMs > CLASSROOM_ALARM_CATCHUP_WINDOW_MS)) {
      return "authority";
    }
  }
  return null;
}

function rollbackStagedTransactionState(
  registry: ClassroomAlarmRegistryV1,
  transaction: ClassroomAlarmStagedTransactionV1,
  replacementCancellationReceiptId: string | null = null,
): ClassroomAlarmRegistryStateV1 {
  if (!exactStagedTransactionIsCurrent(registry, transaction)) {
    throw new RangeError("A staged classroom alarm transaction is no longer exact.");
  }
  const affectedKeys = transactionAffectedIdentityKeys(transaction);
  const stagedIds = new Set(transaction.stagedJobs.map(({ id }) => id));
  const stagedIdentityKeys = new Set(transaction.stagedJobs.map(alarmIdentityKey));
  const jobs = registry.jobs.filter(({ id }) => !stagedIds.has(id));
  if (jobs.some((candidate) => transaction.previousJobs.some((previous) => (
    candidate.id === previous.id || jobMatchesAlarmIdentity(candidate, previous)
  ))) || jobs.length + transaction.previousJobs.length > MAX_ACTIVE_ALARM_JOBS) {
    throw new RangeError("The staged classroom alarm preimage can no longer be restored.");
  }
  return {
    jobs: [...jobs, ...transaction.previousJobs.map(cloneJob)].sort((left, right) => (
      left.deadlineMs - right.deadlineMs || left.id.localeCompare(right.id)
    )),
    deliveredTombstones: registry.deliveredTombstones,
    cancellationTombstones: [
      ...registry.cancellationTombstones.filter((tombstone) => (
        !affectedKeys.has(alarmIdentityKey(tombstone))
      )),
      ...transaction.previousCancellationTombstones.map((tombstone) => {
        const previous = cloneCancellationTombstone(tombstone);
        return transaction.mode === "cancelled-restore"
          && stagedIdentityKeys.has(alarmIdentityKey(previous))
          ? {
            ...previous,
            receiptId: replacementCancellationReceiptId,
            ...(replacementCancellationReceiptId === null ? { receiptJob: null } : {}),
          }
          : previous;
      }),
    ],
    stagedTransactions: (registry.stagedTransactions ?? []).filter(
      ({ id }) => id !== transaction.id,
    ),
  };
}

export function rollbackExpiredClassroomAlarmTransactions(
  registry: ClassroomAlarmRegistryV1,
  nowMs: number,
): ClassroomAlarmRegistryStateV1 {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  let current = parseClassroomAlarmRegistry(registry);
  if (!current) throw new TypeError("Classroom alarm registry is invalid.");
  const expired = (current.stagedTransactions ?? []).filter((transaction) => (
    nowMs >= transaction.stagedAtMs
    && nowMs - transaction.stagedAtMs > CLASSROOM_ALARM_STAGED_TRANSACTION_RETENTION_MS
  ));
  for (const transaction of expired) {
    const rolledBack = rollbackStagedTransactionState(current, transaction);
    current = {
      ...current,
      jobs: [...rolledBack.jobs],
      deliveredTombstones: [...rolledBack.deliveredTombstones],
      cancellationTombstones: [...rolledBack.cancellationTombstones],
      ...(rolledBack.stagedTransactions?.length
        ? { stagedTransactions: [...rolledBack.stagedTransactions] }
        : { stagedTransactions: undefined }),
    };
  }
  return {
    jobs: current.jobs.map(cloneJob),
    deliveredTombstones: current.deliveredTombstones.map(cloneTombstone),
    cancellationTombstones: current.cancellationTombstones.map(
      cloneCancellationTombstone,
    ),
    stagedTransactions: (current.stagedTransactions ?? []).map(cloneStagedTransaction),
  };
}

function cancellationForPendingJob(
  job: ClassroomAlarmJobV1,
  nowMs: number,
): ClassroomAlarmCancellationTombstoneV1 {
  return {
    version: 1,
    sourceProjectId: job.sourceProjectId,
    ownerId: job.ownerId,
    target: job.target,
    cancelledAtMs: Math.max(nowMs, job.createdAtMs),
    cancelledGeneration: {
      jobId: job.id,
      createdAtMs: job.createdAtMs,
      deadlineMs: job.deadlineMs,
    },
    restoredAtMs: null,
    receiptId: null,
  };
}

/**
 * Durable non-deliverable reservation used before publishing corresponding
 * project state. Its persisted transaction record contains the exact affected
 * preimage so a crash can deterministically activate or roll back on startup.
 */
export async function stageClassroomAlarmTransaction(
  mode: ClassroomAlarmStageMode,
  requestedJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
  cancellationReceipt?: ClassroomAlarmCancellationReceiptV1,
): Promise<ClassroomAlarmTransactionWriteResult> {
  if (!isClassroomAlarmStageMode(mode)) {
    throw new TypeError("Classroom alarm transaction mode is invalid.");
  }
  const requested = validateUniqueClassroomAlarmJobBatch(
    requestedJobs,
    "pending",
    nowMs,
    "Classroom alarm transaction jobs are invalid.",
  );
  const parsedCancellationReceipt = cancellationReceipt === undefined
    ? null
    : parseClassroomAlarmCancellationReceipt(cancellationReceipt);
  if ((mode === "cancelled-restore") !== (parsedCancellationReceipt !== null)
    || (mode === "cancelled-restore" && parsedCancellationReceipt !== null
      && (parsedCancellationReceipt.cancelledJobs.length !== requested.length
        || parsedCancellationReceipt.cancelledJobs.some((job, index) => (
          !exactPristinePendingAlarmJobMatch(job, requested[index])
        ))))) {
    throw new TypeError("Cancelled restore requires its exact cancellation receipt.");
  }
  const transactionId = createClassroomAlarmOpaqueId("stage", nowMs);
  let stagedTransaction: ClassroomAlarmStagedTransactionV1 | null = null;
  const result = await mutateClassroomAlarmRegistryState((current) => {
    const expiredResolved = rollbackExpiredClassroomAlarmTransactions(current, nowMs);
    const base: ClassroomAlarmRegistryV1 = {
      ...current,
      jobs: [...expiredResolved.jobs],
      deliveredTombstones: [...expiredResolved.deliveredTombstones],
      cancellationTombstones: [...expiredResolved.cancellationTombstones],
      ...(expiredResolved.stagedTransactions?.length
        ? { stagedTransactions: [...expiredResolved.stagedTransactions] }
        : { stagedTransactions: undefined }),
    };
    const existingTransactions = base.stagedTransactions ?? [];
    if (existingTransactions.length >= MAX_CLASSROOM_ALARM_STAGED_TRANSACTIONS
      || existingTransactions.some(({ id }) => id === transactionId)) {
      throw new RangeError("Too many classroom alarm transactions are staged.");
    }
    let cancellationTombstones = pruneClassroomAlarmCancellationTombstones(
      base.cancellationTombstones,
      nowMs,
    );
    if (mode === "cancelled-restore"
      && parsedCancellationReceipt !== null
      && !exactCancellationReceiptAuthority(
        cancellationTombstones,
        parsedCancellationReceipt,
      )) {
      throw new RangeError("Cancellation receipt authority is not an exact complete batch.");
    }
    const deliveredTombstones = pruneClassroomAlarmDeliveryTombstones(
      base.deliveredTombstones,
      nowMs,
    );
    let jobs = applyClassroomAlarmCancellationAuthority(
      base.jobs,
      cancellationTombstones,
      nowMs,
    );
    const requestedIdentityKeys = new Set(requested.map(alarmIdentityKey));
    const existingAffectedKeys = new Set(existingTransactions.flatMap((transaction) => [
      ...transaction.stagedJobs.map(alarmIdentityKey),
      ...transaction.previousJobs.map(alarmIdentityKey),
    ]));
    const existingReservedIds = new Set(existingTransactions.flatMap((transaction) => [
      ...transaction.stagedJobs.map(({ id }) => id),
      ...transaction.previousJobs.map(({ id }) => id),
    ]));
    if ([...requestedIdentityKeys].some((key) => existingAffectedKeys.has(key))
      || requested.some(({ id }) => existingReservedIds.has(id))) {
      throw new RangeError("A classroom alarm transaction already owns this identity.");
    }
    const previousJobs: ClassroomAlarmJobV1[] = [];
    for (const requestedJob of requested) {
      const sameIdentity = jobs.filter((candidate) => (
        jobMatchesAlarmIdentity(candidate, requestedJob)
      ));
      const idCollision = jobs.find((candidate) => (
        candidate.id === requestedJob.id
        && !jobMatchesAlarmIdentity(candidate, requestedJob)
      ));
      if (idCollision) {
        if (idCollision.deliveryState !== "pending") {
          throw new RangeError("An in-flight classroom alarm owns this ID.");
        }
        if (existingAffectedKeys.has(alarmIdentityKey(idCollision))
          || existingReservedIds.has(idCollision.id)) {
          throw new RangeError("A staged classroom alarm transaction owns this ID.");
        }
        previousJobs.push(cloneJob(idCollision));
      }
      const cancellation = latestClassroomAlarmCancellationTombstone(
        cancellationTombstones,
        requestedJob,
        nowMs,
      );
      const authorityRegistry: ClassroomAlarmRegistryV1 = {
        version: 1,
        revision: base.revision,
        jobs,
        deliveredTombstones,
        cancellationTombstones,
        ...(existingTransactions.length ? { stagedTransactions: existingTransactions } : {}),
      };
      if (hasClassroomAlarmDeliveredGeneration(authorityRegistry, requestedJob, nowMs)) {
        throw new RangeError("A delivered or newer classroom alarm cannot be staged.");
      }
      if (mode === "cancelled-restore") {
        if (!cancellation
          || cancellation.restoredAtMs !== null
          || cancellation.receiptId !== parsedCancellationReceipt?.receiptId
          || cancellation.cancelledAtMs !== parsedCancellationReceipt?.cancelledAtMs
          || !cancelledGenerationMatchesJob(
            cancellation.cancelledGeneration,
            requestedJob,
          )
          || sameIdentity.length > 0
          || idCollision) {
          throw new RangeError("No exact cancelled alarm generation can be staged.");
        }
      } else if (mode === "recovery") {
        if (cancellation
          || sameIdentity.some((candidate) => candidate.deliveryState !== "pending"
            || compareClassroomAlarmGenerations(candidate, requestedJob) >= 0)) {
          throw new RangeError("Classroom alarm recovery authority changed before staging.");
        }
      } else {
        if (sameIdentity.some((candidate) => candidate.deliveryState === "delivering")) {
          throw new RangeError("A classroom alarm delivery is already in flight.");
        }
        if (mode === "scheduler-start" && sameIdentity.some((candidate) => (
          candidate.deliveryState !== "pending"
        ))) {
          throw new RangeError("A classroom alarm delivery is still pending for this identity.");
        }
        const replacesOnlyAuthorizedRestoredJobs = cancellation !== null
          && sameIdentity.length > 0
          && sameIdentity.every((candidate) => (
            cancellationAuthorizesRestoredJob(cancellation, candidate)
            && compareClassroomAlarmGenerations(candidate, requestedJob) < 0
          ));
        if (cancellation && requestedJob.createdAtMs <= cancellation.cancelledAtMs
          && !replacesOnlyAuthorizedRestoredJobs) {
          throw new RangeError("A trusted Start must follow its cancellation fence.");
        }
        if (sameIdentity.some((candidate) => (
          compareClassroomAlarmGenerations(candidate, requestedJob) >= 0
        ))) {
          throw new RangeError("A trusted Start must create a later alarm generation.");
        }
      }
      previousJobs.push(...sameIdentity.map(cloneJob));
    }
    const uniquePreviousJobs = [...new Map(previousJobs.map((job) => [job.id, job])).values()];
    const affectedIdentityKeys = new Set([
      ...requestedIdentityKeys,
      ...uniquePreviousJobs.map(alarmIdentityKey),
    ]);
    if ([...affectedIdentityKeys].some((key) => existingAffectedKeys.has(key))) {
      throw new RangeError("A classroom alarm transaction overlaps another staged transaction.");
    }
    const previousCancellationTombstones = affectedCancellationTombstones(
      cancellationTombstones,
      affectedIdentityKeys,
    );
    const displacedDifferentIdentityJobs = uniquePreviousJobs.filter((previous) => (
      !requested.some((job) => jobMatchesAlarmIdentity(previous, job))
    ));
    if (displacedDifferentIdentityJobs.length) {
      const beforeKeys = new Set(cancellationTombstones.map(alarmIdentityKey));
      cancellationTombstones = pruneClassroomAlarmCancellationTombstones([
        ...cancellationTombstones,
        ...displacedDifferentIdentityJobs.map((job) => cancellationForPendingJob(job, nowMs)),
      ], nowMs);
      if ([...beforeKeys].some((key) => !cancellationTombstones.some(
        (tombstone) => alarmIdentityKey(tombstone) === key,
      ))) {
        throw new RangeError("Staging would evict unrelated cancellation authority.");
      }
    }
    if (mode === "cancelled-restore") {
      cancellationTombstones = cancellationTombstones.map((tombstone) => (
        requestedIdentityKeys.has(alarmIdentityKey(tombstone))
          ? { ...tombstone, restoredAtMs: Math.max(nowMs, tombstone.cancelledAtMs) }
          : tombstone
      ));
    } else if (mode === "trusted-start" || mode === "scheduler-start") {
      cancellationTombstones = cancellationTombstones.map((tombstone) => (
        requestedIdentityKeys.has(alarmIdentityKey(tombstone))
          ? { ...tombstone, restoredAtMs: null, receiptId: null, receiptJob: null }
          : tombstone
      ));
    }
    const previousIds = new Set(uniquePreviousJobs.map(({ id }) => id));
    const previousIdentityKeys = new Set(uniquePreviousJobs.map(alarmIdentityKey));
    jobs = jobs.filter((candidate) => (
      !previousIds.has(candidate.id)
      && !previousIdentityKeys.has(alarmIdentityKey(candidate))
    ));
    if (jobs.length + requested.length > MAX_ACTIVE_ALARM_JOBS) {
      throw new RangeError("The device already has 32 active classroom alarms.");
    }
    const stagedJobs = requested.map((job) => ({
      ...job,
      deliveryState: "staged" as const,
      deliveryStateAtMs: nowMs,
    }));
    for (const stagedJob of stagedJobs) jobs = upsertClassroomAlarmJob(jobs, stagedJob, nowMs);
    const transaction: ClassroomAlarmStagedTransactionV1 = {
      version: 1,
      id: transactionId,
      mode,
      stagedAtMs: nowMs,
      stagedJobs,
      previousJobs: uniquePreviousJobs,
      previousCancellationTombstones,
      stagedCancellationTombstones: affectedCancellationTombstones(
        cancellationTombstones,
        affectedIdentityKeys,
      ),
    };
    stagedTransaction = cloneStagedTransaction(transaction);
    return {
      jobs,
      deliveredTombstones,
      cancellationTombstones,
      stagedTransactions: [...existingTransactions, transaction],
    };
  }, storage);
  return {
    ...result,
    receipt: result.status === "persisted" && stagedTransaction
      ? transactionReceipt(stagedTransaction)
      : null,
  };
}

export async function stageTrustedClassroomAlarmJobs(
  requestedJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmTransactionWriteResult> {
  return stageClassroomAlarmTransaction("trusted-start", requestedJobs, nowMs, storage);
}

export async function stageSchedulerClassroomAlarmJobs(
  requestedJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmTransactionWriteResult> {
  return stageClassroomAlarmTransaction("scheduler-start", requestedJobs, nowMs, storage);
}

export async function stageRecoveredClassroomAlarmJobs(
  requestedJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmTransactionWriteResult> {
  return stageClassroomAlarmTransaction("recovery", requestedJobs, nowMs, storage);
}

export async function stageCancelledClassroomAlarmReceipt(
  cancellationReceipt: ClassroomAlarmCancellationReceiptV1,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmTransactionWriteResult> {
  const parsed = parseClassroomAlarmCancellationReceipt(cancellationReceipt);
  if (!parsed || parsed.cancelledJobs.length === 0) {
    throw new TypeError("Cancellation receipt has no restorable classroom alarms.");
  }
  return stageClassroomAlarmTransaction(
    "cancelled-restore",
    parsed.cancelledJobs,
    nowMs,
    storage,
    parsed,
  );
}

/** Exact startup matcher; unmatched receipts must be rolled back or paused. */
export function matchStagedClassroomAlarmTransaction(
  registry: ClassroomAlarmRegistryV1,
  requestedPendingJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
): ClassroomAlarmTransactionReceiptV1 | null {
  const current = parseClassroomAlarmRegistry(registry);
  if (!current) throw new TypeError("Classroom alarm registry is invalid.");
  const requested = validateUniqueClassroomAlarmJobBatch(
    requestedPendingJobs,
    "pending",
    nowMs,
    "Staged classroom alarm startup match is invalid.",
  );
  const transaction = (current.stagedTransactions ?? []).find((candidate) => (
    candidate.stagedJobs.length === requested.length
    && candidate.stagedJobs.every((staged) => (
      requested.some((pending) => exactStagedAlarmJobMatchesPending(staged, pending))
    ))
    && exactStagedTransactionIsCurrent(current, candidate)
  ));
  if (!transaction
    || (nowMs >= transaction.stagedAtMs
      && nowMs - transaction.stagedAtMs > CLASSROOM_ALARM_STAGED_TRANSACTION_RETENTION_MS)) {
    return null;
  }
  return transactionReceipt(transaction);
}

export function listStagedClassroomAlarmTransactions(
  registry: ClassroomAlarmRegistryV1,
): ClassroomAlarmTransactionReceiptV1[] {
  const current = parseClassroomAlarmRegistry(registry);
  if (!current) throw new TypeError("Classroom alarm registry is invalid.");
  return (current.stagedTransactions ?? []).map(transactionReceipt);
}

/**
 * Returns a transient safety-check view in which exact, activatable staged
 * jobs owned by this caller are treated as pending during synchronous UI
 * publication. The persisted transaction records intentionally remain staged:
 * this projection must never be persisted, reparsed, or used for delivery.
 * Untracked, stale, expired, and authority-invalid stages remain non-authority.
 */
export function projectTrackedStagedClassroomAlarmTransactionsAsPending(
  registry: ClassroomAlarmRegistryV1,
  trackedTransactionIds: ReadonlySet<string>,
  nowMs: number,
): ClassroomAlarmRegistryV1 {
  if (!isTimestamp(nowMs)) {
    throw new RangeError("A non-negative integer timestamp is required.");
  }
  const current = parseClassroomAlarmRegistry(registry);
  if (!current) return registry;
  const projectedJobIds = new Set<string>();
  for (const transaction of current.stagedTransactions ?? []) {
    if (trackedTransactionIds.has(transaction.id)
      && classroomAlarmTransactionActivationFailure(current, transaction, nowMs) === null) {
      for (const staged of transaction.stagedJobs) projectedJobIds.add(staged.id);
    }
  }
  if (projectedJobIds.size === 0) return registry;
  return {
    ...registry,
    jobs: registry.jobs.map((alarmJob) => projectedJobIds.has(alarmJob.id) ? {
      ...alarmJob,
      deliveryState: "pending" as const,
      deliveryStateAtMs: null,
    } : alarmJob),
  };
}

export async function activateClassroomAlarmTransaction(
  requestedReceipt: ClassroomAlarmTransactionReceiptV1,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  const receipt = parseClassroomAlarmTransactionReceipt(requestedReceipt);
  if (!receipt || !isTimestamp(nowMs)) {
    throw new TypeError("Classroom alarm transaction receipt is invalid.");
  }
  return mutateClassroomAlarmRegistryState((current) => {
    const transaction = (current.stagedTransactions ?? []).find(
      ({ id }) => id === receipt.transactionId,
    );
    if (!transaction || !transactionMatchesReceipt(transaction, receipt)) {
      throw new RangeError("A staged classroom alarm transaction can no longer be activated.");
    }
    const activationFailure = classroomAlarmTransactionActivationFailure(
      current,
      transaction,
      nowMs,
    );
    if (activationFailure === "transaction") {
      throw new RangeError("A staged classroom alarm transaction can no longer be activated.");
    }
    if (activationFailure === "authority") {
      throw new RangeError("Classroom alarm authority changed before activation.");
    }
    const stagedIds = new Set(transaction.stagedJobs.map(({ id }) => id));
    return {
      jobs: current.jobs.map((job) => stagedIds.has(job.id) ? {
        ...job,
        deliveryState: "pending" as const,
        deliveryStateAtMs: null,
      } : job),
      deliveredTombstones: current.deliveredTombstones,
      cancellationTombstones: current.cancellationTombstones,
      stagedTransactions: (current.stagedTransactions ?? []).filter(
        ({ id }) => id !== transaction.id,
      ),
    };
  }, storage);
}

export async function rollbackClassroomAlarmTransaction(
  requestedReceipt: ClassroomAlarmTransactionReceiptV1,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmTransactionRollbackResult> {
  const receipt = parseClassroomAlarmTransactionReceipt(requestedReceipt);
  if (!receipt || !isTimestamp(nowMs)) {
    throw new TypeError("Classroom alarm transaction receipt is invalid.");
  }
  const rotatedReceiptId = createClassroomAlarmOpaqueId("cancel", nowMs);
  let refreshedCancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null = null;
  const result = await mutateClassroomAlarmRegistryState((current) => {
    const transaction = (current.stagedTransactions ?? []).find(
      ({ id }) => id === receipt.transactionId,
    );
    if (!transaction || !transactionMatchesReceipt(transaction, receipt)) {
      throw new RangeError("A staged classroom alarm transaction can no longer be rolled back.");
    }
    if (transaction.mode === "cancelled-restore") {
      const previousCancellations = transaction.previousCancellationTombstones.filter(
        (tombstone) => transaction.stagedJobs.some((job) => (
          jobMatchesAlarmIdentity(job, tombstone)
          && cancelledGenerationMatchesJob(tombstone.cancelledGeneration, job)
        )),
      );
      if (previousCancellations.length !== transaction.stagedJobs.length
        || new Set(previousCancellations.map(({ cancelledAtMs }) => cancelledAtMs)).size !== 1) {
        throw new RangeError("Cancelled restore preimage cannot issue a refreshed receipt.");
      }
      refreshedCancellationReceipt = {
        version: 1,
        receiptId: rotatedReceiptId,
        cancelledAtMs: previousCancellations[0].cancelledAtMs,
        identities: transaction.stagedJobs.map((job) => ({
          sourceProjectId: job.sourceProjectId,
          ownerId: job.ownerId,
          target: job.target,
        })),
        cancelledJobs: transaction.stagedJobs.map((job) => ({
          ...job,
          deliveryState: "pending" as const,
          deliveryStateAtMs: null,
        })),
      };
    }
    return rollbackStagedTransactionState(
      current,
      transaction,
      transaction.mode === "cancelled-restore" ? rotatedReceiptId : null,
    );
  }, storage);
  return {
    ...result,
    cancellationReceipt: result.status === "persisted" && refreshedCancellationReceipt
      ? cloneCancellationReceipt(refreshedCancellationReceipt)
      : null,
  };
}

/**
 * Scheduler-compensation boundary. It releases a complete trusted-start batch
 * only while every reserved job is still the exact pristine pending snapshot.
 * It never creates cancellation authority or changes tombstones/other jobs.
 */
export async function releaseClassroomAlarmJobs(
  requestedJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  const parsedJobs = requestedJobs.map(parseClassroomAlarmJob);
  if (parsedJobs.length === 0
    || parsedJobs.length > MAX_ACTIVE_ALARM_JOBS
    || !isTimestamp(nowMs)
    || parsedJobs.some((job) => job === null
      || job.deliveryState !== "pending"
      || job.createdAtMs > nowMs)) {
    throw new TypeError("Classroom alarm release job is invalid.");
  }
  const requested = parsedJobs as ClassroomAlarmJobV1[];
  const identityKeys = requested.map(alarmIdentityKey);
  if (new Set(identityKeys).size !== identityKeys.length
    || new Set(requested.map(({ id }) => id)).size !== requested.length) {
    throw new TypeError("Classroom alarm release contains duplicate identities or IDs.");
  }
  return mutateClassroomAlarmRegistryState((current) => {
    for (const job of requested) {
      const candidate = current.jobs.find(({ id }) => id === job.id);
      if (!candidate || !exactPristinePendingAlarmJobMatch(candidate, job)) {
        throw new RangeError("A reserved classroom alarm is no longer exact and pending.");
      }
    }
    const releasedIds = new Set(requested.map(({ id }) => id));
    return {
      jobs: current.jobs.filter(({ id }) => !releasedIds.has(id)),
      deliveredTombstones: current.deliveredTombstones,
      cancellationTombstones: current.cancellationTombstones,
    };
  }, storage);
}

export async function releaseClassroomAlarmJob(
  requested: ClassroomAlarmJobV1,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  return releaseClassroomAlarmJobs([requested], nowMs, storage);
}

/**
 * Stale wrapper-Undo compensation. It revokes only exact restored pending jobs
 * and clears their one matching restore authorizations in the same registry
 * transaction, while retaining each cancellation cutoff/generation fence.
 */
export async function revokeRestoredClassroomAlarmJobs(
  requestedJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  const parsedJobs = requestedJobs.map(parseClassroomAlarmJob);
  if (parsedJobs.length === 0
    || parsedJobs.length > MAX_ACTIVE_ALARM_JOBS
    || !isTimestamp(nowMs)
    || parsedJobs.some((job) => job === null
      || job.deliveryState !== "pending"
      || job.createdAtMs > nowMs)) {
    throw new TypeError("Restored classroom alarm revocation is invalid.");
  }
  const requested = parsedJobs as ClassroomAlarmJobV1[];
  const identityKeys = requested.map(alarmIdentityKey);
  if (new Set(identityKeys).size !== identityKeys.length
    || new Set(requested.map(({ id }) => id)).size !== requested.length) {
    throw new TypeError("Restored classroom alarm revocation contains duplicates.");
  }
  return mutateClassroomAlarmRegistryState((current) => {
    for (const job of requested) {
      const candidate = current.jobs.find(({ id }) => id === job.id);
      const cancellation = current.cancellationTombstones.find((tombstone) => (
        alarmIdentityKey(tombstone) === alarmIdentityKey(job)
      ));
      if (!candidate
        || !exactPristinePendingAlarmJobMatch(candidate, job)
        || !cancellation
        || cancellation.restoredAtMs === null
        || cancellation.restoredAtMs > nowMs
        || !cancellationAuthorizesRestoredJob(cancellation, job)) {
        throw new RangeError("A restored classroom alarm is no longer an exact authorized match.");
      }
    }
    const revokedIds = new Set(requested.map(({ id }) => id));
    const revokedIdentityKeys = new Set(identityKeys);
    return {
      jobs: current.jobs.filter(({ id }) => !revokedIds.has(id)),
      deliveredTombstones: current.deliveredTombstones,
      cancellationTombstones: current.cancellationTombstones.map((tombstone) => (
        revokedIdentityKeys.has(alarmIdentityKey(tombstone))
          ? { ...tombstone, restoredAtMs: null, receiptId: null, receiptJob: null }
          : tombstone
      )),
    };
  }, storage);
}

export async function revokeRestoredClassroomAlarmJob(
  requested: ClassroomAlarmJobV1,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  return revokeRestoredClassroomAlarmJobs([requested], nowMs, storage);
}

/**
 * Durable notice-Dismiss boundary. It removes a complete batch only while
 * every snapshot still matches the exact blocked registry job, preventing a
 * later global Enable sound action from replaying the dismissed delivery.
 */
export async function acknowledgeBlockedClassroomAlarmJobs(
  requestedJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  const parsedJobs = requestedJobs.map(parseClassroomAlarmJob);
  if (parsedJobs.length === 0
    || parsedJobs.length > MAX_ACTIVE_ALARM_JOBS
    || !isTimestamp(nowMs)
    || parsedJobs.some((job) => job === null
      || job.deliveryState !== "blocked"
      || job.deliveryStateAtMs === null
      || job.deliveryStateAtMs > nowMs)) {
    throw new TypeError("Blocked classroom alarm acknowledgement is invalid.");
  }
  const requested = parsedJobs as ClassroomAlarmJobV1[];
  const identityKeys = requested.map(alarmIdentityKey);
  if (new Set(identityKeys).size !== identityKeys.length
    || new Set(requested.map(({ id }) => id)).size !== requested.length) {
    throw new TypeError("Blocked classroom alarm acknowledgement contains duplicates.");
  }
  return mutateClassroomAlarmRegistryState((current) => {
    for (const job of requested) {
      const candidate = current.jobs.find(({ id }) => id === job.id);
      if (!candidate
        || candidate.deliveryState !== "blocked"
        || !exactClassroomAlarmJobMatch(candidate, job)) {
        throw new RangeError("A blocked classroom alarm is no longer an exact match.");
      }
    }
    const acknowledgedIds = new Set(requested.map(({ id }) => id));
    return {
      jobs: current.jobs.filter(({ id }) => !acknowledgedIds.has(id)),
      deliveredTombstones: current.deliveredTombstones,
      cancellationTombstones: current.cancellationTombstones,
    };
  }, storage);
}

export async function acknowledgeBlockedClassroomAlarmJob(
  requested: ClassroomAlarmJobV1,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): Promise<ClassroomAlarmRegistryWriteResult> {
  return acknowledgeBlockedClassroomAlarmJobs([requested], nowMs, storage);
}

export function pruneClassroomAlarmJobs(
  currentJobs: readonly ClassroomAlarmJobV1[],
  nowMs: number,
): ClassroomAlarmJobV1[] {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  return currentJobs.map((job) => {
    if (job.deliveryState !== "delivering"
      || job.deliveryStateAtMs === null
      || nowMs < job.deliveryStateAtMs
      || nowMs - job.deliveryStateAtMs < CLASSROOM_ALARM_DELIVERY_LEASE_MS) {
      return cloneJob(job);
    }
    return {
      ...job,
      deliveryState: "blocked" as const,
      deliveryStateAtMs: nowMs,
      blockedAttempts: Math.min(
        MAX_BLOCKED_ALARM_REPLAY_ATTEMPTS,
        job.blockedAttempts + 1,
      ),
    };
  }).filter((job) => {
    if (job.deliveryState === "staged") {
      // Persisted staged transactions own expiry/rollback. A standalone prune
      // must never discard their durable preimage.
      return true;
    }
    if (job.deadlineMs + CLASSROOM_ALARM_CATCHUP_WINDOW_MS < nowMs) return false;
    if (job.deliveryState === "blocked") {
      return job.blockedAttempts < MAX_BLOCKED_ALARM_REPLAY_ATTEMPTS;
    }
    if (!job.repeat && job.soundCount > 0) return false;
    if (job.repeat && job.soundWindowStartedAtMs !== null
      && job.soundWindowStartedAtMs + MAX_ALARM_REPEAT_WINDOW_MS <= nowMs) return false;
    return true;
  });
}

export function dueClassroomAlarmJobs(
  registry: ClassroomAlarmRegistryV1,
  nowMs: number,
): ClassroomAlarmJobV1[] {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  return registry.jobs.filter((job) => {
    if (nowMs < job.deadlineMs || nowMs > job.deadlineMs + CLASSROOM_ALARM_CATCHUP_WINDOW_MS) return false;
    if (job.deliveryState !== "pending") return false;
    if (job.lastSoundAtMs === null) return true;
    if (!job.repeat || job.soundWindowStartedAtMs === null) return false;
    return nowMs - job.lastSoundAtMs >= ALARM_REPEAT_INTERVAL_MS
      && nowMs - job.soundWindowStartedAtMs < MAX_ALARM_REPEAT_WINDOW_MS;
  }).map(cloneJob);
}

export function markClassroomAlarmJobsSounded(
  currentJobs: readonly ClassroomAlarmJobV1[],
  jobIds: ReadonlySet<string>,
  nowMs: number,
): ClassroomAlarmJobV1[] {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  return currentJobs.map((job) => jobIds.has(job.id) ? {
    ...job,
    soundWindowStartedAtMs: job.soundWindowStartedAtMs ?? nowMs,
    lastSoundAtMs: nowMs,
    soundCount: Math.min(7, job.soundCount + 1),
    deliveryState: "pending" as const,
    deliveryStateAtMs: null,
    blockedAttempts: 0,
  } : cloneJob(job));
}

export function markClassroomAlarmJobsDelivering(
  currentJobs: readonly ClassroomAlarmJobV1[],
  jobIds: ReadonlySet<string>,
  nowMs: number,
): ClassroomAlarmJobV1[] {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  return currentJobs.map((job) => jobIds.has(job.id) ? {
    ...job,
    deliveryState: "delivering" as const,
    deliveryStateAtMs: nowMs,
  } : cloneJob(job));
}

export function blockedClassroomAlarmJobs(
  registry: ClassroomAlarmRegistryV1,
  nowMs: number,
): ClassroomAlarmJobV1[] {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  return registry.jobs.filter((job) => job.deliveryState === "blocked"
    && job.blockedAttempts < MAX_BLOCKED_ALARM_REPLAY_ATTEMPTS
    && nowMs <= job.deadlineMs + CLASSROOM_ALARM_CATCHUP_WINDOW_MS)
    .map(cloneJob);
}

export function markClassroomAlarmJobsBlocked(
  currentJobs: readonly ClassroomAlarmJobV1[],
  jobIds: ReadonlySet<string>,
  nowMs: number,
): ClassroomAlarmJobV1[] {
  if (!isTimestamp(nowMs)) throw new RangeError("A non-negative integer timestamp is required.");
  return currentJobs.map((job) => jobIds.has(job.id) ? {
    ...job,
    deliveryState: "blocked" as const,
    deliveryStateAtMs: nowMs,
    blockedAttempts: Math.min(MAX_BLOCKED_ALARM_REPLAY_ATTEMPTS, job.blockedAttempts + 1),
  } : cloneJob(job));
}

function claimStorageKey(jobId: string): string {
  return `${CLASSROOM_ALARM_CLAIM_STORAGE_KEY_PREFIX}${encodeURIComponent(jobId)}`;
}

export function parseClassroomAlarmClaim(value: unknown): ClassroomAlarmClaimV1 | null {
  if (!isRecord(value) || !exactKeys(value, ["version", "jobId", "claimantId", "claimedAtMs", "expiresAtMs"])) return null;
  if (value.version !== 1
    || !isClassroomTimeId(value.jobId)
    || !isClassroomTimeId(value.claimantId)
    || !isTimestamp(value.claimedAtMs)
    || !isTimestamp(value.expiresAtMs)
    || value.expiresAtMs <= value.claimedAtMs
    || value.expiresAtMs - value.claimedAtMs > CLASSROOM_ALARM_CLAIM_LEASE_MS) return null;
  return value as unknown as ClassroomAlarmClaimV1;
}

export function tryClaimClassroomAlarm(
  jobId: string,
  claimantId: string,
  nowMs: number,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): boolean {
  if (!isClassroomTimeId(jobId) || !isClassroomTimeId(claimantId) || !isTimestamp(nowMs) || !storage) return false;
  const key = claimStorageKey(jobId);
  try {
    const currentText = storage.getItem(key);
    const current = currentText === null ? null : parseClassroomAlarmClaim(JSON.parse(currentText) as unknown);
    if (current && current.expiresAtMs > nowMs && current.claimantId !== claimantId) return false;
    const claim: ClassroomAlarmClaimV1 = {
      version: 1,
      jobId,
      claimantId,
      claimedAtMs: nowMs,
      expiresAtMs: nowMs + CLASSROOM_ALARM_CLAIM_LEASE_MS,
    };
    storage.setItem(key, JSON.stringify(claim));
    const verifiedText = storage.getItem(key);
    const verified = verifiedText === null ? null : parseClassroomAlarmClaim(JSON.parse(verifiedText) as unknown);
    return !!verified && verified.claimantId === claimantId && verified.claimedAtMs === nowMs;
  } catch {
    return false;
  }
}

export function releaseClassroomAlarmClaim(
  jobId: string,
  claimantId: string,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): void {
  if (!storage || !storage.removeItem) return;
  const key = claimStorageKey(jobId);
  try {
    const serialized = storage.getItem(key);
    const claim = serialized === null ? null : parseClassroomAlarmClaim(JSON.parse(serialized) as unknown);
    if (claim?.claimantId === claimantId) storage.removeItem(key);
  } catch {
    // A short lease guarantees eventual recovery.
  }
}

interface AlarmLockManager {
  request<T>(
    name: string,
    options: { ifAvailable: true; mode: "exclusive" },
    callback: (lock: unknown | null) => Promise<T> | T,
  ): Promise<T>;
}

function browserLockManager(): AlarmLockManager | null {
  try {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    return locks as unknown as AlarmLockManager | undefined ?? null;
  } catch {
    return null;
  }
}

export async function withClassroomAlarmClaim(
  jobId: string,
  claimantId: string,
  nowMs: number,
  callback: () => void | Promise<void>,
  options: {
    storage?: ClassroomAlarmStorage | null;
    locks?: AlarmLockManager | null;
  } = {},
): Promise<boolean> {
  const locks = options.locks === undefined ? browserLockManager() : options.locks;
  if (locks) {
    let acquired = false;
    await locks.request(`patterdraw:classroom-alarm:${jobId}`, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
      if (!lock) return;
      acquired = true;
      await callback();
    });
    return acquired;
  }
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  if (!tryClaimClassroomAlarm(jobId, claimantId, nowMs, storage)) return false;
  try {
    await callback();
    return true;
  } finally {
    releaseClassroomAlarmClaim(jobId, claimantId, storage);
  }
}

export interface ClaimDueClassroomAlarmJobsResult {
  claimed: boolean;
  jobs: ClassroomAlarmJobV1[];
  deliveryResult?: ClassroomAlarmDeliveryResult;
  persistenceStatus?: ClassroomAlarmPersistenceStatus;
  error?: unknown;
}

function alarmJobsEqual(
  left: readonly ClassroomAlarmJobV1[],
  right: readonly ClassroomAlarmJobV1[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function alarmTombstonesEqual(
  left: readonly ClassroomAlarmDeliveryTombstoneV1[],
  right: readonly ClassroomAlarmDeliveryTombstoneV1[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function alarmCancellationTombstonesEqual(
  left: readonly ClassroomAlarmCancellationTombstoneV1[],
  right: readonly ClassroomAlarmCancellationTombstoneV1[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function alarmStagedTransactionsEqual(
  left: readonly ClassroomAlarmStagedTransactionV1[] | undefined,
  right: readonly ClassroomAlarmStagedTransactionV1[] | undefined,
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

async function reconcileClassroomAlarmRegistry(
  nowMs: number,
  storage: ClassroomAlarmStorage | null,
): Promise<ClassroomAlarmRegistryWriteResult | null> {
  const current = readClassroomAlarmRegistry(storage);
  const expiredResolved = rollbackExpiredClassroomAlarmTransactions(current, nowMs);
  const base: ClassroomAlarmRegistryV1 = {
    ...current,
    jobs: [...expiredResolved.jobs],
    deliveredTombstones: [...expiredResolved.deliveredTombstones],
    cancellationTombstones: [...expiredResolved.cancellationTombstones],
    ...(expiredResolved.stagedTransactions?.length
      ? { stagedTransactions: [...expiredResolved.stagedTransactions] }
      : { stagedTransactions: undefined }),
  };
  const reconciledCancellations = pruneClassroomAlarmCancellationTombstones(
    base.cancellationTombstones,
    nowMs,
  );
  const reconciledJobs = applyClassroomAlarmCancellationAuthority(
    base.jobs,
    reconciledCancellations,
    nowMs,
  );
  const reconciledTombstones = pruneClassroomAlarmDeliveryTombstones(
    base.deliveredTombstones,
    nowMs,
  );
  if (alarmJobsEqual(current.jobs, reconciledJobs)
    && alarmTombstonesEqual(current.deliveredTombstones, reconciledTombstones)
    && alarmCancellationTombstonesEqual(
      current.cancellationTombstones,
      reconciledCancellations,
    )
    && alarmStagedTransactionsEqual(
      current.stagedTransactions,
      base.stagedTransactions,
    )) return null;
  return mutateClassroomAlarmRegistryState(
    (latest) => {
      const resolved = rollbackExpiredClassroomAlarmTransactions(latest, nowMs);
      const cancellationTombstones = pruneClassroomAlarmCancellationTombstones(
        resolved.cancellationTombstones,
        nowMs,
      );
      return {
        jobs: applyClassroomAlarmCancellationAuthority(
          resolved.jobs,
          cancellationTombstones,
          nowMs,
        ),
        deliveredTombstones: pruneClassroomAlarmDeliveryTombstones(
          resolved.deliveredTombstones,
          nowMs,
        ),
        cancellationTombstones,
        stagedTransactions: resolved.stagedTransactions ?? [],
      };
    },
    storage,
  );
}

function deliveryWriteSucceeded(
  result: ClassroomAlarmRegistryWriteResult,
): boolean {
  return result.status === "persisted";
}

/**
 * One idempotent scheduler boundary. It durably stages every simultaneously
 * due job as delivering before invoking the callback. The callback must publish
 * the single visible completion alert synchronously before awaiting playback.
 * A long or interrupted callback therefore cannot let another tab publish the
 * same alert: stale deliveries become sound-only blocked replays.
 */
export async function claimAndMarkDueClassroomAlarmJobs(
  claimantId: string,
  nowMs: number,
  onClaimed: (
    jobs: readonly ClassroomAlarmJobV1[],
  ) => ClassroomAlarmDeliveryResult | Promise<ClassroomAlarmDeliveryResult>,
  options: {
    storage?: ClassroomAlarmStorage | null;
    locks?: AlarmLockManager | null;
  } = {},
): Promise<ClaimDueClassroomAlarmJobsResult> {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  let jobs: ClassroomAlarmJobV1[] = [];
  let deliveryResult: ClassroomAlarmDeliveryResult | undefined;
  let persistenceStatus: ClassroomAlarmPersistenceStatus | undefined;
  let callbackError: unknown;
  const claimed = await withClassroomAlarmClaim(
    "due-batch",
    claimantId,
    nowMs,
    async () => {
      const reconciliation = await reconcileClassroomAlarmRegistry(nowMs, storage);
      if (reconciliation) {
        persistenceStatus = reconciliation.status;
        if (!deliveryWriteSucceeded(reconciliation)) return;
      }
      const initial = reconciliation?.registry ?? readClassroomAlarmRegistry(storage);
      jobs = dueClassroomAlarmJobs(initial, nowMs);
      if (!jobs.length) return;
      const candidateIds = new Set(jobs.map((job) => job.id));
      let stagedIds = new Set<string>();
      const staged = await mutateClassroomAlarmRegistryState((current) => {
        const cancellationTombstones = pruneClassroomAlarmCancellationTombstones(
          current.cancellationTombstones,
          nowMs,
        );
        const reconciledJobs = applyClassroomAlarmCancellationAuthority(
          current.jobs,
          cancellationTombstones,
          nowMs,
        );
        const deliverableJobs = dueClassroomAlarmJobs(
          { ...current, jobs: reconciledJobs },
          nowMs,
        ).filter((job) => candidateIds.has(job.id));
        const deliverableIds = new Set(deliverableJobs.map((job) => job.id));
        stagedIds = deliverableIds;
        return {
          jobs: markClassroomAlarmJobsDelivering(reconciledJobs, deliverableIds, nowMs),
          deliveredTombstones: recordClassroomAlarmDeliveredTombstones(
            current.deliveredTombstones,
            deliverableJobs,
            nowMs,
          ),
          cancellationTombstones,
        };
      }, storage);
      persistenceStatus = staged.status;
      if (!deliveryWriteSucceeded(staged)) {
        jobs = [];
        return;
      }
      jobs = staged.registry.jobs.filter((job) => stagedIds.has(job.id)
        && job.deliveryState === "delivering"
        && job.deliveryStateAtMs === nowMs).map(cloneJob);
      if (!jobs.length) return;
      try {
        deliveryResult = await onClaimed(jobs) === "acknowledged"
          ? "acknowledged"
          : "audio-blocked";
      } catch (error) {
        callbackError = error;
        deliveryResult = "audio-blocked";
      }
      const jobIds = new Set(jobs.map((job) => job.id));
      const result = await mutateClassroomAlarmRegistryState((current) => {
        const deliverableIds = new Set(current.jobs
          .filter((job) => jobIds.has(job.id)
            && job.deliveryState === "delivering"
            && job.deliveryStateAtMs === nowMs)
          .map((job) => job.id));
        if (!deliverableIds.size) return {
          jobs: current.jobs,
          deliveredTombstones: current.deliveredTombstones,
          cancellationTombstones: current.cancellationTombstones,
        };
        const updated = deliveryResult === "acknowledged"
          ? markClassroomAlarmJobsSounded(current.jobs, deliverableIds, nowMs)
          : markClassroomAlarmJobsBlocked(current.jobs, deliverableIds, nowMs);
        const cancellationTombstones = pruneClassroomAlarmCancellationTombstones(
          current.cancellationTombstones,
          nowMs,
        );
        return {
          jobs: applyClassroomAlarmCancellationAuthority(
            updated,
            cancellationTombstones,
            nowMs,
          ),
          deliveredTombstones: current.deliveredTombstones,
          cancellationTombstones,
        };
      }, storage);
      persistenceStatus = result.status;
    },
    { storage, locks: options.locks },
  );
  return {
    claimed,
    jobs,
    ...(deliveryResult === undefined ? {} : { deliveryResult }),
    ...(persistenceStatus === undefined ? {} : { persistenceStatus }),
    ...(callbackError === undefined ? {} : { error: callbackError }),
  };
}

/**
 * Trusted Enable sound replay path. Call only after
 * `prepareClassroomAlarmAudio()` reports ready. This callback attempts audio
 * only; the original visible completion alert must remain the sole alert.
 */
export async function replayBlockedClassroomAlarmJobs(
  claimantId: string,
  nowMs: number,
  onReplay: (
    jobs: readonly ClassroomAlarmJobV1[],
  ) => ClassroomAlarmDeliveryResult | Promise<ClassroomAlarmDeliveryResult>,
  options: {
    storage?: ClassroomAlarmStorage | null;
    locks?: AlarmLockManager | null;
  } = {},
): Promise<ClaimDueClassroomAlarmJobsResult> {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  let jobs: ClassroomAlarmJobV1[] = [];
  let deliveryResult: ClassroomAlarmDeliveryResult | undefined;
  let persistenceStatus: ClassroomAlarmPersistenceStatus | undefined;
  let callbackError: unknown;
  const claimed = await withClassroomAlarmClaim(
    "due-batch",
    claimantId,
    nowMs,
    async () => {
      const reconciliation = await reconcileClassroomAlarmRegistry(nowMs, storage);
      if (reconciliation) {
        persistenceStatus = reconciliation.status;
        if (!deliveryWriteSucceeded(reconciliation)) return;
      }
      const initial = reconciliation?.registry ?? readClassroomAlarmRegistry(storage);
      jobs = blockedClassroomAlarmJobs(initial, nowMs);
      if (!jobs.length) return;
      const candidateIds = new Set(jobs.map((job) => job.id));
      let stagedIds = new Set<string>();
      const staged = await mutateClassroomAlarmRegistryState((current) => {
        const cancellationTombstones = pruneClassroomAlarmCancellationTombstones(
          current.cancellationTombstones,
          nowMs,
        );
        const reconciledJobs = applyClassroomAlarmCancellationAuthority(
          current.jobs,
          cancellationTombstones,
          nowMs,
        );
        const replayableIds = new Set(blockedClassroomAlarmJobs(
          { ...current, jobs: reconciledJobs },
          nowMs,
        ).filter((job) => candidateIds.has(job.id)).map((job) => job.id));
        stagedIds = replayableIds;
        return {
          jobs: markClassroomAlarmJobsDelivering(
            reconciledJobs,
            replayableIds,
            nowMs,
          ),
          deliveredTombstones: pruneClassroomAlarmDeliveryTombstones(
            current.deliveredTombstones,
            nowMs,
          ),
          cancellationTombstones,
        };
      }, storage);
      persistenceStatus = staged.status;
      if (!deliveryWriteSucceeded(staged)) {
        jobs = [];
        return;
      }
      jobs = staged.registry.jobs.filter((job) => stagedIds.has(job.id)
        && job.deliveryState === "delivering"
        && job.deliveryStateAtMs === nowMs).map(cloneJob);
      if (!jobs.length) return;
      try {
        deliveryResult = await onReplay(jobs) === "acknowledged"
          ? "acknowledged"
          : "audio-blocked";
      } catch (error) {
        callbackError = error;
        deliveryResult = "audio-blocked";
      }
      const jobIds = new Set(jobs.map((job) => job.id));
      const result = await mutateClassroomAlarmRegistryState((current) => {
        const replayableIds = new Set(current.jobs
          .filter((job) => jobIds.has(job.id)
            && job.deliveryState === "delivering"
            && job.deliveryStateAtMs === nowMs)
          .map((job) => job.id));
        if (!replayableIds.size) return {
          jobs: current.jobs,
          deliveredTombstones: current.deliveredTombstones,
          cancellationTombstones: current.cancellationTombstones,
        };
        const updated = deliveryResult === "acknowledged"
          ? markClassroomAlarmJobsSounded(current.jobs, replayableIds, nowMs)
          : markClassroomAlarmJobsBlocked(current.jobs, replayableIds, nowMs);
        const cancellationTombstones = pruneClassroomAlarmCancellationTombstones(
          current.cancellationTombstones,
          nowMs,
        );
        return {
          jobs: applyClassroomAlarmCancellationAuthority(
            updated,
            cancellationTombstones,
            nowMs,
          ),
          deliveredTombstones: pruneClassroomAlarmDeliveryTombstones(
            current.deliveredTombstones,
            nowMs,
          ),
          cancellationTombstones,
        };
      }, storage);
      persistenceStatus = result.status;
    },
    { storage, locks: options.locks },
  );
  return {
    claimed,
    jobs,
    ...(deliveryResult === undefined ? {} : { deliveryResult }),
    ...(persistenceStatus === undefined ? {} : { persistenceStatus }),
    ...(callbackError === undefined ? {} : { error: callbackError }),
  };
}

export function subscribeToClassroomAlarmRegistry(
  listener: (registry: ClassroomAlarmRegistryV1) => void,
  storage: ClassroomAlarmStorage | null = browserStorage(),
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onSameTab = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    listener(parseClassroomAlarmRegistry(event.detail) ?? createEmptyClassroomAlarmRegistry());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === CLASSROOM_ALARM_REGISTRY_STORAGE_KEY || event.key === null) {
      listener(readClassroomAlarmRegistry(storage));
    }
  };
  window.addEventListener(CLASSROOM_ALARM_REGISTRY_EVENT, onSameTab);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CLASSROOM_ALARM_REGISTRY_EVENT, onSameTab);
    window.removeEventListener("storage", onStorage);
  };
}
