import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { inTauri } from "./components/WindowControls";

const FIRST_CHECK_MS = 2_000;
const CHECK_EVERY_MS = 30 * 60 * 1000;

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; progress: number | null }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

let state: UpdateState = { kind: "idle" };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}

/** For `useSyncExternalStore`. */
export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const getSnapshot = () => state;

/** Looks for a new release. A manual check reports its result; a failed one goes back to idle. */
export async function checkForUpdates(): Promise<"available" | "none" | "failed" | "busy"> {
  if (state.kind === "checking" || state.kind === "downloading" || state.kind === "ready") return "busy";
  set({ kind: "checking" });
  try {
    const update = await check();
    if (!update) {
      pending = null;
      set({ kind: "idle" });
      return "none";
    }
    pending = update;
    set({ kind: "available", version: update.version, notes: update.body ?? "" });
    return "available";
  } catch (e) {
    console.warn("update check failed", e);
    set({ kind: "idle" });
    return "failed";
  }
}

/** Downloads the update on offer, reporting progress as it arrives. */
export async function download() {
  const update = pending;
  if (!update) return;
  let total = 0;
  let got = 0;
  set({ kind: "downloading", progress: null });
  try {
    await update.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      if (event.event === "Progress") {
        got += event.data.chunkLength;
        set({ kind: "downloading", progress: total > 0 ? Math.min(got / total, 1) : null });
      }
    });
    set({ kind: "ready", version: update.version });
  } catch (e) {
    set({ kind: "error", message: String(e) });
  }
}

/** Installs the downloaded update and relaunches the app. */
export async function restart() {
  const update = pending;
  if (!update) return;
  try {
    await update.install();
    await relaunch();
  } catch (e) {
    set({ kind: "error", message: String(e) });
  }
}

let started = false;

/** Checks shortly after launch, then every half hour. Only in a packaged app, never in dev or a browser. */
export function startUpdateChecks() {
  if (started || !inTauri || !import.meta.env.PROD) return;
  started = true;
  const tick = () => void checkForUpdates();
  window.setTimeout(() => {
    tick();
    window.setInterval(tick, CHECK_EVERY_MS);
  }, FIRST_CHECK_MS);
}
