import { AnimatePresence, motion, type Variants } from "motion/react";
import { useState } from "react";
import { api, type Attempt, type Coaching, type Message } from "../api";
import { loadDraft, storeDraft } from "../drafts";
import { EASE, rise, stagger } from "../motion";
import "../styles/messages.css";
import { ago, errorText, IssueChip, Meter, scoreChange, usd, type Notify } from "./shared";

// The "Remember" callout slides in from the side, after the sections above it have landed.
const slideIn: Variants = {
  hidden: { opacity: 0, x: -18 },
  show: { opacity: 1, x: 0, transition: { duration: 0.5, ease: EASE } },
};

const expand = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.38, ease: EASE },
} as const;

const REGISTER_ICON = { casual: "ph-chat-teardrop", professional: "ph-briefcase" } as const;

type CardProps = {
  /** The parent owns the message: the card shows what it is given and reports every change through `onChange`. */
  message: Message;
  notify: Notify;
  /** Called with the message as stored after a version was saved or reviewed, so reopening the card shows it. */
  onChange: (message: Message) => void;
  onReviewed?: () => void;
  /** Called after the message was set aside or put back, so the list can drop or reload it. */
  onExcluded?: () => void;
};

/** What a review cost, at Claude's list prices. Renders nothing for a review saved before costs were tracked. */
function CostChip({ coaching }: { coaching: Coaching }) {
  if (coaching.costUsd === null) return null;
  return (
    <span className="cost-chip" title="What this review cost at Claude's list prices. On a subscription you are not charged this amount.">
      <i className="ph ph-coins" aria-hidden="true" />
      {usd(coaching.costUsd)}
    </span>
  );
}

/** The versions the user already wrote, newest first, each with its score and what the coach said about it. */
function VersionHistory({ attempts, defaultOpen }: { attempts: Attempt[]; defaultOpen: boolean }) {
  if (attempts.length === 0) return null;
  return (
    <details className="versions" open={defaultOpen}>
      <summary>
        <i className="ph ph-clock-counter-clockwise" aria-hidden="true" />
        Earlier versions
        <span className="count-pill">{attempts.length}</span>
      </summary>
      <ol className="ver-list">
        {attempts
          .map((a, i) => ({ a, n: i + 1 }))
          .reverse()
          .map(({ a, n }) => (
            <li key={a.id} className="ver">
              <div className="ver-top">
                <span className="trail-label">Try {n}</span>
                <span className="muted" title={new Date(a.createdAt).toLocaleString()}>
                  {ago(a.createdAt)}
                </span>
                {a.screen && <Meter value={a.screen.naturalness} />}
              </div>
              <p className="attempt-text">{a.text}</p>
              {a.coaching ? (
                <details className="ver-coach">
                  <summary>
                    What the coach said
                    <CostChip coaching={a.coaching} />
                  </summary>
                  <p>{a.coaching.explanation}</p>
                  <ul>
                    {a.coaching.rewrites.map((r, i) => (
                      <li key={i}>
                        <span className={`reg ${r.register}`}>{r.register}</span> {r.text}
                      </li>
                    ))}
                  </ul>
                  <p>
                    <strong>Remember</strong> {a.coaching.tip}
                  </p>
                </details>
              ) : (
                <span className="muted">Not reviewed</span>
              )}
            </li>
          ))}
      </ol>
    </details>
  );
}

export function MessageCard({ message, notify, onChange, onReviewed, onExcluded }: CardProps) {
  const [draft, setDraftText] = useState(() => loadDraft(message.id));
  const [busy, setBusy] = useState(false);
  const [coachError, setCoachError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [marking, setMarking] = useState(false);
  const [settingAside, setSettingAside] = useState(false);
  // A draft left behind on an already reviewed message means the user was in the middle of trying again.
  const [redoing, setRedoing] = useState(() => loadDraft(message.id).trim() !== "");
  const [showRewrites, setShowRewrites] = useState(false);
  const screen = message.screen;
  const attempts = message.attempts;
  const coaching = message.coaching;
  const latest = attempts[attempts.length - 1];

  const setDraft = (text: string) => {
    setDraftText(text);
    storeDraft(message.id, text);
  };
  const refresh = async () => onChange(await api.getMessage(message.id));

  // The original, then every try that was scored, so a rewrite can be compared with where it started.
  const trail = [
    ...(screen ? [{ label: "Original", value: screen.naturalness }] : []),
    ...attempts.flatMap((a, i) => (a.screen ? [{ label: `Try ${i + 1}`, value: a.screen.naturalness }] : [])),
  ];
  const latestScore = latest?.screen?.naturalness;
  const delta = screen && latest?.screen ? scoreChange(screen, latest.screen) : null;

  /** Reviews the latest saved version. Also what Retry runs, since the version is already saved by then. */
  const coach = async (newVersion?: string) => {
    setBusy(true);
    setCoachError(null);
    try {
      if (newVersion) {
        await api.saveAttempt(message.id, newVersion);
        setDraft("");
        // Show the saved version at once: if the review below fails it is still there, with a way to retry.
        await refresh();
      }
      await api.coachMessage(message.id);
      await refresh();
      setShowRewrites(false);
      setRedoing(false);
    } catch (e) {
      setCoachError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const tryAgain = () => {
    setCoachError(null);
    setRedoing(true);
  };

  const copy = async (text: string, i: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      window.setTimeout(() => setCopied(null), 1500);
    } catch (e) {
      notify("Could not copy", errorText(e));
    }
  };

  const setExcluded = async (excluded: boolean) => {
    setSettingAside(true);
    try {
      await api.setExcluded(message.id, excluded);
      onExcluded?.();
    } catch (e) {
      notify(excluded ? "Could not set it aside" : "Could not put it back", errorText(e));
    } finally {
      setSettingAside(false);
    }
  };

  const markReviewed = async () => {
    setMarking(true);
    try {
      await api.markReviewed(message.id, true);
      onReviewed?.();
    } catch (e) {
      notify("Could not mark as reviewed", errorText(e));
    } finally {
      setMarking(false);
    }
  };

  return (
    <motion.article
      className="card"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
    >
      <header className="card-h">
        <span className="card-meta" title={new Date(message.ts).toLocaleString()}>
          {message.project ?? "No project"} · sent {ago(message.ts)}
        </span>
        {screen ? (
          <span className="card-scores">
            <Meter value={screen.naturalness} word />
            <IssueChip issue={screen.issue} />
          </span>
        ) : (
          <span className="muted">Not screened yet</span>
        )}
      </header>

      <figure className="orig">
        <figcaption className="eyebrow">What you wrote</figcaption>
        <blockquote>{message.text}</blockquote>
      </figure>

      <AnimatePresence mode="wait">
        {(!coaching || redoing) && (
          <motion.div
            key="attempt"
            className="attempt"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8, transition: { duration: 0.16 } }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <label htmlFor={`draft-${message.id}`}>{attempts.length > 0 ? "Try it again" : "Say it your way"}</label>
            <textarea
              id={`draft-${message.id}`}
              rows={3}
              value={draft}
              disabled={busy}
              placeholder="Write the message the way you would say it"
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="card-actions">
              <button type="button" className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void coach(draft.trim())}>
                <i className={busy ? "ph ph-spinner spin" : "ph ph-sparkle"} aria-hidden="true" />
                {busy ? "Coaching" : "Show suggestions"}
              </button>
              {redoing && coaching && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setRedoing(false)}>
                  Cancel
                </button>
              )}
            </div>

            {latest && !coaching && !busy && !coachError && (
              <div className="pending-note" role="status">
                <i className="ph ph-clock-countdown" aria-hidden="true" />
                <span>Your last version is saved, but it was not reviewed yet.</span>
                <button type="button" className="btn btn-ghost sm" onClick={() => void coach()}>
                  Review it
                </button>
              </div>
            )}

            <VersionHistory attempts={attempts} defaultOpen />

            <AnimatePresence initial={false}>
              {busy && (
                <motion.div key="wait" className="coach-wait" role="status" {...expand}>
                  <div className="coach-wait-in">
                    <div className="coach-wait-h">
                      <i className="ph-fill ph-sparkle coach-spark" aria-hidden="true" />
                      <span>Finding what to coach</span>
                      <span className="dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                    <span className="skel" aria-hidden="true" />
                    <span className="skel w60" aria-hidden="true" />
                    <span className="muted">This can take 10 to 30 seconds.</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence initial={false}>
              {coachError && (
                <motion.div key="error" className="inline-error" role="alert" {...expand}>
                  <i className="ph ph-warning-circle" aria-hidden="true" />
                  <span>Could not get suggestions: {coachError}</span>
                  <button type="button" className="btn btn-ghost sm" disabled={busy} onClick={() => void coach()}>
                    Retry
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}

        {coaching && !redoing && (
          <motion.div
            key="coaching"
            className="coaching"
            variants={stagger(0.1, 0.05)}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
          >
            <motion.section variants={rise}>
              <div className="sect-h">
                <h3>Your version</h3>
                <button type="button" className="btn btn-ghost sm" onClick={tryAgain}>
                  <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" />
                  Try again
                </button>
              </div>
              {latest ? <p className="attempt-text">{latest.text}</p> : <p className="muted">No attempt saved.</p>}
              {trail.length > 1 && (
                <div className="progress">
                  <ol className="trail" aria-label="Naturalness of each version">
                    {trail.map((step) => (
                      <li key={step.label}>
                        <span className="trail-label">{step.label}</span>
                        <Meter value={step.value} />
                      </li>
                    ))}
                  </ol>
                  {delta !== null && (
                    <span className={`delta ${delta > 0 ? "up" : delta < 0 ? "down" : "flat"}`}>
                      {delta === 0 ? "No change" : `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}`} since your original
                    </span>
                  )}
                </div>
              )}
              {latestScore !== undefined && message.reviewedAt === null && message.excludedAt === null && (
                <p className="stays-note">
                  <i className="ph ph-arrow-bend-up-left" aria-hidden="true" />
                  This version scored {latestScore.toFixed(1)}, below your goal, so the message stays in your queue.
                </p>
              )}
              {attempts.length > 1 && (
                <div className="ver-wrap">
                  <VersionHistory attempts={attempts.slice(0, -1)} defaultOpen={false} />
                </div>
              )}
            </motion.section>

            <motion.section variants={rise} className="rw-sec">
              <div className="sect-h">
                <h3>Rewrites</h3>
                <button
                  type="button"
                  className="btn btn-ghost sm"
                  aria-expanded={showRewrites}
                  aria-controls={`rewrites-${message.id}`}
                  onClick={() => setShowRewrites((v) => !v)}
                >
                  <motion.span
                    key={showRewrites ? "hide" : "show"}
                    style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, ease: EASE }}
                  >
                    <i className={showRewrites ? "ph ph-eye-slash" : "ph ph-eye"} aria-hidden="true" />
                    {showRewrites ? "Hide rewrites" : "Show rewrites"}
                  </motion.span>
                </button>
              </div>
              <AnimatePresence initial={false}>
                {showRewrites && (
                  <motion.div key="rewrites" id={`rewrites-${message.id}`} className="rw-wrap" {...expand}>
                    <motion.ul className="rewrites" variants={stagger(0.09, 0.08)} initial="hidden" animate="show">
                      {coaching.rewrites.map((r, i) => (
                        <motion.li key={i} className="rw" variants={rise}>
                          <div className="rw-top">
                            <span className={`reg ${r.register}`}>
                              <i className={`ph ${REGISTER_ICON[r.register]}`} aria-hidden="true" />
                              {r.register}
                            </span>
                            <span className="rw-act" aria-live="polite">
                              <AnimatePresence>
                                {copied === i && (
                                  <motion.span
                                    key="said"
                                    className="rw-copied"
                                    initial={{ opacity: 0, x: 8 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: 4 }}
                                    transition={{ duration: 0.2, ease: EASE }}
                                  >
                                    Copied
                                  </motion.span>
                                )}
                              </AnimatePresence>
                              <button
                                type="button"
                                className={`ib sm copy${copied === i ? " done" : ""}`}
                                aria-label={`Copy ${r.register} rewrite`}
                                onClick={() => void copy(r.text, i)}
                              >
                                <AnimatePresence mode="wait" initial={false}>
                                  {copied === i ? (
                                    <motion.i
                                      key="check"
                                      className="ph ph-check"
                                      aria-hidden="true"
                                      initial={{ scale: 0.3, rotate: -40, opacity: 0 }}
                                      animate={{ scale: [0.3, 1.4, 1], rotate: 0, opacity: 1 }}
                                      exit={{ scale: 0.4, opacity: 0 }}
                                      transition={{ duration: 0.42, ease: EASE }}
                                    />
                                  ) : (
                                    <motion.i
                                      key="copy"
                                      className="ph ph-copy"
                                      aria-hidden="true"
                                      initial={{ scale: 0.5, opacity: 0 }}
                                      animate={{ scale: 1, opacity: 1 }}
                                      exit={{ scale: 0.5, opacity: 0 }}
                                      transition={{ duration: 0.15 }}
                                    />
                                  )}
                                </AnimatePresence>
                              </button>
                            </span>
                          </div>
                          <p>{r.text}</p>
                        </motion.li>
                      ))}
                    </motion.ul>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.section>

            <motion.section variants={rise} className="why">
              <div className="sect-h">
                <h3>About your version</h3>
                <CostChip coaching={coaching} />
              </div>
              <p>{coaching.explanation}</p>
            </motion.section>

            <motion.aside variants={slideIn} className="remember">
              {/* Wobbles once, just after the callout lands, to say "this is the part to keep". */}
              <motion.i
                className="ph-fill ph-lightbulb bulb"
                aria-hidden="true"
                animate={{ rotate: [0, -18, 14, -9, 5, 0] }}
                transition={{ duration: 0.9, delay: 0.85, ease: "easeInOut" }}
              />
              <div>
                <strong>Remember</strong>
                <p>{coaching.tip}</p>
              </div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="card-f">
        {message.excludedAt !== null ? (
          <>
            <span className="muted">Set aside {ago(message.excludedAt)}, so it does not count</span>
            {onExcluded && (
              <button type="button" className="btn btn-ghost" disabled={settingAside} onClick={() => void setExcluded(false)}>
                <i className="ph ph-arrow-u-up-left" aria-hidden="true" />
                Put it back
              </button>
            )}
          </>
        ) : (
          <>
            {onExcluded && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={settingAside}
                title="Pasted text or file names make this read oddly: leave it out of the queue and the scores"
                onClick={() => void setExcluded(true)}
              >
                <i className="ph ph-prohibit" aria-hidden="true" />
                Not for Cadence
              </button>
            )}
            {message.reviewedAt !== null ? (
              <span className="muted">Reviewed {ago(message.reviewedAt)}</span>
            ) : (
              onReviewed && (
                <button
                  type="button"
                  className={`btn btn-ghost${marking ? " is-done" : ""}`}
                  disabled={marking}
                  title={latestScore !== undefined ? "Take it out of the queue although the last version is below your goal" : undefined}
                  onClick={() => void markReviewed()}
                >
                  <motion.i
                    key={marking ? "done" : "idle"}
                    className="ph ph-check"
                    aria-hidden="true"
                    initial={marking ? { scale: 0.3, rotate: -30 } : false}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: "spring", stiffness: 520, damping: 14 }}
                  />
                  {marking ? "Marking" : latestScore !== undefined ? "Done anyway" : "Mark reviewed"}
                </button>
              )
            )}
          </>
        )}
      </footer>
    </motion.article>
  );
}
