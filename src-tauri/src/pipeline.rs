use crate::db::Db;
use crate::model::{RunPhase, RunProgress};
use crate::{coach, ingest, jev, schedule};
use chrono::Local;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

const SCREEN_CONCURRENCY: usize = 4;
const SCREEN_PER_RUN: i64 = 3000;
const MESSAGES_CHANGED: &str = "messages-changed";

pub struct Core {
    pub db: Db,
    pub coach_dir: PathBuf,
    pub claude: Option<PathBuf>,
    pub running: AtomicBool,
}

pub struct RunGuard<'a>(&'a AtomicBool);

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Core {
    pub fn try_start(&self) -> Option<RunGuard<'_>> {
        self.running.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| RunGuard(&self.running))
    }
}

pub fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn progress(app: &AppHandle, phase: RunPhase, done: usize, total: usize, message: Option<String>) {
    let _ = app.emit("run-progress", RunProgress { phase, done, total, message });
}

pub struct Summary {
    pub ingested: usize,
    pub screened: usize,
    pub coached: usize,
    pub failed: usize,
    pub queued: i64,
}

impl Summary {
    pub fn detail(&self) -> String {
        format!(
            "{} new, {} screened, {} coached, {} failed, {} in the queue",
            self.ingested, self.screened, self.coached, self.failed, self.queued
        )
    }
}

/// Ingest, screen with TypeSafe, coach the worst few with Claude. Every step is safe to repeat:
/// ingestion dedupes by text, screening only touches unscreened rows, coaching only uncoached ones.
async fn steps(core: &Arc<Core>, app: &AppHandle) -> Result<Summary, String> {
    let settings = core.db.settings().map_err(|e| e.to_string())?;

    progress(app, RunPhase::Ingest, 0, 0, None);
    let ingest_core = core.clone();
    let ingested = tauri::async_runtime::spawn_blocking(move || ingest::ingest(&ingest_core.db, &ingest_core.coach_dir))
        .await
        .map_err(|e| e.to_string())??;
    let _ = app.emit(MESSAGES_CHANGED, ());

    let key = jev::api_key().ok_or("No TypeSafe API key; add one in Settings")?;
    let jev = Arc::new(jev::Jev::new(key));
    let pending = core.db.unscreened(settings.min_words, SCREEN_PER_RUN).map_err(|e| e.to_string())?;
    let total = pending.len();
    let (mut screened, mut failed, mut last_error) = (0usize, 0usize, None::<String>);
    for chunk in pending.chunks(SCREEN_CONCURRENCY) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|(id, text)| {
                let (jev, id, text) = (jev.clone(), id.clone(), text.clone());
                tauri::async_runtime::spawn(async move { (id, jev.screen(&text).await) })
            })
            .collect();
        for handle in handles {
            match handle.await {
                Ok((id, Ok(screen))) => {
                    core.db.save_screen(&id, &screen, "jev-latest", now_ms()).map_err(|e| e.to_string())?;
                    screened += 1;
                }
                Ok((_, Err(e))) => {
                    if e.contains("401") {
                        return Err(format!("TypeSafe rejected the API key: {e}"));
                    }
                    failed += 1;
                    last_error = Some(e);
                }
                Err(e) => {
                    failed += 1;
                    last_error = Some(e.to_string());
                }
            }
        }
        progress(app, RunPhase::Screen, screened + failed, total, last_error.clone());
    }
    let _ = app.emit(MESSAGES_CHANGED, ());

    let mut coached = 0;
    if let Some(claude) = &core.claude {
        let todo = core.db.queue_uncoached(&settings, settings.auto_coach).map_err(|e| e.to_string())?;
        let total = todo.len();
        for (i, m) in todo.iter().enumerate() {
            progress(app, RunPhase::Coach, i, total, None);
            let hint = m.screen.as_ref().map(|s| s.issue);
            match coach::coach(claude, &core.coach_dir, &m.text, hint, now_ms()).await {
                Ok(c) => {
                    core.db.save_coaching(&m.id, &c).map_err(|e| e.to_string())?;
                    coached += 1;
                }
                Err(e) => {
                    failed += 1;
                    last_error = Some(e);
                }
            }
        }
        let _ = app.emit(MESSAGES_CHANGED, ());
    }

    let queued = core.db.counts(&settings).map_err(|e| e.to_string())?.queued;
    let summary = Summary { ingested, screened, coached, failed, queued };
    if summary.failed > 0 && summary.screened == 0 && summary.coached == 0 {
        return Err(last_error.unwrap_or_else(|| "every request failed".into()));
    }
    Ok(summary)
}

/// Runs the whole pipeline once and records it under today's slot. Returns the summary on success.
pub async fn run(core: Arc<Core>, app: AppHandle) -> Option<Summary> {
    let guard = core.try_start()?;
    let settings = core.db.settings().unwrap_or_default();
    let now = Local::now().naive_local();
    let day = schedule::day_key(schedule::last_slot(now, settings.run_hour));
    let _ = core.db.begin_run(&day, now_ms());
    progress(&app, RunPhase::Ingest, 0, 0, None);

    let result = steps(&core, &app).await;
    let (ok, detail) = match &result {
        Ok(s) => (true, s.detail()),
        Err(e) => (false, e.clone()),
    };
    let _ = core.db.finish_run(&day, now_ms(), ok, &detail);
    drop(guard);
    progress(&app, if ok { RunPhase::Done } else { RunPhase::Error }, 0, 0, Some(detail));
    let _ = app.emit(MESSAGES_CHANGED, ());
    result.ok()
}
