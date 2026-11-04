import { useEffect, useState } from "react";
import { api, ISSUE_LABEL, type Progress as ProgressData, type ProgressWeek } from "../api";
import { Practice } from "./Practice";
import { errorText, SAME_SCORE, type Notify } from "./shared";
import "../styles/progress.css";

const RANGES: [number, string][] = [
  [4, "4 weeks"],
  [8, "8 weeks"],
  [0, "All"],
];

const W = 600;
const H = 236;
const X0 = 44;
const X1 = 520;
const Y_TOP = 20;
const Y_BOT = 200;
const MAX = 3;

/** `YYYY-MM-DD` as a local date, so the Monday does not slip a day in other time zones. */
const parseDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const monthDay = (iso: string) => parseDay(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmt = (n: number) => n.toFixed(1);

function Chart({ weeks, goal }: { weeks: ProgressWeek[]; goal: number }) {
  const values = weeks.flatMap((w) => (w.afterRetries === null ? [w.firstDraft] : [w.firstDraft, w.afterRetries]));
  const yMin = Math.max(0, Math.floor(Math.min(...values) * 2) / 2 - 0.5);
  const y = (v: number) => Y_BOT - ((v - yMin) / (MAX - yMin)) * (Y_BOT - Y_TOP);

  const times = weeks.map((w) => parseDay(w.week).getTime());
  const span = times[times.length - 1] - times[0];
  const x = (i: number) => (weeks.length === 1 || span === 0 ? (X0 + X1) / 2 : X0 + ((times[i] - times[0]) / span) * (X1 - X0));

  const ticks: number[] = [];
  for (let t = yMin; t <= MAX + 1e-9; t += 0.5) ticks.push(t);

  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  const summary =
    weeks.length > 1
      ? `Weekly average first-draft score went from ${fmt(first.firstDraft)} in the week of ${monthDay(first.week)} to ${fmt(last.firstDraft)} in the week of ${monthDay(last.week)}. Goal ${fmt(goal)}.`
      : `First-draft score ${fmt(last.firstDraft)} in the week of ${monthDay(last.week)}. Goal ${fmt(goal)}.`;

  // After-retries: only consecutive non-null points are joined.
  const runs: { x: number; y: number }[][] = [];
  weeks.forEach((w, i) => {
    if (w.afterRetries === null) {
      runs.push([]);
      return;
    }
    if (!runs.length) runs.push([]);
    runs[runs.length - 1].push({ x: x(i), y: y(w.afterRetries) });
  });
  const lines = runs.filter((r) => r.length > 1);

  // Shaded band over each run of weeks where both series exist.
  const bands = lines.map((r) => {
    const idx = r.map((p) => weeks.findIndex((_, i) => x(i) === p.x));
    const top = r.map((p) => `${p.x},${p.y}`);
    const bottom = idx.map((i) => `${x(i)},${y(weeks[i].firstDraft)}`).reverse();
    return [...top, ...bottom].join(" ");
  });

  const step = Math.ceil(weeks.length / 10);
  const labelAt = weeks.map((_, i) => i % step === 0 || i === weeks.length - 1);
  let prevMonth = -1;
  const xLabels = weeks.map((w, i) => {
    if (!labelAt[i]) return null;
    const d = parseDay(w.week);
    const text = d.getMonth() !== prevMonth ? monthDay(w.week) : String(d.getDate());
    prevMonth = d.getMonth();
    return text;
  });
  const showValues = weeks.length <= 12;
  const goalY = y(goal);
  const lastX = x(weeks.length - 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="pg-svg">
      {ticks.map((t) => (
        <g key={t}>
          <line className={t === yMin ? "pg-axis" : "pg-grid"} x1={X0} x2={X1} y1={y(t)} y2={y(t)} />
          <text className="pg-tick" x={X0 - 10} y={y(t) + 4} textAnchor="end">
            {t.toFixed(1)}
          </text>
        </g>
      ))}
      <line className="pg-goal" x1={X0} x2={X1} y1={goalY} y2={goalY} />
      <text className="pg-goal-t" x={X1 + 6} y={goalY + 4}>
        Goal {fmt(goal)}
      </text>

      {bands.map((pts, i) => (
        <polygon key={i} className="pg-band" points={pts} />
      ))}
      {lines.map((r, i) => (
        <polyline key={i} className="pg-retry-line" points={r.map((p) => `${p.x},${p.y}`).join(" ")} />
      ))}
      {weeks.map(
        (w, i) =>
          w.afterRetries !== null && <circle key={i} className="pg-retry-dot" cx={x(i)} cy={y(w.afterRetries)} r={2.6} />,
      )}

      <polyline className="pg-line" points={weeks.map((w, i) => `${x(i)},${y(w.firstDraft)}`).join(" ")} />
      {weeks.map((w, i) => {
        const isLast = i === weeks.length - 1;
        const cy = y(w.firstDraft);
        const below = cy < Y_BOT - 18;
        return (
          <g key={i}>
            <circle className={isLast ? "pg-dot pg-dot-last" : "pg-dot"} cx={x(i)} cy={cy} r={isLast ? 5.5 : 4} />
            {showValues && !isLast && (
              <text className="pg-val" x={x(i)} y={below ? cy + 20 : cy - 11} textAnchor="middle">
                {fmt(w.firstDraft)}
              </text>
            )}
          </g>
        );
      })}
      <text className="pg-last-val" x={lastX + 10} y={y(last.firstDraft) + 4}>
        {fmt(last.firstDraft)}
      </text>
      <text className="pg-last-lbl" x={lastX + 10} y={y(last.firstDraft) + 18}>
        first draft
      </text>

      {xLabels.map(
        (t, i) =>
          t !== null && (
            <text key={i} className={i === weeks.length - 1 ? "pg-x pg-x-last" : "pg-x"} x={x(i)} y={222} textAnchor="middle">
              {t}
            </text>
          ),
      )}
    </svg>
  );
}

function Slips({ slips }: { slips: ProgressData["slips"] }) {
  const rows = slips.slice(0, 6);
  if (!rows.length) return <p className="pg-note">No flagged messages in the last 14 days.</p>;
  const max = Math.max(1, ...rows.flatMap((r) => [r.now, r.before]));
  const width = (n: number) => (n === 0 ? "0" : `${Math.max(4, (n / max) * 100)}%`);
  return (
    <section className="pg-card pg-slips" aria-label="Recurring slips">
      {rows.map((r) => {
        const d = r.now - r.before;
        const tone = d < 0 ? "down" : d > 0 ? "up" : "flat";
        const icon = d < 0 ? "ph-arrow-down" : d > 0 ? "ph-arrow-up" : "ph-arrow-right";
        const label = d < 0 ? `Down ${-d}` : d > 0 ? `Up ${d}` : "No change";
        return (
          <article key={r.issue} className="pg-slip">
            <div className="pg-slip-name">{ISSUE_LABEL[r.issue]}</div>
            <div className="pg-bars">
              <span>Before</span>
              <span className="pg-track pg-prev">
                <i style={{ width: width(r.before) }} />
              </span>
              <b>{r.before}</b>
              <span>Now</span>
              <span className="pg-track pg-now">
                <i style={{ width: width(r.now) }} />
              </span>
              <b>{r.now}</b>
            </div>
            <div className="pg-slip-row">
              <div className="pg-slip-n">
                {r.now}
                <small>times</small>
              </div>
              <span className={`pg-trend ${tone}`}>
                <i className={`ph ${icon}`} aria-hidden="true" />
                {label}
              </span>
            </div>
          </article>
        );
      })}
    </section>
  );
}

export function Progress({ version, notify }: { version: number; notify: Notify }) {
  const [range, setRange] = useState(8);
  const [data, setData] = useState<ProgressData | null>(null);

  useEffect(() => {
    let live = true;
    api.progress(range).then(
      (d) => live && setData(d),
      (e) => live && notify("Could not load progress", errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [range, version, notify]);

  const weeks = data?.weeks ?? [];
  const goal = data?.goal ?? 0;
  const firstW = weeks[0];
  const lastW = weeks[weeks.length - 1];
  const change = firstW && lastW ? lastW.firstDraft - firstW.firstDraft : 0;
  const tone = Math.abs(change) < SAME_SCORE ? "flat" : change > 0 ? "up" : "down";
  const icon = tone === "up" ? "ph-arrow-up" : tone === "down" ? "ph-arrow-down" : "ph-arrow-right";
  const sign = change > 0 ? "+" : change < 0 ? "-" : "";
  const toGo = lastW ? goal - lastW.firstDraft : 0;

  return (
    <div className="pg">
      <div className="pg-head">
        <div>
          <div className="pg-eyebrow">Progress</div>
          <h1 className="pg-h1">
            Are your <em>first drafts</em> getting better?
          </h1>
        </div>
        <div className="pg-range" role="group" aria-label="Period">
          {RANGES.map(([n, label]) => (
            <button key={n} type="button" className={range === n ? "on" : ""} aria-pressed={range === n} onClick={() => setRange(n)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {data && !weeks.length ? (
        <div className="empty">
          <p>No scored messages yet. Your weekly progress shows up once some messages are scored.</p>
        </div>
      ) : (
        lastW && (
          <>
            <section className="pg-card pg-hero" aria-label="First-draft score by week">
              <div className="pg-fig">
                <div className="pg-k">First drafts, this week</div>
                <div className="pg-big">
                  {fmt(lastW.firstDraft)}
                  <small> / 3</small>
                </div>
                {weeks.length > 1 && (
                  <>
                    <span className={`pg-delta ${tone}`}>
                      <i className={`ph ${icon}`} aria-hidden="true" />
                      {sign}
                      {fmt(Math.abs(change))}
                    </span>
                    <div className="pg-since">
                      since week of {monthDay(firstW.week)} ({fmt(firstW.firstDraft)})
                    </div>
                  </>
                )}
                <div className="pg-togo">
                  {lastW.firstDraft >= goal ? (
                    <b>Goal reached</b>
                  ) : (
                    <>
                      <b>{fmt(toGo)}</b> to goal of {fmt(goal)}
                    </>
                  )}
                </div>
              </div>

              <div className="pg-chart">
                <div className="pg-legend">
                  <span>
                    <span className="pg-key" />
                    First draft, weekly average
                  </span>
                  <span>
                    <span className="pg-key dash" />
                    After retries
                  </span>
                  <span>
                    <span className="pg-key goal" />
                    Goal
                  </span>
                </div>
                <div className="pg-scroll">
                  <Chart weeks={weeks} goal={goal} />
                </div>
                <table className="pg-sr">
                  <caption>Weekly average score</caption>
                  <thead>
                    <tr>
                      <th>Week of</th>
                      <th>First draft</th>
                      <th>After retries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weeks.map((w) => (
                      <tr key={w.week}>
                        <td>{monthDay(w.week)}</td>
                        <td>{fmt(w.firstDraft)}</td>
                        <td>{w.afterRetries === null ? "none" : fmt(w.afterRetries)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            {weeks.length < 2 && (
              <p className="pg-note">
                Only messages scored under the current scoring are counted, so older weeks may be missing.
              </p>
            )}
          </>
        )
      )}

      <div className="pg-sec">
        <h2>Recurring slips</h2>
        <span className="pg-meta">Last 7 days vs the 7 before</span>
      </div>
      {data && <Slips slips={data.slips} />}

      <div className="pg-sec">
        <h2>Practice</h2>
      </div>
      <Practice version={version} notify={notify} />
    </div>
  );
}
