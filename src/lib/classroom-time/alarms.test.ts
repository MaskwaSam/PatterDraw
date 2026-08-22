import { describe, expect, it, vi } from "vitest";
import {
  CLASSROOM_ALARM_CATCHUP_WINDOW_MS,
  CLASSROOM_ALARM_CANCELLATION_RETENTION_MS,
  CLASSROOM_ALARM_CLAIM_LEASE_MS,
  CLASSROOM_ALARM_STAGED_RESTORE_RETENTION_MS,
  CLASSROOM_ALARM_TOMBSTONE_RETENTION_MS,
  CLASSROOM_ALARM_REGISTRY_STORAGE_KEY,
  MAX_CLASSROOM_ALARM_CANCELLATION_TOMBSTONES,
  MAX_CLASSROOM_ALARM_DELIVERY_TOMBSTONES,
  MAX_CLASSROOM_ALARM_STAGED_TRANSACTIONS,
  MAX_CLASSROOM_ALARM_STAGED_TRANSACTION_BYTES,
  acknowledgeBlockedClassroomAlarmJobs,
  activateClassroomAlarmTransaction,
  cancelClassroomAlarmIdentities,
  cancelClassroomAlarmIdentitiesWithReceipt,
  cancelClassroomAlarmIdentity,
  claimAndMarkDueClassroomAlarmJobs,
  createClassroomAlarmJob,
  createEmptyClassroomAlarmRegistry,
  dueClassroomAlarmJobs,
  hasClassroomAlarmCancellationTombstone,
  hasClassroomAlarmDeliveredGeneration,
  hasClassroomAlarmDeliveredTombstone,
  isClassroomAlarmJobCancelled,
  listStagedClassroomAlarmTransactions,
  markClassroomAlarmJobsDelivering,
  markClassroomAlarmJobsSounded,
  mutateClassroomAlarmRegistry,
  mutateClassroomAlarmRegistryState,
  nextClassroomAlarmGenerationStartMs,
  parseClassroomAlarmCancellationTombstone,
  parseClassroomAlarmDeliveryTombstone,
  parseClassroomAlarmJob,
  parseClassroomAlarmRegistry,
  parseClassroomAlarmStagedTransaction,
  persistClassroomAlarmRegistry,
  pruneClassroomAlarmCancellationTombstones,
  pruneClassroomAlarmJobs,
  pruneClassroomAlarmDeliveryTombstones,
  readClassroomAlarmRegistry,
  recoverClassroomAlarmJob,
  releaseClassroomAlarmJob,
  releaseClassroomAlarmJobs,
  replayBlockedClassroomAlarmJobs,
  rollbackClassroomAlarmTransaction,
  rollbackExpiredClassroomAlarmTransactions,
  restoreCancelledClassroomAlarmJob,
  restoreCancelledClassroomAlarmJobs,
  revokeRestoredClassroomAlarmJob,
  revokeRestoredClassroomAlarmJobs,
  releaseClassroomAlarmClaim,
  subscribeToClassroomAlarmRegistry,
  startClassroomAlarmJob,
  startClassroomAlarmJobs,
  startSchedulerClassroomAlarmJobs,
  stageCancelledClassroomAlarmReceipt,
  stageClassroomAlarmTransaction,
  stageRecoveredClassroomAlarmJobs,
  stageSchedulerClassroomAlarmJobs,
  stageTrustedClassroomAlarmJobs,
  matchStagedClassroomAlarmTransaction,
  tryClaimClassroomAlarm,
  upsertClassroomAlarmJob,
  withClassroomAlarmClaim,
  type ClassroomAlarmCancellationTombstoneV1,
  type ClassroomAlarmDeliveryTombstoneV1,
  type ClassroomAlarmJobV1,
  type ClassroomAlarmStagedTransactionV1,
} from "./alarms";
import { MAX_ACTIVE_ALARM_JOBS } from "./constants";
import { playClassroomAlarmTone, prepareClassroomAlarmAudio } from "./audio";

const START = 1_800_000_000_000;

function job(overrides: Partial<ClassroomAlarmJobV1> = {}): ClassroomAlarmJobV1 {
  const { target = "timer", ...rest } = overrides;
  return createClassroomAlarmJob({
    id: "alarm-one",
    sourceProjectId: "project-one",
    ownerId: "widget-one",
    widgetKind: "timer",
    target,
    label: "Class Timer",
    deadlineMs: START + 60_000,
    tone: "warm-chime",
    repeat: false,
    createdAtMs: START,
    ...rest,
  });
}

function identityFor(alarm: ClassroomAlarmJobV1) {
  return {
    sourceProjectId: alarm.sourceProjectId,
    ownerId: alarm.ownerId,
    target: alarm.target,
  } as const;
}

function availableLocks() {
  return {
    request: vi.fn(async (
      _name: string,
      _options: unknown,
      run: (lock: object) => Promise<void>,
    ) => run({})),
  };
}

function mapStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

function switchableAudioContext() {
  let gestureEnabled = false;
  const context = {
    state: "suspended" as AudioContextState,
    currentTime: 4,
    destination: {},
    resume: vi.fn(async () => {
      if (!gestureEnabled) throw new Error("autoplay");
      context.state = "running";
    }),
    createOscillator: vi.fn(() => ({
      type: "sine",
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    })),
    createGain: vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
  };
  return {
    context: context as unknown as AudioContext,
    enableGesture: () => { gestureEnabled = true; },
  };
}

describe("classroom alarm registry", () => {
  it("strictly validates jobs and registries", () => {
    const valid = job();
    expect(parseClassroomAlarmJob(valid)).toEqual(valid);
    expect(parseClassroomAlarmJob({ ...valid, remoteSound: "https://bad.invalid" })).toBeNull();
    expect(parseClassroomAlarmJob({ ...valid, tone: "siren" })).toBeNull();
    expect(parseClassroomAlarmRegistry({ version: 1, revision: 0, jobs: [valid] })).toEqual({
      version: 1,
      revision: 0,
      jobs: [valid],
      deliveredTombstones: [],
      cancellationTombstones: [],
    });
    expect(parseClassroomAlarmRegistry({ version: 1, revision: 0, jobs: [valid, valid] })).toBeNull();
    expect(parseClassroomAlarmJob({
      ...valid,
      deadlineMs: valid.createdAtMs + 360_000_000,
    })).toBeNull();
    const { target: _legacyTarget, ...legacyJob } = valid;
    expect(parseClassroomAlarmRegistry({
      version: 1,
      revision: 2,
      jobs: [legacyJob],
    })?.jobs[0].target).toBe("timer");
  });

  it("strictly bounds, deduplicates, and expires delivered-deadline tombstones", () => {
    const tombstones: ClassroomAlarmDeliveryTombstoneV1[] = Array.from(
      { length: MAX_CLASSROOM_ALARM_DELIVERY_TOMBSTONES + 20 },
      (_, index) => ({
        version: 1,
        sourceProjectId: "project-one",
        ownerId: `widget-${index}`,
        target: "timer",
        createdAtMs: START + index,
        deadlineMs: START + index,
        deliveredAtMs: START + index,
      }),
    );
    const bounded = pruneClassroomAlarmDeliveryTombstones(tombstones, START);
    expect(bounded).toHaveLength(MAX_CLASSROOM_ALARM_DELIVERY_TOMBSTONES);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(64 * 1_024);
    expect(pruneClassroomAlarmDeliveryTombstones(
      [bounded.at(-1)!, { ...bounded.at(-1)! }],
      START,
    )).toHaveLength(1);
    expect(pruneClassroomAlarmDeliveryTombstones(
      [bounded.at(-1)!],
      bounded.at(-1)!.deliveredAtMs + CLASSROOM_ALARM_TOMBSTONE_RETENTION_MS + 1,
    )).toEqual([]);
    expect(parseClassroomAlarmRegistry({
      version: 1,
      revision: 0,
      jobs: [],
      deliveredTombstones: tombstones,
    })).toBeNull();
  });

  it("enforces the 32-job device bound", () => {
    let jobs: ClassroomAlarmJobV1[] = [];
    for (let index = 0; index < MAX_ACTIVE_ALARM_JOBS; index += 1) {
      jobs = upsertClassroomAlarmJob(jobs, job({ id: `alarm-${index}` }));
    }
    expect(jobs).toHaveLength(MAX_ACTIVE_ALARM_JOBS);
    expect(() => upsertClassroomAlarmJob(jobs, job({ id: "alarm-over" }))).toThrow(/32/);
  });

  it("catches up once, repeats every ten seconds, and stops at sixty seconds", () => {
    const repeating = job({ repeat: true });
    const registry = {
      version: 1 as const,
      revision: 0,
      jobs: [repeating],
      deliveredTombstones: [],
      cancellationTombstones: [],
    };
    expect(dueClassroomAlarmJobs(registry, repeating.deadlineMs)).toEqual([repeating]);
    const sounded = markClassroomAlarmJobsSounded(registry.jobs, new Set([repeating.id]), repeating.deadlineMs);
    expect(dueClassroomAlarmJobs({ ...registry, jobs: sounded }, repeating.deadlineMs + 9_999)).toEqual([]);
    expect(dueClassroomAlarmJobs({ ...registry, jobs: sounded }, repeating.deadlineMs + 10_000)).toHaveLength(1);
    expect(dueClassroomAlarmJobs({ ...registry, jobs: sounded }, repeating.deadlineMs + 60_000)).toEqual([]);
  });

  it("bounds catch-up to 24 hours and prunes settled jobs", () => {
    const single = job();
    const registry = {
      version: 1 as const,
      revision: 0,
      jobs: [single],
      deliveredTombstones: [],
      cancellationTombstones: [],
    };
    expect(dueClassroomAlarmJobs(registry, single.deadlineMs + CLASSROOM_ALARM_CATCHUP_WINDOW_MS)).toHaveLength(1);
    expect(dueClassroomAlarmJobs(registry, single.deadlineMs + CLASSROOM_ALARM_CATCHUP_WINDOW_MS + 1)).toEqual([]);
    const sounded = markClassroomAlarmJobsSounded([single], new Set([single.id]), single.deadlineMs);
    expect(pruneClassroomAlarmJobs(sounded, single.deadlineMs + 1)).toEqual([]);
  });

  it("persists with serialized revisions and recovers malformed values", async () => {
    const storage = mapStorage("{broken");
    expect(readClassroomAlarmRegistry(storage)).toEqual(createEmptyClassroomAlarmRegistry());

    storage.values.clear();
    const result = await mutateClassroomAlarmRegistry(
      (current) => upsertClassroomAlarmJob(current.jobs, job()),
      storage,
    );
    expect(result.status).toBe("persisted");
    expect(result.registry.revision).toBe(1);
    expect(readClassroomAlarmRegistry(storage).jobs).toHaveLength(1);

    const stale = await persistClassroomAlarmRegistry(
      {
        version: 1,
        revision: 1,
        jobs: [],
        deliveredTombstones: [],
        cancellationTombstones: [],
      },
      0,
      storage,
    );
    expect(stale.status).toBe("conflicted");
    expect(stale.registry.jobs).toHaveLength(1);
  });

  it("rolls back the exact previous registry when a write mutates then throws", async () => {
    const previous = {
      version: 1 as const,
      revision: 1,
      jobs: [job()],
      deliveredTombstones: [],
      cancellationTombstones: [],
    };
    const storage = mapStorage(JSON.stringify(previous));
    const ordinarySet = storage.setItem;
    let rejectOnce = true;
    storage.setItem = (key: string, value: string) => {
      ordinarySet(key, value);
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("quota");
      }
    };
    const result = await persistClassroomAlarmRegistry(
      {
        version: 1,
        revision: 2,
        jobs: [],
        deliveredTombstones: [],
        cancellationTombstones: [],
      },
      1,
      storage,
    );
    expect(result.status).toBe("rolled-back");
    expect(result.registry).toEqual(previous);
  });

  it("uses a revisioned storage lease so competing tabs do not both claim", () => {
    const storage = mapStorage();
    expect(tryClaimClassroomAlarm("alarm-one", "tab-one", START, storage)).toBe(true);
    expect(tryClaimClassroomAlarm("alarm-one", "tab-two", START + 1, storage)).toBe(false);
    releaseClassroomAlarmClaim("alarm-one", "tab-two", storage);
    expect(tryClaimClassroomAlarm("alarm-one", "tab-two", START + 2, storage)).toBe(false);
    releaseClassroomAlarmClaim("alarm-one", "tab-one", storage);
    expect(tryClaimClassroomAlarm("alarm-one", "tab-two", START + 3, storage)).toBe(true);
  });

  it("prefers an available Web Lock and skips an unavailable lock", async () => {
    const callback = vi.fn(async () => undefined);
    const availableLocks = {
      request: vi.fn(async (_name, _options, run: (lock: object) => Promise<void>) => run({})),
    };
    expect(await withClassroomAlarmClaim("alarm-one", "tab-one", START, callback, {
      locks: availableLocks as never,
    })).toBe(true);
    expect(callback).toHaveBeenCalledOnce();

    const unavailableLocks = {
      request: vi.fn(async (_name, _options, run: (lock: null) => Promise<void>) => run(null)),
    };
    expect(await withClassroomAlarmClaim("alarm-one", "tab-one", START, callback, {
      locks: unavailableLocks as never,
    })).toBe(false);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("atomically marks one simultaneous batch before releasing its claim", async () => {
    const due = job({ deadlineMs: START, createdAtMs: START, repeat: true });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [due] }));
    const callback = vi.fn(async () => "acknowledged" as const);
    const locks = {
      request: vi.fn(async (_name, _options, run: (lock: object) => Promise<void>) => run({})),
    };

    const first = await claimAndMarkDueClassroomAlarmJobs("tab-one", START, callback, {
      storage,
      locks: locks as never,
    });
    const second = await claimAndMarkDueClassroomAlarmJobs("tab-two", START, callback, {
      storage,
      locks: locks as never,
    });

    expect(first.jobs.map(({ id }) => id)).toEqual([due.id]);
    expect(first.persistenceStatus).toBe("persisted");
    expect(second.jobs).toEqual([]);
    expect(callback).toHaveBeenCalledOnce();
    expect(readClassroomAlarmRegistry(storage).jobs[0].soundCount).toBe(1);
  });

  it("serializes simultaneous registry writers so neither scheduled job is lost", async () => {
    const storage = mapStorage();
    const firstJob = job({ id: "first-owner:timer", ownerId: "first-owner" });
    const secondJob = job({ id: "second-owner:timer", ownerId: "second-owner" });

    const [first, second] = await Promise.all([
      mutateClassroomAlarmRegistry(
        (current) => upsertClassroomAlarmJob(current.jobs, firstJob),
        storage,
      ),
      mutateClassroomAlarmRegistry(
        (current) => upsertClassroomAlarmJob(current.jobs, secondJob),
        storage,
      ),
    ]);

    expect(first.status).toBe("persisted");
    expect(second.status).toBe("persisted");
    expect(readClassroomAlarmRegistry(storage).jobs.map(({ id }) => id).sort()).toEqual([
      firstJob.id,
      secondJob.id,
    ]);
  });

  it("fails closed instead of mutating browser localStorage without Web Locks", async () => {
    class TestStorage {
      private readonly values = new Map<string, string>();
      get length() { return this.values.size; }
      clear() { this.values.clear(); }
      getItem(key: string) { return this.values.get(key) ?? null; }
      key(index: number) { return [...this.values.keys()][index] ?? null; }
      removeItem(key: string) { this.values.delete(key); }
      setItem(key: string, value: string) { this.values.set(key, value); }
    }
    const storage = new TestStorage() as unknown as Storage;
    const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
    const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    try {
      const alarm = job({ deadlineMs: START, createdAtMs: START });
      const result = await mutateClassroomAlarmRegistry(
        (current) => upsertClassroomAlarmJob(current.jobs, alarm),
        storage,
      );
      expect(result.status).toBe("memory-only");
      expect(result.registry.jobs).toHaveLength(1);
      expect(storage.getItem(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY)).toBeNull();

      const callback = vi.fn(async () => "acknowledged" as const);
      const delivery = await claimAndMarkDueClassroomAlarmJobs(
        "no-lock-tab",
        START,
        callback,
        { storage, locks: null },
      );
      expect(delivery.jobs).toEqual([]);
      expect(callback).not.toHaveBeenCalled();
    } finally {
      if (locksDescriptor) Object.defineProperty(navigator, "locks", locksDescriptor);
      else Reflect.deleteProperty(navigator, "locks");
      if (localStorageDescriptor) Object.defineProperty(window, "localStorage", localStorageDescriptor);
      else Reflect.deleteProperty(window, "localStorage");
    }
  });

  it("persists an exact delivered deadline so a delayed tab cannot recreate or sound it", async () => {
    const due = job({
      id: "widget-one:timer",
      deadlineMs: START,
      createdAtMs: START,
    });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [due] }));
    const firstCallback = vi.fn(async () => "acknowledged" as const);
    const delayedCallback = vi.fn(async () => "acknowledged" as const);
    const locks = {
      request: vi.fn(async (_name, _options, run: (lock: object) => Promise<void>) => run({})),
    };

    await claimAndMarkDueClassroomAlarmJobs("foreground-tab", START, firstCallback, {
      storage,
      locks: locks as never,
    });
    const delivered = readClassroomAlarmRegistry(storage);
    expect(delivered.jobs).toEqual([]);
    expect(delivered.deliveredTombstones).toEqual([{
      version: 1,
      sourceProjectId: due.sourceProjectId,
      ownerId: due.ownerId,
      target: due.target,
      createdAtMs: due.createdAtMs,
      deadlineMs: due.deadlineMs,
      deliveredAtMs: START,
    }]);

    const delayedAt = START + 60 * 60 * 1_000;
    const delayedWrite = await mutateClassroomAlarmRegistry((registry) => (
      hasClassroomAlarmDeliveredTombstone(registry, due, delayedAt)
        ? registry.jobs
        : upsertClassroomAlarmJob(registry.jobs, due, delayedAt)
    ), storage);
    expect(delayedWrite.registry.jobs).toEqual([]);
    await claimAndMarkDueClassroomAlarmJobs("background-tab", delayedAt, delayedCallback, {
      storage,
      locks: locks as never,
    });
    expect(firstCallback).toHaveBeenCalledOnce();
    expect(delayedCallback).not.toHaveBeenCalled();
  });

  it("keeps delivered tombstones outside the 32-job capacity for sequential one-shots", async () => {
    const storage = mapStorage();
    const callback = vi.fn(async () => "acknowledged" as const);
    const locks = {
      request: vi.fn(async (_name, _options, run: (lock: object) => Promise<void>) => run({})),
    };

    for (let index = 0; index < MAX_ACTIVE_ALARM_JOBS + 1; index += 1) {
      const deadlineMs = START + index;
      const nextJob = job({
        id: "sequential-owner:timer",
        ownerId: "sequential-owner",
        deadlineMs,
        createdAtMs: deadlineMs,
      });
      const scheduled = await mutateClassroomAlarmRegistry(
        (current) => upsertClassroomAlarmJob(current.jobs, nextJob, deadlineMs),
        storage,
      );
      expect(scheduled.registry.jobs).toHaveLength(1);
      await claimAndMarkDueClassroomAlarmJobs(`tab-${index}`, deadlineMs, callback, {
        storage,
        locks: locks as never,
      });
      expect(readClassroomAlarmRegistry(storage).jobs).toEqual([]);
    }

    const settled = readClassroomAlarmRegistry(storage);
    expect(settled.jobs).toEqual([]);
    expect(settled.deliveredTombstones).toHaveLength(MAX_ACTIVE_ALARM_JOBS + 1);
    expect(callback).toHaveBeenCalledTimes(MAX_ACTIVE_ALARM_JOBS + 1);
  });

  it("bounds blocked replays and then frees a full one-shot registry", async () => {
    const jobs = Array.from({ length: MAX_ACTIVE_ALARM_JOBS }, (_, index) => job({
      id: `completed-owner-${index}:timer`,
      ownerId: `completed-owner-${index}`,
      deadlineMs: START,
      createdAtMs: START,
    }));
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs }));
    const alertCallback = vi.fn(async () => "audio-blocked" as const);
    const replayCallback = vi.fn(async () => "audio-blocked" as const);
    const locks = {
      request: vi.fn(async (_name, _options, run: (lock: object) => Promise<void>) => run({})),
    };

    const result = await claimAndMarkDueClassroomAlarmJobs("tab-one", START, alertCallback, {
      storage,
      locks: locks as never,
    });

    expect(result.jobs).toHaveLength(MAX_ACTIVE_ALARM_JOBS);
    expect(result.deliveryResult).toBe("audio-blocked");
    expect(alertCallback).toHaveBeenCalledOnce();
    expect(readClassroomAlarmRegistry(storage).jobs.every((candidate) => (
      candidate.deliveryState === "blocked" && candidate.blockedAttempts === 1
    ))).toBe(true);
    expect(readClassroomAlarmRegistry(storage).deliveredTombstones).toHaveLength(
      MAX_ACTIVE_ALARM_JOBS,
    );

    await replayBlockedClassroomAlarmJobs("tab-one", START + 1, replayCallback, {
      storage,
      locks: locks as never,
    });
    await replayBlockedClassroomAlarmJobs("tab-one", START + 2, replayCallback, {
      storage,
      locks: locks as never,
    });
    const settled = readClassroomAlarmRegistry(storage);
    expect(settled.jobs).toEqual([]);
    expect(settled.deliveredTombstones).toHaveLength(MAX_ACTIVE_ALARM_JOBS);
    expect(upsertClassroomAlarmJob(settled.jobs, job({ id: "alarm-33" }))).toHaveLength(1);
  });

  it("persists a blocked reload alarm and replays it after trusted audio preparation", async () => {
    const due = job({ deadlineMs: START, createdAtMs: START });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [due] }));
    const audio = switchableAudioContext();
    const locks = {
      request: vi.fn(async (_name, _options, run: (lock: object) => Promise<void>) => run({})),
    };
    let visibleAlertCount = 0;

    const initial = await claimAndMarkDueClassroomAlarmJobs("tab-one", START, async ([alarm]) => {
      visibleAlertCount += 1;
      const playback = await playClassroomAlarmTone(alarm.tone, { context: audio.context });
      return playback.status === "blocked" || playback.status === "unavailable"
        ? "audio-blocked"
        : "acknowledged";
    }, { storage, locks: locks as never });

    expect(initial.deliveryResult).toBe("audio-blocked");
    const afterReload = readClassroomAlarmRegistry(storage);
    expect(afterReload.jobs[0]).toMatchObject({ deliveryState: "blocked", blockedAttempts: 1 });
    expect(dueClassroomAlarmJobs(afterReload, START + 1)).toEqual([]);

    audio.enableGesture();
    await expect(prepareClassroomAlarmAudio(audio.context)).resolves.toEqual({ status: "ready" });
    const replay = await replayBlockedClassroomAlarmJobs("tab-reloaded", START + 2, async ([alarm]) => {
      const playback = await playClassroomAlarmTone(alarm.tone, { context: audio.context });
      return playback.status === "played" || playback.status === "muted"
        ? "acknowledged"
        : "audio-blocked";
    }, { storage, locks: locks as never });

    expect(replay.deliveryResult).toBe("acknowledged");
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([]);
    expect(visibleAlertCount).toBe(1);
  });

  it("durably stages delivery so an expired fallback claim cannot duplicate the alert", async () => {
    const due = job({ deadlineMs: START, createdAtMs: START });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [due] }));
    let finishPlayback: (() => void) | undefined;
    const playbackFinished = new Promise<void>((resolve) => { finishPlayback = resolve; });
    let visibleAlertCount = 0;
    const competingCallback = vi.fn(async () => "acknowledged" as const);

    const firstPromise = claimAndMarkDueClassroomAlarmJobs("tab-one", START, async () => {
      visibleAlertCount += 1;
      await playbackFinished;
      return "acknowledged" as const;
    }, { storage, locks: null });

    await vi.waitFor(() => {
      expect(readClassroomAlarmRegistry(storage).jobs[0]).toMatchObject({
        deliveryState: "delivering",
        deliveryStateAtMs: START,
      });
    });

    const competing = await claimAndMarkDueClassroomAlarmJobs(
      "tab-two",
      START + CLASSROOM_ALARM_CLAIM_LEASE_MS + 1,
      competingCallback,
      { storage, locks: null },
    );
    expect(competing.claimed).toBe(true);
    expect(competing.jobs).toEqual([]);
    expect(competingCallback).not.toHaveBeenCalled();
    expect(visibleAlertCount).toBe(1);

    finishPlayback?.();
    const first = await firstPromise;
    expect(first.deliveryResult).toBe("acknowledged");
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([]);
  });

  it("ages out blocked alarms without manual replay and frees device capacity", async () => {
    const jobs = Array.from({ length: MAX_ACTIVE_ALARM_JOBS }, (_, index) => job({
      id: `blocked-${index}`,
      ownerId: `blocked-owner-${index}`,
      deadlineMs: START,
      createdAtMs: START,
    }));
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs }));
    const initialCallback = vi.fn(async () => "audio-blocked" as const);
    const laterCallback = vi.fn(async () => "acknowledged" as const);
    const locks = {
      request: vi.fn(async (_name, _options, run: (lock: object) => Promise<void>) => run({})),
    };

    await claimAndMarkDueClassroomAlarmJobs("tab-one", START, initialCallback, {
      storage,
      locks: locks as never,
    });
    expect(readClassroomAlarmRegistry(storage).jobs).toHaveLength(MAX_ACTIVE_ALARM_JOBS);

    const expiredAt = START + CLASSROOM_ALARM_CATCHUP_WINDOW_MS + 1;
    await claimAndMarkDueClassroomAlarmJobs("tab-two", expiredAt, laterCallback, {
      storage,
      locks: locks as never,
    });
    expect(laterCallback).not.toHaveBeenCalled();
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([]);

    expect(upsertClassroomAlarmJob([], job({
      id: "replacement-alarm",
      deadlineMs: expiredAt,
      createdAtMs: expiredAt,
    }))).toHaveLength(1);
  });

  it("strictly validates generation-aware delivery and cancellation tombstones", () => {
    const delivered: ClassroomAlarmDeliveryTombstoneV1 = {
      version: 1,
      sourceProjectId: "project-one",
      ownerId: "widget-one",
      target: "timer",
      createdAtMs: START,
      deadlineMs: START + 60_000,
      deliveredAtMs: START + 60_000,
    };
    const cancelled: ClassroomAlarmCancellationTombstoneV1 = {
      version: 1,
      sourceProjectId: "project-one",
      ownerId: "widget-one",
      target: "timer",
      cancelledAtMs: START + 1,
      cancelledGeneration: {
        jobId: "alarm-one",
        createdAtMs: START,
        deadlineMs: START + 60_000,
      },
      restoredAtMs: null,
    };

    expect(parseClassroomAlarmDeliveryTombstone(delivered)).toEqual(delivered);
    expect(parseClassroomAlarmDeliveryTombstone({ ...delivered, remote: true })).toBeNull();
    expect(parseClassroomAlarmCancellationTombstone(cancelled)).toEqual(cancelled);
    expect(parseClassroomAlarmCancellationTombstone({
      ...cancelled,
      cancelledGeneration: { ...cancelled.cancelledGeneration, extra: true },
    })).toBeNull();
    expect(parseClassroomAlarmCancellationTombstone({
      ...cancelled,
      restoredAtMs: START,
    })).toBeNull();

    const legacyDelivery = {
      version: 1,
      sourceProjectId: delivered.sourceProjectId,
      ownerId: delivered.ownerId,
      target: delivered.target,
      deadlineMs: delivered.deadlineMs,
      deliveredAtMs: delivered.deliveredAtMs,
    };
    const migrated = parseClassroomAlarmRegistry({
      version: 1,
      revision: 1,
      jobs: [],
      deliveredTombstones: [legacyDelivery],
    });
    expect(migrated?.deliveredTombstones[0]).toMatchObject(legacyDelivery);
    expect(migrated?.deliveredTombstones[0].createdAtMs).toBeLessThanOrEqual(
      legacyDelivery.deadlineMs,
    );
    expect(hasClassroomAlarmDeliveredGeneration(
      migrated!,
      job({ deadlineMs: legacyDelivery.deadlineMs }),
      legacyDelivery.deliveredAtMs,
    )).toBe(true);
  });

  it("bounds, deduplicates, and expires cancellation authority independently", () => {
    const tombstones: ClassroomAlarmCancellationTombstoneV1[] = Array.from(
      { length: MAX_CLASSROOM_ALARM_CANCELLATION_TOMBSTONES + 20 },
      (_, index) => ({
        version: 1,
        sourceProjectId: "project-one",
        ownerId: `cancelled-widget-${index}`,
        target: "timer",
        cancelledAtMs: START + index,
        cancelledGeneration: null,
        restoredAtMs: null,
      }),
    );
    const bounded = pruneClassroomAlarmCancellationTombstones(tombstones, START);
    expect(bounded).toHaveLength(MAX_CLASSROOM_ALARM_CANCELLATION_TOMBSTONES);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength)
      .toBeLessThanOrEqual(64 * 1_024);
    expect(pruneClassroomAlarmCancellationTombstones(
      [bounded.at(-1)!, { ...bounded.at(-1)! }],
      START,
    )).toHaveLength(1);
    expect(pruneClassroomAlarmCancellationTombstones(
      [bounded.at(-1)!],
      bounded.at(-1)!.cancelledAtMs + CLASSROOM_ALARM_CANCELLATION_RETENTION_MS + 1,
    )).toEqual([]);
    expect(parseClassroomAlarmRegistry({
      version: 1,
      revision: 0,
      jobs: [],
      deliveredTombstones: [],
      cancellationTombstones: tombstones,
    })).toBeNull();
  });

  it.each([
    "pause",
    "reset",
    "delete",
    "convert",
    "native undo-style delete",
    "PDF page delete",
  ])("persists %s authority so a delayed tab cannot recover the cancelled job", async () => {
    const original = job({ id: "widget-one:timer" });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [original],
    }));
    const cancelledAt = START + 1_000;

    const cancelled = await cancelClassroomAlarmIdentity(
      identityFor(original),
      cancelledAt,
      storage,
    );
    expect(cancelled.status).toBe("persisted");
    expect(cancelled.registry.jobs).toEqual([]);
    expect(cancelled.registry.cancellationTombstones[0]).toMatchObject({
      ...identityFor(original),
      cancelledAtMs: cancelledAt,
      cancelledGeneration: {
        jobId: original.id,
        createdAtMs: original.createdAtMs,
        deadlineMs: original.deadlineMs,
      },
      restoredAtMs: null,
    });
    expect(isClassroomAlarmJobCancelled(cancelled.registry, original, cancelledAt)).toBe(true);

    const delayed = await mutateClassroomAlarmRegistry(
      (registry) => recoverClassroomAlarmJob(registry, original, cancelledAt + 1),
      storage,
    );
    expect(delayed.status).toBe("persisted");
    expect(delayed.registry.jobs).toEqual([]);
    expect(hasClassroomAlarmCancellationTombstone(
      delayed.registry,
      identityFor(original),
      cancelledAt + 1,
    )).toBe(true);
  });

  it("retains a cancellation fence across a later Start and completed delivery", async () => {
    const first = job({ id: "widget-one:timer" });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [first] }));
    const cancelledAt = START + 1_000;
    await cancelClassroomAlarmIdentity(identityFor(first), cancelledAt, storage);
    const cancelled = readClassroomAlarmRegistry(storage);
    const logicalStart = nextClassroomAlarmGenerationStartMs(
      cancelled,
      identityFor(first),
      cancelledAt,
    );
    expect(logicalStart).toBe(cancelledAt + 1);
    const second = job({
      id: first.id,
      createdAtMs: logicalStart,
      deadlineMs: logicalStart + 30_000,
    });

    const started = await startClassroomAlarmJob(second, logicalStart, storage);
    expect(started.status).toBe("persisted");
    expect(started.registry.jobs).toEqual([second]);
    expect(started.registry.cancellationTombstones).toHaveLength(1);
    expect(started.registry.cancellationTombstones[0].cancelledAtMs).toBe(cancelledAt);

    const callback = vi.fn(async () => "acknowledged" as const);
    await claimAndMarkDueClassroomAlarmJobs("new-generation-tab", second.deadlineMs, callback, {
      storage,
      locks: availableLocks() as never,
    });
    const delivered = readClassroomAlarmRegistry(storage);
    expect(delivered.jobs).toEqual([]);
    expect(hasClassroomAlarmDeliveredGeneration(delivered, first, second.deadlineMs)).toBe(true);
    expect(delivered.cancellationTombstones).toHaveLength(1);

    const stale = await mutateClassroomAlarmRegistry(
      (registry) => recoverClassroomAlarmJob(registry, first, second.deadlineMs + 1),
      storage,
    );
    expect(stale.registry.jobs).toEqual([]);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("starts multiple trusted generations in one atomic registry revision", async () => {
    const first = job({ id: "first-owner:timer", ownerId: "first-owner" });
    const second = job({ id: "second-owner:timer", ownerId: "second-owner" });
    const firstNext = job({
      id: first.id,
      ownerId: first.ownerId,
      createdAtMs: START + 1,
      deadlineMs: START + 30_001,
    });
    const secondNext = job({
      id: second.id,
      ownerId: second.ownerId,
      createdAtMs: START + 1,
      deadlineMs: START + 45_001,
    });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [first, second],
    }));

    const result = await startClassroomAlarmJobs(
      [firstNext, secondNext],
      START + 1,
      storage,
    );
    expect(result.status).toBe("persisted");
    expect(result.registry.revision).toBe(1);
    expect(result.registry.jobs).toEqual([firstNext, secondNext]);
    expect(readClassroomAlarmRegistry(storage)).toEqual(result.registry);
  });

  it("rolls back the whole trusted-start batch when its second generation conflicts", async () => {
    const first = job({ id: "first-owner:timer", ownerId: "first-owner" });
    const second = job({ id: "second-owner:timer", ownerId: "second-owner" });
    const firstNext = job({
      id: first.id,
      ownerId: first.ownerId,
      createdAtMs: START + 1,
      deadlineMs: START + 30_001,
    });
    const conflictingSecond = job({
      id: second.id,
      ownerId: second.ownerId,
      createdAtMs: second.createdAtMs,
      deadlineMs: second.deadlineMs,
    });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [first, second],
    }));

    const result = await startClassroomAlarmJobs(
      [firstNext, conflictingSecond],
      START + 1,
      storage,
    );
    expect(result.status).toBe("rolled-back");
    expect(result.error).toBeInstanceOf(RangeError);
    expect(readClassroomAlarmRegistry(storage)).toMatchObject({
      revision: 0,
      jobs: [first, second],
    });
    expect(readClassroomAlarmRegistry(storage).jobs).not.toContainEqual(firstNext);
  });

  it("rolls back the whole trusted-start batch when final capacity exceeds 32", async () => {
    const existing = Array.from({ length: MAX_ACTIVE_ALARM_JOBS - 1 }, (_, index) => job({
      id: `capacity-owner-${index}:timer`,
      ownerId: `capacity-owner-${index}`,
    }));
    const firstNew = job({ id: "capacity-new-a:timer", ownerId: "capacity-new-a" });
    const secondNew = job({ id: "capacity-new-b:timer", ownerId: "capacity-new-b" });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: existing,
    }));

    const result = await startClassroomAlarmJobs(
      [firstNew, secondNew],
      START,
      storage,
    );
    expect(result.status).toBe("rolled-back");
    expect(result.error).toBeInstanceOf(RangeError);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual(existing);
    expect(readClassroomAlarmRegistry(storage).revision).toBe(0);
  });

  it("scheduler start preserves blocked or delivering jobs that change under the lock", async () => {
    const first = job({ id: "scheduler-first:timer", ownerId: "scheduler-first" });
    const second = job({ id: "scheduler-second:timer", ownerId: "scheduler-second" });
    const nowMs = second.deadlineMs;
    const firstNext = job({
      id: first.id,
      ownerId: first.ownerId,
      createdAtMs: nowMs,
      deadlineMs: nowMs + 30_000,
    });
    const secondNext = job({
      id: second.id,
      ownerId: second.ownerId,
      createdAtMs: nowMs,
      deadlineMs: nowMs + 45_000,
    });
    const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
    try {
      for (const deliveryState of ["blocked", "delivering"] as const) {
        const transitionedSecond: ClassroomAlarmJobV1 = {
          ...second,
          deliveryState,
          deliveryStateAtMs: nowMs,
          blockedAttempts: deliveryState === "blocked" ? 1 : 0,
        };
        const storage = mapStorage(JSON.stringify({
          version: 1,
          revision: 0,
          jobs: [first, second],
        }));
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          value: {
            request: vi.fn(async (
              _name: string,
              _options: unknown,
              run: () => Promise<unknown>,
            ) => {
              storage.values.set(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY, JSON.stringify({
                version: 1,
                revision: 0,
                jobs: [first, transitionedSecond],
              }));
              return run();
            }),
          },
        });

        const result = await startSchedulerClassroomAlarmJobs(
          [firstNext, secondNext],
          nowMs,
          storage,
        );
        expect(result.status, deliveryState).toBe("rolled-back");
        expect(result.error, deliveryState).toBeInstanceOf(RangeError);
        expect(readClassroomAlarmRegistry(storage).jobs, deliveryState).toEqual([
          first,
          transitionedSecond,
        ]);
        expect(readClassroomAlarmRegistry(storage).revision, deliveryState).toBe(0);
      }
    } finally {
      if (locksDescriptor) Object.defineProperty(navigator, "locks", locksDescriptor);
      else Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("scheduler start remains atomic when all current jobs are pending", async () => {
    const first = job({ id: "scheduler-first:timer", ownerId: "scheduler-first" });
    const second = job({ id: "scheduler-second:timer", ownerId: "scheduler-second" });
    const firstNext = job({
      id: first.id,
      ownerId: first.ownerId,
      createdAtMs: START + 1,
      deadlineMs: START + 30_001,
    });
    const secondNext = job({
      id: second.id,
      ownerId: second.ownerId,
      createdAtMs: START + 1,
      deadlineMs: START + 45_001,
    });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [first, second],
    }));

    const result = await startSchedulerClassroomAlarmJobs(
      [firstNext, secondNext],
      START + 1,
      storage,
    );
    expect(result.status).toBe("persisted");
    expect(result.registry.jobs).toEqual([firstNext, secondNext]);
  });

  it("atomically releases only exact pending reservations and preserves authority", async () => {
    const first = job({ id: "release-first:timer", ownerId: "release-first" });
    const second = job({ id: "release-second:timer", ownerId: "release-second" });
    const unrelated = job({ id: "release-other:timer", ownerId: "release-other" });
    const deliveredTombstone: ClassroomAlarmDeliveryTombstoneV1 = {
      version: 1,
      sourceProjectId: "project-one",
      ownerId: "delivered-owner",
      target: "timer",
      createdAtMs: START,
      deadlineMs: START,
      deliveredAtMs: START,
    };
    const cancellationTombstone: ClassroomAlarmCancellationTombstoneV1 = {
      version: 1,
      sourceProjectId: "project-one",
      ownerId: "cancelled-owner",
      target: "timer",
      cancelledAtMs: START,
      cancelledGeneration: null,
      restoredAtMs: null,
    };
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [first, second, unrelated],
      deliveredTombstones: [deliveredTombstone],
      cancellationTombstones: [cancellationTombstone],
    }));

    const result = await releaseClassroomAlarmJobs([first, second], START, storage);
    expect(result.status).toBe("persisted");
    expect(result.registry.revision).toBe(1);
    expect(result.registry.jobs).toEqual([unrelated]);
    expect(result.registry.deliveredTombstones).toEqual([deliveredTombstone]);
    expect(result.registry.cancellationTombstones).toEqual([cancellationTombstone]);
  });

  it("does not release a newer, blocked, or delivering job", async () => {
    const requested = job({
      id: "release-owner:timer",
      ownerId: "release-owner",
      createdAtMs: START,
      deadlineMs: START,
    });
    const cases: Array<[string, ClassroomAlarmJobV1, number]> = [
      ["newer", job({
        id: requested.id,
        ownerId: requested.ownerId,
        createdAtMs: START + 1,
        deadlineMs: START + 1,
      }), START + 1],
      ["blocked", {
        ...requested,
        deliveryState: "blocked",
        deliveryStateAtMs: START,
        blockedAttempts: 1,
      }, START],
      ["delivering", {
        ...requested,
        deliveryState: "delivering",
        deliveryStateAtMs: START,
      }, START],
    ];

    for (const [name, current, nowMs] of cases) {
      const storage = mapStorage(JSON.stringify({
        version: 1,
        revision: 0,
        jobs: [current],
      }));
      const result = await releaseClassroomAlarmJob(requested, nowMs, storage);
      expect(result.status, name).toBe("rolled-back");
      expect(result.error, name).toBeInstanceOf(RangeError);
      expect(readClassroomAlarmRegistry(storage).jobs, name).toEqual([current]);
      expect(readClassroomAlarmRegistry(storage).revision, name).toBe(0);
    }
  });

  it("rolls back an exact-release batch when its second reservation changed", async () => {
    const first = job({ id: "release-first:timer", ownerId: "release-first" });
    const second = job({ id: "release-second:timer", ownerId: "release-second" });
    const newerSecond = job({
      id: second.id,
      ownerId: second.ownerId,
      createdAtMs: START + 1,
      deadlineMs: START + 60_001,
    });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [first, newerSecond],
    }));

    const result = await releaseClassroomAlarmJobs(
      [first, second],
      START + 1,
      storage,
    );
    expect(result.status).toBe("rolled-back");
    expect(result.error).toBeInstanceOf(RangeError);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([first, newerSecond]);
    expect(readClassroomAlarmRegistry(storage).revision).toBe(0);
  });

  it("durably dismisses an exact blocked batch without replaying it later", async () => {
    const blocked = (ownerId: string): ClassroomAlarmJobV1 => ({
      ...job({
        id: `${ownerId}:timer`,
        ownerId,
        createdAtMs: START,
        deadlineMs: START,
      }),
      deliveryState: "blocked",
      deliveryStateAtMs: START,
      blockedAttempts: 1,
    });
    const first = blocked("dismiss-first");
    const second = blocked("dismiss-second");
    const unrelated = blocked("dismiss-unrelated");
    const deliveredTombstones: ClassroomAlarmDeliveryTombstoneV1[] = [
      first,
      second,
      unrelated,
    ].map((alarm) => ({
      version: 1,
      sourceProjectId: alarm.sourceProjectId,
      ownerId: alarm.ownerId,
      target: alarm.target,
      createdAtMs: alarm.createdAtMs,
      deadlineMs: alarm.deadlineMs,
      deliveredAtMs: START,
    }));
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [first, second, unrelated],
      deliveredTombstones,
      cancellationTombstones: [],
    }));

    const dismissed = await acknowledgeBlockedClassroomAlarmJobs(
      [first, second],
      START + 1,
      storage,
    );
    expect(dismissed.status).toBe("persisted");
    expect(dismissed.registry.jobs).toEqual([unrelated]);
    expect(dismissed.registry.deliveredTombstones).toEqual(deliveredTombstones);

    const replayedIds: string[] = [];
    await replayBlockedClassroomAlarmJobs(
      "dismiss-replay-tab",
      START + 2,
      async (jobs) => {
        replayedIds.push(...jobs.map(({ id }) => id));
        return "acknowledged" as const;
      },
      { storage, locks: availableLocks() as never },
    );
    expect(replayedIds).toEqual([unrelated.id]);
    expect(replayedIds).not.toContain(first.id);
    expect(replayedIds).not.toContain(second.id);
  });

  it("rolls back blocked dismissal when its second generation no longer matches", async () => {
    const first: ClassroomAlarmJobV1 = {
      ...job({
        id: "dismiss-first:timer",
        ownerId: "dismiss-first",
        createdAtMs: START,
        deadlineMs: START,
      }),
      deliveryState: "blocked",
      deliveryStateAtMs: START,
      blockedAttempts: 1,
    };
    const second: ClassroomAlarmJobV1 = {
      ...job({
        id: "dismiss-second:timer",
        ownerId: "dismiss-second",
        createdAtMs: START,
        deadlineMs: START,
      }),
      deliveryState: "blocked",
      deliveryStateAtMs: START,
      blockedAttempts: 1,
    };
    const newerSecond: ClassroomAlarmJobV1 = {
      ...job({
        id: second.id,
        ownerId: second.ownerId,
        createdAtMs: START + 1,
        deadlineMs: START + 1,
      }),
      deliveryState: "blocked",
      deliveryStateAtMs: START + 1,
      blockedAttempts: 1,
    };
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [first, newerSecond],
    }));

    const result = await acknowledgeBlockedClassroomAlarmJobs(
      [first, second],
      START + 2,
      storage,
    );
    expect(result.status).toBe("rolled-back");
    expect(result.error).toBeInstanceOf(RangeError);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([first, newerSecond]);
    expect(readClassroomAlarmRegistry(storage).revision).toBe(0);
  });

  it("uses delivered generations to suppress an old deadline after add-minute", async () => {
    const original = job({ id: "widget-one:timer" });
    const adjusted = job({
      id: original.id,
      createdAtMs: original.createdAtMs,
      deadlineMs: original.deadlineMs + 60_000,
    });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [original] }));
    const replaced = await startClassroomAlarmJob(adjusted, START + 1_000, storage);
    expect(replaced.status).toBe("persisted");
    expect(replaced.registry.jobs).toEqual([adjusted]);

    await claimAndMarkDueClassroomAlarmJobs(
      "adjusted-tab",
      adjusted.deadlineMs,
      async () => "acknowledged" as const,
      { storage, locks: availableLocks() as never },
    );
    const delivered = readClassroomAlarmRegistry(storage);
    expect(delivered.deliveredTombstones[0]).toMatchObject({
      createdAtMs: adjusted.createdAtMs,
      deadlineMs: adjusted.deadlineMs,
    });
    expect(hasClassroomAlarmDeliveredGeneration(delivered, original, adjusted.deadlineMs))
      .toBe(true);

    const stale = await mutateClassroomAlarmRegistry(
      (registry) => recoverClassroomAlarmJob(registry, original, adjusted.deadlineMs + 1),
      storage,
    );
    expect(stale.registry.jobs).toEqual([]);
  });

  it("allows a trusted later Start to supersede a blocked older generation", async () => {
    const first = job({
      id: "widget-one:timer",
      createdAtMs: START,
      deadlineMs: START,
    });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [first] }));
    await claimAndMarkDueClassroomAlarmJobs(
      "blocked-tab",
      START,
      async () => "audio-blocked" as const,
      { storage, locks: availableLocks() as never },
    );
    expect(readClassroomAlarmRegistry(storage).jobs[0].deliveryState).toBe("blocked");

    const logicalStart = nextClassroomAlarmGenerationStartMs(
      readClassroomAlarmRegistry(storage),
      identityFor(first),
      START,
    );
    const second = job({
      id: first.id,
      createdAtMs: logicalStart,
      deadlineMs: logicalStart + 60_000,
    });
    const started = await startClassroomAlarmJob(second, logicalStart, storage);
    expect(started.status).toBe("persisted");
    expect(started.registry.jobs).toEqual([second]);
    expect(started.registry.deliveredTombstones).toHaveLength(1);
  });

  it("batch-cancels dashboard targets atomically while preserving target identity", async () => {
    const timer = job({
      id: "dashboard-one:timer",
      ownerId: "dashboard-one",
      widgetKind: "dashboard",
      target: "timer",
    });
    const pomodoro = job({
      id: "dashboard-one:pomodoro",
      ownerId: "dashboard-one",
      widgetKind: "dashboard",
      target: "pomodoro",
    });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [timer, pomodoro],
    }));
    const result = await cancelClassroomAlarmIdentities(
      [identityFor(timer), identityFor(pomodoro)],
      START + 1,
      storage,
    );
    expect(result.status).toBe("persisted");
    expect(result.registry.revision).toBe(1);
    expect(result.registry.jobs).toEqual([]);
    expect(result.registry.cancellationTombstones.map(({ target }) => target).sort())
      .toEqual(["pomodoro", "timer"]);
    await expect(cancelClassroomAlarmIdentities(
      [{ ...identityFor(timer), unsafe: true } as never],
      START + 2,
      storage,
    )).rejects.toThrow(/identity/);
  });

  it("restores a multi-widget Undo atomically or not at all", async () => {
    const timer = job({
      id: "dashboard-one:timer",
      ownerId: "dashboard-one",
      widgetKind: "dashboard",
      target: "timer",
    });
    const pomodoro = job({
      id: "dashboard-one:pomodoro",
      ownerId: "dashboard-one",
      widgetKind: "dashboard",
      target: "pomodoro",
    });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [timer, pomodoro],
    }));
    await cancelClassroomAlarmIdentities(
      [identityFor(timer), identityFor(pomodoro)],
      START + 1,
      storage,
    );
    const invalidPomodoro = job({
      ...pomodoro,
      deadlineMs: pomodoro.deadlineMs + 1,
    });
    const rejected = await restoreCancelledClassroomAlarmJobs(
      [timer, invalidPomodoro],
      START + 2,
      storage,
    );
    expect(rejected.status).toBe("rolled-back");
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([]);
    expect(readClassroomAlarmRegistry(storage).cancellationTombstones.every(
      ({ restoredAtMs }) => restoredAtMs === null,
    )).toBe(true);

    const restored = await restoreCancelledClassroomAlarmJobs(
      [timer, pomodoro],
      START + 3,
      storage,
    );
    expect(restored.status).toBe("persisted");
    expect(restored.registry.jobs.map(({ id }) => id).sort()).toEqual([
      pomodoro.id,
      timer.id,
    ]);
    expect(restored.registry.cancellationTombstones.every(
      ({ restoredAtMs }) => restoredAtMs === START + 3,
    )).toBe(true);
  });

  it("keeps a cancelled blocked alarm replayable, then removes its repeat", async () => {
    const repeating = job({
      id: "widget-one:timer",
      deadlineMs: START,
      createdAtMs: START,
      repeat: true,
    });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [repeating],
    }));
    const visible = vi.fn(async () => "audio-blocked" as const);
    const replay = vi.fn(async () => "acknowledged" as const);
    const locks = availableLocks();
    await claimAndMarkDueClassroomAlarmJobs("visible-tab", START, visible, {
      storage,
      locks: locks as never,
    });
    const cancelled = await cancelClassroomAlarmIdentity(
      identityFor(repeating),
      START + 1,
      storage,
    );
    expect(cancelled.registry.jobs[0].deliveryState).toBe("blocked");
    expect(cancelled.registry.cancellationTombstones[0].cancelledGeneration).toBeNull();

    const staleAdjusted = job({
      id: repeating.id,
      createdAtMs: repeating.createdAtMs,
      deadlineMs: repeating.deadlineMs + 60_000,
      repeat: true,
    });
    const staleStart = await startClassroomAlarmJob(
      staleAdjusted,
      START + 2,
      storage,
    );
    expect(staleStart.status).toBe("rolled-back");
    expect(staleStart.error).toBeInstanceOf(RangeError);
    expect(readClassroomAlarmRegistry(storage).jobs[0].deliveryState).toBe("blocked");

    await replayBlockedClassroomAlarmJobs("replay-tab", START + 3, replay, {
      storage,
      locks: locks as never,
    });
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([]);
    expect(visible).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledOnce();
  });

  it.each(["native wrapper Undo", "PDF page Undo"])(
    "restores only the exact cancelled generation for %s without weakening recovery",
    async () => {
      const original = job({ id: "widget-one:timer" });
      const storage = mapStorage(JSON.stringify({
        version: 1,
        revision: 0,
        jobs: [original],
      }));
      await cancelClassroomAlarmIdentity(identityFor(original), START + 1, storage);

      const restored = await restoreCancelledClassroomAlarmJob(
        original,
        START + 2,
        storage,
      );
      expect(restored.status).toBe("persisted");
      expect(restored.registry.jobs).toEqual([original]);
      expect(restored.registry.cancellationTombstones[0].restoredAtMs).toBe(START + 2);
      expect(isClassroomAlarmJobCancelled(restored.registry, original, START + 2)).toBe(true);

      const removed = await mutateClassroomAlarmRegistry(
        () => [],
        storage,
      );
      const staleRecovery = await mutateClassroomAlarmRegistry(
        (registry) => recoverClassroomAlarmJob(registry, original, START + 3),
        storage,
      );
      expect(removed.status).toBe("persisted");
      expect(staleRecovery.registry.jobs).toEqual([]);
    },
  );

  it("revokes a stale restored Undo while retaining its cancellation fence", async () => {
    const original = job({ id: "revoke-owner:timer", ownerId: "revoke-owner" });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [original],
    }));
    await cancelClassroomAlarmIdentity(identityFor(original), START + 1, storage);
    await restoreCancelledClassroomAlarmJob(original, START + 2, storage);
    const authorized = readClassroomAlarmRegistry(storage).cancellationTombstones[0];

    const revoked = await revokeRestoredClassroomAlarmJob(
      original,
      START + 3,
      storage,
    );
    expect(revoked.status).toBe("persisted");
    expect(revoked.registry.jobs).toEqual([]);
    expect(revoked.registry.cancellationTombstones[0]).toEqual({
      ...authorized,
      restoredAtMs: null,
      receiptId: null,
      receiptJob: null,
    });
    expect(revoked.registry.cancellationTombstones[0]).toMatchObject({
      cancelledAtMs: START + 1,
      cancelledGeneration: {
        jobId: original.id,
        createdAtMs: original.createdAtMs,
        deadlineMs: original.deadlineMs,
      },
    });

    const stale = await mutateClassroomAlarmRegistry(
      (registry) => recoverClassroomAlarmJob(registry, original, START + 4),
      storage,
    );
    expect(stale.registry.jobs).toEqual([]);
    expect(isClassroomAlarmJobCancelled(stale.registry, original, START + 4)).toBe(true);
  });

  it("does not revoke a newer, altered, or claimed restored generation", async () => {
    const runCase = async (
      name: string,
      change: (
        storage: ReturnType<typeof mapStorage>,
        original: ClassroomAlarmJobV1,
      ) => Promise<void>,
    ) => {
      const original = job({
        id: `revoke-${name}:timer`,
        ownerId: `revoke-${name}`,
      });
      const storage = mapStorage(JSON.stringify({
        version: 1,
        revision: 0,
        jobs: [original],
      }));
      await cancelClassroomAlarmIdentity(identityFor(original), START + 1, storage);
      await restoreCancelledClassroomAlarmJob(original, START + 2, storage);
      await change(storage, original);
      const before = readClassroomAlarmRegistry(storage);

      const result = await revokeRestoredClassroomAlarmJob(
        original,
        original.deadlineMs,
        storage,
      );
      expect(result.status, name).toBe("rolled-back");
      expect(result.error, name).toBeInstanceOf(RangeError);
      expect(readClassroomAlarmRegistry(storage), name).toEqual(before);
    };

    await runCase("newer", async (storage, original) => {
      const newer = job({
        id: original.id,
        ownerId: original.ownerId,
        createdAtMs: START + 3,
        deadlineMs: original.deadlineMs + 3,
      });
      const result = await startClassroomAlarmJob(newer, START + 3, storage);
      expect(result.status).toBe("persisted");
    });
    await runCase("altered", async (storage) => {
      const result = await mutateClassroomAlarmRegistry(
        (registry) => registry.jobs.map((candidate) => ({
          ...candidate,
          label: "Changed after restore",
        })),
        storage,
      );
      expect(result.status).toBe("persisted");
    });
    await runCase("claimed", async (storage, original) => {
      const current = readClassroomAlarmRegistry(storage);
      storage.values.set(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY, JSON.stringify({
        ...current,
        revision: current.revision + 1,
        jobs: markClassroomAlarmJobsDelivering(
          current.jobs,
          new Set([original.id]),
          original.deadlineMs,
        ),
      }));
      expect(readClassroomAlarmRegistry(storage).jobs[0].deliveryState).toBe("delivering");
    });
  });

  it("rolls back restored revocation when its second snapshot changed", async () => {
    const first = job({ id: "revoke-first:timer", ownerId: "revoke-first" });
    const second = job({ id: "revoke-second:timer", ownerId: "revoke-second" });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [first, second],
    }));
    await cancelClassroomAlarmIdentities(
      [identityFor(first), identityFor(second)],
      START + 1,
      storage,
    );
    await restoreCancelledClassroomAlarmJobs([first, second], START + 2, storage);
    await mutateClassroomAlarmRegistry(
      (registry) => registry.jobs.map((candidate) => (
        candidate.id === second.id
          ? { ...candidate, label: "Second changed" }
          : candidate
      )),
      storage,
    );
    const before = readClassroomAlarmRegistry(storage);

    const result = await revokeRestoredClassroomAlarmJobs(
      [first, second],
      START + 3,
      storage,
    );
    expect(result.status).toBe("rolled-back");
    expect(result.error).toBeInstanceOf(RangeError);
    expect(readClassroomAlarmRegistry(storage)).toEqual(before);
    expect(readClassroomAlarmRegistry(storage).jobs.some(({ id }) => id === first.id))
      .toBe(true);
    expect(readClassroomAlarmRegistry(storage).cancellationTombstones.every(
      ({ restoredAtMs }) => restoredAtMs === START + 2,
    )).toBe(true);
  });

  it("rejects Undo restore when the snapshot is not the exact cancelled generation", async () => {
    const original = job({ id: "widget-one:timer" });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [original] }));
    await cancelClassroomAlarmIdentity(identityFor(original), START + 1, storage);
    const changed = job({
      id: original.id,
      createdAtMs: original.createdAtMs,
      deadlineMs: original.deadlineMs + 1,
    });
    const rejected = await restoreCancelledClassroomAlarmJob(changed, START + 2, storage);
    expect(rejected.status).toBe("rolled-back");
    expect(rejected.registry.jobs).toEqual([]);
    expect(rejected.error).toBeInstanceOf(RangeError);
  });

  it("allows an explicit add-minute to replace an authorized restored job", async () => {
    const original = job({ id: "widget-one:timer" });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [original] }));
    await cancelClassroomAlarmIdentity(identityFor(original), START + 1, storage);
    await restoreCancelledClassroomAlarmJob(original, START + 2, storage);
    const adjusted = job({
      id: original.id,
      createdAtMs: original.createdAtMs,
      deadlineMs: original.deadlineMs + 60_000,
    });
    const replaced = await startClassroomAlarmJob(adjusted, START + 3, storage);
    expect(replaced.status).toBe("persisted");
    expect(replaced.registry.jobs).toEqual([adjusted]);
    expect(replaced.registry.cancellationTombstones[0]).toMatchObject({
      cancelledAtMs: START + 1,
      restoredAtMs: null,
    });
  });

  it("does not let an old in-flight callback overwrite a trusted new Start", async () => {
    const first = job({ id: "widget-one:timer", deadlineMs: START, createdAtMs: START });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [first] }));
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const firstDelivery = claimAndMarkDueClassroomAlarmJobs(
      "old-tab",
      START,
      async () => {
        await gate;
        return "acknowledged" as const;
      },
      { storage, locks: availableLocks() as never },
    );
    await vi.waitFor(() => {
      expect(readClassroomAlarmRegistry(storage).jobs[0].deliveryState).toBe("delivering");
    });
    await cancelClassroomAlarmIdentity(identityFor(first), START + 1, storage);
    const logicalStart = nextClassroomAlarmGenerationStartMs(
      readClassroomAlarmRegistry(storage),
      identityFor(first),
      START + 1,
    );
    const second = job({
      id: first.id,
      createdAtMs: logicalStart,
      deadlineMs: logicalStart + 60_000,
    });
    const started = await startClassroomAlarmJob(second, logicalStart, storage);
    expect(started.registry.jobs).toEqual([second]);

    finish?.();
    await firstDelivery;
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([second]);
  });

  it("publishes same-tab and storage updates", async () => {
    const storage = mapStorage();
    const listener = vi.fn();
    const unsubscribe = subscribeToClassroomAlarmRegistry(listener, storage);
    const next = {
      version: 1 as const,
      revision: 1,
      jobs: [job()],
      deliveredTombstones: [],
      cancellationTombstones: [],
    };
    await persistClassroomAlarmRegistry(next, 0, storage);
    expect(listener).toHaveBeenLastCalledWith(next);

    storage.values.set(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY, JSON.stringify({ version: 1, revision: 2, jobs: [] }));
    window.dispatchEvent(new StorageEvent("storage", { key: CLASSROOM_ALARM_REGISTRY_STORAGE_KEY }));
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2, jobs: [] }));
    unsubscribe();
  });

  it("keeps a staged alarm non-deliverable until exact activation", async () => {
    const pending = job({ deadlineMs: START + 10, createdAtMs: START });
    const storage = mapStorage();
    const staged = await stageTrustedClassroomAlarmJobs([pending], START + 1, storage);
    expect(staged.status).toBe("persisted");
    expect(staged.receipt).not.toBeNull();
    expect(staged.registry.jobs[0].deliveryState).toBe("staged");
    expect(dueClassroomAlarmJobs(staged.registry, pending.deadlineMs)).toEqual([]);

    const callback = vi.fn(async () => "acknowledged" as const);
    const beforeActivation = await claimAndMarkDueClassroomAlarmJobs(
      "queued-before-activation",
      pending.deadlineMs,
      callback,
      { storage, locks: availableLocks() as never },
    );
    expect(beforeActivation.jobs).toEqual([]);
    expect(callback).not.toHaveBeenCalled();

    const activated = await activateClassroomAlarmTransaction(
      staged.receipt!,
      START + 2,
      storage,
    );
    expect(activated.status).toBe("persisted");
    expect(activated.registry.jobs[0].deliveryState).toBe("pending");
    expect(listStagedClassroomAlarmTransactions(activated.registry)).toEqual([]);

    const afterActivation = await claimAndMarkDueClassroomAlarmJobs(
      "queued-after-activation",
      pending.deadlineMs,
      callback,
      { storage, locks: availableLocks() as never },
    );
    expect(afterActivation.jobs).toHaveLength(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it.each(["pending", "blocked"] as const)(
    "rolls a staged trusted Start back to its exact %s preimage",
    async (state) => {
      const pristine = job({ id: `preimage-${state}:timer`, ownerId: `preimage-${state}` });
      const original = state === "pending" ? pristine : {
        ...pristine,
        deadlineMs: START,
        deliveryState: "blocked" as const,
        deliveryStateAtMs: START,
        blockedAttempts: 1,
      };
      const replacement = job({
        id: pristine.id,
        ownerId: pristine.ownerId,
        createdAtMs: START + 1,
        deadlineMs: START + 120_000,
      });
      const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [original] }));
      const staged = await stageTrustedClassroomAlarmJobs(
        [replacement],
        START + 1,
        storage,
      );
      expect(staged.status).toBe("persisted");
      expect(staged.registry.stagedTransactions?.[0].previousJobs).toEqual([original]);

      const rolledBack = await rollbackClassroomAlarmTransaction(
        staged.receipt!,
        START + 2,
        storage,
      );
      expect(rolledBack.status).toBe("persisted");
      expect(rolledBack.registry.jobs).toEqual([original]);
      expect(rolledBack.registry.stagedTransactions).toBeUndefined();
    },
  );

  it("atomically rolls an expired crash-stage back before scheduler delivery", async () => {
    const original = job({
      id: "crash-owner:timer",
      ownerId: "crash-owner",
      deadlineMs: START + 48 * 60 * 60 * 1_000,
    });
    const replacement = job({
      id: original.id,
      ownerId: original.ownerId,
      createdAtMs: START + 1,
      deadlineMs: START + 49 * 60 * 60 * 1_000,
    });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [original] }));
    const staged = await stageTrustedClassroomAlarmJobs([replacement], START + 1, storage);
    const expiry = START + 1 + CLASSROOM_ALARM_STAGED_RESTORE_RETENTION_MS + 1;
    const pure = rollbackExpiredClassroomAlarmTransactions(staged.registry, expiry);
    expect(pure.jobs).toEqual([original]);
    expect(pure.stagedTransactions).toEqual([]);

    await claimAndMarkDueClassroomAlarmJobs(
      "crash-reconcile",
      expiry,
      vi.fn(async () => "acknowledged" as const),
      { storage, locks: availableLocks() as never },
    );
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([original]);
    expect(readClassroomAlarmRegistry(storage).stagedTransactions).toBeUndefined();
  });

  it("rejects scheduler staging over blocked or delivering work without mutation", async () => {
    for (const state of ["blocked", "delivering"] as const) {
      const pristine = job({
        id: `scheduler-${state}:timer`,
        ownerId: `scheduler-${state}`,
        deadlineMs: START,
        createdAtMs: START,
      });
      const incumbent = state === "blocked" ? {
        ...pristine,
        deliveryState: "blocked" as const,
        deliveryStateAtMs: START,
        blockedAttempts: 1,
      } : {
        ...pristine,
        deliveryState: "delivering" as const,
        deliveryStateAtMs: START,
      };
      const requested = job({
        id: pristine.id,
        ownerId: pristine.ownerId,
        createdAtMs: START + 1,
        deadlineMs: START + 60_000,
      });
      const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [incumbent] }));
      const before = readClassroomAlarmRegistry(storage);
      const result = await stageSchedulerClassroomAlarmJobs(
        [requested],
        START + 1,
        storage,
      );
      expect(result.status, state).toBe("rolled-back");
      expect(result.receipt, state).toBeNull();
      expect(readClassroomAlarmRegistry(storage), state).toEqual(before);
    }
  });

  it("captures the exact under-lock cancellation generation and excludes blocked jobs", async () => {
    const old = job({ id: "receipt-running:timer", ownerId: "receipt-running" });
    const newer = job({
      id: old.id,
      ownerId: old.ownerId,
      createdAtMs: START + 2,
      deadlineMs: START + 120_000,
    });
    const blockedBase = job({
      id: "receipt-blocked:timer",
      ownerId: "receipt-blocked",
      deadlineMs: START,
      createdAtMs: START,
    });
    const blocked = {
      ...blockedBase,
      deliveryState: "blocked" as const,
      deliveryStateAtMs: START,
      blockedAttempts: 1,
    };
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [old, blocked],
    }));
    await startClassroomAlarmJob(newer, START + 2, storage);
    const cancelled = await cancelClassroomAlarmIdentitiesWithReceipt(
      [identityFor(newer), identityFor(blocked)],
      START + 3,
      storage,
    );
    expect(cancelled.status).toBe("persisted");
    expect(cancelled.receipt?.cancelledJobs).toEqual([newer]);
    expect(cancelled.registry.jobs).toEqual([blocked]);
    expect(cancelled.registry.cancellationTombstones.find(
      ({ ownerId }) => ownerId === newer.ownerId,
    )?.cancelledGeneration).toMatchObject({
      jobId: newer.id,
      createdAtMs: newer.createdAtMs,
      deadlineMs: newer.deadlineMs,
    });
  });

  it("binds a cancellation receipt to its complete batch and exact job snapshots", async () => {
    const first = job({ id: "receipt-batch-a:timer", ownerId: "receipt-batch-a" });
    const second = job({
      id: "receipt-batch-b:timer",
      ownerId: "receipt-batch-b",
      label: "Second timer",
      tone: "gentle-bell",
      repeat: true,
    });
    const storage = mapStorage(JSON.stringify({
      version: 1,
      revision: 0,
      jobs: [first, second],
    }));
    const cancelled = await cancelClassroomAlarmIdentitiesWithReceipt(
      [identityFor(first), identityFor(second)],
      START + 1,
      storage,
    );
    expect(cancelled.status).toBe("persisted");
    expect(cancelled.receipt?.cancelledJobs).toEqual([first, second]);
    expect(cancelled.registry.cancellationTombstones).toEqual(expect.arrayContaining([
      expect.objectContaining({ receiptId: cancelled.receipt?.receiptId, receiptJob: first }),
      expect.objectContaining({ receiptId: cancelled.receipt?.receiptId, receiptJob: second }),
    ]));
    const before = readClassroomAlarmRegistry(storage);

    const subset = await stageCancelledClassroomAlarmReceipt({
      ...cancelled.receipt!,
      identities: [identityFor(first)],
      cancelledJobs: [first],
    }, START + 2, storage);
    expect(subset.status).toBe("rolled-back");
    expect(subset.receipt).toBeNull();
    expect(readClassroomAlarmRegistry(storage)).toEqual(before);

    const tamperedFirst = { ...first, label: "Altered timer", tone: "bright-marimba" as const };
    const tampered = await stageCancelledClassroomAlarmReceipt({
      ...cancelled.receipt!,
      cancelledJobs: [tamperedFirst, second],
    }, START + 3, storage);
    expect(tampered.status).toBe("rolled-back");
    expect(tampered.receipt).toBeNull();
    expect(readClassroomAlarmRegistry(storage)).toEqual(before);

    const exact = await stageCancelledClassroomAlarmReceipt(
      cancelled.receipt!,
      START + 4,
      storage,
    );
    expect(exact.status).toBe("persisted");
    expect(exact.receipt?.stagedJobs).toHaveLength(2);
  });

  it("keeps a cancelled-Undo receipt silent until publication and activation", async () => {
    const original = job({ deadlineMs: START + 10, createdAtMs: START });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [original] }));
    const cancelled = await cancelClassroomAlarmIdentitiesWithReceipt(
      [identityFor(original)],
      START + 1,
      storage,
    );
    const staged = await stageCancelledClassroomAlarmReceipt(
      cancelled.receipt!,
      START + 2,
      storage,
    );
    expect(staged.status).toBe("persisted");
    expect(staged.registry.jobs[0].deliveryState).toBe("staged");
    const callback = vi.fn(async () => "acknowledged" as const);
    await claimAndMarkDueClassroomAlarmJobs(
      "cancelled-undo-before-publish",
      original.deadlineMs,
      callback,
      { storage, locks: availableLocks() as never },
    );
    expect(callback).not.toHaveBeenCalled();

    await activateClassroomAlarmTransaction(staged.receipt!, START + 3, storage);
    await claimAndMarkDueClassroomAlarmJobs(
      "cancelled-undo-after-publish",
      original.deadlineMs,
      callback,
      { storage, locks: availableLocks() as never },
    );
    expect(callback).toHaveBeenCalledOnce();
  });

  it("restores a cross-project same-ID preimage on rollback and fences it on activation", async () => {
    const outgoing = job({ id: "shared-owner:timer", ownerId: "shared-owner" });
    const incoming = job({
      id: outgoing.id,
      sourceProjectId: "project-two",
      ownerId: outgoing.ownerId,
      createdAtMs: START + 1,
      deadlineMs: START + 120_000,
    });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [outgoing] }));
    const first = await stageRecoveredClassroomAlarmJobs([incoming], START + 1, storage);
    expect(first.status).toBe("persisted");
    expect(first.registry.stagedTransactions?.[0].previousJobs).toEqual([outgoing]);
    expect(first.registry.cancellationTombstones).toEqual([
      expect.objectContaining(identityFor(outgoing)),
    ]);
    await rollbackClassroomAlarmTransaction(first.receipt!, START + 2, storage);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([outgoing]);
    expect(readClassroomAlarmRegistry(storage).cancellationTombstones).toEqual([]);

    const second = await stageRecoveredClassroomAlarmJobs([incoming], START + 3, storage);
    await activateClassroomAlarmTransaction(second.receipt!, START + 4, storage);
    const delayedOutgoing = await mutateClassroomAlarmRegistry(
      (registry) => recoverClassroomAlarmJob(registry, outgoing, START + 5),
      storage,
    );
    expect(delayedOutgoing.registry.jobs).toEqual([incoming]);
  });

  it("keeps staged batches all-or-nothing on a second authority conflict", async () => {
    const first = job({ id: "batch-stage-first:timer", ownerId: "batch-stage-first" });
    const incumbent = job({
      id: "batch-stage-second:timer",
      ownerId: "batch-stage-second",
      createdAtMs: START + 2,
      deadlineMs: START + 120_000,
    });
    const staleSecond = job({
      id: incumbent.id,
      ownerId: incumbent.ownerId,
      createdAtMs: START + 1,
      deadlineMs: START + 90_000,
    });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [incumbent] }));
    const before = readClassroomAlarmRegistry(storage);
    const result = await stageTrustedClassroomAlarmJobs(
      [first, staleSecond],
      START + 2,
      storage,
    );
    expect(result.status).toBe("rolled-back");
    expect(result.receipt).toBeNull();
    expect(readClassroomAlarmRegistry(storage)).toEqual(before);
  });

  it("does not let a stale transaction receipt activate a later reservation", async () => {
    const requested = job({ id: "stale-receipt:timer", ownerId: "stale-receipt" });
    const storage = mapStorage();
    const first = await stageTrustedClassroomAlarmJobs([requested], START + 1, storage);
    await rollbackClassroomAlarmTransaction(first.receipt!, START + 2, storage);
    const second = await stageTrustedClassroomAlarmJobs([requested], START + 3, storage);
    const before = readClassroomAlarmRegistry(storage);

    const staleActivation = await activateClassroomAlarmTransaction(
      first.receipt!,
      START + 4,
      storage,
    );
    expect(staleActivation.status).toBe("rolled-back");
    expect(readClassroomAlarmRegistry(storage)).toEqual(before);
    expect(listStagedClassroomAlarmTransactions(before)).toEqual([second.receipt]);
  });

  it("reserves rollback-only IDs and identities until expiry restores the preimage", async () => {
    const original = job({
      id: "reserved-old-id:timer",
      ownerId: "reserved-owner",
      deadlineMs: START + 48 * 60 * 60 * 1_000,
    });
    const replacement = job({
      id: "reserved-new-id:timer",
      ownerId: original.ownerId,
      createdAtMs: START + 1,
      deadlineMs: START + 49 * 60 * 60 * 1_000,
    });
    const collidingId = job({
      id: original.id,
      ownerId: "other-owner",
      createdAtMs: START + 2,
      deadlineMs: START + 50 * 60 * 60 * 1_000,
    });
    const collidingIdentity = job({
      id: "other-id:timer",
      ownerId: original.ownerId,
      createdAtMs: START + 2,
      deadlineMs: START + 50 * 60 * 60 * 1_000,
    });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [original] }));
    const first = await stageTrustedClassroomAlarmJobs([replacement], START + 1, storage);
    const before = readClassroomAlarmRegistry(storage);

    for (const requested of [collidingId, collidingIdentity]) {
      const conflicting = await stageTrustedClassroomAlarmJobs(
        [requested],
        START + 2,
        storage,
      );
      expect(conflicting.status).toBe("rolled-back");
      expect(readClassroomAlarmRegistry(storage)).toEqual(before);
    }

    const expiry = START + 1 + CLASSROOM_ALARM_STAGED_RESTORE_RETENTION_MS + 1;
    await claimAndMarkDueClassroomAlarmJobs(
      "reserved-expiry",
      expiry,
      vi.fn(async () => "acknowledged" as const),
      { storage, locks: availableLocks() as never },
    );
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([original]);
    expect(readClassroomAlarmRegistry(storage).stagedTransactions).toBeUndefined();
    expect(first.receipt).not.toBeNull();
  });

  it("rotates cancelled-Undo authority on rollback and rejects old or re-cancelled receipts", async () => {
    const original = job({ id: "nonce-owner:timer", ownerId: "nonce-owner" });
    const storage = mapStorage(JSON.stringify({ version: 1, revision: 0, jobs: [original] }));
    const firstCancel = await cancelClassroomAlarmIdentitiesWithReceipt(
      [identityFor(original)],
      START + 1,
      storage,
    );
    const firstStage = await stageCancelledClassroomAlarmReceipt(
      firstCancel.receipt!,
      START + 2,
      storage,
    );
    const rolledBack = await rollbackClassroomAlarmTransaction(
      firstStage.receipt!,
      START + 3,
      storage,
    );
    expect(rolledBack.status).toBe("persisted");
    expect(rolledBack.cancellationReceipt).not.toBeNull();
    expect(rolledBack.cancellationReceipt?.receiptId).not.toBe(firstCancel.receipt?.receiptId);

    const stale = await stageCancelledClassroomAlarmReceipt(
      firstCancel.receipt!,
      START + 4,
      storage,
    );
    expect(stale.status).toBe("rolled-back");
    const retry = await stageCancelledClassroomAlarmReceipt(
      rolledBack.cancellationReceipt!,
      START + 5,
      storage,
    );
    expect(retry.status).toBe("persisted");
    await activateClassroomAlarmTransaction(retry.receipt!, START + 6, storage);

    const secondCancel = await cancelClassroomAlarmIdentitiesWithReceipt(
      [identityFor(original)],
      START + 7,
      storage,
    );
    expect(secondCancel.receipt?.receiptId).not.toBe(
      rolledBack.cancellationReceipt?.receiptId,
    );
    const olderAfterRecancel = await stageCancelledClassroomAlarmReceipt(
      rolledBack.cancellationReceipt!,
      START + 8,
      storage,
    );
    expect(olderAfterRecancel.status).toBe("rolled-back");
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([]);
  });

  it("rejects orphan stages, duplicate identities, malformed transactions, and oversized batches", async () => {
    const first = job();
    const duplicateIdentity = job({ id: "different-id" });
    expect(parseClassroomAlarmRegistry({
      version: 1,
      revision: 0,
      jobs: [first, duplicateIdentity],
      deliveredTombstones: [],
      cancellationTombstones: [],
    })).toBeNull();

    const storage = mapStorage();
    const staged = await stageTrustedClassroomAlarmJobs([first], START + 1, storage);
    const { stagedTransactions: _transactions, ...orphan } = staged.registry;
    expect(parseClassroomAlarmRegistry(orphan)).toBeNull();
    expect(parseClassroomAlarmStagedTransaction({
      ...staged.registry.stagedTransactions![0],
      remote: true,
    })).toBeNull();
    expect(parseClassroomAlarmRegistry({
      ...staged.registry,
      stagedTransactions: Array.from(
        { length: MAX_CLASSROOM_ALARM_STAGED_TRANSACTIONS + 1 },
        () => staged.registry.stagedTransactions![0],
      ),
    })).toBeNull();
    expect(MAX_CLASSROOM_ALARM_STAGED_TRANSACTION_BYTES).toBe(256 * 1_024);

    const tooMany = Array.from({ length: MAX_ACTIVE_ALARM_JOBS + 1 }, (_, index) => job({
      id: `stage-cap-${index}:timer`,
      ownerId: `stage-cap-${index}`,
    }));
    await expect(stageClassroomAlarmTransaction(
      "trusted-start",
      tooMany,
      START + 1,
      mapStorage(),
    )).rejects.toThrow(/invalid/);
  });

  it("preserves a transaction across unrelated legacy writes and rejects orphaning edits", async () => {
    const stagedJob = job({ id: "legacy-staged:timer", ownerId: "legacy-staged" });
    const unrelated = job({ id: "legacy-other:timer", ownerId: "legacy-other" });
    const storage = mapStorage();
    const staged = await stageRecoveredClassroomAlarmJobs([stagedJob], START + 1, storage);
    const unrelatedWrite = await mutateClassroomAlarmRegistry(
      (registry) => upsertClassroomAlarmJob(registry.jobs, unrelated, START + 1),
      storage,
    );
    expect(unrelatedWrite.status).toBe("persisted");
    expect(unrelatedWrite.registry.stagedTransactions).toHaveLength(1);

    const before = readClassroomAlarmRegistry(storage);
    const orphaning = await mutateClassroomAlarmRegistry(
      (registry) => registry.jobs.filter(({ id }) => id !== stagedJob.id),
      storage,
    );
    expect(orphaning.status).toBe("rolled-back");
    expect(readClassroomAlarmRegistry(storage)).toEqual(before);
    expect(matchStagedClassroomAlarmTransaction(
      staged.registry,
      [stagedJob],
      START + 2,
    )).toEqual(staged.receipt);
  });
});
