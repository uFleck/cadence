import { motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { SOFT_SPRING, SPRING } from "../motion";

export function Dialog({
  tone,
  icon,
  title,
  lead,
  onClose,
  footer,
  children,
}: {
  tone: "ask" | "warn";
  icon: string;
  title: string;
  lead: string;
  onClose: () => void;
  footer: ReactNode;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("[data-first]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab" && box.current) {
        const items = [...box.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
        e.preventDefault();
        items[next]?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <motion.div
      className="dlg-scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className={`dlg ${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        ref={box}
        initial={{ opacity: 0, y: 24, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.97 }}
        transition={SOFT_SPRING}
      >
        <div className="dlg-h">
          <motion.span
            className="dlg-ico"
            initial={{ scale: 0.4, rotate: -20 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ ...SPRING, delay: 0.12 }}
          >
            <i className={icon} aria-hidden="true" />
          </motion.span>
          <div>
            <h2 id="dlg-title">{title}</h2>
            <p>{lead}</p>
          </div>
        </div>
        {children && <div className="dlg-b">{children}</div>}
        <div className="dlg-f">{footer}</div>
      </motion.div>
    </motion.div>
  );
}

export function NoticeDialog({ title, lead, onClose }: { title: string; lead: string; onClose: () => void }) {
  return (
    <Dialog
      tone="warn"
      icon="ph-fill ph-warning"
      title={title}
      lead={lead}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" data-first onClick={onClose}>
          OK
        </button>
      }
    />
  );
}
