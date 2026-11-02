import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { EASE } from "../motion";
import { Meter } from "./shared";

export type TrailStep = { label: string; value: number };

/** Tries shown at each end while the middle is folded: "Try 1 → Try 2 → … → Try 8 → Try 9". */
const EDGE = 2;

type Item = { kind: "step"; step: TrailStep; latest: boolean } | { kind: "gap"; hidden: number };

/**
 * Original, then the tries. With many tries only the first and last two stay in view and the middle
 * folds into one "N more" button, so the line never wraps into a wall of numbers.
 */
function fold(steps: TrailStep[], open: boolean): Item[] {
  const [original, ...tries] = steps;
  const all = (list: TrailStep[], offset: number): Item[] =>
    list.map((step, i) => ({ kind: "step", step, latest: offset + i === steps.length - 1 }));
  if (open || tries.length <= EDGE * 2) return all(steps, 0);
  const head = tries.slice(0, EDGE);
  const tail = tries.slice(-EDGE);
  return [
    ...all([original, ...head], 0),
    { kind: "gap", hidden: tries.length - EDGE * 2 },
    ...all(tail, steps.length - EDGE),
  ];
}

export function ScoreTrail({ steps }: { steps: TrailStep[] }) {
  const [open, setOpen] = useState(false);
  const foldable = steps.length - 1 > EDGE * 2;
  const items = fold(steps, open);

  return (
    <ol className="trail" aria-label="Naturalness of each version">
      <AnimatePresence initial>
        {items.map((item, i) =>
          item.kind === "gap" ? (
            <motion.li
              key="gap"
              layout
              className="trail-gap"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.14 } }}
              transition={{ duration: 0.3, ease: EASE, delay: 0.07 * Math.min(i, 5) }}
            >
              <button
                type="button"
                className="trail-more"
                onClick={() => setOpen(true)}
                aria-label={`Show the ${item.hidden} tries in between`}
                title={`Show the ${item.hidden} tries in between`}
              >
                +{item.hidden} more
              </button>
            </motion.li>
          ) : (
            <motion.li
              key={item.step.label}
              layout
              className={item.latest ? "trail-step latest" : "trail-step"}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -6, transition: { duration: 0.14 } }}
              transition={{ duration: 0.38, ease: EASE, delay: 0.07 * Math.min(i, 5) }}
            >
              <span className="trail-label">{item.step.label}</span>
              <Meter value={item.step.value} />
            </motion.li>
          ),
        )}
      </AnimatePresence>
      {foldable && open && (
        <motion.li layout className="trail-gap trail-end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
          <button type="button" className="trail-more" onClick={() => setOpen(false)}>
            Show less
          </button>
        </motion.li>
      )}
    </ol>
  );
}
