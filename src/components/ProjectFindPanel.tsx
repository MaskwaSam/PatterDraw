import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ClassroomProject } from "../types";
import {
  searchProjectText,
  type ProjectSearchResult,
  type ProjectSearchScope,
} from "../lib/project-search";

export interface ProjectFindPanelProps {
  project: ClassroomProject;
  onActivate: (result: ProjectSearchResult) => void;
  onOpenCanvasSearch: () => void;
}

function scopeLabel(result: ProjectSearchResult): string {
  if (result.scope === "board") return "Board";
  if (result.scope === "slide") {
    const number = result.slideIndex === undefined ? "" : ` ${result.slideIndex + 1}`;
    return `Slide${number}`;
  }
  return "PDF";
}

function contextLabel(result: ProjectSearchResult): string {
  if (result.scope === "board") {
    return result.sceneName || result.contextLabel || "Board";
  }
  if (result.scope === "slide") {
    return result.slideTitle || result.contextLabel || "Slide";
  }
  const document = result.pdfDocumentName || result.contextLabel || result.sceneName || "PDF";
  const page = result.pdfOutputIndex === undefined ? "" : ` · Page ${result.pdfOutputIndex + 1}`;
  const source = result.pdfSourcePageIndex === undefined
    ? ""
    : ` · Source page ${result.pdfSourcePageIndex + 1}`;
  return `${document}${page}${source}`;
}

function buttonLabel(result: ProjectSearchResult): string {
  return `${scopeLabel(result)} · ${contextLabel(result)} · ${result.text}`;
}

function moveResult(
  results: readonly ProjectSearchResult[],
  activeKey: string | null,
  direction: -1 | 1,
): ProjectSearchResult | null {
  if (!results.length) return null;
  const currentIndex = activeKey ? results.findIndex((result) => result.key === activeKey) : -1;
  const nextIndex = currentIndex < 0
    ? direction > 0 ? 0 : results.length - 1
    : (currentIndex + direction + results.length) % results.length;
  return results[nextIndex] || null;
}

/**
 * A semantic, wrapper-owned project search surface. It intentionally does not
 * edit the project: callers decide how to focus the matching Excalidraw text.
 */
export function ProjectFindPanel({
  project,
  onActivate,
  onOpenCanvasSearch,
}: ProjectFindPanelProps) {
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchProjectText(project, query), [project, query]);

  useEffect(() => {
    if (!results.length) {
      setActiveKey(null);
      return;
    }
    setActiveKey((current) => (
      current && results.some((result) => result.key === current)
        ? current
        : results[0].key
    ));
  }, [results]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!activeKey) return;
    resultsRef.current
      ?.querySelector<HTMLElement>(".project-find-result.is-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const activeResult = activeKey
    ? results.find((result) => result.key === activeKey) || null
    : null;

  const activate = (result: ProjectSearchResult | null) => {
    if (!result) return;
    setActiveKey(result.key);
    onActivate(result);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction: -1 | 1 = event.key === "ArrowDown" ? 1 : -1;
      const next = moveResult(results, activeKey, direction);
      if (next) setActiveKey(next.key);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.shiftKey) {
      activate(moveResult(results, activeKey, -1));
      return;
    }
    activate(activeResult || moveResult(results, null, 1));
  };

  const countLabel = `${results.length} result${results.length === 1 ? "" : "s"}`;

  return (
    <section className="project-find-panel" role="region" aria-label="Project Find">
      <div className="project-find-header">
        <div>
          <h2 className="project-find-title">Project Find</h2>
          <p className="project-find-status" role="status" aria-live="polite">
            {countLabel}
          </p>
        </div>
        <button
          className="project-find-canvas-search"
          type="button"
          onClick={onOpenCanvasSearch}
        >
          Search current canvas
        </button>
      </div>
      <label className="project-find-query-label">
        <span className="visually-hidden">Find text across project</span>
        <input
          ref={inputRef}
          className="project-find-query"
          type="search"
          value={query}
          autoFocus
          aria-label="Find text across project"
          aria-controls="project-find-results"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleInputKeyDown}
        />
      </label>
      <div
        ref={resultsRef}
        id="project-find-results"
        className="project-find-results"
        aria-label="Project Find results"
      >
        {results.length ? (
          <ul className="project-find-result-list">
            {results.map((result) => (
              <li key={result.key} className="project-find-result-item">
                <button
                  className={`project-find-result ${result.key === activeKey ? "is-active" : ""}`}
                  type="button"
                  aria-label={buttonLabel(result)}
                  aria-current={result.key === activeKey ? "true" : undefined}
                  onClick={() => activate(result)}
                >
                  <span className={`project-find-result-scope project-find-result-scope-${result.scope as ProjectSearchScope}`}>
                    {scopeLabel(result)}
                  </span>
                  <span className="project-find-result-context">{contextLabel(result)}</span>
                  <span className="project-find-result-text">{result.text}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="project-find-empty">No matching text.</p>
        )}
      </div>
    </section>
  );
}

export default ProjectFindPanel;
