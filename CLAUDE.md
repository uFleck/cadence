# Cadence

Tauri 2 desktop app (React 19 + Vite, Rust backend, SQLite). It reads the English prompts the user wrote to Claude Code, scores how natural they sound with TypeSafe's Jev, coaches the worst ones with `claude -p`, and runs on its own every day at 22:00 local time.

## Layout

- `src/api.ts`: the IPC contract with the Rust commands and events. Change the Rust `model.rs` types and `api.ts` together.
- `src/App.tsx`: frameless window shell, nav, banners, status bar, and the refresh wiring (`messages-changed`, `run-progress`).
- `src/components/`: one view per file (`Today`, `MessageList`, `Patterns`, `SettingsView`), plus `MessageCard` (the rewrite-first card), `StatusBar`, `WindowControls`, `Dialog`, and `shared`.
- `src/dev/mockBackend.ts`: stands in for Tauri when running `pnpm dev` in a plain browser. Keep it in step with `api.ts`.
- `src-tauri/src/`: `ingest` (Claude history and transcripts), `db` (SQLite), `jev` (TypeSafe client), `coach` (`claude -p`), `pipeline` (one run), `schedule` (22:00 slot logic), `lib` (commands, tray, scheduler).
- `src-tauri/src/interview.rs`: the Interview practice mode: built-in question bank, the `claude -p` feedback prompt and schema, and output parsing. It reuses `coach::run_claude`.
- `src/updater.ts` and `src/components/UpdateButton.tsx`: the in-app updater (status bar, packaged builds only). `release.yml` builds and signs on a `v*` tag and uploads `latest.json`; the signing key is the `TAURI_SIGNING_PRIVATE_KEY` secret of the `Production` environment, and its public half is in `tauri.conf.json`.

## Rules

- **Never use native dialogs in the desktop app.** No `alert`, `confirm`, `prompt`, or `@tauri-apps/plugin-dialog`. Confirmations and errors use the in-app `Dialog`.
- **The TypeSafe key comes only from the `TYPESAFE_API_KEY` environment variable.** Never write it to a file, a log or the database.
- **Cadence must never ingest its own prompts.** The `claude -p` calls run in `<app data>/coach`, and ingestion skips every message whose `cwd` is under that folder. Keep both in step if either changes.
- Naturalness is always shown as a number next to the meter; colour is never the only signal.
- Run the app through Spawner (`spawner:tauri dev`), not a terminal.

## Data

- `messages` is deduped by a hash of the whitespace-normalised text, so a prompt present in both `history.jsonl` and a transcript is stored once.
- Ingestion tails each source file from a stored byte offset and only consumes complete lines.
- A run is idempotent: it only screens unscreened rows. It never coaches: `claude -p` runs only when the user writes a new version of a message, and it reviews that version (the original goes along as context). Coaching strips the stray `\"` the model sometimes writes (`coach::clean`).
- Ingestion redacts file paths and links (`redact.rs`): a path becomes its file name (`@src/x/Y.razor` becomes `Y.razor`) and a URL becomes its host (`https://github.com/o/r/pull/1` becomes `github.com`; written as "this github.com link" unless the user already put a determiner or a noun like "PR" around it). Different paths that share a file name within one message get numbered names (`S.cs`, `S2.cs`) so they do not read as "S.cs, S.cs and S.cs"; the same path always keeps the same name. Folders, queries and credentials are never stored or sent to Jev or `claude -p`. The stored text, word count, Jev score and coaching all use the redacted text; the message id still hashes the original. `Db::open` redacts rows stored earlier and drops their screen and coaching so the next run redoes them. `redact::VERSION` plus `kv('redaction')` trigger a one-time re-read of all sources when the redaction output changes, and `insert_messages` rewrites a stored row (dropping its screen and coaching, keeping attempts and the reviewed mark) when the redaction of its original now differs. Placeholder phrases such as "this file" clash with the surrounding grammar ("these this file files"), while a file name works like a proper noun in any position.
- A screen only counts when `english >= MIN_ENGLISH` and `prose >= MIN_PROSE` (`model.rs`; `db.rs` builds its SQL from them). `prose` asks Jev whether a person wrote sentences, so pasted logs, stack traces and code never reach the queue. Screens saved before `prose` existed have it NULL and are screened again on the next run.
- `interview_questions` holds the built-in bank (`interview.rs`, `custom = 0`) plus the user's own (`custom = 1`). `Db::open` re-seeds the bank with `INSERT OR IGNORE` on the unique text, so new bank questions appear on the next start. `interview_answers` cascades with its question; the Jev screen and the feedback are stored as JSON.

## Threshold eval

`src-tauri/evals/cases.json` holds 113 labelled messages (native, flawed, pasted, Portuguese, and some with paths that go through `redact`). `cargo test --lib jev_eval -- --ignored --nocapture` screens them with the real TypeSafe API (needs `TYPESAFE_API_KEY`, costs cents) and asserts the English, prose and flag thresholds sit well inside the gaps between the groups. Re-run it after touching `questions()` in `jev.rs` or any threshold.

**Never run the eval, or anything else that calls Jev, on your own.** The database holds 1000+ messages and every Jev call costs money. Agents and delegated briefs use free checks only (`cargo test --lib`); when a change needs the eval, say so at the end and let the user run it or ask for it. Changes that alter stored text must re-screen only the rows they affect (as `insert_messages` does), never the whole table.
