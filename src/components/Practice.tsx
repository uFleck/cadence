import { useEffect, useState, type KeyboardEvent } from "react";
import { MAX_TRIES, api, type Message, type Retest, type RetestQueue, type Screen } from "../api";
import { loadDraft, storeDraft } from "../drafts";
import { Meter, errorText, scoreChange, type Notify } from "./shared";
import "../styles/practice.css";

const DAY = 86_400_000;

function ScoreOrNone({ screen }: { screen: Screen | null }) {
  return screen ? <Meter value={screen.naturalness} /> : <span className="pr-none">Not scored</span>;
}

function ScoreValue({ value }: { value: number | null }) {
  return value === null ? <span className="pr-none">Not scored</span> : <Meter value={value} />;
}

function ctrlEnter(send: () => void) {
  return (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };
}

function Delta({ before, after }: { before: Screen | null; after: Screen | null }) {
  if (!before || !after) return null;
  const d = scoreChange(before, after);
  if (d === null) return null;
  if (d === 0) return <span className="pr-chip">No change</span>;
  const sign = d > 0 ? "+" : "-";
  return (
    <span className={`pr-chip ${d > 0 ? "up" : "down"}`}>
      <i className={`ph ph-arrow-${d > 0 ? "up" : "down"}`} aria-hidden="true" />
      {sign}
      {Math.abs(d).toFixed(1)}
    </span>
  );
}

/* ---------- retry ---------- */

function RetryCard({ version, notify }: { version: number; notify: Notify }) {
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [text, setText] = useState("");
  const [view, setView] = useState<"write" | "result">("write");
  const [phase, setPhase] = useState<"scoring" | "reviewing" | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [showRewrites, setShowRewrites] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const list = await api.listMessages({ filter: "queue", limit: 20, offset: 0 });
        const pick =
          list.find((m) => m.attempts.length > 0 && m.attempts.length < MAX_TRIES) ??
          list.find((m) => m.attempts.length < MAX_TRIES) ??
          null;
        if (!live) return;
        setMessage(pick);
        setText(pick ? loadDraft(pick.id) : "");
        setView("write");
        setNeedsReview(false);
        setShowRewrites(false);
      } catch (e) {
        if (live) notify("Could not load the retry", errorText(e));
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [version, reload, notify]);

  const busy = phase !== null;

  async function review(id: string) {
    setPhase("reviewing");
    try {
      await api.coachMessage(id);
      setNeedsReview(false);
    } catch (e) {
      setNeedsReview(true);
      notify("Could not review", errorText(e));
    }
    try {
      setMessage(await api.getMessage(id));
    } catch (e) {
      notify("Could not load the retry", errorText(e));
    }
    setPhase(null);
    setView("result");
  }

  async function send() {
    if (!message || busy || !text.trim()) return;
    setPhase("scoring");
    try {
      await api.saveAttempt(message.id, text.trim());
    } catch (e) {
      setPhase(null);
      notify("Could not save", errorText(e));
      return;
    }
    storeDraft(message.id, "");
    setText("");
    await review(message.id);
  }

  async function reviewAgain() {
    if (message && !busy) await review(message.id);
  }

  if (!loaded) return <article className="pr-card" aria-busy="true"><div className="pr-h"><h3>Retry</h3></div></article>;

  if (!message) {
    return (
      <article className="pr-card">
        <div className="pr-h"><h3>Retry</h3></div>
        <p className="pr-empty">Nothing to retry right now.</p>
      </article>
    );
  }

  const attempts = message.attempts;
  const tries = attempts.length;
  const latest = attempts[tries - 1];
  const previous: Screen | null = tries >= 2 ? attempts[tries - 2].screen : message.screen;
  const coaching = latest?.coaching ?? null;
  const settled = message.reviewedAt !== null;
  const canTryAgain = !settled && tries < MAX_TRIES;
  const n = tries + 1;

  const dots = (
    <span className="pr-dots" aria-hidden="true">
      {Array.from({ length: MAX_TRIES }, (_, i) => (
        <i key={i} className={view === "write" ? (i < tries ? "d" : i === tries ? "c" : "") : i < tries ? "d" : ""} />
      ))}
    </span>
  );

  return (
    <article className="pr-card">
      <div className="pr-h">
        <h3>Retry</h3>
        <span className="pr-meta">
          {view === "write" ? `Try ${n} of ${MAX_TRIES}` : `Try ${tries} of ${MAX_TRIES}`}
          {dots}
        </span>
      </div>

      <ol className="pr-trail">
        <li className="done">
          <div className="pr-who">
            Original
            <ScoreOrNone screen={message.screen} />
          </div>
          <p className="pr-txt">{message.text}</p>
        </li>
        {attempts.map((a, i) => {
          const isLatestShown = view === "result" && i === tries - 1;
          return (
            <li key={a.id} className={isLatestShown ? "cur" : "done"}>
              <div className="pr-who">
                Try {i + 1}
                <ScoreOrNone screen={a.screen} />
                {isLatestShown && <Delta before={previous} after={a.screen} />}
              </div>
              {view === "write" ? (
                <p className="pr-txt hidden">Hidden while you write</p>
              ) : isLatestShown ? (
                <p className="pr-txt">{a.text}</p>
              ) : (
                <p className="pr-txt hidden">Hidden while you write</p>
              )}
            </li>
          );
        })}
        {view === "write" && (
          <li className="cur">
            <div className="pr-who">Try {n}</div>
          </li>
        )}
      </ol>

      {view === "write" ? (
        <>
          <label className="pr-sr" htmlFor="pr-retry-text">Try {n}</label>
          <textarea
            id="pr-retry-text"
            className="pr-ta"
            rows={4}
            value={text}
            disabled={busy}
            placeholder="Write it as you would send it"
            onChange={(e) => {
              setText(e.target.value);
              storeDraft(message.id, e.target.value);
            }}
            onKeyDown={ctrlEnter(send)}
          />
          <div className="pr-row">
            <span className="pr-note">
              <i className="ph ph-lock" aria-hidden="true" />
              {phase === "scoring" ? "Scoring…" : phase === "reviewing" ? "Reviewing…" : "Review opens after you send"}
            </span>
            <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={send}>
              Send try {n}
            </button>
          </div>
        </>
      ) : (
        <div className="pr-result" aria-live="polite">
          {coaching ? (
            <>
              <p className="pr-explain">{coaching.explanation}</p>
              {coaching.tip && (
                <p className="pr-tip">
                  <strong>Remember</strong> {coaching.tip}
                </p>
              )}
              {coaching.rewrites.length > 0 && (
                <>
                  <button
                    type="button"
                    className="pr-link"
                    aria-expanded={showRewrites}
                    aria-controls="pr-rewrites"
                    onClick={() => setShowRewrites((v) => !v)}
                  >
                    {showRewrites ? "Hide rewrites" : "Show rewrites"}
                  </button>
                  {showRewrites && (
                    <ul className="pr-rewrites" id="pr-rewrites">
                      {coaching.rewrites.map((r, i) => (
                        <li key={i}>
                          <span className="pr-reg">{r.register === "casual" ? "Casual" : "Professional"}</span>
                          <span className="pr-rw">{r.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          ) : (
            needsReview && (
              <div className="pr-row left">
                <span className="pr-note">The review did not finish.</span>
                <button type="button" className="btn btn-ghost sm" disabled={busy} onClick={reviewAgain}>
                  {phase === "reviewing" ? "Reviewing…" : "Review again"}
                </button>
              </div>
            )
          )}
          {tries >= MAX_TRIES && <p className="pr-last">That was the last try.</p>}
          <div className="pr-row">
            {canTryAgain ? (
              <>
                <span className="pr-note" />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => {
                    setText(loadDraft(message.id));
                    setView("write");
                  }}
                >
                  Try again
                </button>
              </>
            ) : (
              <>
                <span className="pr-note">
                  <i className="ph ph-check-circle" aria-hidden="true" />
                  Settled
                </span>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setReload((v) => v + 1)}>
                  Next message
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/* ---------- re-test ---------- */

function inDays(dueAt: number) {
  const d = Math.max(1, Math.round((dueAt - Date.now()) / DAY));
  return d === 1 ? "tomorrow" : `in ${d} days`;
}

function RetestCard({ version, notify }: { version: number; notify: Notify }) {
  const [loaded, setLoaded] = useState(false);
  const [queue, setQueue] = useState<RetestQueue | null>(null);
  const [goal, setGoal] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"send" | "later" | null>(null);
  const [result, setResult] = useState<Retest | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [q, s] = await Promise.all([api.retestQueue(), api.getSettings()]);
        if (!live) return;
        setQueue(q);
        setGoal(s.flagThreshold);
        setText(q.due ? loadDraft(`retest-${q.due.id}`) : "");
        setResult(null);
      } catch (e) {
        if (live) notify("Could not load the re-test", errorText(e));
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [version, reload, notify]);

  const due = queue?.due ?? null;

  async function send() {
    if (!due || busy || !text.trim()) return;
    setBusy("send");
    try {
      const r = await api.saveRetest(due.id, text.trim());
      storeDraft(`retest-${due.id}`, "");
      setText("");
      setResult(r);
    } catch (e) {
      notify("Could not save", errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function later() {
    if (!due || busy) return;
    setBusy("later");
    try {
      await api.postponeRetest(due.id);
      setReload((v) => v + 1);
    } catch (e) {
      notify("Could not postpone", errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) return <article className="pr-card" aria-busy="true"><div className="pr-h"><h3>Re-test</h3></div></article>;

  const upcoming = (queue?.upcoming ?? []).slice(0, 5);
  const next =
    upcoming.length > 0 ? (
      <div className="pr-queue">
        Next
        {upcoming.map((r) => (
          <span key={r.id} className="pr-q">{inDays(r.dueAt)}</span>
        ))}
      </div>
    ) : null;

  if (result) {
    const s = result.screen;
    const reached = s !== null && goal !== null && s.naturalness >= goal;
    return (
      <article className="pr-card">
        <div className="pr-h"><h3>Re-test</h3></div>
        <div className="pr-result" aria-live="polite">
          {s ? (
            <>
              <dl className="pr-scores">
                <div><dt>Your version</dt><dd><Meter value={s.naturalness} /></dd></div>
                <div><dt>First draft</dt><dd><ScoreValue value={result.originalScore} /></dd></div>
                <div><dt>When it settled</dt><dd><ScoreValue value={result.settledScore} /></dd></div>
              </dl>
              <p className="pr-explain">
                {reached
                  ? "Natural without the old text."
                  : result.step === 1
                    ? "Not there yet. It comes back in 10 days."
                    : "Not there yet."}
              </p>
            </>
          ) : (
            <p className="pr-explain">Saved without a score.</p>
          )}
          <div className="pr-row">
            <span className="pr-note" />
            <button type="button" className="btn btn-primary" onClick={() => setReload((v) => v + 1)}>
              Next re-test
            </button>
          </div>
        </div>
        {next}
      </article>
    );
  }

  if (!due) {
    return (
      <article className="pr-card">
        <div className="pr-h"><h3>Re-test</h3></div>
        <p className="pr-empty">No re-test due.</p>
        {next}
      </article>
    );
  }

  const count = queue?.dueCount ?? 1;
  return (
    <article className="pr-card">
      <div className="pr-h">
        <h3>Re-test</h3>
        <span className="pr-due">{count > 1 ? `${count} due` : "Due today"}</span>
      </div>
      <p className="pr-idea">{due.idea}</p>
      <label className="pr-sr" htmlFor="pr-retest-text">Write it in your own words</label>
      <textarea
        id="pr-retest-text"
        className="pr-ta"
        rows={4}
        value={text}
        disabled={busy !== null}
        placeholder="Write it as you would send it"
        onChange={(e) => {
          setText(e.target.value);
          storeDraft(`retest-${due.id}`, e.target.value);
        }}
        onKeyDown={ctrlEnter(send)}
      />
      <p className="pr-hint">Write it in your own words</p>
      <div className="pr-row">
        <span className="pr-note">{busy === "send" ? "Scoring…" : ""}</span>
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={later}>
          Later
        </button>
        <button type="button" className="btn btn-primary" disabled={busy !== null || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
      {next}
    </article>
  );
}

/** The Practice section of the Progress view: the retry card and the re-test card. */
export function Practice({ version, notify }: { version: number; notify: Notify }) {
  return (
    <div className="practice">
      <RetryCard version={version} notify={notify} />
      <RetestCard version={version} notify={notify} />
    </div>
  );
}
