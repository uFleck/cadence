import { useEffect, useLayoutEffect, useRef, useState } from "react";

const SHOW_MS = 350;
const GAP = 8;
const EDGE = 8;

type Tip = { text: string; target: Element };

/**
 * The app's only tooltip. Mounted once in `App`; any element with a `data-tip="text"` attribute (HTML or SVG)
 * gets it on hover or keyboard focus. Never use the native `title` attribute: the webview draws its own
 * unstyled pop-up for it.
 */
export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    const find = (e: Event) => (e.target instanceof Element ? e.target.closest("[data-tip]") : null);
    const hide = () => {
      window.clearTimeout(timer);
      setTip(null);
      setAt(null);
    };
    const show = (target: Element) => {
      const text = target.getAttribute("data-tip");
      if (text) setTip({ text, target });
    };
    const over = (e: MouseEvent) => {
      const el = find(e);
      window.clearTimeout(timer);
      if (!el) return hide();
      timer = window.setTimeout(() => show(el), SHOW_MS);
    };
    const focus = (e: FocusEvent) => {
      const el = find(e);
      if (el && el.matches(":focus-visible")) show(el);
    };
    const gone = new MutationObserver(() => {
      setTip((t) => (t && !t.target.isConnected ? null : t));
    });
    gone.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("keydown", hide);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      gone.disconnect();
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("keydown", hide);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Below the element, centred; above it when there is no room; always inside the window.
  useLayoutEffect(() => {
    if (!tip || !box.current) return;
    const r = tip.target.getBoundingClientRect();
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, EDGE), window.innerWidth - w - EDGE);
    const below = r.bottom + GAP + h <= window.innerHeight - EDGE;
    setAt({ x, y: below ? r.bottom + GAP : Math.max(r.top - GAP - h, EDGE) });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={box}
      className="tip"
      role="tooltip"
      style={{ left: at?.x ?? 0, top: at?.y ?? 0, visibility: at ? "visible" : "hidden" }}
    >
      {tip.text}
    </div>
  );
}
