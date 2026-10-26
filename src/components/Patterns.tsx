import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useInView, AnimatePresence, type Variants } from "motion/react";
import { api, ISSUE_LABEL, type Patterns } from "../api";
import { CountUp, EASE, rise, stagger } from "../motion";
import { errorText, type Notify } from "./shared";
import "../styles/patterns.css";

const W = 640;
const H = 240;
const PAD = { l: 36, r: 12, t: 12, b: 28 };
const DAY_MS = 86_400_000;
/** Fewer screened messages than this on either side and a verdict would be noise. */
const MIN_SAMPLE = 5;

const rate = (flagged: number, screened: number) => (screened ? flagged / screened : 0);

/** Percent as a counting number, or "n/a" when nothing was screened. */
function Pct({ r, screened }: { r: number; screened: number }) {
  if (!screened) return <>n/a</>;
  return (
    <>
      <CountUp value={Math.round(r * 100)} />%
    </>
  );
}

// An orchestrator with no motion of its own: it keeps a section's stagger from reaching deeper children.
const hold: Variants = { hidden: {}, show: {} };

const sectionV: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: (delay: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, ease: EASE, delay, staggerChildren: 0.08, delayChildren: delay + 0.1 },
  }),
};

const barV: Variants = {
  hidden: { width: 0 },
  show: (pct: number) => ({ width: `${pct}%`, transition: { duration: 0.9, ease: EASE, delay: 0.15 } }),
};

const cellBarV: Variants = {
  hidden: { height: 0 },
  show: ({ pct, d }: { pct: number; d: number }) => ({
    height: `${pct}%`,
    transition: { duration: 0.6, ease: EASE, delay: 0.1 + d },
  }),
};

const badgeV: Variants = {
  hidden: { opacity: 0, scale: 0.6 },
  show: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 480, damping: 17, delay: 0.3 } },
};

const lineV: Variants = {
  hidden: { pathLength: 0, opacity: 0 },
  show: {
    pathLength: 1,
    opacity: 1,
    transition: { pathLength: { duration: 1.4, ease: EASE, delay: 0.25 }, opacity: { duration: 0.2, delay: 0.25 } },
  },
};

const fadeIn = (delay: number, duration = 0.5): Variants => ({
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration, ease: EASE, delay } },
});

// Dots pop in as the line passes them, so `at` is the dot's share of the line (0..1).
const dotV: Variants = {
  hidden: { opacity: 0, scale: 0 },
  show: (at: number) => ({
    opacity: 1,
    scale: 1,
    transition: { type: "spring", stiffness: 520, damping: 16, delay: 0.4 + at * 0.95 },
  }),
};

/** A card that reveals once it scrolls into view, then staggers its children in. */
function Section({ title, lead, delay, children }: { title: string; lead: string; delay: number; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.12 });
  return (
    <motion.section
      ref={ref}
      className="surface pat-sec"
      variants={sectionV}
      custom={delay}
      initial="hidden"
      animate={seen ? "show" : "hidden"}
    >
      <motion.header variants={rise} className="pat-sec-head">
        <h2>{title}</h2>
        <p className="lead">{lead}</p>
      </motion.header>
      <motion.div variants={hold}>{children}</motion.div>
    </motion.section>
  );
}

function WeekRowCells({
  label,
  row,
  cells,
}: {
  label: string;
  row: number;
  cells: { week: string; n: number; s: number }[];
}) {
  return (
    <>
      <span className="bar-label">{label}</span>
      {cells.map(({ week, n, s }, col) => {
        const r = rate(n, s);
        return (
          <span key={week} className="week-cell" title={`${label}, week of ${week}: ${n} of ${s} screened`}>
            <motion.span
              className="week-bar"
              variants={cellBarV}
              custom={{ pct: Math.round(r * 100), d: (row + col) * 0.045 }}
            />
            <span className="week-pct">{s ? `${Math.round(r * 100)}%` : "-"}</span>
          </span>
        );
      })}
    </>
  );
}

const VERDICT_LOOK: Record<string, { tone: string; icon: string }> = {
  "Not enough data yet": { tone: "few", icon: "ph-hourglass-medium" },
  "No change": { tone: "same", icon: "ph-equals" },
  Down: { tone: "down", icon: "ph-arrow-down" },
  Up: { tone: "up", icon: "ph-arrow-up" },
};

export function PatternsView({ version, notify }: { version: number; notify: Notify }) {
  const [data, setData] = useState<Patterns | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    api.patterns().then(setData, (e) => notify("Could not load patterns", errorText(e)));
  }, [version, notify]);

  if (!data) return <p className="muted">Loading</p>;

  const issues = data.issues.filter((r) => r.issue !== "none").sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...issues.map((r) => r.count));
  const trend = data.trend;
  const screened = trend.reduce((n, t) => n + t.count, 0);
  const x = (i: number) =>
    trend.length === 1 ? (W + PAD.l - PAD.r) / 2 : PAD.l + (i * (W - PAD.l - PAD.r)) / (trend.length - 1);
  const y = (v: number) => PAD.t + (1 - v / 3) * (H - PAD.t - PAD.b);
  const line = trend.map((t, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(t.avgNaturalness).toFixed(1)}`).join(" ");
  const every = Math.ceil(trend.length / 6);

  // Trailing 7 calendar days ending at each day, weighted by message count; empty days add nothing.
  const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
  const rolling = trend.map((t, i) => {
    const end = dayNum(t.day);
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0 && end - dayNum(trend[j].day) < 7; j--) {
      sum += trend[j].avgNaturalness * trend[j].count;
      n += trend[j].count;
    }
    return n ? sum / n : t.avgNaturalness;
  });
  const rollLine = rolling.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const goal = Math.min(3, Math.max(0, data.threshold));

  // Area under the daily line, closed down to the axis, so the trend reads as a shape.
  const area = trend.length > 1 ? `${line} L${x(trend.length - 1).toFixed(1)} ${y(0)} L${x(0).toFixed(1)} ${y(0)} Z` : "";
  // Each point owns a full-height column so dense charts stay easy to hover and tab through.
  const step = trend.length > 1 ? (W - PAD.l - PAD.r) / (trend.length - 1) : W - PAD.l - PAD.r;
  const active = hover !== null && hover < trend.length ? hover : null;
  const tipLeft = active === null ? 0 : (x(active) / W) * 100;

  const coached = data.coachedImpact;
  const weeks = data.weeks.slice(-12);
  const screenedOf = new Map(weeks.map((w) => [w.week, w.screened]));
  const counts = new Map<string, number>();
  for (const r of data.issueWeeks) counts.set(`${r.issue}|${r.week}`, r.count);
  const weekIssues = issues.filter((r) => weeks.some((w) => counts.get(`${r.issue}|${w.week}`)));

  return (
    <div className="patterns">
      <motion.header className="pg-head" variants={stagger(0.07)} initial="hidden" animate="show">
        <motion.div variants={rise} className="eyebrow">
          {screened} screened {screened === 1 ? "message" : "messages"}
        </motion.div>
        <motion.h1 variants={rise}>Patterns</motion.h1>
        <motion.p variants={rise} className="sub">
          The same few slips come back. Fix these and your average moves the most.
        </motion.p>
      </motion.header>

      <Section title="Where you lose naturalness" lead="The slips that show up most in your flagged messages." delay={0.12}>
        {issues.length === 0 ? (
          <p className="muted">No issues found yet.</p>
        ) : (
          <motion.ol className="bar-list" variants={stagger(0.07)}>
            {issues.map((r, i) => (
              <motion.li key={r.issue} className={`bar-row${i === 0 ? " top" : ""}`} variants={rise}>
                <span className="bar-label">{ISSUE_LABEL[r.issue]}</span>
                <span className="bar-track">
                  <motion.span className="bar-fill" variants={barV} custom={(r.count / max) * 100} />
                </span>
                <span className="bar-num">
                  <CountUp value={r.count} />
                </span>
                <span className="bar-avg">
                  avg <CountUp value={r.avgNaturalness} decimals={1} />
                </span>
              </motion.li>
            ))}
          </motion.ol>
        )}
      </Section>

      <Section title="Naturalness over time" lead="Your daily average and its 7-day rolling average, against your goal." delay={0.2}>
        {trend.length === 0 ? (
          <p className="muted">Nothing screened yet.</p>
        ) : (
          <>
            <div className="chart-wrap" onPointerLeave={() => setHover(null)}>
              <motion.svg
                className="chart"
                variants={hold}
                viewBox={`0 0 ${W} ${H}`}
                role="img"
                aria-label={`Daily average naturalness, 0 to 3, with a 7-day rolling average and a goal of ${data.threshold.toFixed(1)}. Latest rolling average ${rolling[rolling.length - 1].toFixed(2)}.`}
              >
                <defs>
                  <linearGradient id="pat-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" className="area-top" />
                    <stop offset="100%" className="area-bottom" />
                  </linearGradient>
                </defs>
                {[0, 1, 2, 3].map((v) => (
                  <motion.g key={v} variants={fadeIn(0.05 + v * 0.06)}>
                    <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
                    <text className="axis" x={PAD.l - 8} y={y(v)} dy="0.35em" textAnchor="end">
                      {v}
                    </text>
                  </motion.g>
                ))}
                <motion.g variants={fadeIn(0.3, 0.7)}>
                  <line className="goal" x1={PAD.l} x2={W - PAD.r} y1={y(goal)} y2={y(goal)} />
                  <text className="goal-label" x={W - PAD.r - 4} y={y(goal) - 5} textAnchor="end">
                    {`goal ${data.threshold.toFixed(1)}`}
                  </text>
                </motion.g>
                {area && <motion.path className="area" d={area} variants={fadeIn(1.1, 0.8)} />}
                <motion.path className="line" d={line} variants={lineV} />
                <motion.path className="roll" d={rollLine} variants={fadeIn(1.5, 0.7)} />
                {active !== null && <line className="cursor" x1={x(active)} x2={x(active)} y1={PAD.t} y2={y(0)} />}
                {trend.map((t, i) => (
                  <g key={t.day}>
                    <motion.circle
                      className={`dot${active === i ? " on" : ""}`}
                      cx={x(i)}
                      cy={y(t.avgNaturalness)}
                      r={3.5}
                      variants={dotV}
                      custom={trend.length > 1 ? i / (trend.length - 1) : 0}
                      style={{ transformBox: "fill-box", transformOrigin: "center" }}
                    />
                    {i % every === 0 && (
                      <text className="axis" x={x(i)} y={H - 8} textAnchor="middle">
                        {t.day.slice(5)}
                      </text>
                    )}
                  </g>
                ))}
                {trend.map((t, i) => (
                  <rect
                    key={t.day}
                    className="hit"
                    x={trend.length > 1 ? x(i) - step / 2 : PAD.l}
                    y={PAD.t}
                    width={step}
                    height={H - PAD.t - PAD.b}
                    tabIndex={0}
                    onPointerEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                  >
                    <title>{`${t.day}: ${t.avgNaturalness.toFixed(2)} from ${t.count} messages. 7-day average ${rolling[i].toFixed(2)}`}</title>
                  </rect>
                ))}
              </motion.svg>
              <AnimatePresence>
                {active !== null && (
                  <div
                    key="tip"
                    className="chart-tip-pos"
                    aria-hidden="true"
                    style={{
                      left: `${tipLeft}%`,
                      top: `${(y(trend[active].avgNaturalness) / H) * 100}%`,
                      transform: `translate(${tipLeft < 14 ? "-14%" : tipLeft > 86 ? "-86%" : "-50%"}, -100%)`,
                    }}
                  >
                    <motion.div
                      className="chart-tip"
                      initial={{ opacity: 0, y: 6, scale: 0.94 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 4, scale: 0.96 }}
                      transition={{ duration: 0.16, ease: EASE }}
                    >
                      <span className="tip-day">{trend[active].day}</span>
                      <span className="tip-num">{trend[active].avgNaturalness.toFixed(2)}</span>
                      <span className="tip-meta">
                        {trend[active].count} {trend[active].count === 1 ? "message" : "messages"} · 7-day{" "}
                        {rolling[active].toFixed(2)}
                      </span>
                    </motion.div>
                  </div>
                )}
              </AnimatePresence>
            </div>
            <p className="legend">
              <span><i className="key key-daily" /> Daily average (solid)</span>
              <span><i className="key key-roll" /> 7-day rolling average (dashed)</span>
              <span><i className="key key-goal" /> Goal {data.threshold.toFixed(1)} (dotted)</span>
            </p>
            <p className="note">
              Daily average over {screened} screened messages; latest 7-day average is {rolling[rolling.length - 1].toFixed(2)}.
              Higher is more natural. Hover a dot for its 7-day value.
            </p>
          </>
        )}
      </Section>

      <Section title="Your coached issues" lead="Did the flag rate drop after you practised an issue?" delay={0.28}>
        {coached.length === 0 ? (
          <p className="muted">Nothing coached yet. Once you rewrite a flagged message, its issue shows up here.</p>
        ) : (
          <>
            <motion.ul className="impact-list" variants={stagger(0.08)}>
              {coached.map((c) => {
                const enough = c.beforeScreened >= MIN_SAMPLE && c.afterScreened >= MIN_SAMPLE;
                const before = rate(c.beforeFlagged, c.beforeScreened);
                const after = rate(c.afterFlagged, c.afterScreened);
                const verdict = !enough
                  ? "Not enough data yet"
                  : Math.abs(after - before) < 0.02
                    ? "No change"
                    : after < before
                      ? "Down"
                      : "Up";
                const look = VERDICT_LOOK[verdict];
                return (
                  <motion.li key={c.issue} className="impact-row" variants={rise}>
                    <span className="bar-label">{ISSUE_LABEL[c.issue]}</span>
                    <span className="impact-side">
                      <span className="impact-line">
                        Before <b><Pct r={before} screened={c.beforeScreened} /></b>
                        <span className="muted"> {c.beforeFlagged} of {c.beforeScreened}</span>
                      </span>
                      <span className="mini">
                        <motion.span className="mini-fill before" variants={barV} custom={before * 100} />
                      </span>
                    </span>
                    <span className="impact-side">
                      <span className="impact-line">
                        After <b><Pct r={after} screened={c.afterScreened} /></b>
                        <span className="muted"> {c.afterFlagged} of {c.afterScreened}</span>
                      </span>
                      <span className="mini">
                        <motion.span className="mini-fill after" variants={barV} custom={after * 100} />
                      </span>
                    </span>
                    <motion.span className={`impact-verdict ${look.tone}`} variants={badgeV}>
                      <i className={`ph ${look.icon}`} aria-hidden="true" />
                      {verdict}
                    </motion.span>
                  </motion.li>
                );
              })}
            </motion.ul>
            <p className="note">
              Flag rate before vs after you first coached each issue. A before/after comparison, not proof of cause.
            </p>
          </>
        )}
      </Section>

      <Section title="Issues by week" lead="How much of each week's writing carried each slip." delay={0.36}>
        {weeks.length === 0 || weekIssues.length === 0 ? (
          <p className="muted">No flagged issues by week yet.</p>
        ) : (
          <>
            <div className="week-scroll">
              <div className="week-grid" style={{ gridTemplateColumns: `150px repeat(${weeks.length}, minmax(34px, 1fr))` }}>
                <span />
                {weeks.map((w) => (
                  <span key={w.week} className="week-head" title={`Week of ${w.week}, ${w.screened} screened`}>
                    {w.week.slice(5)}
                  </span>
                ))}
                {weekIssues.map((r, row) => (
                  <WeekRowCells
                    key={r.issue}
                    label={ISSUE_LABEL[r.issue]}
                    row={row}
                    cells={weeks.map((w) => {
                      const n = counts.get(`${r.issue}|${w.week}`) ?? 0;
                      const s = screenedOf.get(w.week) ?? 0;
                      return { week: w.week, n, s };
                    })}
                  />
                ))}
              </div>
            </div>
            <p className="note">Share of screened messages flagged for each issue, per week (week start date). Lower is better.</p>
          </>
        )}
      </Section>
    </div>
  );
}
