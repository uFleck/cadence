import { animate, useInView, useReducedMotion, type Variants } from "motion/react";
import { useEffect, useRef, useState } from "react";

/** Shared easing so every surface moves with the same feel. */
export const EASE = [0.22, 1, 0.36, 1] as const;
export const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;
export const SOFT_SPRING = { type: "spring", stiffness: 220, damping: 26 } as const;

/** A column of things that arrive one after another. Put on the parent; children use `rise`. */
export const stagger = (gap = 0.06, delay = 0): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: gap, delayChildren: delay } },
});

export const rise: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } },
};

export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.35, ease: EASE } },
};

/**
 * A number that counts up to its value. The final text is always the exact value;
 * with reduced motion it simply is the value from the first frame.
 */
export function CountUp({
  value,
  decimals = 0,
  duration = 0.9,
  className,
}: {
  value: number;
  decimals?: number;
  duration?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, { once: true });
  const from = useRef(0);
  const [shown, setShown] = useState(reduced ? value : 0);

  useEffect(() => {
    if (reduced) {
      setShown(value);
      return;
    }
    if (!seen) return;
    const controls = animate(from.current, value, {
      duration,
      ease: EASE,
      onUpdate: setShown,
    });
    from.current = value;
    return () => controls.stop();
  }, [value, duration, reduced, seen]);

  return (
    <span ref={ref} className={className}>
      {shown.toFixed(decimals)}
    </span>
  );
}
