import { describe, expect, it, vi } from "vitest";
import {
  playClassroomAlarmTone,
  prepareClassroomAlarmAudio,
  testClassroomAlarmTone,
} from "./audio";

function fakeAudioContext(state: AudioContextState = "running", rejectResume = false) {
  const oscillators: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  const gains: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  const context = {
    state,
    currentTime: 4,
    destination: {},
    resume: vi.fn(async () => {
      if (rejectResume) throw new Error("autoplay");
      context.state = "running";
    }),
    createOscillator: vi.fn(() => {
      const oscillator = {
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      };
      oscillators.push(oscillator);
      return oscillator;
    }),
    createGain: vi.fn(() => {
      const gain = {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
  };
  return { context: context as unknown as AudioContext, oscillators, gains };
}

describe("local classroom alarm audio", () => {
  it("silently prepares audio during a trusted Start/Test gesture", async () => {
    const { context, oscillators } = fakeAudioContext("suspended");
    await expect(prepareClassroomAlarmAudio(context)).resolves.toEqual({ status: "ready" });
    expect(context.resume).toHaveBeenCalledOnce();
    expect(oscillators).toEqual([]);
  });

  it("reports a blocked silent preparation without producing audio", async () => {
    const { context, oscillators } = fakeAudioContext("suspended", true);
    const result = await prepareClassroomAlarmAudio(context);
    expect(result.status).toBe("blocked");
    expect(result.error).toBeInstanceOf(Error);
    expect(oscillators).toEqual([]);
  });

  it.each([
    ["warm-chime", 6],
    ["gentle-bell", 5],
    ["bright-marimba", 9],
  ] as const)("synthesizes %s locally", async (tone, oscillatorCount) => {
    const { context, oscillators } = fakeAudioContext();
    const result = await playClassroomAlarmTone(tone, { context, masterVolume: 0.5 });
    expect(result.status).toBe("played");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(oscillators).toHaveLength(oscillatorCount);
    expect(oscillators.every((oscillator) => oscillator.start.mock.calls.length === 1)).toBe(true);
  });

  it("does not create sound while muted or at zero volume", async () => {
    const { context, oscillators } = fakeAudioContext();
    expect(await playClassroomAlarmTone("warm-chime", { context, muted: true })).toEqual({
      status: "muted",
      durationMs: 0,
    });
    expect(await playClassroomAlarmTone("warm-chime", { context, masterVolume: 0 })).toEqual({
      status: "muted",
      durationMs: 0,
    });
    expect(oscillators).toHaveLength(0);
  });

  it("reports autoplay blocking so the UI can offer Enable sound", async () => {
    const { context } = fakeAudioContext("suspended", true);
    const result = await playClassroomAlarmTone("gentle-bell", { context });
    expect(result.status).toBe("blocked");
    expect(result.error).toBeInstanceOf(Error);
  });

  it("routes Test Alarm through the same synthesizer", async () => {
    const { context, oscillators } = fakeAudioContext();
    expect(await testClassroomAlarmTone("bright-marimba", 0.8, false, context)).toMatchObject({ status: "played" });
    expect(oscillators.length).toBeGreaterThan(0);
  });

  it("disconnects the master graph after the final oscillator ends", async () => {
    const { context, oscillators, gains } = fakeAudioContext();
    await playClassroomAlarmTone("warm-chime", { context });
    const master = gains[0];
    expect(master.disconnect).not.toHaveBeenCalled();
    [...oscillators].reverse().find((oscillator) => oscillator.onended !== null)?.onended?.();
    expect(master.disconnect).toHaveBeenCalledOnce();
  });
});
