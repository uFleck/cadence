import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, TOPIC_LABEL, type InterviewAnswer, type InterviewQuestion, type InterviewTopic } from "../api";
import { EASE, rise, SPRING, stagger } from "../motion";
import "../styles/interview.css";
import { Dialog } from "./Dialog";
import { ago, errorText, IssueChip, Meter, when, type Notify } from "./shared";

const TOPICS = Object.keys(TOPIC_LABEL) as InterviewTopic[];
const LONG_ANSWER = 120;

type Phase = "answering" | "reviewing" | "failed" | "done";

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function Interview({ notify }: { notify: Notify }) {
  const [topic, setTopic] = useState<InterviewTopic | null>(null);
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [current, setCurrent] = useState<InterviewQuestion | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("answering");
  const [answer, setAnswer] = useState<InterviewAnswer | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [history, setHistory] = useState<InterviewAnswer[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [added, setAdded] = useState<InterviewQuestion | null>(null);
  const [toDelete, setToDelete] = useState<InterviewQuestion | null>(null);
  const [session, setSession] = useState(0);

  const startedAt = useRef(Date.now());
  const frozen = useRef<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const loadToken = useRef(0);

  const reloadQuestions = useCallback(
    () => api.interviewQuestions().then(setQuestions, (e) => notify("Could not load the questions", errorText(e))),
    [notify],
  );

  const reloadHistory = useCallback((qid: number) => {
    api.interviewAnswers(qid, 10).then(
      (rows) => setHistory(rows),
      () => setHistory([]),
    );
  }, []);

  const startTimer = useCallback(() => {
    startedAt.current = Date.now();
    frozen.current = null;
    setElapsed(0);
  }, []);

  const show = useCallback(
    (q: InterviewQuestion) => {
      setCurrent(q);
      setText("");
      setAnswer(null);
      setReviewError(null);
      setPhase("answering");
      setHistory([]);
      setSession((n) => n + 1);
      startTimer();
      reloadHistory(q.id);
    },
    [reloadHistory, startTimer],
  );

  const load = useCallback(
    (t: InterviewTopic | null, exclude: number | null) => {
      const token = ++loadToken.current;
      setLoadError(null);
      api.nextInterviewQuestion(t, exclude).then(
        (q) => token === loadToken.current && show(q),
        (e) => token === loadToken.current && setLoadError(errorText(e)),
      );
    },
    [show],
  );

  useEffect(() => {
    void reloadQuestions();
    load(null, null);
  }, [reloadQuestions, load]);

  useEffect(() => {
    if (phase !== "answering") return;
    area.current?.focus();
  }, [session, phase]);

  useEffect(() => {
    const id = window.setInterval(() => setElapsed(frozen.current ?? Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [session]);

  const counts = useMemo(() => {
    const by = (t: InterviewTopic | null) => {
      const list = questions.filter((q) => t === null || q.topic === t);
      return { answered: list.filter((q) => q.answers > 0).length, total: list.length };
    };
    return { all: by(null), topics: Object.fromEntries(TOPICS.map((t) => [t, by(t)])) as Record<InterviewTopic, { answered: number; total: number }> };
  }, [questions]);

  const pickTopic = (t: InterviewTopic | null) => {
    setTopic(t);
    load(t, null);
  };

  const review = async (a: InterviewAnswer) => {
    setPhase("reviewing");
    setReviewError(null);
    try {
      const reviewed = await api.reviewInterviewAnswer(a.id);
      setAnswer(reviewed);
      setPhase("done");
    } catch (e) {
      setReviewError(errorText(e));
      setPhase("failed");
    }
    void reloadQuestions();
    reloadHistory(a.questionId);
  };

  const submit = async () => {
    if (!current || !text.trim() || phase !== "answering") return;
    const seconds = Math.floor((Date.now() - startedAt.current) / 1000);
    frozen.current = seconds;
    setElapsed(seconds);
    setPhase("reviewing");
    let saved: InterviewAnswer;
    try {
      saved = await api.saveInterviewAnswer(current.id, text.trim(), seconds);
    } catch (e) {
      frozen.current = null;
      setPhase("answering");
      notify("Could not save your answer", errorText(e));
      return;
    }
    setAnswer(saved);
    void review(saved);
  };

  const answerAgain = () => {
    if (current) show(current);
  };

  const practiseFollowUp = async (followUp: string) => {
    if (!current) return;
    try {
      const q = await api.addInterviewQuestion(current.topic, followUp);
      void reloadQuestions();
      show(q);
    } catch (e) {
      notify("Could not add the follow-up", errorText(e));
    }
  };

  const confirmDelete = async () => {
    const q = toDelete;
    if (!q) return;
    setToDelete(null);
    try {
      await api.deleteInterviewQuestion(q.id);
      if (added?.id === q.id) setAdded(null);
      await reloadQuestions();
      if (current?.id === q.id) load(topic, null);
    } catch (e) {
      notify("Could not delete the question", errorText(e));
    }
  };

  const closeDelete = useCallback(() => setToDelete(null), []);
  const custom = questions.filter((q) => q.custom);
  const busy = phase === "reviewing";

  return (
    <motion.div className="iv" variants={stagger(0.07)} initial="hidden" animate="show">
      <motion.header className="iv-header" variants={rise}>
        <div className="eyebrow">Interview practice</div>
        <h1>Say it out loud, then hear how it should sound</h1>
      </motion.header>

      <motion.div className="iv-topics" variants={rise} role="group" aria-label="Topic">
        {[null, ...TOPICS].map((t) => {
          const c = t === null ? counts.all : counts.topics[t];
          const on = topic === t;
          return (
            <button key={t ?? "all"} type="button" className="iv-topic" aria-pressed={on} onClick={() => pickTopic(t)}>
              {on && <motion.span layoutId="iv-topic-pill" className="iv-topic-pill" transition={SPRING} />}
              <span className="iv-topic-label">{t === null ? "All" : TOPIC_LABEL[t]}</span>
              <span className="iv-topic-count" aria-label={`${c.answered} of ${c.total} answered`}>
                {c.answered}/{c.total}
              </span>
            </button>
          );
        })}
      </motion.div>

      {loadError && !current && (
        <motion.div className="iv-card" variants={rise}>
          <div className="inline-error" role="alert">
            <i className="ph-fill ph-warning" aria-hidden="true" />
            <span>{loadError}</span>
            <button type="button" className="btn btn-ghost sm" onClick={() => load(topic, null)}>
              Try again
            </button>
          </div>
        </motion.div>
      )}

      {!current && !loadError && (
        <motion.div className="iv-card iv-skel" variants={rise} aria-busy="true">
          <span className="muted">Picking a question…</span>
        </motion.div>
      )}

      {current && (
        <>
          <motion.section className="iv-card iv-question" variants={rise} aria-labelledby="iv-q">
            <div className="iv-q-top">
              <span className="eyebrow">{TOPIC_LABEL[current.topic]}</span>
              {current.custom && (
                <span className="chip iv-custom">
                  <i className="ph ph-user" aria-hidden="true" /> Your question
                </span>
              )}
              <button type="button" className="btn btn-ghost sm iv-skip" onClick={() => load(topic, current.id)} disabled={busy}>
                <i className="ph ph-skip-forward" aria-hidden="true" /> Skip
              </button>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.h2
                id="iv-q"
                key={current.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25, ease: EASE }}
              >
                {current.text}
              </motion.h2>
            </AnimatePresence>
          </motion.section>

          {(phase === "answering" || phase === "reviewing" || phase === "failed") && (
            <motion.section className="iv-card iv-answer" variants={rise} aria-label="Your answer">
              <label htmlFor="iv-text" className="iv-hint">
                <i className="ph ph-microphone" aria-hidden="true" />
                Answer out loud: press Win+H and speak. Aim for 1 to 2 minutes.
              </label>
              <textarea
                id="iv-text"
                ref={area}
                value={text}
                readOnly={phase !== "answering"}
                rows={7}
                placeholder="Your answer will appear here as you speak"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              <div className="iv-bar">
                <span className={`iv-timer${elapsed > LONG_ANSWER ? " long" : ""}`} role="timer" aria-label={`Elapsed ${clock(elapsed)}`}>
                  <i className="ph ph-timer" aria-hidden="true" />
                  {clock(elapsed)}
                  {elapsed > LONG_ANSWER && <span> · Over 2 minutes, wrap up when you can</span>}
                </span>
                <span className="iv-keys muted">Ctrl+Enter to send</span>
                <button type="button" className="btn btn-primary" disabled={!text.trim() || phase !== "answering"} onClick={() => void submit()}>
                  <i className="ph ph-paper-plane-tilt" aria-hidden="true" /> Get feedback
                </button>
              </div>

              {phase === "reviewing" && (
                <div className="iv-working" role="status" aria-live="polite">
                  <i className="ph ph-circle-notch spin" aria-hidden="true" />
                  <div>
                    <b>Reviewing your answer</b>
                    <p className="muted">Checking your English and the depth of the content. This can take up to 2 minutes.</p>
                  </div>
                </div>
              )}
              {phase === "failed" && answer && (
                <div className="inline-error" role="alert">
                  <i className="ph-fill ph-warning" aria-hidden="true" />
                  <span>Your answer is saved, but the review failed: {reviewError}</span>
                  <button type="button" className="btn btn-ghost sm" onClick={() => void review(answer)}>
                    <i className="ph ph-arrow-clockwise" aria-hidden="true" /> Try again
                  </button>
                </div>
              )}
            </motion.section>
          )}

          {phase === "done" && answer?.feedback && <FeedbackPanel answer={answer} onAgain={answerAgain} onNext={() => load(topic, current.id)} onFollowUp={practiseFollowUp} />}

          <motion.div variants={rise}>
            <History answers={history} />
          </motion.div>
        </>
      )}

      <motion.section className="iv-card iv-add" variants={rise} aria-labelledby="iv-add-h">
        <AddQuestion
          defaultTopic={current?.topic ?? "cloud"}
          notify={notify}
          onAdded={(q) => {
            setAdded(q);
            void reloadQuestions();
          }}
        />
        <AnimatePresence initial={false}>
          {added && (
            <motion.div
              key={added.id}
              className="iv-added"
              role="status"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: EASE }}
            >
              <i className="ph-fill ph-check-circle" aria-hidden="true" />
              <span>Question added.</span>
              <button
                type="button"
                className="btn btn-primary sm"
                onClick={() => {
                  show(added);
                  setAdded(null);
                }}
                disabled={busy}
              >
                Practise it now
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        {custom.length > 0 && (
          <details className="iv-custom-list">
            <summary>Your questions ({custom.length})</summary>
            <ul>
              {custom.map((q) => (
                <li key={q.id}>
                  <div className="iv-custom-text">
                    <span className="eyebrow">{TOPIC_LABEL[q.topic]}</span>
                    <p>{q.text}</p>
                    <span className="muted">{q.answers === 0 ? "Not answered yet" : `${q.answers} answer${q.answers === 1 ? "" : "s"}${q.bestDepth ? `, best depth ${q.bestDepth} / 5` : ""}`}</span>
                  </div>
                  <button type="button" className="btn btn-ghost sm" onClick={() => show(q)} disabled={busy}>
                    Practise
                  </button>
                  <button type="button" className="btn btn-ghost sm iv-del" aria-label={`Delete question: ${q.text}`} onClick={() => setToDelete(q)}>
                    <i className="ph ph-trash" aria-hidden="true" /> Delete
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </motion.section>

      <AnimatePresence>
        {toDelete && (
          <Dialog
            key="del"
            tone="warn"
            icon="ph-fill ph-trash"
            title="Delete this question?"
            lead="Its saved answers and feedback are deleted with it. This cannot be undone."
            onClose={closeDelete}
            footer={
              <>
                <button type="button" className="btn btn-ghost" data-first onClick={closeDelete}>
                  Keep it
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void confirmDelete()}>
                  Delete
                </button>
              </>
            }
          >
            <p className="iv-del-q">{toDelete.text}</p>
          </Dialog>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function FeedbackPanel({
  answer,
  onAgain,
  onNext,
  onFollowUp,
}: {
  answer: InterviewAnswer;
  onAgain: () => void;
  onNext: () => void;
  onFollowUp: (text: string) => Promise<void>;
}) {
  const fb = answer.feedback!;
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus(), []);
  return (
    <motion.section
      className="iv-feedback"
      variants={stagger(0.08)}
      initial="hidden"
      animate="show"
      aria-label="Feedback"
      tabIndex={-1}
      ref={panel}
    >
      <motion.div className="iv-card iv-scores" variants={rise}>
        <div className="iv-score">
          <span className="eyebrow">Naturalness</span>
          {answer.screen ? (
            <Meter value={answer.screen.naturalness} word />
          ) : (
            <p className="muted">TypeSafe is not configured, so only Claude's feedback is shown.</p>
          )}
        </div>
        <div className="iv-score">
          <span className="eyebrow">Depth</span>
          <div className="iv-depth">
            <b>{fb.depth} / 5</b>
            <span>{fb.depthNotes}</span>
          </div>
        </div>
      </motion.div>

      <motion.div className="iv-card iv-spoken" variants={rise}>
        <span className="eyebrow">Say it like this</span>
        <p className="iv-spoken-text">{fb.spoken}</p>
        <p className="muted">
          <i className="ph ph-speaker-high" aria-hidden="true" /> Read it aloud twice, the second time without looking.
        </p>
      </motion.div>

      <motion.div className="iv-card" variants={rise}>
        <div className="iv-row">
          <span className="eyebrow">English notes</span>
          <IssueChip issue={fb.issue} />
        </div>
        <p className="iv-p">{fb.englishNotes}</p>
        <p className="iv-tip">
          <i className="ph ph-lightbulb" aria-hidden="true" /> {fb.tip}
        </p>
      </motion.div>

      {fb.missing.length > 0 && (
        <motion.div className="iv-card" variants={rise}>
          <span className="eyebrow">A strong answer would also cover</span>
          <ul className="iv-missing">
            {fb.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </motion.div>
      )}

      <motion.div className="iv-card iv-follow" variants={rise}>
        <span className="eyebrow">Likely follow-up</span>
        <p className="iv-follow-text">{fb.followUp}</p>
        <button
          type="button"
          className="btn btn-ghost sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onFollowUp(fb.followUp).finally(() => setBusy(false));
          }}
        >
          <i className="ph ph-arrow-bend-down-right" aria-hidden="true" /> Practise this follow-up
        </button>
      </motion.div>

      <motion.div className="iv-actions" variants={rise}>
        <button type="button" className="btn btn-ghost" onClick={onAgain}>
          <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" /> Answer again
        </button>
        <button type="button" className="btn btn-primary" onClick={onNext}>
          Next question <i className="ph ph-arrow-right" aria-hidden="true" />
        </button>
      </motion.div>
    </motion.section>
  );
}

function History({ answers }: { answers: InterviewAnswer[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (answers.length === 0) return null;
  return (
    <details className="iv-history">
      <summary>Previous answers ({answers.length})</summary>
      <ul>
        {answers.map((a) => {
          const isOpen = open === a.id;
          return (
            <li key={a.id} className={isOpen ? "open" : undefined}>
              <button type="button" className="iv-h-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.id)}>
                <span className="iv-h-when" title={when(a.createdAt)}>
                  {ago(a.createdAt)}
                </span>
                <span>{clock(a.seconds)}</span>
                <span>{a.screen ? `Naturalness ${a.screen.naturalness.toFixed(1)}` : "Naturalness n/a"}</span>
                <span>{a.feedback ? `Depth ${a.feedback.depth} / 5` : "Not reviewed"}</span>
                <i className={`ph ph-caret-${isOpen ? "up" : "down"}`} aria-hidden="true" />
              </button>
              {isOpen && (
                <div className="iv-h-body">
                  <span className="eyebrow">You said</span>
                  <p>{a.text}</p>
                  {a.feedback && (
                    <>
                      <span className="eyebrow">Spoken version</span>
                      <p>{a.feedback.spoken}</p>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function AddQuestion({ defaultTopic, notify, onAdded }: { defaultTopic: InterviewTopic; notify: Notify; onAdded: (q: InterviewQuestion) => void }) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState<InterviewTopic>(defaultTopic);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      const q = await api.addInterviewQuestion(topic, text.trim());
      setText("");
      setOpen(false);
      onAdded(q);
    } catch (e) {
      notify("Could not add the question", errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="iv-add-form">
      <div className="iv-row">
        <h3 id="iv-add-h">Add your own question</h3>
        <button type="button" className="btn btn-ghost sm" aria-expanded={open} aria-controls="iv-add-body" onClick={() => setOpen((o) => !o)}>
          <i className={`ph ${open ? "ph-x" : "ph-plus"}`} aria-hidden="true" /> {open ? "Cancel" : "Add"}
        </button>
      </div>
      <p className="muted">Got a question from a real interview? Add it here and practise it.</p>
      {open && (
        <div id="iv-add-body" className="iv-add-body">
          <label className="iv-field">
            <span>Topic</span>
            <select value={topic} onChange={(e) => setTopic(e.target.value as InterviewTopic)}>
              {TOPICS.map((t) => (
                <option key={t} value={t}>
                  {TOPIC_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="iv-field">
            <span>Question</span>
            <textarea value={text} rows={3} onChange={(e) => setText(e.target.value)} placeholder="Type the question as the interviewer asked it" />
          </label>
          <div>
            <button type="button" className="btn btn-primary" disabled={!text.trim() || saving} onClick={() => void save()}>
              Save question
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
