import { useCallback, useEffect, useRef, useState } from "react";
import {
  LOCAL_GEOGON_VERSION,
  localGeoGonUrl,
} from "../lib/local-geogon";
import {
  readExperimentalFeaturesPreference,
  subscribeToExperimentalFeaturesPreference,
} from "../lib/experimental-features";
import { useModalDialog } from "./useModalDialog";

const GEOGON_STARTUP_TIMEOUT_MS = 15_000;
const GEOGON_STARTUP_POLL_MS = 50;
const MAX_GEOGON_SVG_TEXT_LENGTH = 8 * 1024 * 1024;

interface GeoGonAppApi {
  buildObjectSvgMarkup: () => string;
  localStateReady?: boolean;
}

interface GeoGonFrameWindow extends Window {
  threeDGeoGonApp?: GeoGonAppApi | null;
}

interface GeoGonDialogProps {
  onCancel: () => void;
  onInsert: (svg: string) => Promise<boolean>;
}

type GeoGonFrameStatus = "loading" | "ready" | "error";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function frameLocationMatches(childWindow: Window, expectedUrl: string): boolean {
  try {
    const expected = new URL(expectedUrl);
    const actual = new URL(childWindow.location.href);
    return actual.origin === expected.origin
      && actual.pathname === expected.pathname
      && actual.search === expected.search;
  } catch {
    return false;
  }
}

function frameApi(
  frame: HTMLIFrameElement,
  expectedUrl: string,
): GeoGonAppApi | null {
  const childWindow = frame.contentWindow as GeoGonFrameWindow | null;
  if (!childWindow || !frameLocationMatches(childWindow, expectedUrl)) return null;
  const api = childWindow.threeDGeoGonApp;
  return api && typeof api.buildObjectSvgMarkup === "function" ? api : null;
}

export function GeoGonDialog({ onCancel, onInsert }: GeoGonDialogProps) {
  const dialogRef = useModalDialog<HTMLElement>({
    onClose: onCancel,
    restoreFocus: false,
  });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadGenerationRef = useRef(0);
  const [frameKey, setFrameKey] = useState(0);
  const [status, setStatus] = useState<GeoGonFrameStatus>("loading");
  const [message, setMessage] = useState("Starting the bundled GeoGon editor…");
  const [inserting, setInserting] = useState(false);

  useEffect(() => {
    if (!readExperimentalFeaturesPreference()) {
      onCancel();
      return undefined;
    }
    return subscribeToExperimentalFeaturesPreference((enabled) => {
      if (!enabled) onCancel();
    });
  }, [onCancel]);

  useEffect(() => () => {
    loadGenerationRef.current += 1;
  }, []);

  const handleFrameLoad = useCallback(async () => {
    const frame = iframeRef.current;
    if (!frame) return;
    const generation = ++loadGenerationRef.current;
    setStatus("loading");
    setMessage("Starting the bundled GeoGon editor…");
    try {
      const childWindow = frame.contentWindow as GeoGonFrameWindow | null;
      const childDocument = frame.contentDocument;
      if (!childWindow || !childDocument || !frameLocationMatches(childWindow, localGeoGonUrl())) {
        throw new Error("The local GeoGon frame could not be verified.");
      }
      if (!childWindow.threeDGeoGonApp) {
        const startButton = childDocument.getElementById("start-btn");
        if (
          !startButton
          || startButton.tagName !== "BUTTON"
          || typeof (startButton as HTMLButtonElement).click !== "function"
        ) {
          throw new Error("The local GeoGon start control is unavailable.");
        }
        (startButton as HTMLButtonElement).click();
      }

      const deadline = Date.now() + GEOGON_STARTUP_TIMEOUT_MS;
      while (generation === loadGenerationRef.current && Date.now() < deadline) {
        const api = frameApi(frame, localGeoGonUrl());
        if (api?.localStateReady) {
          setStatus("ready");
          setMessage("GeoGon is ready. Build a diagram, then insert its vector view.");
          return;
        }
        await delay(GEOGON_STARTUP_POLL_MS);
      }
      if (generation !== loadGenerationRef.current) return;
      throw new Error("GeoGon took too long to start.");
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const retry = useCallback(() => {
    loadGenerationRef.current += 1;
    setFrameKey((current) => current + 1);
    setStatus("loading");
    setMessage("Restarting the bundled GeoGon editor…");
  }, []);

  const insert = useCallback(async () => {
    const frame = iframeRef.current;
    const api = frame ? frameApi(frame, localGeoGonUrl()) : null;
    if (!api || !api.localStateReady) {
      setStatus("error");
      setMessage("GeoGon is not ready to export this diagram.");
      return;
    }
    setInserting(true);
    try {
      const svg = api.buildObjectSvgMarkup();
      if (
        typeof svg !== "string"
        || svg.length === 0
        || svg.length > MAX_GEOGON_SVG_TEXT_LENGTH
      ) {
        throw new Error("GeoGon returned an invalid or oversized vector image.");
      }
      const inserted = await onInsert(svg);
      if (!inserted) {
        setStatus("error");
        setMessage("The GeoGon diagram could not be inserted. Correct the reported image error and try again.");
      }
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setInserting(false);
    }
  }, [onInsert]);

  return (
    <div className="modal-backdrop geogon-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="geogon-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="geogon-dialog-title"
        aria-describedby="geogon-dialog-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading geogon-dialog-heading">
          <div>
            <span className="dialog-kicker">Experimental · bundled locally</span>
            <h2 id="geogon-dialog-title">3D GeoGon</h2>
          </div>
          <button className="dialog-close" type="button" onClick={onCancel} aria-label="Close 3D GeoGon">×</button>
        </div>
        <p id="geogon-dialog-description" className="geogon-dialog-description">
          Build the geometry here, then insert its current true-vector view as a local PatterDraw image.
        </p>

        <div className="geogon-frame-shell" aria-busy={status === "loading"}>
          <iframe
            key={frameKey}
            ref={iframeRef}
            className="geogon-frame"
            src={localGeoGonUrl()}
            title="Bundled 3D GeoGon editor"
            sandbox="allow-scripts allow-same-origin allow-downloads"
            referrerPolicy="no-referrer"
            tabIndex={0}
            onLoad={() => void handleFrameLoad()}
          />
          {status !== "ready" ? (
            <div className={`geogon-frame-state is-${status}`} role={status === "error" ? "alert" : "status"}>
              {status === "loading" ? <span className="spinner" aria-hidden="true" /> : null}
              <p>{message}</p>
              {status === "error" ? <button type="button" onClick={retry}>Try again</button> : null}
            </div>
          ) : null}
        </div>

        <div className="geogon-dialog-actions">
          <span className={`geogon-dialog-status is-${status}`} aria-live="polite">
            GeoGon {LOCAL_GEOGON_VERSION} · {message}
          </span>
          <button className="dialog-cancel" type="button" onClick={onCancel}>Cancel</button>
          <button
            className="primary-button"
            type="button"
            data-testid="geogon-insert"
            disabled={status !== "ready" || inserting}
            onClick={() => void insert()}
          >
            {inserting ? "Inserting…" : "Insert into PatterDraw"}
          </button>
        </div>
      </section>
    </div>
  );
}
