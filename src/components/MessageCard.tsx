import { AnimatePresence, motion, type Variants } from "motion/react";
import { useState } from "react";
import { api, type Attempt, type Coaching, type Message } from "../api";
import { EASE, rise, stagger } from "../motion";
import "../styles/messages.css";
import { ago, errorText, IssueChip, Meter, type Notify } from "./shared";

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

export function MessageCard({ message, notify, onReviewed }: { message: Message; notify: Notify; onReviewed?: () => void }) {
  const [draft, setDraft] = useState("");
  const [attempts, setAttempts] = useState<Attempt[]>(message.attempts);
  const [coaching, setCoaching] = useState<Coaching | null>(message.coaching);
  const [busy, setBusy] = useState(false);
  const [coachError, setCoachError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [marking, setMarking] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [showRewrites, setShowRewrites] = useState(false);
  const screen = message.screen;
  const latest = attempts[attempts.length - 1];

  /** Reviews the latest saved version. Also what Retry runs, since the version is already saved by then. */
  const coach = async (newVersion?: string) => {
    setBusy(true);
    setCoachError(null);
    try {
      if (newVersion) {
        const saved = await api.saveAttempt(message.id, newVersion);
        setAttempts((list) => [...list, saved]);
        setDraft("");
      }
      setCoaching(await api.coachMessage(message.id));
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
    setDraft("");
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
            <label htmlFor={`draft-${message.id}`}>Say it your way</label>
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
              {redoing && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setRedoing(false)}>
                  Cancel
                </button>
              )}
            </div>

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
              <h3>About your version</h3>
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
        {message.reviewedAt !== null ? (
          <span className="muted">Reviewed {ago(message.reviewedAt)}</span>
        ) : (
          onReviewed && (
            <button
              type="button"
              className={`btn btn-ghost${marking ? " is-done" : ""}`}
              disabled={marking}
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
              {marking ? "Marking" : "Mark reviewed"}
            </button>
          )
        )}
      </footer>
    </motion.article>
  );
}
