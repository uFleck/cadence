import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SOFT_SPRING } from "../motion";
import { checkForUpdates, download, getSnapshot, restart, startUpdateChecks, subscribe } from "../updater";

/** How long a manual check's result stays on the button. */
const NOTE_MS = 3_000;

/** The release body is one "* commit subject" bullet per line plus a "Full Changelog" link line. */
export function parseNotes(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[*-]\s+/.test(l))
    .map((l) =>
      l
        .replace(/^[*-]\s+/, "")
        .replace(/\s+by @\S+ in \S+$/, "")
        .replace(/\*\*|`/g, "")
        .trim(),
    )
    .filter(Boolean);
}

/** "Update to vX" opens a panel with what changed; downloading starts from its button. */
function Available({ version, notes }: { version: string; notes: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const items = parseNotes(notes);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="upd-wrap" ref={wrap}>
      <button
        type="button"
        className="upd"
        aria-expanded={items.length ? open : undefined}
        onClick={() => (items.length ? setOpen((o) => !o) : void download())}
      >
        <span className="upd-ico">
          <i className="ph ph-arrow-circle-up" aria-hidden="true" />
          <span className="upd-dot" />
        </span>
        {`Update to v${version}`}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="upd-panel"
            role="dialog"
            aria-label={`What's new in v${version}`}
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={SOFT_SPRING}
          >
            <h3>
              <span>What's new</span>
              <b>v{version}</b>
            </h3>
            <ul>
              {items.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
            <div className="upd-foot">
              <button type="button" className="btn btn-ghost sm" onClick={() => setOpen(false)}>
                Later
              </button>
              <button
                type="button"
                className="btn btn-primary sm"
                autoFocus
                onClick={() => {
                  setOpen(false);
                  void download();
                }}
              >
                Update
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}

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
      return <Available version={upd.version} notes={upd.notes} />;
    case "downloading":
      return (
        <button type="button" className="upd" disabled>
          {upd.progress == null ? <i className="ph ph-spinner spin" aria-hidden="true" /> : icon}
          {upd.progress == null ? "Updating" : `Updating ${Math.round(upd.progress * 100)}%`}
        </button>
      );
    case "ready":
      return (
        <span className="upd-wrap" data-tip={busy ? "Wait for the run to finish" : undefined}>
          <button type="button" className="upd ready" disabled={busy} onClick={() => void restart()}>
            {icon}
            Restart to update
          </button>
        </span>
      );
    case "error":
      return (
        <span className="upd-wrap" data-tip={upd.message}>
          <button type="button" className="upd bad" onClick={() => void download()}>
            {icon}
            Update failed
          </button>
        </span>
      );
    default:
      return (
        <button
          type="button"
          className={`upd${note && note !== "Up to date" ? " bad" : ""}`}
          aria-label="Check for updates"
          data-tip={note ? undefined : "Check for updates"}
          onClick={() => void checkNow()}
        >
          {icon}
          {note}
        </button>
      );
  }
}
