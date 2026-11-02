import { useEffect, useState } from "react";
import { api } from "../api";
import { errorText, type Notify } from "./shared";
import "../styles/patterns.css";

const MAX = 2000;

/** The person's own work terms. The coach reads them as defined and never "corrects" them. */
export function Glossary({ notify }: { notify: Notify }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getGlossary().then(
      (g) => {
        setSaved(g);
        setValue(g);
      },
      (e) => notify("Could not load your terms", errorText(e)),
    );
  }, [notify]);

  if (saved === null) return null;

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.setGlossary(value);
      setSaved(next);
      setValue(next);
    } catch (e) {
      notify("Could not save your terms", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="settings glossary-card"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="fields surface">
        <div className="field">
          <label htmlFor="set-glossary">Your work terms</label>
          <p className="hint" id="set-glossary-hint">
            Words that mean something specific in your work, one per line, like "lead: a potential customer". The coach reads them as you use
            them and will not correct them.
          </p>
          <textarea
            id="set-glossary"
            rows={5}
            maxLength={MAX}
            spellCheck={false}
            placeholder={"lead: a potential customer\nreferral: someone a user invited\ntester: a user on the trial plan"}
            value={value}
            aria-describedby="set-glossary-hint"
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
      </div>
      <div className="save-row">
        <button type="submit" className="btn btn-primary" disabled={busy || value.trim() === saved.trim()}>
          Save terms
        </button>
      </div>
    </form>
  );
}
