import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  MATH_TOOL_CATALOGUE,
  MATH_TOOL_CATEGORIES,
  mathToolPreview,
  mathToolsForCategory,
  type MathInteractionKind,
  type MathToolDefinition,
} from "../lib/math-tools/catalogue";
import type {
  GeneratedMathToolInsertion,
  MathToolCategory,
  MathToolConfiguration,
} from "../lib/math-tools/types";
import {
  persistExperimentalFeaturesPreference,
  readExperimentalFeaturesPreference,
  subscribeToExperimentalFeaturesPreference,
} from "../lib/experimental-features";
import { useModalDialog } from "./useModalDialog";

interface MathToolsDialogProps {
  initialConfiguration?: MathToolConfiguration | null;
  onCancel: () => void;
  onOpenGeoGon: () => void;
  onInsert: (tool: GeneratedMathToolInsertion) => void;
  onStartInteraction: (kind: MathInteractionKind) => void;
}

interface MathToolConfigurationFormProps {
  configuration: MathToolConfiguration;
  error: string | null;
  generated: GeneratedMathToolInsertion | null;
  title: string;
  updating: boolean;
  onBack: () => void;
  onChange: (configuration: MathToolConfiguration) => void;
  onInsert: () => void;
}

const BASELINE_MATH_TOOL_IDS = new Set(["ruler", "protractor"]);

function numericValue(value: number): number | "" {
  return Number.isFinite(value) ? value : "";
}

function MathToolConfigurationForm({
  configuration,
  error,
  generated,
  title,
  updating,
  onBack,
  onChange,
  onInsert,
}: MathToolConfigurationFormProps) {
  const previewAsset = generated ? ("pieces" in generated ? generated.pieces[0]?.asset : generated.asset) : null;
  return (
    <div className="math-tool-config" data-testid={`math-tool-config-${configuration.kind}`}>
      <div className="math-tool-config-heading">
        <button type="button" className="math-tool-back" onClick={onBack}>← All tools</button>
        <h3>{title}</h3>
      </div>

      {configuration.kind === "set-square" ? (
        <label>Triangle
          <select value={configuration.variant} onChange={(event) => onChange({ ...configuration, variant: event.target.value as typeof configuration.variant })}>
            <option value="45-45-90">45-45-90</option>
            <option value="30-60-90">30-60-90</option>
          </select>
        </label>
      ) : null}

      {configuration.kind === "cartesian-plane" ? (
        <>
          <div className="math-tool-form-grid">
            <label>x minimum<input type="number" value={numericValue(configuration.xMin)} onChange={(event) => onChange({ ...configuration, xMin: event.target.valueAsNumber })} /></label>
            <label>x maximum<input type="number" value={numericValue(configuration.xMax)} onChange={(event) => onChange({ ...configuration, xMax: event.target.valueAsNumber })} /></label>
            <label>y minimum<input type="number" value={numericValue(configuration.yMin)} onChange={(event) => onChange({ ...configuration, yMin: event.target.valueAsNumber })} /></label>
            <label>y maximum<input type="number" value={numericValue(configuration.yMax)} onChange={(event) => onChange({ ...configuration, yMax: event.target.valueAsNumber })} /></label>
            <label>Major step<input type="number" min="0.01" max="10" step="any" value={numericValue(configuration.majorStep)} onChange={(event) => onChange({ ...configuration, majorStep: event.target.valueAsNumber })} /></label>
            <label>Minor divisions<input type="number" min="1" max="5" step="1" value={numericValue(configuration.minorDivisions)} onChange={(event) => onChange({ ...configuration, minorDivisions: event.target.valueAsNumber })} /></label>
            <label>x-axis label<input type="text" maxLength={12} value={configuration.xLabel} onChange={(event) => onChange({ ...configuration, xLabel: event.target.value })} /></label>
            <label>y-axis label<input type="text" maxLength={12} value={configuration.yLabel} onChange={(event) => onChange({ ...configuration, yLabel: event.target.value })} /></label>
          </div>
          <div className="math-tool-checks">
            <label><input type="checkbox" checked={configuration.showGrid} onChange={(event) => onChange({ ...configuration, showGrid: event.target.checked })} /> Grid</label>
            <label><input type="checkbox" checked={configuration.showAxes} onChange={(event) => onChange({ ...configuration, showAxes: event.target.checked })} /> Axes</label>
            <label><input type="checkbox" checked={configuration.showNumbers} onChange={(event) => onChange({ ...configuration, showNumbers: event.target.checked })} /> Numbers</label>
            <label><input type="checkbox" checked={configuration.showQuadrantLabels} onChange={(event) => onChange({ ...configuration, showQuadrantLabels: event.target.checked })} /> Quadrant labels</label>
          </div>
        </>
      ) : null}

      {configuration.kind === "number-line" ? (
        <>
          <div className="math-tool-form-grid">
            <label>Minimum<input type="number" value={numericValue(configuration.minimum)} onChange={(event) => onChange({ ...configuration, minimum: event.target.valueAsNumber })} /></label>
            <label>Maximum<input type="number" value={numericValue(configuration.maximum)} onChange={(event) => onChange({ ...configuration, maximum: event.target.valueAsNumber })} /></label>
            <label>Major step<input type="number" min="0.01" step="any" value={numericValue(configuration.majorStep)} onChange={(event) => onChange({ ...configuration, majorStep: event.target.valueAsNumber })} /></label>
            <label>Minor divisions<input type="number" min="1" max="10" step="1" value={numericValue(configuration.minorDivisions)} onChange={(event) => onChange({ ...configuration, minorDivisions: event.target.valueAsNumber })} /></label>
            <label>Label format
              <select value={configuration.labelFormat} onChange={(event) => onChange({ ...configuration, labelFormat: event.target.value as typeof configuration.labelFormat })}>
                <option value="integer">Integer</option><option value="decimal">Decimal</option><option value="fraction">Fraction</option>
              </select>
            </label>
            <label>Endpoint arrows
              <select value={configuration.arrowMode} onChange={(event) => onChange({ ...configuration, arrowMode: event.target.value as typeof configuration.arrowMode })}>
                <option value="both">Both</option><option value="left">Left</option><option value="right">Right</option><option value="none">None</option>
              </select>
            </label>
            <label className="math-tool-wide-field">Optional label<input type="text" maxLength={24} value={configuration.axisLabel} onChange={(event) => onChange({ ...configuration, axisLabel: event.target.value })} /></label>
          </div>
        </>
      ) : null}

      {configuration.kind === "unit-circle" ? (
        <div className="math-tool-form-grid">
          <label>Angle labels
            <select value={configuration.labelMode} onChange={(event) => onChange({ ...configuration, labelMode: event.target.value as typeof configuration.labelMode })}>
              <option value="both">Degrees and radians</option><option value="degrees">Degrees</option><option value="radians">Radians</option>
            </select>
          </label>
          <label className="math-tool-checkbox-field"><input type="checkbox" checked={configuration.showCoordinates} onChange={(event) => onChange({ ...configuration, showCoordinates: event.target.checked })} /> Show exact coordinates</label>
        </div>
      ) : null}

      {configuration.kind === "grid" ? (
        <label>Grid type
          <select value={configuration.variant} onChange={(event) => onChange({ ...configuration, variant: event.target.value as typeof configuration.variant })}>
            <option value="square">Square</option><option value="isometric">Isometric</option><option value="dot">Dot</option><option value="polar">Polar</option>
          </select>
        </label>
      ) : null}

      {configuration.kind === "function-plot" ? (
        <>
          <div className="math-tool-form-grid">
            <label className="math-tool-wide-field">Function y =
              <input type="text" maxLength={160} value={configuration.expression} onChange={(event) => onChange({ ...configuration, expression: event.target.value })} placeholder="x^2 - 4" />
            </label>
            <label>x minimum<input type="number" value={numericValue(configuration.xMin)} onChange={(event) => onChange({ ...configuration, xMin: event.target.valueAsNumber })} /></label>
            <label>x maximum<input type="number" value={numericValue(configuration.xMax)} onChange={(event) => onChange({ ...configuration, xMax: event.target.valueAsNumber })} /></label>
            <label>y minimum<input type="number" value={numericValue(configuration.yMin)} onChange={(event) => onChange({ ...configuration, yMin: event.target.valueAsNumber })} /></label>
            <label>y maximum<input type="number" value={numericValue(configuration.yMax)} onChange={(event) => onChange({ ...configuration, yMax: event.target.valueAsNumber })} /></label>
          </div>
          <p className="math-tool-form-help">Allowed: x, pi, e, + − × ÷ ^, parentheses, sin, cos, tan, abs, sqrt, ln, and exp.</p>
          <div className="math-tool-checks">
            <label><input type="checkbox" checked={configuration.showGrid} onChange={(event) => onChange({ ...configuration, showGrid: event.target.checked })} /> Grid</label>
            <label><input type="checkbox" checked={configuration.showAxes} onChange={(event) => onChange({ ...configuration, showAxes: event.target.checked })} /> Axes</label>
          </div>
        </>
      ) : null}

      {configuration.kind === "fraction-piece" ? (
        <div className="math-tool-form-grid">
          <label>Representation
            <select value={configuration.representation} onChange={(event) => onChange({ ...configuration, representation: event.target.value as typeof configuration.representation })}>
              <option value="bar">Fraction bars</option><option value="circle">Fraction circles</option>
            </select>
          </label>
          <label>Maximum denominator<input type="number" min="2" max="8" step="1" value={numericValue(configuration.maximumDenominator)} onChange={(event) => onChange({ ...configuration, maximumDenominator: event.target.valueAsNumber })} /></label>
        </div>
      ) : null}

      {configuration.kind === "algebra-tile" ? (
        <div className="math-tool-form-grid">
          <label>Positive units<input type="number" min="0" max="10" step="1" value={numericValue(configuration.positiveUnits)} onChange={(event) => onChange({ ...configuration, positiveUnits: event.target.valueAsNumber })} /></label>
          <label>Negative units<input type="number" min="0" max="10" step="1" value={numericValue(configuration.negativeUnits)} onChange={(event) => onChange({ ...configuration, negativeUnits: event.target.valueAsNumber })} /></label>
          <label>Positive x tiles<input type="number" min="0" max="10" step="1" value={numericValue(configuration.positiveX)} onChange={(event) => onChange({ ...configuration, positiveX: event.target.valueAsNumber })} /></label>
          <label>Negative x tiles<input type="number" min="0" max="10" step="1" value={numericValue(configuration.negativeX)} onChange={(event) => onChange({ ...configuration, negativeX: event.target.valueAsNumber })} /></label>
          <label>Positive x² tiles<input type="number" min="0" max="10" step="1" value={numericValue(configuration.positiveXSquared)} onChange={(event) => onChange({ ...configuration, positiveXSquared: event.target.valueAsNumber })} /></label>
          <label>Negative x² tiles<input type="number" min="0" max="10" step="1" value={numericValue(configuration.negativeXSquared)} onChange={(event) => onChange({ ...configuration, negativeXSquared: event.target.valueAsNumber })} /></label>
        </div>
      ) : null}

      {configuration.kind === "integer-chip" ? (
        <div className="math-tool-form-grid">
          <label>Positive chips<input type="number" min="0" max="10" step="1" value={numericValue(configuration.positiveCount)} onChange={(event) => onChange({ ...configuration, positiveCount: event.target.valueAsNumber })} /></label>
          <label>Negative chips<input type="number" min="0" max="10" step="1" value={numericValue(configuration.negativeCount)} onChange={(event) => onChange({ ...configuration, negativeCount: event.target.valueAsNumber })} /></label>
        </div>
      ) : null}

      {configuration.kind === "probability-piece" ? (
        <div className="math-tool-checks math-tool-probability-checks">
          <label><input type="checkbox" checked={configuration.includeDice} onChange={(event) => onChange({ ...configuration, includeDice: event.target.checked })} /> Six die faces</label>
          <label><input type="checkbox" checked={configuration.includeCoins} onChange={(event) => onChange({ ...configuration, includeCoins: event.target.checked })} /> Heads and tails</label>
          <label><input type="checkbox" checked={configuration.includeSpinner} onChange={(event) => onChange({ ...configuration, includeSpinner: event.target.checked })} /> Eight-sector spinner</label>
          <label><input type="checkbox" checked={configuration.includeCards} onChange={(event) => onChange({ ...configuration, includeCards: event.target.checked })} /> Cards 1–10</label>
        </div>
      ) : null}

      <div className="math-tool-config-preview" aria-live="polite">
        {previewAsset ? <img src={previewAsset.dataUrl} alt={`${title} preview`} /> : <p>Correct the settings to preview this tool.</p>}
      </div>
      {error ? <p className="math-tool-error" role="alert">{error}</p> : null}
      <div className="math-tool-config-actions">
        <button type="button" className="dialog-cancel" onClick={onBack}>Cancel</button>
        <button type="button" className="primary-button" disabled={!generated} onClick={onInsert}>{updating ? "Update" : "Insert"}</button>
      </div>
    </div>
  );
}

function initialConfigurations(initialConfiguration?: MathToolConfiguration | null): Record<string, MathToolConfiguration> {
  const configurations = Object.fromEntries(MATH_TOOL_CATALOGUE.map((definition) => [definition.id, { ...definition.defaultConfiguration }])) as Record<string, MathToolConfiguration>;
  const definition = initialConfiguration
    ? MATH_TOOL_CATALOGUE.find((candidate) => candidate.kind === initialConfiguration.kind)
    : null;
  if (definition && initialConfiguration) configurations[definition.id] = { ...initialConfiguration };
  return configurations;
}

export function MathToolsDialog({
  initialConfiguration,
  onCancel,
  onOpenGeoGon,
  onInsert,
  onStartInteraction,
}: MathToolsDialogProps) {
  const dialogRef = useModalDialog<HTMLElement>({
    onClose: onCancel,
    restoreFocus: false,
  });
  const [experimentalFeaturesEnabled, setExperimentalFeaturesEnabled] = useState(readExperimentalFeaturesPreference);
  const autofocusGeoGon = useRef(experimentalFeaturesEnabled).current;
  const initialDefinition = initialConfiguration
    ? MATH_TOOL_CATALOGUE.find((candidate) => candidate.kind === initialConfiguration.kind) || null
    : null;
  const initialDefinitionIsVisible = !initialDefinition || BASELINE_MATH_TOOL_IDS.has(initialDefinition.id) || experimentalFeaturesEnabled;
  const [category, setCategory] = useState<MathToolCategory>(initialDefinitionIsVisible ? initialDefinition?.category || "instruments" : "instruments");
  const [configurations, setConfigurations] = useState(() => initialConfigurations(initialConfiguration));
  const [editingId, setEditingId] = useState<string | null>(initialDefinitionIsVisible ? initialDefinition?.id || null : null);
  const editingDefinition = editingId ? MATH_TOOL_CATALOGUE.find((definition) => definition.id === editingId) || null : null;
  const configuration = editingDefinition ? configurations[editingDefinition.id] : null;

  const generatedPreview = useMemo(() => {
    if (!editingDefinition || !configuration) return { tool: null, error: null };
    try {
      return { tool: editingDefinition.generate(configuration), error: null };
    } catch (error) {
      return { tool: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [configuration, editingDefinition]);

  useEffect(() => {
    return subscribeToExperimentalFeaturesPreference(setExperimentalFeaturesEnabled);
  }, []);

  const changeCategory = (next: MathToolCategory) => {
    setCategory(next);
    setEditingId(null);
    window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>(`[data-testid="math-tool-${next}-tab"]`)?.focus());
  };

  const handleCategoryKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, current: MathToolCategory) => {
    const index = MATH_TOOL_CATEGORIES.findIndex((candidate) => candidate.id === current);
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % MATH_TOOL_CATEGORIES.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + MATH_TOOL_CATEGORIES.length) % MATH_TOOL_CATEGORIES.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = MATH_TOOL_CATEGORIES.length - 1;
    else return;
    event.preventDefault();
    changeCategory(MATH_TOOL_CATEGORIES[nextIndex].id);
  };

  const chooseTool = (definition: MathToolDefinition) => {
    if (definition.interaction) {
      onStartInteraction(definition.interaction);
      return;
    }
    if (definition.configurable) {
      setEditingId(definition.id);
      return;
    }
    onInsert(definition.generate(configurations[definition.id]));
  };

  const toggleExperimentalFeatures = (enabled: boolean) => {
    setExperimentalFeaturesEnabled(enabled);
    persistExperimentalFeaturesPreference(enabled);
    if (!enabled) {
      setCategory("instruments");
      setEditingId(null);
    } else if (initialDefinition && !BASELINE_MATH_TOOL_IDS.has(initialDefinition.id)) {
      setCategory(initialDefinition.category);
      setEditingId(initialDefinition.id);
    }
  };

  const tools = experimentalFeaturesEnabled
    ? mathToolsForCategory(category)
    : mathToolsForCategory("instruments").filter((definition) => BASELINE_MATH_TOOL_IDS.has(definition.id));

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="math-tools-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="math-tools-title"
        aria-describedby="math-tools-help"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <span className="dialog-kicker">Advanced classroom tools</span>
            <h2 id="math-tools-title">Math tools</h2>
          </div>
          <button className="dialog-close" type="button" onClick={onCancel} aria-label="Close math tools">×</button>
        </div>
        <p id="math-tools-help" className="math-tools-help">Add local, movable tools to the current board or PDF page.</p>

        <label className="math-tools-experimental-toggle">
          <span>
            <strong>Experimental features</strong>
            <small>Show developing instruments, graphs, manipulatives, and interactive tools.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Experimental features"
            checked={experimentalFeaturesEnabled}
            onChange={(event) => toggleExperimentalFeatures(event.target.checked)}
          />
        </label>

        {editingDefinition && configuration ? (
          <MathToolConfigurationForm
            configuration={configuration}
            error={generatedPreview.error}
            generated={generatedPreview.tool}
            title={editingDefinition.title}
            updating={!!initialConfiguration && editingDefinition.kind === initialConfiguration.kind}
            onBack={() => setEditingId(null)}
            onChange={(next) => setConfigurations((current) => ({ ...current, [editingDefinition.id]: next }))}
            onInsert={() => generatedPreview.tool && onInsert(generatedPreview.tool)}
          />
        ) : (
          <>
            {experimentalFeaturesEnabled ? (
              <div className="math-tool-categories" role="tablist" aria-label="Math tool categories">
                {MATH_TOOL_CATEGORIES.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="tab"
                    aria-selected={category === candidate.id}
                    data-testid={`math-tool-${candidate.id}-tab`}
                    onClick={() => changeCategory(candidate.id)}
                    onKeyDown={(event) => handleCategoryKeyDown(event, candidate.id)}
                  >{candidate.label}</button>
                ))}
              </div>
            ) : null}
            <div className="math-tools-grid" role="region" aria-label={experimentalFeaturesEnabled ? `${MATH_TOOL_CATEGORIES.find((candidate) => candidate.id === category)?.label} tools` : "Ready classroom tools"}>
              {experimentalFeaturesEnabled && category === "instruments" ? (
                <button
                  className="math-tool-card geogon-math-tool-card"
                  type="button"
                  data-testid="math-tool-geogon"
                  autoFocus={autofocusGeoGon}
                  onClick={onOpenGeoGon}
                >
                  <span className="math-tool-card-heading">
                    <strong>3D GeoGon</strong>
                    <span>Local 3D</span>
                  </span>
                  <span className="geogon-math-tool-preview" aria-hidden="true">
                    <svg viewBox="0 0 180 100" role="img">
                      <path d="M48 77 30 35 86 18l49 25 14 42-58 4Z" />
                      <path d="m30 35 61 54m-5-71 5 71m44-46-44 46M48 77l87-34" />
                      <circle cx="30" cy="35" r="4" />
                      <circle cx="86" cy="18" r="4" />
                      <circle cx="135" cy="43" r="4" />
                      <circle cx="149" cy="85" r="4" />
                      <circle cx="91" cy="89" r="4" />
                      <circle cx="48" cy="77" r="4" />
                    </svg>
                  </span>
                  <span>Build a 3D geometry view and insert it as a local vector image.</span>
                </button>
              ) : null}
              {tools.length ? tools.map((definition, index) => {
                const preview = mathToolPreview(definition);
                return (
                  <button
                    key={definition.id}
                    className="math-tool-card"
                    type="button"
                    data-testid={`math-tool-${definition.id}`}
                    autoFocus={category === "instruments" && index === 0 && !experimentalFeaturesEnabled}
                    onClick={() => chooseTool(definition)}
                  >
                    <span className="math-tool-card-heading"><strong>{definition.title}</strong>{definition.configurable ? <span>Configure</span> : null}</span>
                    <img src={preview.dataUrl} alt="" />
                    <span>{definition.description}</span>
                  </button>
                );
              }) : <p className="math-tools-empty">Manipulatives are the next implementation release.</p>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
