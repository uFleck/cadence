mod coach;
mod db;
mod ingest;
mod interview;
mod jev;
#[cfg(test)]
mod jev_eval;
mod model;
mod pipeline;
mod redact;
mod schedule;

use chrono::Local;
use db::Db;
use model::{
    Attempt, Coaching, InterviewAnswer, InterviewQuestion, InterviewTopic, Message, MessageQuery, Overview, Patterns, Settings,
};
use pipeline::{now_ms, Core};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

/// Passed by the login entry so Cadence can start hidden in the tray.
const AUTOSTART_ARG: &str = "--autostart";
/// Written once the first-run default has been applied, so turning it off in the tray sticks.
const AUTOSTART_MARKER: &str = "autostart-initialized";
const TICK: Duration = Duration::from_secs(30);

type Shared<'a> = State<'a, Arc<Core>>;

/// A debug build gets its own identifier, so it runs beside an installed Cadence with its own data directory.
fn context() -> tauri::Context {
    let mut context = tauri::generate_context!();
    if cfg!(debug_assertions) {
        let config = context.config_mut();
        config.identifier.push_str(".dev");
        for window in &mut config.app.windows {
            window.title.push_str(" (dev)");
        }
    }
    context
}

fn fail(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
fn overview(core: Shared<'_>) -> Result<Overview, String> {
    let settings = core.db.settings().map_err(fail)?;
    let mut o = core.db.counts(&settings).map_err(fail)?;
    o.last_run = core.db.last_run().map_err(fail)?;
    o.next_run_at = schedule::to_millis(schedule::next_slot(Local::now().naive_local(), settings.run_hour));
    o.running = core.running.load(Ordering::SeqCst);
    o.typesafe_configured = jev::api_key().is_some();
    o.claude_found = core.claude.is_some();
    Ok(o)
}

#[tauri::command]
fn list_messages(core: Shared<'_>, query: MessageQuery) -> Result<Vec<Message>, String> {
    let settings = core.db.settings().map_err(fail)?;
    core.db.list_messages(&query, &settings).map_err(fail)
}

#[tauri::command]
async fn coach_message(core: Shared<'_>, id: String, force: bool) -> Result<Coaching, String> {
    let message = core.db.get_message(&id).map_err(fail)?.ok_or("That message no longer exists")?;
    if let Some(existing) = message.coaching {
        if !force {
            return Ok(existing);
        }
    }
    let claude = core.claude.as_ref().ok_or("Claude Code CLI not found on PATH")?;
    let hint = message.screen.as_ref().map(|s| s.issue);
    let coaching = coach::coach(claude, &core.coach_dir, &message.text, hint, now_ms()).await?;
    core.db.save_coaching(&id, &coaching).map_err(fail)?;
    Ok(coaching)
}

#[tauri::command]
fn save_attempt(core: Shared<'_>, id: String, text: String) -> Result<Attempt, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Write your version first".into());
    }
    core.db.save_attempt(&id, text, now_ms()).map_err(fail)
}

#[tauri::command]
fn mark_reviewed(core: Shared<'_>, id: String, reviewed: bool) -> Result<(), String> {
    core.db.mark_reviewed(&id, reviewed.then(now_ms)).map_err(fail)
}

#[tauri::command]
fn patterns(core: Shared<'_>) -> Result<Patterns, String> {
    let settings = core.db.settings().map_err(fail)?;
    core.db.patterns(&settings).map_err(fail)
}

#[tauri::command]
fn get_settings(core: Shared<'_>) -> Result<Settings, String> {
    core.db.settings().map_err(fail)
}

#[tauri::command]
fn set_settings(core: Shared<'_>, settings: Settings) -> Result<Settings, String> {
    let settings = settings.clamped();
    core.db.set_settings(&settings).map_err(fail)?;
    Ok(settings)
}

#[tauri::command]
fn run_now(app: AppHandle, core: Shared<'_>) -> Result<(), String> {
    if core.running.load(Ordering::SeqCst) {
        return Err("A run is already in progress".into());
    }
    let core = core.inner().clone();
    tauri::async_runtime::spawn(async move {
        pipeline::run(core, app).await;
    });
    Ok(())
}

const MAX_QUESTION_CHARS: usize = 1000;

#[tauri::command]
fn interview_questions(core: Shared<'_>) -> Result<Vec<InterviewQuestion>, String> {
    core.db.interview_questions().map_err(fail)
}

#[tauri::command]
fn next_interview_question(core: Shared<'_>, topic: Option<InterviewTopic>, exclude: Option<i64>) -> Result<InterviewQuestion, String> {
    core.db
        .next_interview_question(topic, exclude)
        .map_err(fail)?
        .ok_or_else(|| "There are no interview questions for this topic".to_string())
}

#[tauri::command]
fn add_interview_question(core: Shared<'_>, topic: InterviewTopic, text: String) -> Result<InterviewQuestion, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Write the question first".into());
    }
    if text.chars().count() > MAX_QUESTION_CHARS {
        return Err(format!("A question can have at most {MAX_QUESTION_CHARS} characters"));
    }
    core.db.add_interview_question(topic, text, now_ms()).map_err(fail)
}

#[tauri::command]
fn delete_interview_question(core: Shared<'_>, id: i64) -> Result<(), String> {
    if core.db.delete_interview_question(id).map_err(fail)? {
        return Ok(());
    }
    match core.db.interview_question(id).map_err(fail)? {
        Some(_) => Err("Built-in questions can't be deleted".into()),
        None => Err("That question no longer exists".into()),
    }
}

#[tauri::command]
fn save_interview_answer(core: Shared<'_>, question_id: i64, text: String, seconds: i64) -> Result<InterviewAnswer, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Say or type your answer first".into());
    }
    if core.db.interview_question(question_id).map_err(fail)?.is_none() {
        return Err("That question no longer exists".into());
    }
    core.db.save_interview_answer(question_id, text, seconds.clamp(0, 3600), now_ms()).map_err(fail)
}

#[tauri::command]
async fn review_interview_answer(core: Shared<'_>, id: i64, force: bool) -> Result<InterviewAnswer, String> {
    let answer = core.db.get_interview_answer(id).map_err(fail)?.ok_or("That answer no longer exists")?;
    if answer.feedback.is_some() && !force {
        return Ok(answer);
    }
    let question =
        core.db.interview_question(answer.question_id).map_err(fail)?.ok_or("That question no longer exists")?;
    let claude = core.claude.as_ref().ok_or("Claude Code CLI not found on PATH")?;

    // A Jev failure must not fail the review: the old screen (or none) stays.
    let screen = match jev::api_key() {
        Some(key) => jev::Jev::new(key).screen(&answer.text).await.ok(),
        None => None,
    };
    let stdout = coach::run_claude(
        claude,
        &core.coach_dir,
        interview::SYSTEM_PROMPT,
        &interview::schema(),
        &interview::user_prompt(question.topic, &question.text, &answer.text),
    )
    .await?;
    let feedback = interview::parse_output(&stdout, now_ms())?;
    core.db.save_interview_review(id, screen.as_ref(), &feedback).map_err(fail)?;
    core.db.get_interview_answer(id).map_err(fail)?.ok_or_else(|| "That answer no longer exists".to_string())
}

#[tauri::command]
fn interview_answers(core: Shared<'_>, question_id: Option<i64>, limit: i64) -> Result<Vec<InterviewAnswer>, String> {
    core.db.interview_answers(question_id, limit).map_err(fail)
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn window_is_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

/// Turns on start-on-login the first time a release build runs; after that the tray toggle owns it.
fn enable_autostart_once(app: &AppHandle, data_dir: &std::path::Path) {
    if cfg!(debug_assertions) {
        return;
    }
    let marker = data_dir.join(AUTOSTART_MARKER);
    if marker.exists() {
        return;
    }
    if app.autolaunch().enable().is_ok() {
        let _ = std::fs::write(&marker, "");
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Cadence", true, None::<&str>)?;
    let run = MenuItem::with_id(app, "run", "Run now", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(app, "login", "Start on login", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &run, &login, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Cadence")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "run" => {
                if let Some(core) = app.try_state::<Arc<Core>>() {
                    let (core, app) = (core.inner().clone(), app.clone());
                    tauri::async_runtime::spawn(async move {
                        pipeline::run(core, app).await;
                    });
                }
            }
            "login" => {
                let autolaunch = app.autolaunch();
                let _ = if login.is_checked().unwrap_or(false) { autolaunch.enable() } else { autolaunch.disable() };
                let _ = login.set_checked(autolaunch.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Checks every tick whether the latest daily slot still lacks a successful run. Because it asks
/// the database rather than counting down to a time, a laptop that slept through 22:00 or an app
/// that was closed catches up as soon as it is running again.
fn start_scheduler(app: AppHandle, core: Arc<Core>) {
    tauri::async_runtime::spawn(async move {
        loop {
            if !core.running.load(Ordering::SeqCst) {
                let settings = core.db.settings().unwrap_or_default();
                let slot = schedule::last_slot(Local::now().naive_local(), settings.run_hour);
                let existing = core.db.run_for_day(&schedule::day_key(slot)).ok().flatten();
                if schedule::needs_run(existing.as_ref(), now_ms()) {
                    if let Some(summary) = pipeline::run(core.clone(), app.clone()).await {
                        if summary.queued > 0 && !window_is_focused(&app) {
                            let _ = app
                                .notification()
                                .builder()
                                .title("Cadence")
                                .body(format!("{} messages are ready to practice", summary.queued))
                                .show();
                        }
                    }
                }
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

fn open_core(data_dir: &std::path::Path) -> Result<Core, String> {
    let coach_dir: PathBuf = data_dir.join("coach");
    std::fs::create_dir_all(&coach_dir).map_err(fail)?;
    let db = Db::open(&data_dir.join("cadence.db")).map_err(fail)?;
    Ok(Core { db, coach_dir, claude: coach::find_claude(), running: AtomicBool::new(false) })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let core = Arc::new(open_core(&data_dir)?);
            app.manage(core.clone());
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            enable_autostart_once(app.handle(), &data_dir);
            build_tray(app.handle())?;
            if std::env::args().any(|a| a == AUTOSTART_ARG) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            start_scheduler(app.handle().clone(), core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            overview,
            list_messages,
            coach_message,
            save_attempt,
            mark_reviewed,
            patterns,
            get_settings,
            set_settings,
            run_now,
            interview_questions,
            next_interview_question,
            add_interview_question,
            delete_interview_question,
            save_interview_answer,
            review_interview_answer,
            interview_answers
        ])
        .run(context())
        .expect("error while running tauri application");
}
