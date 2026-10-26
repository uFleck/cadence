import { useEffect, useState } from "react";
import { api, type KeySource } from "../api";
import { errorText, type Notify } from "./shared";
import "../styles/patterns.css";

const STATUS: Record<KeySource, string> = {
  app: "A key is saved in this computer's credential store.",
  env: "Using the TYPESAFE_API_KEY environment variable. A key saved here takes priority over it.",
  none: "No key yet. Cadence cannot screen your messages without one.",
};

export function TypeSafeKey({ notify, onChanged }: { notify: Notify; onChanged: () => void }) {
  const [source, setSource] = useState<KeySource | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.typesafeKeySource().then(setSource, (e) => notify("Could not read the TypeSafe key status", errorText(e)));
  }, [notify]);

  const run = async (action: () => Promise<KeySource>, failure: string) => {
    setBusy(true);
    try {
      setSource(await action());
      setValue("");
      onChanged();
    } catch (e) {
      notify(failure, errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="settings key-card"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.setTypesafeKey(value), "Could not save the key");
      }}
    >
      <div className="fields surface">
        <div className="field">
          <label htmlFor="set-typesafe-key">TypeSafe API key</label>
          <input
            id="set-typesafe-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={source === "app" ? "Saved. Paste a new key to replace it" : "Paste your key"}
            value={value}
            aria-describedby="set-typesafe-key-hint"
            onChange={(e) => setValue(e.target.value)}
          />
          <p className="hint" id="set-typesafe-key-hint">
            {source ? STATUS[source] : "Checking"} Every install uses its own key; Cadence never ships one.
          </p>
        </div>
      </div>
      <div className="save-row">
        <button type="submit" className="btn btn-primary" disabled={busy || value.trim() === ""}>
          Save key
        </button>
        {source === "app" && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void run(() => api.clearTypesafeKey(), "Could not remove the key")}
          >
            Remove key
          </button>
        )}
      </div>
    </form>
  );
}
