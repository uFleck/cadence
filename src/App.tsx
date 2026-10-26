import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, onMessagesChanged, onRunProgress, type Overview, type RunProgress } from "./api";
import { NoticeDialog } from "./components/Dialog";
import { Interview } from "./components/Interview";
import { MessageList } from "./components/MessageList";
import { PatternsView } from "./components/Patterns";
import { SettingsView } from "./components/SettingsView";
import { StatusBar } from "./components/StatusBar";
import { Today } from "./components/Today";
import { WindowControls } from "./components/WindowControls";
import { errorText, type Notify } from "./components/shared";
import { EASE, SPRING } from "./motion";
import { useTheme } from "./theme";

type View = "today" | "interview" | "all" | "patterns" | "settings";

const VIEWS: [View, string, string][] = [
  ["today", "Today", "ph-tray"],
  ["interview", "Interview", "ph-microphone"],
  ["all", "All messages", "ph-list"],
  ["patterns", "Patterns", "ph-chart-line-up"],
  ["settings", "Settings", "ph-gear"],
];

export default function App() {
  const [view, setView] = useState<View>("today");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  /** Bumped whenever messages may have changed, so views reload. */
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<{ title: string; lead: string } | null>(null);
  const { theme, toggle } = useTheme();
  const toggleRef = useRef<HTMLButtonElement>(null);

  const notify = useCallback<Notify>((title, lead) => setNotice({ title, lead }), []);
  const closeNotice = useCallback(() => setNotice(null), []);

  const refresh = useCallback(() => {
    api.overview().then(setOverview, (e) => notify("Could not load Cadence", errorText(e)));
    setVersion((v) => v + 1);
  }, [notify]);

  useEffect(() => {
    api.overview().then(setOverview, (e) => notify("Could not load Cadence", errorText(e)));
    const off = [
      onMessagesChanged(refresh),
      onRunProgress((p) => {
        setProgress(p);
        if (p.phase === "done" || p.phase === "error") refresh();
      }),
    ];
    return () => off.forEach((u) => void u.then((fn) => fn()));
  }, [notify, refresh]);

  const runNow = async () => {
    try {
      await api.runNow();
    } catch (e) {
      notify("Could not start a run", errorText(e));
    }
    api.overview().then(setOverview, () => undefined);
  };

  const running = overview?.running ?? false;
  const onToggleTheme = () => {
    const box = toggleRef.current?.getBoundingClientRect();
    toggle(box && { x: box.left + box.width / 2, y: box.top + box.height / 2 });
  };

  return (
    <div className="shell">
      <motion.header
        className="titlebar"
        data-tauri-drag-region
        initial={{ y: -44, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: EASE }}
      >
        <span className="brand" data-tauri-drag-region>
          <motion.span
            className="tick"
            aria-hidden="true"
            animate={running ? { rotate: [-16, 16] } : { rotate: [-18, 12, -6, 0] }}
            transition={
              running
                ? { duration: 0.55, ease: "easeInOut", repeat: Infinity, repeatType: "reverse" }
                : { duration: 1.1, ease: EASE }
            }
          >
            <i className="ph ph-metronome" />
          </motion.span>
          Cadence
        </span>
        <div className="titlebar-end">
          <button
            ref={toggleRef}
            type="button"
            className="theme-toggle"
            aria-label={theme === "light" ? "Switch to the dark theme" : "Switch to the light theme"}
            onClick={onToggleTheme}
          >
            <span className="glyph">
              <AnimatePresence mode="wait" initial={false}>
                <motion.i
                  key={theme}
                  className={`ph ${theme === "light" ? "ph-moon" : "ph-sun"}`}
                  aria-hidden="true"
                  initial={{ rotate: -90, scale: 0.4, opacity: 0 }}
                  animate={{ rotate: 0, scale: 1, opacity: 1 }}
                  exit={{ rotate: 90, scale: 0.4, opacity: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                />
              </AnimatePresence>
            </span>
            {theme === "light" ? "Dark" : "Light"}
          </button>
          <WindowControls />
        </div>
      </motion.header>

      <motion.nav
        className="nav"
        aria-label="Views"
        initial={{ x: -28, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: EASE, delay: 0.08 }}
      >
        <span className="nav-label">Practice</span>
        {VIEWS.map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className={`nav-item${id === "settings" ? " nav-end" : ""}`}
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            {view === id && <motion.span layoutId="nav-pill" className="nav-pill" transition={SPRING} />}
            <i className={`ph ${icon}`} aria-hidden="true" />
            <span>{label}</span>
            {id === "today" && overview && overview.queued > 0 && (
              <motion.span
                key={overview.queued}
                className="count"
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={SPRING}
              >
                {overview.queued}
              </motion.span>
            )}
          </button>
        ))}
      </motion.nav>

      <main className="main">
        <AnimatePresence initial={false}>
          {overview && !overview.typesafeConfigured && (
            <motion.div
              key="typesafe"
              className="banner-wrap"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: EASE }}
            >
              <div className="banner" role="alert">
                <i className="ph-fill ph-warning" aria-hidden="true" />
                Set the TYPESAFE_API_KEY environment variable and restart Cadence
              </div>
            </motion.div>
          )}
          {overview && !overview.claudeFound && (
            <motion.div
              key="claude"
              className="banner-wrap"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: EASE }}
            >
              <div className="banner" role="alert">
                <i className="ph-fill ph-warning" aria-hidden="true" />
                Claude Code CLI not found on PATH
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <section className="view">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              className="view-inner"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: EASE }}
            >
              {view === "today" && <Today version={version} overview={overview} notify={notify} onRunNow={() => void runNow()} />}
              {view === "interview" && <Interview notify={notify} />}
              {view === "all" && <MessageList version={version} notify={notify} />}
              {view === "patterns" && <PatternsView version={version} notify={notify} />}
              {view === "settings" && <SettingsView notify={notify} onSaved={refresh} />}
            </motion.div>
          </AnimatePresence>
        </section>
      </main>

      <StatusBar overview={overview} progress={overview?.running ? progress : null} onRunNow={() => void runNow()} />

      <AnimatePresence>
        {notice && <NoticeDialog key="notice" title={notice.title} lead={notice.lead} onClose={closeNotice} />}
      </AnimatePresence>
    </div>
  );
}
