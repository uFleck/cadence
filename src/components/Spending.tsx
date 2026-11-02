import { useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { api, USAGE_KIND_LABEL, type Spending, type UsageCall, type UsageTotals } from "../api";
import { rise, stagger } from "../motion";
import { ago, errorText, usd, type Notify } from "./shared";
import "../styles/spending.css";

const W = 640;
const H = 200;
const PAD = { l: 52, r: 12, t: 12, b: 26 };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shortDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const dateOnly = (ts: number) => new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const stamp = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const TILES: [string, "today" | "week" | "month" | "allTime"][] = [
  ["Today", "today"],
  ["Last 7 days", "week"],
  ["Last 30 days", "month"],
  ["All time", "allTime"],
];

/** The page frame: header plus a stagger for everything inside it. */
function Frame({ busy = false, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <motion.div className="spending" variants={stagger(0.07)} initial="hidden" animate="show" aria-busy={busy || undefined}>
      <motion.header className="sp-head" variants={rise}>
        <div className="eyebrow">What Cadence spends</div>
        <h1>Spending</h1>
      </motion.header>
      {children}
    </motion.div>
  );
}

function Tile({ label, t }: { label: string; t: UsageTotals }) {
  return (
    <motion.div className="surface sp-tile" variants={rise}>
      <span className="sp-tile-label">{label}</span>
      <span className="sp-tile-cost">{usd(t.costUsd)}</span>
      <span className="sp-tile-meta">
        {plural(t.claudeCalls, "Claude call")} · {plural(t.jevCalls, "TypeSafe screen")}
      </span>
    </motion.div>
  );
}

function DayChart({ days }: { days: Spending["days"] }) {
  const peak = Math.max(0, ...days.map((d) => d.costUsd));
  const total = days.reduce((n, d) => n + d.costUsd, 0);
  // With no spend at all the scale still needs a height, so it runs to 1 dollar.
  const scale = peak > 0 ? peak : 1;
  const plotH = H - PAD.t - PAD.b;
  const slot = (W - PAD.l - PAD.r) / Math.max(1, days.length);
  const barW = slot * 0.64;
  const y = (v: number) => PAD.t + (1 - v / scale) * plotH;
  const first = days[0];
  const lastDay = days[days.length - 1];

  return (
    <>
      <svg
        className="sp-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Claude spending per day over the last ${days.length} days: ${usd(total)} in total, highest day ${usd(peak)}.`}
      >
        <line className="sp-grid" x1={PAD.l} x2={W - PAD.r} y1={PAD.t} y2={PAD.t} />
        <text className="sp-axis" x={PAD.l - 8} y={PAD.t} dy="0.35em" textAnchor="end">
          {usd(peak)}
        </text>
        <line className="sp-base" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
        <text className="sp-axis" x={PAD.l - 8} y={y(0)} dy="0.35em" textAnchor="end">
          {usd(0)}
        </text>
        {days.map((d, i) => {
          const x = PAD.l + i * slot + (slot - barW) / 2;
          // A zero day draws a 1px tick on the baseline so it still reads as a day.
          const yTop = d.costUsd > 0 ? y(d.costUsd) : y(0) - 1;
          const label = `${shortDay(d.day)}: ${usd(d.costUsd)}, ${plural(d.claudeCalls, "Claude call")}, ${plural(d.jevCalls, "screen")}`;
          return (
            <rect key={d.day} className={`sp-bar${d.costUsd > 0 ? "" : " zero"}`} x={x} y={yTop} width={barW} height={y(0) - yTop} rx={2}>
              <title>{label}</title>
            </rect>
          );
        })}
        {first && (
          <text className="sp-axis" x={PAD.l} y={H - 6}>
            {shortDay(first.day)}
          </text>
        )}
        {lastDay && (
          <text className="sp-axis" x={W - PAD.r} y={H - 6} textAnchor="end">
            {shortDay(lastDay.day)}
          </text>
        )}
      </svg>
      <p className="sp-note">
        Hover a bar for its day. Highest day {usd(peak)}; {usd(total)} over the last {days.length} days.
      </p>
    </>
  );
}

function CallRow({ c }: { c: UsageCall }) {
  const cache = c.cacheReadTokens + c.cacheWriteTokens;
  return (
    <tr>
      <td>
        <time dateTime={new Date(c.at).toISOString()} title={stamp(c.at)}>
          {ago(c.at)}
        </time>
      </td>
      <td>{USAGE_KIND_LABEL[c.kind]}</td>
      <td>
        {c.preview === null ? (
          <span className="muted">(deleted message)</span>
        ) : (
          <span className="sp-preview" title={c.preview}>
            {c.preview}
          </span>
        )}
        {!c.ok && <span className="sp-tag">Answer unreadable</span>}
      </td>
      <td className="sp-model">{c.model}</td>
      <td className="num">
        {c.inputTokens.toLocaleString()} / {c.outputTokens.toLocaleString()}
        {cache > 0 && <span className="sp-cache"> +{cache.toLocaleString()} cache</span>}
      </td>
      <td className="num">{(c.durationMs / 1000).toFixed(1)} s</td>
      <td className="num">{c.costUsd === null ? "n/a" : usd(c.costUsd)}</td>
    </tr>
  );
}

export function SpendingView({ version, notify }: { version: number; notify: Notify }) {
  const [data, setData] = useState<Spending | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let current = true;
    setFailed(false);
    api.spending().then(
      (s) => {
        if (current) setData(s);
      },
      (e) => {
        if (!current) return;
        setFailed(true);
        notify("Could not load spending", errorText(e));
      },
    );
    return () => {
      current = false;
    };
  }, [version, retry, notify]);

  if (!data && failed) {
    return (
      <Frame>
        <div className="surface sp-error" role="alert">
          <span>Could not load spending.</span>
          <button type="button" className="btn" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      </Frame>
    );
  }

  if (!data) {
    return (
      <Frame busy>
        <div className="sp-tiles">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="sp-skel sp-skel-tile" />
          ))}
        </div>
        <div className="sp-skel sp-skel-chart" />
      </Frame>
    );
  }

  if (data.since === null) {
    return (
      <Frame>
        <motion.section className="surface sp-empty" variants={rise}>
          <i className="ph ph-coins" aria-hidden="true" />
          <h2>Nothing tracked yet</h2>
          <p>Costs appear after your next rewrite review or interview feedback.</p>
        </motion.section>
      </Frame>
    );
  }

  return (
    <Frame>
      <div className="sp-tiles">
        {TILES.map(([label, key]) => (
          <Tile key={key} label={label} t={data[key]} />
        ))}
      </div>

      <motion.p className="sp-note" variants={rise}>
        Claude costs are the list-price equivalent that <code>claude -p</code> reports; on a subscription you are not charged that
        part. TypeSafe charges $0.042 per million input tokens and nothing for output, but does not report the count, so its part is
        an estimate from the size of each request.
        {` Tracked since ${dateOnly(data.since)}; earlier spending is not counted.`}
      </motion.p>

      <motion.section className="surface sp-sec" variants={rise}>
        <h2>Per day</h2>
        <DayChart days={data.days} />
      </motion.section>

      <motion.section className="surface sp-sec" variants={rise}>
        <h2>By kind</h2>
        <ul className="sp-kinds">
          {data.byKind.map((k) => (
            <li key={k.kind} className="sp-kind">
              <span>{USAGE_KIND_LABEL[k.kind]}</span>
              <span className="muted">{plural(k.calls, "call")}</span>
              <span className="sp-kind-cost">{k.kind === "screen" ? `≈ ${usd(k.costUsd)}` : usd(k.costUsd)}</span>
            </li>
          ))}
        </ul>
      </motion.section>

      <motion.section className="surface sp-sec" variants={rise}>
        <h2>Every response</h2>
        {data.recent.length === 0 ? (
          <p className="muted">No Claude calls yet.</p>
        ) : (
          <div className="sp-scroll">
            <table className="sp-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Message</th>
                  <th scope="col">Model</th>
                  <th scope="col" className="num">Tokens in / out</th>
                  <th scope="col" className="num">Time</th>
                  <th scope="col" className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((c) => (
                  <CallRow key={c.id} c={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.section>
    </Frame>
  );
}
