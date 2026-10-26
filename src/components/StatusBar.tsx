import { AnimatePresence, motion } from "motion/react";
import { type Overview, type RunPhase, type RunProgress } from "../api";
import { CountUp, EASE } from "../motion";
import { UpdateButton } from "./UpdateButton";
import { ago, when } from "./shared";

const PHASE: Record<RunPhase, string> = {
  ingest: "Reading messages",
  screen: "Screening",
  coach: "Coaching",
  done: "Finished",
  error: "Failed",
};

export function StatusBar({
  overview,
  progress,
  onRunNow,
}: {
  overview: Overview | null;
  progress: RunProgress | null;
  onRunNow: () => void;
}) {
  if (!overview) return <footer className="status" />;
  const { lastRun: run, running } = overview;
  const live = progress && progress.phase !== "done" && progress.phase !== "error" ? progress : null;
  const fraction = live && live.total > 0 ? live.done / live.total : 0;

  return (
    <footer className="status" aria-live="polite">
      <AnimatePresence>
        {running && (
          <motion.span
            key="progress"
            className="status-progress"
            initial={{ scaleX: 0, opacity: 0 }}
            animate={{ scaleX: live ? Math.max(0.04, fraction) : 0.12, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
          />
        )}
      </AnimatePresence>
      <span className="stat">
        <b>
          <CountUp value={overview.queued} />
        </b>
        queued
      </span>
      <span className="stat">
        <b>
          <CountUp value={overview.reviewed} />
        </b>
        reviewed
      </span>
      <span className="stat">
        <b>
          <CountUp value={overview.pending} />
        </b>
        pending
      </span>
      <span className="sep" aria-hidden="true" />
      {running ? (
        <span className="run">
          <i className="ph ph-spinner spin" aria-hidden="true" />
          {live ? `${PHASE[live.phase]} ${live.done} of ${live.total}` : "Run in progress"}
        </span>
      ) : (
        run && (
          <span className={`run${run.ok ? "" : " bad"}`} title={run.detail}>
            <i className={run.ok ? "ph ph-check-circle" : "ph-fill ph-warning"} aria-hidden="true" />
            Last run {run.ok ? "ok" : "failed"}, {ago(run.startedAt)}
          </span>
        )
      )}
      <span className="next">Next run {when(overview.nextRunAt)}</span>
      {import.meta.env.PROD && <UpdateButton busy={running} />}
      <button type="button" className="btn btn-ghost sm" disabled={running} onClick={onRunNow}>
        <i className="ph ph-play" aria-hidden="true" />
        Run now
      </button>
    </footer>
  );
}
