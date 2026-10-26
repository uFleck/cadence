import { useEffect, useState } from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { api, type Settings } from "../api";
import { EASE, rise, stagger } from "../motion";
import { errorText, type Notify } from "./shared";
import { TypeSafeKey } from "./TypeSafeKey";
import "../styles/patterns.css";

type Form = Record<keyof Settings, string>;

// The card fades up, then its fields rise one after another.
const cardV: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, staggerChildren: 0.08, delayChildren: 0.1 } },
};

const FIELDS: { key: keyof Settings; label: string; hint: string; step: number; min: number; max?: number }[] = [
  { key: "runHour", label: "Daily run hour", hint: "Local hour, 0 to 23, when Cadence screens the day's messages.", step: 1, min: 0, max: 23 },
  { key: "flagThreshold", label: "Flag threshold", hint: "Messages scoring below this (0 to 3) go to the queue.", step: 0.1, min: 0, max: 3 },
  { key: "minWords", label: "Minimum words", hint: "Shorter messages are not used for practice.", step: 1, min: 0 },
  { key: "autoCoach", label: "Auto-coach count", hint: "How many queued messages the daily run coaches ahead of time.", step: 1, min: 0 },
];

const toForm = (s: Settings): Form => ({
  runHour: String(s.runHour),
  flagThreshold: String(s.flagThreshold),
  minWords: String(s.minWords),
  autoCoach: String(s.autoCoach),
});

function parse(f: Form): Settings | string {
  const n = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const s = {
    runHour: n(f.runHour),
    flagThreshold: n(f.flagThreshold),
    minWords: n(f.minWords),
    autoCoach: n(f.autoCoach),
  };
  if (!Number.isInteger(s.runHour) || s.runHour < 0 || s.runHour > 23) return "Run hour must be a whole number from 0 to 23.";
  if (!(s.flagThreshold >= 0 && s.flagThreshold <= 3)) return "Flag threshold must be between 0 and 3.";
  if (!Number.isInteger(s.minWords) || s.minWords < 0) return "Minimum words must be a whole number, 0 or more.";
  if (!Number.isInteger(s.autoCoach) || s.autoCoach < 0) return "Auto-coach count must be a whole number, 0 or more.";
  return s;
}

export function SettingsView({ notify, onSaved }: { notify: Notify; onSaved: () => void }) {
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errTick, setErrTick] = useState(0);

  useEffect(() => {
    api.getSettings().then(
      (s) => setForm(toForm(s)),
      (e) => notify("Could not load settings", errorText(e)),
    );
  }, [notify]);

  if (!form) return <p className="muted">Loading</p>;

  const edit = (key: keyof Settings, value: string) => {
    setForm({ ...form, [key]: value });
    setSaved(false);
  };

  const save = async () => {
    const next = parse(form);
    if (typeof next === "string") {
      setError(next);
      setErrTick((t) => t + 1);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      setForm(toForm(await api.setSettings(next)));
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(`Could not save: ${errorText(e)}`);
      setErrTick((t) => t + 1);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <motion.form
      className="settings"
      variants={stagger(0.08)}
      initial="hidden"
      animate="show"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <motion.header className="pg-head" variants={rise}>
        <div className="eyebrow">Preferences</div>
        <h1>Settings</h1>
        <p className="sub">When Cadence runs, and how picky it is about what goes in your queue.</p>
      </motion.header>
      <motion.div className="fields surface" variants={cardV}>
        {FIELDS.map((f) => (
          <motion.div className="field" key={f.key} variants={rise}>
            <label htmlFor={`set-${f.key}`}>{f.label}</label>
            <input
              id={`set-${f.key}`}
              type="number"
              inputMode="decimal"
              min={f.min}
              max={f.max}
              step={f.step}
              value={form[f.key]}
              aria-describedby={`set-${f.key}-hint`}
              onChange={(e) => edit(f.key, e.target.value)}
            />
            <p className="hint" id={`set-${f.key}-hint`}>
              {f.hint}
            </p>
          </motion.div>
        ))}
      </motion.div>
      <motion.div className="save-row" variants={rise}>
        <button type="submit" className={`btn btn-primary${saving ? " saving" : ""}`} disabled={saving} aria-busy={saving}>
          {saving ? (
            <>
              <i className="ph ph-circle-notch spin" aria-hidden="true" />
              Saving
            </>
          ) : (
            "Save"
          )}
        </button>
        <div className="notes" aria-live="polite">
          <AnimatePresence>
            {saved && (
              <motion.span
                key="saved"
                className="ok-note"
                role="status"
                initial={{ opacity: 0, scale: 0.7, x: -6 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 420, damping: 20 }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="ring" cx="12" cy="12" r="10.5" />
                  <motion.path
                    className="tick"
                    d="M7.2 12.6l3.3 3.2 6.3-6.8"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.4, ease: EASE, delay: 0.12 }}
                  />
                </svg>
                Saved
              </motion.span>
            )}
            {error && (
              <motion.span
                // The tick in the key replays the shake when the same message comes back.
                key={`err-${errTick}`}
                className="err-note"
                role="alert"
                initial={{ opacity: 0, x: 0 }}
                animate={{ opacity: 1, x: [0, -7, 6, -4, 2, 0] }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.45, ease: "easeOut" }}
              >
                {error}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.form>
    <TypeSafeKey notify={notify} onChanged={onSaved} />
    </>
  );
}
