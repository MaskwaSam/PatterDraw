import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type SaveStatus = "saved" | "saving" | "error";

export function useAutosaveStatus() {
  const [status, dispatch] = useState<SaveStatus>("saving");
  const requested = useRef<SaveStatus>("saving");
  const committed = useRef<SaveStatus>("saving");
  useLayoutEffect(() => { committed.current = status; }, [status]);
  const publish = useCallback((next: SaveStatus) => {
    // Same-value dispatches from autosave's layout effect can replay pending
    // project updates indefinitely. Preserve ordering against queued statuses,
    // and still promote a pending status when the visible value differs.
    if (requested.current === next && committed.current === next) return;
    requested.current = next;
    dispatch(next);
  }, []);
  return [status, publish] as const;
}
