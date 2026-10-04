import type { Page, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

type DiagnosticRecord = Record<string, unknown>;
type NativeUpdater = Record<"enqueueSetState" | "enqueueForceUpdate", (...args: unknown[]) => unknown>;
type NativeApp = { state: DiagnosticRecord; props?: unknown; updater: NativeUpdater };
type Fiber = {
  type?: unknown;
  elementType?: unknown;
  stateNode?: unknown;
  flags: number;
  return?: Fiber;
  child?: Fiber;
  sibling?: Fiber;
  alternate?: Fiber;
  memoizedState?: unknown;
  memoizedProps?: unknown;
  actualStartTime?: number;
};
type DevToolsHook = { onCommitFiberRoot: (...args: unknown[]) => unknown };
type EditorDiagnostics = {
  startedAt: number;
  updates: DiagnosticRecord[];
  commits: DiagnosticRecord[];
  keys: DiagnosticRecord[];
  failures: DiagnosticRecord[];
  updateCount: number;
  commitCount: number;
  observerError?: string;
  firstFailure?: DiagnosticRecord;
};
type DiagnosticWindow = Window & {
  h?: { app?: NativeApp };
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook;
  __patterdrawEditorDiagnostics?: EditorDiagnostics;
};

/** Opt-in disposable test observation; no listeners dispatch input or update editor state. */
export async function installEditorUpdateDiagnostics(page: Page): Promise<void> {
  if (process.env.PATTERDRAW_PDF_UPDATE_DIAGNOSTICS !== "1") return;
  await page.evaluate(() => {
    const host = window as DiagnosticWindow;
    const app = host.h?.app;
    const hook = host.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!app || !hook || typeof hook.onCommitFiberRoot !== "function") {
      throw new Error("The mounted development editor and existing React observer are required.");
    }
    const monitor: EditorDiagnostics = host.__patterdrawEditorDiagnostics = {
      startedAt: performance.now(), updates: [], commits: [], keys: [], failures: [], updateCount: 0, commitCount: 0,
    };
    const bounded = (array: DiagnosticRecord[], value: DiagnosticRecord) => {
      array.push(value);
      if (array.length > 250) array.shift();
    };
    const record = (value: unknown): DiagnosticRecord => (
      value && typeof value === "object" ? value as DiagnosticRecord : {}
    );
    const changed = (a: unknown, b: unknown) => {
      const before = record(a);
      const after = record(b);
      return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((key) => before[key] !== after[key]);
    };
    const identities = new WeakMap<object, number>();
    let nextIdentity = 1;
    const identity = (value: unknown) => {
      if (!value || typeof value !== "object") return null;
      if (!identities.has(value)) identities.set(value, nextIdentity++);
      return identities.get(value);
    };
    const nameOf = (value: unknown, depth = 0): string | null => {
      if (!value || depth > 4) return null;
      const component = value as { displayName?: unknown; name?: unknown; type?: unknown; render?: unknown };
      if (typeof component.displayName === "string") return component.displayName;
      if (typeof component.name === "string") return component.name;
      return nameOf(component.type, depth + 1) || nameOf(component.render, depth + 1);
    };
    window.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      bounded(monitor.keys, {
        at: performance.now(), eventTimeStamp: event.timeStamp, key: event.key,
        repeat: event.repeat, defaultPrevented: event.defaultPrevented,
        hydrationGuard: Boolean(document.querySelector('[data-testid="scene-hydration-input-guard"]')),
        pageStatus: document.querySelector(".page-status")?.textContent,
      });
    }, true);
    const updater = app.updater;
    for (const operation of ["enqueueSetState", "enqueueForceUpdate"] as const) {
      const original = updater[operation];
      updater[operation] = function (this: NativeUpdater, ...args: unknown[]) {
        if (args[0] === app) {
          const payload = args[1];
          monitor.updateCount += 1;
          bounded(monitor.updates, {
            at: performance.now(), operation,
            keys: typeof payload === "function" ? ["<functional updater>"] : Object.keys(record(payload)),
            state: {
              openMenu: app.state.openMenu, openSidebar: app.state.openSidebar,
              isLoading: app.state.isLoading, activeTool: record(app.state.activeTool).type,
              showWelcomeScreen: app.state.showWelcomeScreen,
              width: app.state.width, height: app.state.height,
              offsetLeft: app.state.offsetLeft, offsetTop: app.state.offsetTop,
            },
            stack: new Error().stack?.split("\n").slice(1, 10).join("\n"),
          });
        }
        return original.apply(this, args);
      };
    }
    const originalCommit = hook.onCommitFiberRoot;
    let previousNativeState: unknown = app.state;
    let previousNativeProps: unknown = app.props;
    let previousHostProject: unknown;
    let previousHydrationRevision: unknown;
    let hasHostObservation = false;
    hook.onCommitFiberRoot = function (this: DevToolsHook, ...args: unknown[]) {
      const result = originalCommit.apply(this, args);
      try {
        const root = args[1] as { current: Fiber };
        const pending = [root.current];
        const fiberObservations: DiagnosticRecord[] = [];
        const row: DiagnosticRecord = { at: performance.now(), native: null, host: null, fiberObservations };
        while (pending.length) {
          const fiber = pending.pop();
          if (!fiber) continue;
          if (fiber.sibling) pending.push(fiber.sibling);
          if (fiber.child) pending.push(fiber.child);
          const name = nameOf(fiber.type) || nameOf(fiber.elementType);
          if ((fiber.flags & 1) && name && ["In", "MainMenu", "DefaultMainMenu", "DefaultSidebar", "LayerUI", "App", "_App"].includes(name)) {
            let ancestor = fiber.return;
            const ancestry: string[] = [];
            while (ancestor && ancestry.length < 5) {
              const ancestorName = nameOf(ancestor.type) || nameOf(ancestor.elementType);
              if (ancestorName) ancestry.push(ancestorName);
              ancestor = ancestor.return;
            }
            // Flags and alternate deltas can survive a bailout. These are
            // observations, not a claim that each fiber rendered this commit.
            fiberObservations.push({
              name, performedWorkFlag: Boolean(fiber.flags & 1),
              fiberIdentity: identity(fiber), alternateIdentity: identity(fiber.alternate),
              propsIdentity: identity(fiber.memoizedProps), childrenIdentity: identity(record(fiber.memoizedProps).children),
              actualStartTime: fiber.actualStartTime,
              hasAlternate: Boolean(fiber.alternate), ancestry,
            });
          }
          if (fiber.stateNode === app) {
            row.native = {
              performedWorkFlag: Boolean(fiber.flags & 1),
              stateChangesSinceLastCommit: changed(previousNativeState, fiber.memoizedState),
              propsChangesSinceLastCommit: changed(previousNativeProps, fiber.memoizedProps),
              stateIdentity: identity(fiber.memoizedState),
            };
            previousNativeState = fiber.memoizedState;
            previousNativeProps = fiber.memoizedProps;
          }
          if (name === "App" && !fiber.stateNode) {
            // The wrapper's first two useState hooks are project and hydration revision.
            const hooks = record(fiber.memoizedState);
            const project = record(hooks.memoizedState);
            const previous = record(previousHostProject);
            row.host = {
              performedWorkFlag: Boolean(fiber.flags & 1), firstObservation: !hasHostObservation,
              projectIdentity: identity(hooks.memoizedState),
              previousProjectIdentity: identity(previousHostProject),
              activeSceneId: project.activeSceneId, previousActiveSceneId: previous.activeSceneId,
              hydrationRevision: record(hooks.next).memoizedState,
              previousHydrationRevision,
            };
            previousHostProject = hooks.memoizedState;
            previousHydrationRevision = record(hooks.next).memoizedState;
            hasHostObservation = true;
          }
        }
        monitor.commitCount += 1;
        bounded(monitor.commits, row);
      } catch (error) { monitor.observerError = String(error); }
      return result;
    };
    const snapshotFirstFailure = () => {
      monitor.firstFailure ||= {
        at: performance.now(), updates: monitor.updates.slice(), commits: monitor.commits.slice(),
        keys: monitor.keys.slice(), updateCount: monitor.updateCount, commitCount: monitor.commitCount,
      };
    };
    const originalError = console.error;
    console.error = function (this: Console, ...args: unknown[]) {
      if (args.some((value) => typeof value === "string" && value.includes("Maximum update depth"))) snapshotFirstFailure();
      return originalError.apply(this, args);
    };
    window.addEventListener("error", (event) => {
      if (event.target instanceof Element) return;
      if (event.message.includes("Maximum update depth")) snapshotFirstFailure();
      bounded(monitor.failures, {
        at: performance.now(), message: event.message,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      });
    });
  });
}

export async function retainEditorUpdateDiagnostics(page: Page, testInfo: TestInfo): Promise<void> {
  if (process.env.PATTERDRAW_PDF_UPDATE_DIAGNOSTICS !== "1") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const monitor = await Promise.race([
      page.evaluate(() => (window as DiagnosticWindow).__patterdrawEditorDiagnostics || null)
        .catch((error) => ({ unavailable: String(error) })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ unavailable: "diagnostic read timed out" }), 2_000); }),
    ]);
    const path = testInfo.outputPath("editor-update-diagnostics.json");
    await writeFile(path, JSON.stringify({ title: testInfo.title, status: testInfo.status, retry: testInfo.retry, monitor }, null, 2) + "\n");
    await testInfo.attach("editor-update-diagnostics.json", { contentType: "application/json", path });
  } catch (error) {
    // Diagnostic collection must never replace a failing test's original assertion.
    console.debug("Editor update diagnostics unavailable: " + String(error));
  } finally { if (timer) clearTimeout(timer); }
}
