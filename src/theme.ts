import { useCallback, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "cadence.theme";

const read = (): Theme => {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
};

const apply = (t: Theme) => {
  document.documentElement.dataset.theme = t;
};

/** Sets the saved theme before the first paint so the window never flashes the wrong one. */
export function initTheme() {
  apply(read());
}

type ViewTransitionDocument = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read);

  /** `origin` is the toggle's centre: the new theme spreads from there as a circle. */
  const toggle = useCallback(
    (origin?: { x: number; y: number }) => {
      const next: Theme = theme === "light" ? "dark" : "light";
      const commit = () => {
        apply(next);
        setTheme(next);
        try {
          localStorage.setItem(KEY, next);
        } catch {
          /* the choice just does not persist */
        }
      };
      const doc = document as ViewTransitionDocument;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!doc.startViewTransition || reduced) {
        commit();
        return;
      }
      const x = origin?.x ?? window.innerWidth / 2;
      const y = origin?.y ?? 0;
      const root = document.documentElement.style;
      root.setProperty("--vx", `${x}px`);
      root.setProperty("--vy", `${y}px`);
      root.setProperty("--vr", `${Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))}px`);
      doc.startViewTransition(commit);
    },
    [theme],
  );

  return { theme, toggle };
}
