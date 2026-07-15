import type { ProbabilitySelectionSummary } from "../lib/math-tools/probability-randomizer";

interface ProbabilityRandomizerProps {
  isSpinning: boolean;
  onRandomize: () => void | Promise<void>;
  summary: ProbabilitySelectionSummary;
}

function selectedTypeCount({ coins, dice, spinners }: ProbabilitySelectionSummary): number {
  return Number(Boolean(coins)) + Number(Boolean(dice)) + Number(Boolean(spinners));
}

function actionLabel(summary: ProbabilitySelectionSummary): string {
  if (selectedTypeCount(summary) > 1) return "Randomize selected";
  const { coins, dice, spinners } = summary;
  if (dice) return "Roll selected";
  if (coins) return "Flip selected";
  return spinners ? "Spin selected" : "Randomize selected";
}

function selectionLabel({ coins, dice, spinners }: ProbabilitySelectionSummary): string {
  const parts: string[] = [];
  if (dice) parts.push(`${dice} ${dice === 1 ? "die" : "dice"}`);
  if (coins) parts.push(`${coins} ${coins === 1 ? "coin" : "coins"}`);
  if (spinners) parts.push(`${spinners} ${spinners === 1 ? "spinner" : "spinners"}`);
  return `${parts.join(" and ")} selected`;
}

export function ProbabilityRandomizer({ isSpinning, onRandomize, summary }: ProbabilityRandomizerProps) {
  const spinnerOnly = Boolean(summary.spinners) && selectedTypeCount(summary) === 1;
  return (
    <div className="probability-randomizer" role="toolbar" aria-label="Selected probability pieces" aria-busy={isSpinning}>
      <span>{selectionLabel(summary)}</span>
      <button type="button" data-testid="probability-randomize-selected" disabled={isSpinning} onClick={() => void onRandomize()}>
        {spinnerOnly ? (
          <svg className={`probability-spinner-icon${isSpinning ? " is-spinning" : ""}`} aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 12 17 7" />
            <circle cx="12" cy="12" r="1.25" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="4" />
            <circle cx="8" cy="8" r="1.25" />
            <circle cx="16" cy="8" r="1.25" />
            <circle cx="12" cy="12" r="1.25" />
            <circle cx="8" cy="16" r="1.25" />
            <circle cx="16" cy="16" r="1.25" />
          </svg>
        )}
        {isSpinning ? "Spinning…" : actionLabel(summary)}
      </button>
    </div>
  );
}
