import { AnimatePresence, LayoutGroup, motion, type Variants } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Message, type MessageFilter } from "../api";
import { EASE, SPRING } from "../motion";
import "../styles/messages.css";
import { MessageCard } from "./MessageCard";
import { ago, errorText, IssueChip, Meter, type Notify } from "./shared";

const PAGE = 40;
const FILTERS: [MessageFilter, string][] = [
  ["queue", "Queue"],
  ["reviewed", "Reviewed"],
  ["all", "All"],
];

// Each row waits for its place in its own page, so "Load more" cascades in too instead of all landing at once.
const row: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: (i: number) => ({ opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE, delay: Math.min(i, 12) * 0.04 } }),
};

export function MessageList({ version, notify }: { version: number; notify: Notify }) {
  const [filter, setFilter] = useState<MessageFilter>("queue");
  const [items, setItems] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<Message | null>(null);
  const request = useRef(0);

  const fetchPage = useCallback(async (f: MessageFilter, offset: number) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const page = await api.listMessages({ filter: f, limit: PAGE, offset });
      if (id !== request.current) return;
      setItems((prev) => (offset === 0 ? page : [...prev, ...page]));
      setHasMore(page.length === PAGE);
      setFailed(null);
    } catch (e) {
      if (id === request.current) setFailed(errorText(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPage(filter, 0);
  }, [filter, version, fetchPage]);

  return (
    <div className={`messages${open ? " has-panel" : ""}`}>
      <div className="msg-main">
        <div className="msg-title">
          <span className="eyebrow">Everything Cadence has read</span>
          <h1>All messages</h1>
        </div>

        <div className="msg-toolbar">
          <LayoutGroup id="messages-filter">
            <div className="seg-group" role="group" aria-label="Show">
              {FILTERS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className="seg"
                  aria-pressed={filter === id}
                  onClick={() => {
                    setFilter(id);
                    setOpen(null);
                  }}
                >
                  {filter === id && <motion.span layoutId="seg-pill" className="seg-pill" transition={SPRING} />}
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </LayoutGroup>
          {loading && <i className="ph ph-spinner spin msg-busy" role="status" aria-label="Loading" />}
        </div>

        {failed && (
          <div className="inline-error" role="alert">
            <i className="ph ph-warning-circle" aria-hidden="true" />
            <span>Could not load messages: {failed}</span>
          </div>
        )}

        <div className="list">
          {loading && items.length === 0 && !failed && (
            <div className="rows" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="msg-skel" style={{ opacity: 1 - i * 0.2 }}>
                  <span className="skel" />
                  <span className="skel w60" />
                  <span className="skel w35" />
                </div>
              ))}
            </div>
          )}

          <ul className="rows">
            <AnimatePresence mode="popLayout">
              {items.map((m, i) => (
                <motion.li
                  key={m.id}
                  layout="position"
                  custom={i % PAGE}
                  variants={row}
                  initial="hidden"
                  animate="show"
                  exit={{ opacity: 0, x: -20, transition: { duration: 0.22, ease: EASE } }}
                  transition={{ layout: SPRING }}
                >
                  <button
                    type="button"
                    className={`msg-row${open?.id === m.id ? " active" : ""}`}
                    aria-pressed={open?.id === m.id}
                    onClick={() => setOpen(m)}
                  >
                    <span className="row-text">{m.text}</span>
                    <span className="row-meta">
                      <span className="row-when">
                        {ago(m.ts)}
                        {m.reviewedAt !== null && <i className="ph ph-check-circle row-done" role="img" aria-label="Reviewed" title="Reviewed" />}
                      </span>
                      <span className="row-scores">
                        {m.screen && <Meter value={m.screen.naturalness} />}
                        {m.screen && <IssueChip issue={m.screen.issue} />}
                      </span>
                    </span>
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>

          {!loading && !failed && items.length === 0 && (
            <motion.div
              className="msg-empty"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE, delay: 0.15 }}
            >
              <i className="ph ph-tray" aria-hidden="true" />
              <p>No messages here.</p>
            </motion.div>
          )}
          {hasMore && (
            <button
              type="button"
              className="btn btn-ghost msg-more more"
              disabled={loading}
              onClick={() => void fetchPage(filter, items.length)}
            >
              Load more
            </button>
          )}
        </div>
      </div>

      <div className="msg-detail">
        <AnimatePresence initial={false}>
          {open && (
            <motion.aside
              key="panel"
              className="msg-panel"
              aria-label="Message"
              initial={{ opacity: 0, x: 56 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 56 }}
              transition={{ duration: 0.38, ease: EASE }}
            >
              <div className="msg-panel-h">
                <span className="eyebrow">Message</span>
                <button type="button" className="ib" aria-label="Close panel" onClick={() => setOpen(null)}>
                  <i className="ph ph-x" aria-hidden="true" />
                </button>
              </div>
              <MessageCard
                key={open.id}
                message={open}
                notify={notify}
                onReviewed={() => {
                  setOpen(null);
                  void fetchPage(filter, 0);
                }}
              />
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
