import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { api, type Message, type Overview, type Patterns, type TrendRow } from "../api";
import { CountUp, EASE, SOFT_SPRING, rise, stagger } from "../motion";
import { IssueChip, Meter, ago, errorText, type Notify } from "./shared";
import { MessageCard } from "./MessageCard";
import "../styles/today.css";

const QUEUE_LIMIT = 50;
const SPARK_DAYS = 14;
const DAY_MS = 86_400_000;

const tone = (v: number) => (v < 1 ? "low" : v < 2 ? "mid" : "high");
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const weekday = (s: string) => parseDay(s).toLocaleDateString("en", { weekday: "long" });
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Re-renders on an interval so the countdown and relative times stay fresh. */
function useNow(ms = 20_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function countdown(ms: number) {
  const mins = Math.ceil(ms / 60_000);
  if (mins <= 0) return "any moment now";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `in ${d} d${h ? ` ${h} h` : ""}`;
  if (h > 0) return `in ${h} h${m ? ` ${m} min` : ""}`;
  return `in ${m} min`;
}

function runDay(ts: number, now: number) {
  const diff = Math.round((startOfDay(new Date(ts)) - startOfDay(new Date(now))) / DAY_MS);
  if (diff <= 0) return new Date(ts).getHours() >= 18 ? "Tonight" : "Today";
  if (diff === 1) return "Tomorrow";
  return new Date(ts).toLocaleDateString("en", { weekday: "long" });
}

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

/** The headline is derived from the data: latest day against the one before it. */
function summarize(trend: TrendRow[], now: number) {
  const latest = trend[trend.length - 1];
  if (!latest) return null;
  const prev = trend.length > 1 ? trend[trend.length - 2] : null;
  const todayKey = dayKey(new Date(now));
  const isToday = latest.day === todayKey;
  const label = isToday ? "Today" : weekday(latest.day);
  if (!prev) return { latest, prev, isToday, label, delta: null, rel: "", head: "Here is where you stand" };
  const yesterday = dayKey(new Date(now - DAY_MS));
  const rel = isToday && prev.day === yesterday ? "yesterday" : weekday(prev.day);
  const delta = Math.round((latest.avgNaturalness - prev.avgNaturalness) * 10) / 10;
  const relText = isToday && prev.day === yesterday ? "yesterday" : `on ${rel}`;
  const cmp = delta > 0 ? "more natural than" : delta < 0 ? "a little less natural than" : "about as natural as";
  const head = isToday ? `You sounded ${cmp} ${relText}` : `On ${label} you sounded ${cmp} ${relText}`;
  return { latest, prev, isToday, label, delta, rel, head };
}

function Spark({ rows, threshold }: { rows: TrendRow[]; threshold: number }) {
  const reduce = useReducedMotion();
  const W = 400;
  const H = 96;
  const PX = 12;
  const TOP = 16;
  const BOT = 74;
  const vals = rows.map((r) => r.avgNaturalness);
  const lo = Math.max(0, Math.min(...vals, threshold) - 0.3);
  const hi = Math.max(lo + 0.6, Math.min(3, Math.max(...vals, threshold) + 0.3));
  const y = (v: number) => BOT - ((v - lo) / (hi - lo)) * (BOT - TOP);
  const x = (i: number) => (rows.length === 1 ? W / 2 : PX + (i * (W - 2 * PX)) / (rows.length - 1));
  const pts = rows.map((r, i) => [x(i), y(r.avgNaturalness)] as const);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${BOT + 6} L${pts[0][0].toFixed(1)} ${BOT + 6} Z`;
  const ty = y(threshold);
  const short = (s: string) => parseDay(s).toLocaleDateString("en", { month: "short", day: "numeric" });
  const draw = 0.9;
  const base = 0.35;

  return (
    <svg
      className="t-spark"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Daily average naturalness, ${rows.map((r) => `${short(r.day)} ${r.avgNaturalness.toFixed(1)}`).join(", ")}. Goal of ${threshold.toFixed(1)}.`}
    >
      <line className="flag" x1="0" x2={W} y1={ty} y2={ty} />
      <text x={W - 2} y={ty - 5} textAnchor="end">
        goal {threshold.toFixed(1)}
      </text>
      <motion.path
        className="area"
        d={area}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, ease: EASE, delay: base + draw * 0.6 }}
      />
      <motion.path
        className="ln"
        d={line}
        initial={reduce ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: draw, ease: EASE, delay: base }}
      />
      {pts.map(([px, py], i) => (
        <motion.circle
          key={rows[i].day}
          className={i === pts.length - 1 ? "dt last" : "dt"}
          cx={px}
          cy={py}
          r={i === pts.length - 1 ? 5 : 3.5}
          initial={reduce ? false : { scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 18, delay: base + (rows.length > 1 ? (draw * i) / (rows.length - 1) : 0.2) }}
        >
          <title>{`${short(rows[i].day)}: ${rows[i].avgNaturalness.toFixed(1)} of 3`}</title>
        </motion.circle>
      ))}
      <text x={pts[0][0]} y={H - 4} textAnchor={rows.length === 1 ? "middle" : "start"}>
        {short(rows[0].day)}
      </text>
      {rows.length > 1 && (
        <text x={pts[pts.length - 1][0]} y={H - 4} textAnchor="end">
          {short(rows[rows.length - 1].day)}
        </text>
      )}
    </svg>
  );
}

function ScoreCard({ patterns, overview, sum }: { patterns: Patterns | null | undefined; overview: Overview | null; sum: ReturnType<typeof summarize> }) {
  const rows = patterns?.trend.slice(-SPARK_DAYS) ?? [];
  const counts: [string, number | undefined][] = [
    ["screened", overview?.screened],
    ["queued", overview?.queued],
    ["reviewed", overview?.reviewed],
    ["pending", overview?.pending],
  ];
  const d = sum?.delta ?? null;
  const sign = d === null ? "" : d > 0 ? "+" : d < 0 ? "−" : "";

  return (
    <motion.section
      className="t-card t-score"
      aria-label="Naturalness"
      variants={rise}
      whileHover={{ y: -2, transition: { type: "spring", stiffness: 400, damping: 28 } }}
    >
      <div className="eyebrow">{sum ? (sum.isToday ? "Today's naturalness" : `Naturalness on ${sum.label}`) : "Naturalness"}</div>
      {sum ? (
        <>
          <div className="t-score-top">
            <div className={`t-big ${tone(sum.latest.avgNaturalness)}`}>
              <CountUp value={sum.latest.avgNaturalness} decimals={1} duration={1.1} />
              <small>of 3</small>
            </div>
            <div className="t-score-meta">
              <Meter value={sum.latest.avgNaturalness} word />
              {d !== null && (
                <motion.span
                  className={`t-delta ${d > 0 ? "up" : d < 0 ? "down" : "flat"}`}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 20, delay: 0.7 }}
                >
                  <i className={`ph ${d > 0 ? "ph-trend-up" : d < 0 ? "ph-trend-down" : "ph-minus"}`} aria-hidden="true" />
                  {d === 0 ? "No change" : `${sign}${Math.abs(d).toFixed(1)}`} vs {sum.rel}
                </motion.span>
              )}
            </div>
          </div>
          <Spark rows={rows} threshold={patterns?.threshold ?? 2} />
        </>
      ) : patterns === undefined ? (
        <div className="t-skel" style={{ height: 150 }} aria-hidden="true" />
      ) : (
        <p className="t-note">{patterns === null ? "The trend could not be loaded." : "The trend appears after the first run screens some messages."}</p>
      )}
      <div className="t-counts">
        {counts.map(([label, n]) => (
          <span key={label}>
            <b>{n === undefined ? "–" : <CountUp value={n} />}</b> {label}
          </span>
        ))}
      </div>
    </motion.section>
  );
}

function NextRunCard({ overview, onRunNow, now }: { overview: Overview | null; onRunNow: () => void; now: number }) {
  const running = overview?.running ?? false;
  const last = overview?.lastRun ?? null;
  return (
    <motion.section
      className="t-card t-next"
      aria-label="Next run"
      variants={rise}
      whileHover={{ y: -2, transition: { type: "spring", stiffness: 400, damping: 28 } }}
    >
      <div className="eyebrow">Next run</div>
      {overview ? (
        <>
          <div className="t-time">
            <motion.i
              className="ph ph-clock"
              aria-hidden="true"
              initial={{ rotate: -90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              transition={{ ...SOFT_SPRING, delay: 0.3 }}
            />
            {runDay(overview.nextRunAt, now)}, {hhmm(overview.nextRunAt)}
          </div>
          <p className="t-in">{countdown(overview.nextRunAt - now)}</p>
        </>
      ) : (
        <div className="t-skel" style={{ height: 58 }} aria-hidden="true" />
      )}
      <p className={`t-last${last && !last.ok ? " bad" : ""}`}>
        {running ? (
          <>
            <i className="ph ph-spinner spin" aria-hidden="true" /> A run is in progress
          </>
        ) : last ? (
          <>
            <i className={`ph ${last.ok ? "ph-check-circle" : "ph-warning-circle"}`} aria-hidden="true" />
            <span>
              {last.finishedAt === null ? `Last run started ${ago(last.startedAt)} and did not finish` : `Last run ${last.ok ? "finished" : "failed"} ${ago(last.finishedAt)}`}
              {!last.ok && last.detail && <em>{last.detail}</em>}
            </span>
          </>
        ) : (
          "Cadence has not run yet."
        )}
      </p>
      <div className={`t-run${running ? " running" : ""}`}>
        <button type="button" className="btn btn-primary" disabled={running || !overview} onClick={onRunNow}>
          <i className={running ? "ph ph-spinner spin" : "ph ph-play"} aria-hidden="true" />
          {running ? "Running" : "Run now"}
        </button>
      </div>
    </motion.section>
  );
}

type RowProps = {
  m: Message;
  i: number;
  open: boolean;
  intro: boolean;
  onToggle: () => void;
  notify: Notify;
  onReviewed: () => void;
};

// forwardRef: AnimatePresence popLayout needs the DOM node of the exiting row.
const Row = forwardRef<HTMLLIElement, RowProps>(function Row({ m, i, open, intro, onToggle, notify, onReviewed }, ref) {
  const reduce = useReducedMotion();
  const openRef = useRef(open);
  openRef.current = open;
  const id = `q-${m.id}`;

  return (
    <motion.li
      ref={ref}
      layout="position"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 56, scale: 0.97, transition: { duration: 0.3, ease: EASE } }}
      // transition.layout keeps the entrance delay off the slide-up of the rows below a removed one
      transition={{ duration: 0.45, ease: EASE, delay: intro ? 0.4 + Math.min(i, 8) * 0.05 : 0, layout: SOFT_SPRING }}
    >
      <div id={`row-${m.id}`} className={`t-item${open ? " open" : ""}`}>
        <button type="button" className="t-head" aria-expanded={open} aria-controls={id} onClick={onToggle}>
          <span className="t-rank">{i + 1}</span>
          <span className="t-main">
            <span className="t-text">{m.text}</span>
            <span className="t-meta">
              {m.project ? `${m.project} · ` : ""}
              {ago(m.ts)}
            </span>
          </span>
          <span className="t-side">
            {m.screen ? (
              <>
                <Meter value={m.screen.naturalness} />
                <IssueChip issue={m.screen.issue} />
              </>
            ) : (
              <span className="t-meta">Not screened yet</span>
            )}
          </span>
          <i className="ph ph-caret-down t-caret" aria-hidden="true" />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="body"
              id={id}
              className="t-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.38, ease: EASE }}
              onAnimationComplete={() => {
                // Bring a card that opened below the fold into view once it has its full height.
                if (openRef.current) document.getElementById(`row-${m.id}`)?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
              }}
            >
              <div className="t-body-in">
                {/* Reviewing a message and setting it aside both take it out of the queue. */}
                <MessageCard message={m} notify={notify} onReviewed={onReviewed} onExcluded={onReviewed} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.li>
  );
});

export function Today({ version, overview, notify, onRunNow }: { version: number; overview: Overview | null; notify: Notify; onRunNow: () => void }) {
  const [queue, setQueue] = useState<Message[] | null>(null);
  const [patterns, setPatterns] = useState<Patterns | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const intro = useRef(true);
  const now = useNow();

  const load = useCallback(() => {
    api.listMessages({ filter: "queue", limit: QUEUE_LIMIT, offset: 0 }).then(
      (list) => {
        setQueue(list);
        setError(null);
      },
      (e) => setError(errorText(e)),
    );
    // The trend is a nicety: if it fails the queue still works.
    api.patterns().then(
      (p) => setPatterns({ ...p, trend: [...p.trend].sort((a, b) => a.day.localeCompare(b.day)) }),
      () => setPatterns((prev) => prev ?? null),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load, version]);

  const ready = queue !== null;
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => (intro.current = false), 1600);
    return () => clearTimeout(t);
  }, [ready]);

  const sorted = useMemo(
    () =>
      queue &&
      [...queue].sort((a, b) => {
        if (!a.screen || !b.screen) return a.screen ? -1 : b.screen ? 1 : b.ts - a.ts;
        return a.screen.naturalness - b.screen.naturalness || b.ts - a.ts;
      }),
    [queue],
  );
  const sum = useMemo(() => (patterns ? summarize(patterns.trend, now) : null), [patterns, now]);

  if (sorted === null) {
    return error ? (
      <div className="empty" role="alert">
        <i className="ph ph-warning-circle" aria-hidden="true" />
        <h2>Could not load the queue</h2>
        <p>{error}</p>
        <button type="button" className="btn btn-ghost" onClick={load}>
          Retry
        </button>
      </div>
    ) : (
      <div className="today" role="status" aria-label="Loading">
        <div className="t-skel" style={{ height: 14, width: 150 }} />
        <div className="t-skel" style={{ height: 38, width: "62%", marginTop: 14 }} />
        <div className="t-skel" style={{ height: 16, width: "48%", marginTop: 14 }} />
        <div className="t-hero">
          <div className="t-skel" style={{ height: 250, borderRadius: 16 }} />
          <div className="t-skel" style={{ height: 250, borderRadius: 16 }} />
        </div>
        <div className="t-skel" style={{ height: 66, borderRadius: 12 }} />
      </div>
    );
  }

  // The queue is capped at QUEUE_LIMIT; past the cap the overview holds the real total.
  const total = sorted.length >= QUEUE_LIMIT && overview ? overview.queued : sorted.length;
  const date = new Date(now).toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long" });
  const lead =
    total === 0
      ? "Nothing is waiting right now."
      : `${total} ${total === 1 ? "message is" : "messages are"} worth a second look. Start with ${total === 1 ? "it" : "the one that sounds least natural"}.`;

  return (
    <motion.div className="today" variants={stagger(0.08)} initial="hidden" animate="show">
      <motion.header className="t-header" variants={rise}>
        <div className="eyebrow">{date}</div>
        <h1>{sum?.head ?? "Here is where you stand"}</h1>
        <p className="t-lead">{lead}</p>
      </motion.header>

      <div className="t-hero">
        <ScoreCard patterns={patterns} overview={overview} sum={sum} />
        <NextRunCard overview={overview} onRunNow={onRunNow} now={now} />
      </div>

      <motion.section className="t-queue" variants={rise} aria-label="Worst messages first">
        <div className="t-qhead">
          <h2>Worst messages first</h2>
          {total > 0 && <span className="muted">{total} waiting</span>}
        </div>
        {sorted.length === 0 ? (
          <div className="empty">
            <i className="ph ph-check-circle" aria-hidden="true" />
            <h2>Nothing is waiting</h2>
            <p>You have worked through everything Cadence flagged.</p>
          </div>
        ) : (
          <ul className="t-list">
            <AnimatePresence mode="popLayout" initial>
              {sorted.map((m, i) => (
                <Row
                  key={m.id}
                  m={m}
                  i={i}
                  open={openId === m.id}
                  intro={intro.current}
                  onToggle={() => setOpenId((cur) => (cur === m.id ? null : m.id))}
                  notify={notify}
                  onReviewed={() => {
                    setOpenId((cur) => (cur === m.id ? null : cur));
                    setQueue((list) => list?.filter((x) => x.id !== m.id) ?? list);
                  }}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </motion.section>
    </motion.div>
  );
}
