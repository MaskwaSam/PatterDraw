import { ALARM_TONES, type ClassroomAlarmTone } from "./types";

export type ClassroomAlarmPlaybackStatus = "played" | "muted" | "unavailable" | "blocked";

export interface ClassroomAlarmPlaybackResult {
  status: ClassroomAlarmPlaybackStatus;
  durationMs: number;
  error?: unknown;
}

export interface ClassroomAlarmPlaybackOptions {
  masterVolume?: number;
  muted?: boolean;
  context?: AudioContext | null;
}

export interface ClassroomAlarmAudioPreparationResult {
  status: "ready" | "unavailable" | "blocked";
  error?: unknown;
}

let sharedAudioContext: AudioContext | null = null;

function createBrowserAudioContext(): AudioContext | null {
  if (sharedAudioContext) return sharedAudioContext;
  try {
    if (typeof window === "undefined") return null;
    const Constructor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return null;
    sharedAudioContext = new Constructor();
    return sharedAudioContext;
  } catch {
    return null;
  }
}

function safeVolume(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.7;
}

/**
 * Call from Start or Test Alarm's trusted user gesture. It silently creates
 * and resumes the shared context so a later deadline does not first request
 * audio activation outside a gesture.
 */
export async function prepareClassroomAlarmAudio(
  context: AudioContext | null = createBrowserAudioContext(),
): Promise<ClassroomAlarmAudioPreparationResult> {
  if (!context || context.state === "closed") return { status: "unavailable" };
  try {
    if (context.state === "suspended") await context.resume();
    return context.state === "running" ? { status: "ready" } : { status: "blocked" };
  } catch (error) {
    return { status: "blocked", error };
  }
}

function envelope(
  context: AudioContext,
  destination: AudioNode,
  frequency: number,
  start: number,
  duration: number,
  peak: number,
  wave: OscillatorType,
): OscillatorNode {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + Math.min(0.025, duration / 4));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
  return oscillator;
}

interface AlarmPatternResult {
  durationMs: number;
  finalOscillator: OscillatorNode;
}

function warmChime(context: AudioContext, destination: AudioNode, start: number): AlarmPatternResult {
  const notes = [523.25, 659.25, 783.99];
  let finalOscillator: OscillatorNode | null = null;
  notes.forEach((frequency, index) => {
    const noteStart = start + index * 0.16;
    const fundamental = envelope(context, destination, frequency, noteStart, 0.95, 0.28, "sine");
    envelope(context, destination, frequency * 2, noteStart, 0.52, 0.055, "sine");
    if (index === notes.length - 1) finalOscillator = fundamental;
  });
  return { durationMs: 1_300, finalOscillator: finalOscillator! };
}

function gentleBell(context: AudioContext, destination: AudioNode, start: number): AlarmPatternResult {
  envelope(context, destination, 587.33, start, 1.65, 0.24, "sine");
  envelope(context, destination, 1_174.66, start, 1.05, 0.08, "sine");
  envelope(context, destination, 1_762, start + 0.012, 0.7, 0.035, "sine");
  const finalOscillator = envelope(context, destination, 880, start + 0.48, 1.2, 0.16, "sine");
  envelope(context, destination, 1_760, start + 0.48, 0.72, 0.045, "sine");
  return { durationMs: 1_800, finalOscillator };
}

function brightMarimba(context: AudioContext, destination: AudioNode, start: number): AlarmPatternResult {
  const notes = [659.25, 783.99, 987.77, 1_318.51];
  notes.forEach((frequency, index) => {
    const noteStart = start + index * 0.12;
    envelope(context, destination, frequency, noteStart, 0.32, 0.26, "triangle");
    envelope(context, destination, frequency * 2, noteStart, 0.16, 0.045, "sine");
  });
  const finalOscillator = envelope(context, destination, 987.77, start + 0.62, 0.46, 0.19, "triangle");
  return { durationMs: 1_150, finalOscillator };
}

export async function playClassroomAlarmTone(
  tone: ClassroomAlarmTone,
  options: ClassroomAlarmPlaybackOptions = {},
): Promise<ClassroomAlarmPlaybackResult> {
  if (!ALARM_TONES.includes(tone)) return { status: "unavailable", durationMs: 0 };
  const volume = safeVolume(options.masterVolume);
  if (options.muted || volume === 0) return { status: "muted", durationMs: 0 };
  const context = options.context === undefined ? createBrowserAudioContext() : options.context;
  if (!context) return { status: "unavailable", durationMs: 0 };

  try {
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") return { status: "blocked", durationMs: 0 };

    const master = context.createGain();
    const start = context.currentTime + 0.025;
    master.gain.setValueAtTime(volume, start);
    master.connect(context.destination);
    const pattern = tone === "warm-chime"
      ? warmChime(context, master, start)
      : tone === "gentle-bell"
        ? gentleBell(context, master, start)
        : brightMarimba(context, master, start);
    pattern.finalOscillator.onended = () => master.disconnect();
    return { status: "played", durationMs: pattern.durationMs };
  } catch (error) {
    return { status: "blocked", durationMs: 0, error };
  }
}

/** Uses the same local path as a real alarm, so settings can safely offer Test Alarm. */
export function testClassroomAlarmTone(
  tone: ClassroomAlarmTone,
  masterVolume: number,
  muted = false,
  context?: AudioContext | null,
): Promise<ClassroomAlarmPlaybackResult> {
  return playClassroomAlarmTone(tone, { masterVolume, muted, context });
}

export function resetSharedClassroomAlarmAudioContextForTests(): void {
  sharedAudioContext = null;
}
