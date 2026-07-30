import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { createCoinAsset, createDieAsset, createSpinnerAsset } from "./manipulatives";
import { sanitizeClassroomMathToolMetadata, type ProbabilityPieceMathToolMetadata } from "./types";

export interface ProbabilitySelectionSummary {
  coins: number;
  dice: number;
  spinners: number;
}

type RandomUint32 = () => number;

function secureRandomUint32(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0];
}

export function randomIndex(exclusiveMaximum: number, randomUint32: RandomUint32 = secureRandomUint32): number {
  if (!Number.isInteger(exclusiveMaximum) || exclusiveMaximum < 1 || exclusiveMaximum > 0x1_0000_0000) {
    throw new Error("Random range must be a positive 32-bit integer.");
  }
  const range = 0x1_0000_0000;
  const limit = range - (range % exclusiveMaximum);
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const value = randomUint32();
    if (!Number.isInteger(value) || value < 0 || value >= range) throw new Error("Random source returned an invalid unsigned 32-bit integer.");
    if (value < limit) return value % exclusiveMaximum;
  }
  throw new Error("Random source could not produce an unbiased result.");
}

export function randomizeProbabilityPiece(
  metadata: ProbabilityPieceMathToolMetadata,
  randomUint32?: RandomUint32,
) {
  if (metadata.componentType === "die") {
    const face = randomIndex(6, randomUint32) + 1;
    return {
      asset: createDieAsset(face),
      metadata: { ...metadata, faceOrValue: String(face) },
    };
  }
  if (metadata.componentType === "coin") {
    const side = randomIndex(2, randomUint32) === 0 ? "Heads" : "Tails";
    return {
      asset: createCoinAsset(side),
      metadata: { ...metadata, faceOrValue: side },
    };
  }
  if (metadata.componentType === "spinner") {
    if (metadata.spinnerSectorCount !== 8) throw new Error("Only eight-sector spinners can be spun.");
    const sector = randomIndex(metadata.spinnerSectorCount, randomUint32) + 1;
    return {
      asset: createSpinnerAsset(sector),
      metadata: { ...metadata, faceOrValue: String(sector) },
    };
  }
  throw new Error("Only selected dice, coins, and spinners can be randomized.");
}

export function spinnerPointerAngle(faceOrValue: string): number {
  const sector = Number(faceOrValue);
  return Number.isInteger(sector) && sector >= 1 && sector <= 8
    ? (sector - 0.5) * 45
    : -90;
}

export function spinnerPointerAnimationEndAngle(startAngle: number, targetAngle: number, turns = 4): number {
  if (!Number.isFinite(startAngle) || !Number.isFinite(targetAngle)) throw new Error("Spinner pointer angles must be finite.");
  if (!Number.isInteger(turns) || turns < 1 || turns > 12) throw new Error("Spinner animation turns must be an integer from 1 to 12.");
  const forwardOffset = ((targetAngle - startAngle) % 360 + 360) % 360;
  return startAngle + turns * 360 + forwardOffset;
}

export function summarizeSelectedProbabilityPieces(
  elements: readonly ExcalidrawElement[],
  selectedElementIds: Readonly<Record<string, boolean>>,
): ProbabilitySelectionSummary | null {
  if (!Object.values(selectedElementIds).some(Boolean)) return null;
  let coins = 0;
  let dice = 0;
  let spinners = 0;
  for (const element of elements) {
    if (element.isDeleted || element.type !== "image" || !selectedElementIds[element.id]) continue;
    const metadata = sanitizeClassroomMathToolMetadata(
      (element.customData as { classroomMathTool?: unknown } | undefined)?.classroomMathTool,
    );
    if (metadata?.kind !== "probability-piece") continue;
    if (metadata.componentType === "coin") coins += 1;
    if (metadata.componentType === "die") dice += 1;
    if (metadata.componentType === "spinner") spinners += 1;
  }
  return coins || dice || spinners ? { coins, dice, spinners } : null;
}
