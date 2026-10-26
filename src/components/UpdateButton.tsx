import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { checkForUpdates, download, getSnapshot, restart, startUpdateChecks, subscribe } from "../updater";

/** How long a manual check's result stays on the button. */
const NOTE_MS = 3_000;

/** Status-bar update button: checks for releases, downloads, and restarts into the new version. */
export function UpdateButton({ busy }: { busy: boolean }) {
  const upd = useSyncExternalStore(subscribe, getSnapshot);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    startUpdateChecks();
    return () => window.clearTimeout(noteTimer.current);
  }, []);

  async function checkNow() {
    const result = await checkForUpdates();
    if (result === "available" || result === "busy") return;
    setNote(result === "none" ? "Up to date" : "Update check failed");
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), NOTE_MS);
  }

  const icon = <i className="ph ph-arrow-circle-up" aria-hidden="true" />;
  switch (upd.kind) {
    case "checking":
      return (
        <button type="button" className="upd" disabled aria-label="Checking for updates">
          <i className="ph ph-spinner spin" aria-hidden="true" />
        </button>
      );
    case "available":
      return (
        <button type="button" className="upd" title={upd.notes || undefined} onClick={() => void download()}>
          <span className="upd-ico">
            {icon}
            <span className="upd-dot" />
          </span>
          {`Update to v${upd.version}`}
        </button>
      );
    case "downloading":
      return (
        <button type="button" className="upd" disabled>
          {upd.progress == null ? <i className="ph ph-spinner spin" aria-hidden="true" /> : icon}
          {upd.progress == null ? "Updating" : `Updating ${Math.round(upd.progress * 100)}%`}
        </button>
      );
    case "ready":
      return (
        <button
          type="button"
          className="upd ready"
          disabled={busy}
          title={busy ? "Wait for the run to finish" : undefined}
          onClick={() => void restart()}
        >
          {icon}
          Restart to update
        </button>
      );
    case "error":
      return (
        <button type="button" className="upd bad" title={upd.message} onClick={() => void download()}>
          {icon}
          Update failed
        </button>
      );
    default:
      return (
        <button
          type="button"
          className={`upd${note && note !== "Up to date" ? " bad" : ""}`}
          aria-label="Check for updates"
          title={note ? undefined : "Check for updates"}
          onClick={() => void checkNow()}
        >
          {icon}
          {note}
        </button>
      );
  }
}
