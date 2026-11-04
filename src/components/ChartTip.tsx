import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE } from "../motion";
import "../styles/chart.css";

/**
 * The hover read-out every chart shares. Put it inside a `.chart-wrap` (position: relative) next to the SVG and give
 * it the hovered point as percentages of the wrapper. Its body is `tip-day`, `tip-num` and `tip-meta` spans.
 */
export function ChartTip({ at, children }: { at: { left: number; top: number } | null; children: ReactNode }) {
  return (
    <AnimatePresence>
      {at && (
        <div
          key="tip"
          className="chart-tip-pos"
          aria-hidden="true"
          style={{
            left: `${at.left}%`,
            top: `${at.top}%`,
            transform: `translate(${at.left < 14 ? "-14%" : at.left > 86 ? "-86%" : "-50%"}, -100%)`,
          }}
        >
          <motion.div
            className="chart-tip"
            initial={{ opacity: 0, y: 6, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.96 }}
            transition={{ duration: 0.16, ease: EASE }}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
