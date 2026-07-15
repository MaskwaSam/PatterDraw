import { describe, expect, it } from "vitest";
import { createAlgebraTileKit, createFractionKit, createIntegerChipKit, createProbabilityKit } from "./manipulatives";

function svgDocument(svg: string): XMLDocument {
  return new DOMParser().parseFromString(svg, "image/svg+xml");
}

describe("multi-piece math manipulatives", () => {
  it("creates complete independently indexed fraction-bar and fraction-circle sets", () => {
    const bars = createFractionKit("bar", 4);
    const circles = createFractionKit("circle", 4);
    expect(bars.pieces).toHaveLength(10);
    expect(circles.pieces).toHaveLength(10);
    expect(new Set(bars.pieces.map((piece) => piece.metadata.kind === "fraction-piece" ? piece.metadata.setId : "invalid")).size).toBe(1);
    expect(bars.pieces.map((piece) => piece.metadata.kind === "fraction-piece" ? piece.metadata.pieceIndex : -1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (let denominator = 1; denominator <= 4; denominator += 1) {
      const matching = bars.pieces.filter((piece) => piece.metadata.kind === "fraction-piece" && piece.metadata.denominator === denominator);
      expect(matching).toHaveLength(denominator);
      expect(matching.reduce((sum, piece) => sum + piece.asset.width, 0)).toBeCloseTo(240, 8);
    }
    expect(circles.pieces.find((piece) => piece.metadata.kind === "fraction-piece" && piece.metadata.denominator === 3)?.asset.svg).toContain("<path");
    expect(bars.pieces.every((piece) => piece.metadata.kind === "fraction-piece" && piece.metadata.wholeSize === 240)).toBe(true);
    expect(circles.pieces.every((piece) => piece.metadata.kind === "fraction-piece" && piece.metadata.wholeSize === 108)).toBe(true);
  });

  it("keeps algebra-tile dimensions, signs, counts, and source metadata consistent", () => {
    const kit = createAlgebraTileKit({ positiveUnits: 2, negativeUnits: 1, positiveX: 2, negativeX: 1, positiveXSquared: 1, negativeXSquared: 1 });
    expect(kit.pieces).toHaveLength(8);
    const units = kit.pieces.filter((piece) => piece.metadata.kind === "algebra-tile" && piece.metadata.tileType === "unit");
    const xTiles = kit.pieces.filter((piece) => piece.metadata.kind === "algebra-tile" && piece.metadata.tileType === "x");
    const squares = kit.pieces.filter((piece) => piece.metadata.kind === "algebra-tile" && piece.metadata.tileType === "x-squared");
    expect(units.every((piece) => piece.asset.width === 46 && piece.asset.height === 46)).toBe(true);
    expect(xTiles.every((piece) => piece.asset.width === 126 && piece.asset.height === 46)).toBe(true);
    expect(squares.every((piece) => piece.asset.width === 126 && piece.asset.height === 126)).toBe(true);
    expect(kit.pieces.filter((piece) => piece.metadata.kind === "algebra-tile" && piece.metadata.sign === "negative")).toHaveLength(3);
    expect(kit.pieces.every((piece) => piece.asset.dataUrl.startsWith("data:image/svg+xml;base64,"))).toBe(true);
    expect(kit.pieces.every((piece) => piece.metadata.kind === "algebra-tile" && piece.metadata.requestedPositiveUnits === 2 && piece.metadata.requestedNegativeXSquared === 1)).toBe(true);
  });

  it("creates equal-size accessible integer chips with the requested signs", () => {
    const kit = createIntegerChipKit(4, 3);
    expect(kit.pieces).toHaveLength(7);
    expect(new Set(kit.pieces.map((piece) => `${piece.asset.width}x${piece.asset.height}`))).toEqual(new Set(["64x64"]));
    expect(kit.pieces.filter((piece) => piece.metadata.kind === "integer-chip" && piece.metadata.sign === "positive")).toHaveLength(4);
    expect(kit.pieces.filter((piece) => piece.metadata.kind === "integer-chip" && piece.metadata.sign === "negative")).toHaveLength(3);
    expect(kit.pieces.find((piece) => piece.metadata.kind === "integer-chip" && piece.metadata.sign === "negative")?.asset.svg).toContain("stroke-dasharray");
  });

  it("creates correct dice, coins, spinner sectors, and unique cards", () => {
    const kit = createProbabilityKit({ includeDice: true, includeCoins: true, includeSpinner: true, includeCards: true });
    expect(kit.pieces).toHaveLength(19);
    const dice = kit.pieces.filter((piece) => piece.metadata.kind === "probability-piece" && piece.metadata.componentType === "die");
    expect(dice).toHaveLength(6);
    dice.forEach((piece, index) => expect(svgDocument(piece.asset.svg).querySelectorAll("[data-pip]")).toHaveLength(index + 1));
    const spinner = kit.pieces.find((piece) => piece.metadata.kind === "probability-piece" && piece.metadata.componentType === "spinner");
    expect(spinner?.metadata.kind === "probability-piece" ? spinner.metadata.spinnerSectorCount : 0).toBe(8);
    expect(spinner ? svgDocument(spinner.asset.svg).querySelectorAll("[data-spinner-sector]") : []).toHaveLength(8);
    const cards = kit.pieces.filter((piece) => piece.metadata.kind === "probability-piece" && piece.metadata.componentType === "card");
    expect(new Set(cards.map((piece) => piece.metadata.kind === "probability-piece" ? piece.metadata.faceOrValue : ""))).toEqual(new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]));
    expect(dice.every((piece) => piece.metadata.kind === "probability-piece" && piece.metadata.componentQuantity === 6)).toBe(true);
    expect(cards.every((piece) => piece.metadata.kind === "probability-piece" && piece.metadata.componentQuantity === 10)).toBe(true);
    const selections = [
      { includeDice: true, includeCoins: false, includeSpinner: false, includeCards: false, count: 6 },
      { includeDice: false, includeCoins: true, includeSpinner: false, includeCards: false, count: 2 },
      { includeDice: false, includeCoins: false, includeSpinner: true, includeCards: false, count: 1 },
      { includeDice: false, includeCoins: false, includeSpinner: false, includeCards: true, count: 10 },
    ];
    for (const { count, ...selection } of selections) expect(createProbabilityKit(selection).pieces).toHaveLength(count);
  });

  it("rejects empty, excessive, fractional, and out-of-range configurations", () => {
    expect(() => createFractionKit("bar", 1)).toThrow(/2 to 8/);
    expect(() => createFractionKit("circle", 9)).toThrow(/2 to 8/);
    expect(() => createAlgebraTileKit({ positiveUnits: 0, negativeUnits: 0, positiveX: 0, negativeX: 0, positiveXSquared: 0, negativeXSquared: 0 })).toThrow(/at least one/);
    expect(() => createIntegerChipKit(1.5, 2)).toThrow(/integer/);
    expect(() => createIntegerChipKit(11, 0)).toThrow(/0 to 10/);
    expect(() => createProbabilityKit({ includeDice: false, includeCoins: false, includeSpinner: false, includeCards: false })).toThrow(/at least one/);
  });

  it("lays out every set deterministically without identical origins", () => {
    const first = createIntegerChipKit(5, 5).pieces.map(({ offsetX, offsetY }) => [offsetX, offsetY]);
    const second = createIntegerChipKit(5, 5).pieces.map(({ offsetX, offsetY }) => [offsetX, offsetY]);
    expect(first).toEqual(second);
    expect(new Set(first.map((point) => point.join(","))).size).toBe(first.length);
    const maximum = createAlgebraTileKit({ positiveUnits: 10, negativeUnits: 10, positiveX: 10, negativeX: 10, positiveXSquared: 10, negativeXSquared: 10 }).pieces;
    expect(maximum).toHaveLength(60);
    expect(new Set(maximum.map((piece) => `${piece.offsetX},${piece.offsetY}`)).size).toBe(maximum.length);
  });
});
