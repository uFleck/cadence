import { motion } from "motion/react";
import { ISSUE_LABEL, type Issue } from "../api";
import { EASE } from "../motion";

export type Notify = (title: string, lead: string) => void;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

export function ago(ts: number) {
  const s = (ts - Date.now()) / 1000;
  for (const [unit, size] of UNITS) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "just now";
}

export const when = (ts: number) => new Date(ts).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

const TONE_WORD = { low: "Needs work", mid: "Fair", high: "Natural" } as const;

/**
 * Four steps for 0..3: a step lights for each whole level reached, and the number is always shown next to it.
 * The bars grow in one after another; `word` adds the plain-language reading for roomier layouts.
 */
export function Meter({ value, word = false }: { value: number; word?: boolean }) {
  const lit = Math.min(4, Math.max(1, Math.floor(value) + 1));
  const tone = value < 1 ? "low" : value < 2 ? "mid" : "high";
  return (
    <span className={`meter ${tone}`} role="img" aria-label={`Naturalness ${value.toFixed(1)} of 3, ${TONE_WORD[tone]}`}>
      <span className="bars" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <motion.i
            key={i}
            className={i < lit ? "on" : undefined}
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{ duration: 0.4, ease: EASE, delay: 0.05 * i }}
          />
        ))}
      </span>
      <span className="num">{value.toFixed(1)}</span>
      {word && <span className="word">{TONE_WORD[tone]}</span>}
    </span>
  );
}

export function IssueChip({ issue }: { issue: Issue }) {
  return <span className={`chip${issue === "none" ? " ok" : ""}`}>{ISSUE_LABEL[issue]}</span>;
}
