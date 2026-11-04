import { AnimatePresence, motion, type Variants } from "motion/react";
import { useMemo, useState } from "react";
import { api, MAX_TRIES, type Coaching, type Message, type Screen } from "../api";
import { wordDiff } from "../diff";
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

/** With more steps than this the middle of the timeline folds, keeping the original and the newest tries in view. */
const FOLD_AT = 6;
const TAIL = 3;

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

/** One step of the timeline: the original, a saved try, or the try that is being scored right now. */
type Step = {
  key: string;
  index: number;
  label: string;
  text: string;
  createdAt: number | null;
  screen: Screen | null;
  coaching: Coaching | null;
  kind: "original" | "attempt" | "pending";
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

/** How far the score moved from the step before. Never colour alone: the arrow and the sign say it too. */
function DeltaChip({ before, after }: { before: Screen; after: Screen }) {
  const d = scoreChange(before, after);
  if (d === null) return null;
  const tone = d > 0 ? "up" : d < 0 ? "down" : "flat";
  return (
    <motion.span
      className={`dchip ${tone}`}
      initial={{ opacity: 0, scale: 0.4 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 16 }}
    >
      {d !== 0 && <i className={`ph ${d > 0 ? "ph-arrow-up" : "ph-arrow-down"}`} aria-hidden="true" />}
      {d === 0 ? "No change" : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`}
    </motion.span>
  );
}

/** A version's text. Against the step before it, the added words are marked and the removed ones struck through. */
function VersionText({ before, after }: { before: string | null; after: string }) {
  const parts = useMemo(() => (before === null ? null : wordDiff(before, after)), [before, after]);
  const [changes, setChanges] = useState(true);
  if (!parts) return <p className="attempt-text">{after}</p>;
  return (
    <>
      <p className="attempt-text">
        {changes ? parts.map((p, i) => (p.kind === "add" ? <ins key={i}>{p.text}</ins> : p.kind === "del" ? <del key={i}>{p.text}</del> : p.text)) : after}
      </p>
      <button type="button" className="btn btn-ghost sm tl-changes" aria-pressed={changes} onClick={() => setChanges((v) => !v)}>
        <i className={changes ? "ph ph-eye-slash" : "ph ph-eye"} aria-hidden="true" />
        {changes ? "Hide changes" : "Show changes"}
      </button>
    </>
  );
}

/** The short form of a review, for a try that is no longer the newest. */
function CoachNotes({ coaching }: { coaching: Coaching }) {
  return (
    <details className="ver-coach">
      <summary>
        What the coach said
        <CostChip coaching={coaching} />
      </summary>
      <p>{coaching.explanation}</p>
      {coaching.assumption && <p className="muted">{coaching.assumption}</p>}
      <ul>
        {coaching.rewrites.map((r, i) => (
          <li key={i}>
            <span className={`reg ${r.register}`}>{r.register}</span> {r.text}
          </li>
        ))}
      </ul>
      <p>
        <strong>Remember</strong> {coaching.tip}
      </p>
    </details>
  );
}

export function MessageCard({ message, notify, onChange, onReviewed, onExcluded }: CardProps) {
  const [draft, setDraftText] = useState(() => loadDraft(message.id));
  // "scoring": the new version is being saved and scored. "coaching": it is saved and scored, the review is running.
  const [phase, setPhase] = useState<"scoring" | "coaching" | null>(null);
  // The version that is being scored: it is not part of the message yet, but it already belongs on the timeline.
  const [pending, setPending] = useState<string | null>(null);
  const [coachError, setCoachError] = useState<{ text: string; retry: boolean } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [marking, setMarking] = useState(false);
  const [settingAside, setSettingAside] = useState(false);
  // A draft left behind on an already reviewed message means the user was in the middle of trying again.
  const [redoing, setRedoing] = useState(() => loadDraft(message.id).trim() !== "");
  const [showRewrites, setShowRewrites] = useState(false);
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const busy = phase !== null;
  const screen = message.screen;
  const attempts = message.attempts;
  const coaching = message.coaching;
  const latest = attempts[attempts.length - 1];
  const latestScore = latest?.screen?.naturalness;

  const triesLeft = MAX_TRIES - attempts.length;
  const writing = !busy && (!coaching || redoing) && triesLeft > 0;
  // Earlier reviews stay out of sight while the next try is written (or scored), so it is written from memory.
  const blind = attempts.length > 0 && (writing || phase === "scoring");

  const setDraft = (text: string) => {
    setDraftText(text);
    storeDraft(message.id, text);
  };
  const refresh = async () => onChange(await api.getMessage(message.id));

  /** Reviews the latest saved version. Also what Retry runs, since the version is already saved by then. */
  const coach = async (newVersion?: string) => {
    setCoachError(null);
    try {
      if (newVersion) {
        setPending(newVersion);
        setPhase("scoring");
        try {
          await api.saveAttempt(message.id, newVersion);
        } catch (e) {
          // Nothing was saved, so Retry would review an older version: the draft stays in the box to send again.
          setCoachError({ text: errorText(e), retry: false });
          return;
        }
        setDraft("");
        // Show the saved and scored version at once: if the review below fails it is still there, with a way to retry.
        await refresh();
        setPending(null);
      }
      setPhase("coaching");
      await api.coachMessage(message.id);
      await refresh();
      setShowRewrites(false);
      setRedoing(false);
    } catch (e) {
      setCoachError({ text: errorText(e), retry: true });
    } finally {
      setPending(null);
      setPhase(null);
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

  // The whole history as one thread: the original is its first step, every sentence appears once.
  const steps: Step[] = [
    { key: "original", index: 0, label: "Original", text: message.text, createdAt: null, screen, coaching: null, kind: "original" },
    ...attempts.map((a, i) => ({
      key: `try-${a.id}`,
      index: i + 1,
      label: `Try ${i + 1}`,
      text: a.text,
      createdAt: a.createdAt,
      screen: a.screen,
      coaching: a.coaching,
      kind: "attempt" as const,
    })),
    ...(pending !== null
      ? [{ key: "pending", index: attempts.length + 1, label: `Try ${attempts.length + 1}`, text: pending, createdAt: null, screen: null, coaching: null, kind: "pending" as const }]
      : []),
  ];
  const folded = !showAll && steps.length > FOLD_AT;
  const shown = folded ? [steps[0], ...steps.slice(-TAIL)] : steps;
  const hiddenCount = steps.length - shown.length;
  // What still sounds off is about the newest version, so the header names that one's issue.
  const currentScreen = latest?.screen ?? screen;

  const toggleStep = (key: string) =>
    setOpenSteps((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const renderStep = (step: Step) => {
    const last = step.index === steps.length - 1;
    const open = last || openSteps.has(step.key);
    const before = step.index > 0 ? steps[step.index - 1] : null;
    const isLatestTry = last && step.kind !== "original";

    const score =
      step.kind === "pending" ? (
        <span className="pend" role="status">
          <i className="ph ph-spinner spin" aria-hidden="true" />
          Scoring
        </span>
      ) : step.screen ? (
        <>
          <Meter value={step.screen.naturalness} word={step.kind === "original" && attempts.length === 0 && pending === null} />
          {before?.screen && <DeltaChip before={before.screen} after={step.screen} />}
        </>
      ) : (
        <span className="muted">{step.kind === "original" ? "Not screened yet" : "Not scored"}</span>
      );

    const head = (
      <>
        <span className="trail-label">{step.label}</span>
        {step.createdAt !== null && (
          <span className="muted tl-when" title={new Date(step.createdAt).toLocaleString()}>
            {ago(step.createdAt)}
          </span>
        )}
        <span className="tl-score">{score}</span>
        {!last && <i className={`ph ${open ? "ph-caret-up" : "ph-caret-down"} tl-caret`} aria-hidden="true" />}
      </>
    );

    return (
      <motion.li
        key={step.key}
        className={`tl-step${last ? " current" : ""}`}
        layout="position"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
        transition={{ duration: 0.38, ease: EASE }}
      >
        <i className="tl-dot" aria-hidden="true" />
        {last ? (
          <div className="tl-head">{head}</div>
        ) : (
          <button type="button" className="tl-head tl-toggle" aria-expanded={open} onClick={() => toggleStep(step.key)}>
            {head}
          </button>
        )}

        {open ? (
          step.kind === "original" ? (
            <p className="attempt-text">{step.text}</p>
          ) : (
            <VersionText before={before?.text ?? null} after={step.text} />
          )
        ) : (
          <p className="attempt-text tl-clamp">{step.text}</p>
        )}

        {step.kind === "attempt" && blind && (
          <p className="muted review-hidden">
            <i className="ph ph-lock" aria-hidden="true" />
            Review hidden while you write
          </p>
        )}

        {!blind && open && !last && step.coaching && <CoachNotes coaching={step.coaching} />}

        {isLatestTry && (
          <div className="tl-attach">
            {step.kind === "attempt" && screen && step.screen && attempts.length > 1 && (() => {
              const total = scoreChange(screen, step.screen);
              return total === null ? null : (
                <span className={`delta ${total > 0 ? "up" : total < 0 ? "down" : "flat"}`}>
                  {total === 0 ? "No change" : `${total > 0 ? "+" : "−"}${Math.abs(total).toFixed(1)}`} since your original
                </span>
              );
            })()}

            {step.kind === "attempt" && latestScore !== undefined && message.reviewedAt === null && message.excludedAt === null && (
              <p className="stays-note">
                <i className="ph ph-arrow-bend-up-left" aria-hidden="true" />
                This version scored {latestScore.toFixed(1)}, below your goal, so the message stays in your queue.
              </p>
            )}

            {step.kind === "attempt" && !coaching && !busy && !coachError && (
              <div className="pending-note" role="status">
                <i className="ph ph-clock-countdown" aria-hidden="true" />
                <span>This version is saved, but it was not reviewed yet.</span>
                <button type="button" className="btn btn-ghost sm" onClick={() => void coach()}>
                  Review it
                </button>
              </div>
            )}

            <AnimatePresence initial={false}>
              {phase === "coaching" && step.kind === "attempt" && (
                <motion.div key="wait" className="coach-wait" role="status" {...expand}>
                  <div className="coach-wait-in">
                    <div className="coach-wait-h">
                      <i className="ph-fill ph-sparkle coach-spark" aria-hidden="true" />
                      <span>Scored. The coach is reading your version</span>
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

            {step.kind === "attempt" && coaching && !busy && !blind && review(coaching)}
          </div>
        )}
      </motion.li>
    );
  };

  /** The coach's review of the newest version: why, rewrites on request, and the one thing to remember. */
  const review = (c: Coaching) => (
    <motion.div className="coaching" variants={stagger(0.1, 0.05)} initial="hidden" animate="show">
      <motion.section variants={rise} className="why">
        <div className="sect-h">
          <h3>What the coach says</h3>
          <CostChip coaching={c} />
        </div>
        <p>{c.explanation}</p>
        {c.assumption && (
          <p className="muted">
            <i className="ph ph-info" aria-hidden="true" /> {c.assumption}
          </p>
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
                {c.rewrites.map((r, i) => (
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
          <p>{c.tip}</p>
        </div>
      </motion.aside>
    </motion.div>
  );

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
        {currentScreen && <IssueChip issue={currentScreen.issue} />}
      </header>

      <ol className="tl" aria-label="Versions of this message">
        {/* initial={false}: the steps already there do not animate in again, only a new try does. */}
        <AnimatePresence initial={false}>
          {shown.flatMap((step, i) => [
            ...(folded && i === 1
              ? [
                  <li key="gap" className="tl-gap">
                    <i className="tl-dot" aria-hidden="true" />
                    <button type="button" className="trail-more" onClick={() => setShowAll(true)}>
                      +{hiddenCount} earlier {hiddenCount === 1 ? "try" : "tries"}
                    </button>
                  </li>,
                ]
              : []),
            renderStep(step),
          ])}
        </AnimatePresence>
        {showAll && steps.length > FOLD_AT && (
          <li className="tl-gap">
            <i className="tl-dot" aria-hidden="true" />
            <button type="button" className="trail-more" onClick={() => setShowAll(false)}>
              Show fewer
            </button>
          </li>
        )}
      </ol>

      <AnimatePresence initial={false}>
        {coachError && (
          <motion.div key="error" className="inline-error" role="alert" {...expand}>
            <i className="ph ph-warning-circle" aria-hidden="true" />
            <span>{coachError.retry ? "Could not get suggestions" : "Could not save this version"}: {coachError.text}</span>
            {coachError.retry && (
              <button type="button" className="btn btn-ghost sm" disabled={busy} onClick={() => void coach()}>
                Retry
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {writing && (
        <motion.div
          key="attempt"
          className="attempt"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: EASE }}
        >
          <div className="try-count">
            <label htmlFor={`draft-${message.id}`}>{attempts.length > 0 ? "Try it again" : "Say it your way"}</label>
            <span className="try-of muted">
              <span className="try-dots" aria-hidden="true">
                {Array.from({ length: MAX_TRIES }, (_, i) => (
                  <i key={i} className={i <= attempts.length ? "on" : ""} />
                ))}
              </span>
              Try {attempts.length + 1} of {MAX_TRIES}
            </span>
          </div>
          <textarea
            id={`draft-${message.id}`}
            rows={3}
            value={draft}
            placeholder="Write the message the way you would say it"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="card-actions">
            <button type="button" className="btn btn-primary" disabled={!draft.trim()} onClick={() => void coach(draft.trim())}>
              <i className="ph ph-sparkle" aria-hidden="true" />
              Show suggestions
            </button>
            {redoing && coaching && (
              <button type="button" className="btn btn-ghost" onClick={() => setRedoing(false)}>
                Cancel
              </button>
            )}
          </div>
          {attempts.length > 0 && (
            <p className="muted review-hidden">
              <i className="ph ph-lock" aria-hidden="true" />
              Review opens after you send
            </p>
          )}
        </motion.div>
      )}

      {coaching && !redoing && !busy && triesLeft > 0 && (
        <button type="button" className="btn btn-ghost sm tl-again" onClick={tryAgain}>
          <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" />
          Try again
        </button>
      )}
      {coaching && !busy && triesLeft <= 0 && <p className="muted tl-again last-try">That was the last try.</p>}

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
