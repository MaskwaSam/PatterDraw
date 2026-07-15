import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { createProbabilityKit } from "./manipulatives";
import {
  randomIndex,
  randomizeProbabilityPiece,
  spinnerPointerAngle,
  spinnerPointerAnimationEndAngle,
  summarizeSelectedProbabilityPieces,
} from "./probability-randomizer";
import type { ProbabilityPieceMathToolMetadata } from "./types";

function probabilityMetadata(componentType: "coin" | "die" | "spinner"): ProbabilityPieceMathToolMetadata {
  const kit = createProbabilityKit({
    includeCards: false,
    includeCoins: componentType === "coin",
    includeDice: componentType === "die",
    includeSpinner: componentType === "spinner",
  });
  const metadata = kit.pieces[0].metadata;
  if (metadata.kind !== "probability-piece") throw new Error("Expected probability metadata.");
  return metadata;
}

describe("probability randomizer", () => {
  it("uses rejection sampling for unbiased bounded indexes", () => {
    const values = [0xffff_ffff, 5];
    expect(randomIndex(6, () => values.shift() ?? 0)).toBe(5);
    expect(() => randomIndex(0)).toThrow(/positive/);
    expect(() => randomIndex(2, () => -1)).toThrow(/unsigned/);
  });

  it("regenerates deterministic local die and coin faces while preserving identity metadata", () => {
    const die = probabilityMetadata("die");
    const rolled = randomizeProbabilityPiece(die, () => 4);
    expect(rolled.metadata).toMatchObject({
      componentType: "die",
      faceOrValue: "5",
      pieceIndex: die.pieceIndex,
      setId: die.setId,
    });
    expect(rolled.asset.svg.match(/data-pip/g)).toHaveLength(5);
    expect(rolled.asset.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);

    const coin = probabilityMetadata("coin");
    expect(randomizeProbabilityPiece(coin, () => 0).metadata.faceOrValue).toBe("Heads");
    const tails = randomizeProbabilityPiece(coin, () => 1);
    expect(tails.metadata.faceOrValue).toBe("Tails");
    expect(tails.asset.svg).toContain(">T</text>");
  });

  it("spins an eight-sector spinner to a deterministic local result", () => {
    const spinner = probabilityMetadata("spinner");
    const spun = randomizeProbabilityPiece(spinner, () => 5);
    expect(spun.metadata).toMatchObject({
      componentType: "spinner",
      faceOrValue: "6",
      pieceIndex: spinner.pieceIndex,
      setId: spinner.setId,
      spinnerSectorCount: 8,
    });
    expect(spun.asset.svg).toContain('data-spinner-pointer="6"');
    expect(spun.asset.svg).toContain("showing 6");
    expect(spun.asset.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("calculates forward full-turn pointer-only animation angles", () => {
    expect(spinnerPointerAngle("1-8")).toBe(-90);
    expect(spinnerPointerAngle("1")).toBe(22.5);
    expect(spinnerPointerAngle("8")).toBe(337.5);
    expect(spinnerPointerAnimationEndAngle(-90, 22.5)).toBe(1_462.5);
    expect(spinnerPointerAnimationEndAngle(337.5, 22.5)).toBe(1_822.5);
    expect(() => spinnerPointerAnimationEndAngle(0, Number.NaN)).toThrow(/finite/);
    expect(() => spinnerPointerAnimationEndAngle(0, 90, 0)).toThrow(/turns/);
  });

  it("summarizes only selected, live dice, coins, and spinners", () => {
    const die = probabilityMetadata("die");
    const coin = probabilityMetadata("coin");
    const spinner = probabilityMetadata("spinner");
    const elements = [
      { id: "die", type: "image", isDeleted: false, customData: { classroomMathTool: die } },
      { id: "coin", type: "image", isDeleted: false, customData: { classroomMathTool: coin } },
      { id: "spinner", type: "image", isDeleted: false, customData: { classroomMathTool: spinner } },
      { id: "deleted", type: "image", isDeleted: true, customData: { classroomMathTool: die } },
      { id: "shape", type: "rectangle", isDeleted: false },
    ] as unknown as readonly ExcalidrawElement[];
    expect(summarizeSelectedProbabilityPieces(elements, { die: true, coin: true, spinner: true, deleted: true, shape: true })).toEqual({ dice: 1, coins: 1, spinners: 1 });
    expect(summarizeSelectedProbabilityPieces(elements, { shape: true })).toBeNull();
  });

  it("rejects probability pieces that are not dice, coins, or spinners", () => {
    const card = createProbabilityKit({ includeCards: true, includeCoins: false, includeDice: false, includeSpinner: false }).pieces[0].metadata;
    if (card.kind !== "probability-piece") throw new Error("Expected probability metadata.");
    expect(() => randomizeProbabilityPiece(card)).toThrow(/dice, coins, and spinners/);
  });
});
