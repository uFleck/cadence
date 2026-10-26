use crate::db::Db;
use crate::model::NewMessage;
use crate::redact::redact;
use chrono::DateTime;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MAX_WORDS: usize = 300;
const MAX_LINES: usize = 8;

pub fn claude_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(|h| PathBuf::from(h).join(".claude"))
}

pub fn message_id(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let digest = Sha256::digest(normalized.as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// Removes the `[Pasted text #1 +20 lines]` and `[Image #2]` markers Claude Code leaves in prompt history.
fn strip_placeholders(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = ["[Pasted text", "[Image #"].iter().filter_map(|p| rest.find(p)).min() {
        out.push_str(&rest[..start]);
        match rest[start..].find(']') {
            Some(end) => rest = &rest[start + end + 1..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Keeps text a person wrote as a sentence or two. Slash commands, shell escapes, injected tags,
/// session summaries and pasted logs are dropped.
pub fn prose(text: &str) -> Option<String> {
    let cleaned = strip_placeholders(text);
    let text = cleaned.trim();
    if text.is_empty() {
        return None;
    }
    const REJECT_PREFIXES: [&str; 6] =
        ["<", "/", "!", "[Request interrupted", "Caveat:", "This session is being continued"];
    if REJECT_PREFIXES.iter().any(|p| text.starts_with(p)) {
        return None;
    }
    if text.contains("<system-reminder>") || text.contains("<task-notification>") {
        return None;
    }
    if text.lines().count() > MAX_LINES {
        return None;
    }
    let words = text.split_whitespace().count();
    if !(3..=MAX_WORDS).contains(&words) {
        return None;
    }
    let visible = text.chars().filter(|c| !c.is_whitespace()).count();
    let letters = text.chars().filter(|c| c.is_alphabetic()).count();
    if (letters as f64) < 0.6 * visible as f64 {
        return None;
    }
    Some(text.to_string())
}

fn excluded(cwd: &str, exclude: &str) -> bool {
    !exclude.is_empty() && cwd.replace('\\', "/").to_lowercase().starts_with(exclude)
}

fn normalize_exclude(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn transcript_message(line: &str, exclude: &str) -> Option<NewMessage> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "user" {
        return None;
    }
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    if flag("isSidechain") || flag("isMeta") || v.get("toolUseResult").is_some() {
        return None;
    }
    if v.get("turnOrigin").and_then(Value::as_str) == Some("task_notification")
        || v.get("promptSource").and_then(Value::as_str) == Some("system")
    {
        return None;
    }
    let cwd = v.get("cwd").and_then(Value::as_str);
    if cwd.is_some_and(|c| excluded(c, exclude)) {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let raw = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            let texts: Vec<&str> = blocks
                .iter()
                .filter_map(|b| (b.get("type")?.as_str()? == "text").then(|| b.get("text")?.as_str()).flatten())
                .collect();
            if texts.len() != blocks.len() {
                return None;
            }
            texts.join("\n")
        }
        _ => return None,
    };
    let text = prose(&raw)?;
    let ts = DateTime::parse_from_rfc3339(v.get("timestamp")?.as_str()?).ok()?.timestamp_millis();
    Some(NewMessage {
        id: message_id(&text),
        text: redact(&text),
        ts,
        project: cwd.map(str::to_string),
        session_id: v.get("sessionId").and_then(Value::as_str).map(str::to_string),
        source: "transcript",
    })
}

fn history_message(line: &str, exclude: &str) -> Option<NewMessage> {
    let v: Value = serde_json::from_str(line).ok()?;
    let project = v.get("project").and_then(Value::as_str);
    if project.is_some_and(|p| excluded(p, exclude)) {
        return None;
    }
    let text = prose(v.get("display")?.as_str()?)?;
    Some(NewMessage {
        id: message_id(&text),
        text: redact(&text),
        ts: v.get("timestamp")?.as_i64()?,
        project: project.map(str::to_string),
        session_id: v.get("sessionId").and_then(Value::as_str).map(str::to_string),
        source: "history",
    })
}

/// Reads the complete lines appended to `path` since the last run and returns what `parse` keeps.
fn tail(db: &Db, path: &Path, parse: impl Fn(&str) -> Option<NewMessage>) -> Result<Vec<NewMessage>, String> {
    let key = path.to_string_lossy().to_string();
    let mut offset = db.file_offset(&key).map_err(|e| e.to_string())?;
    let mut file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len < offset {
        offset = 0;
    }
    if len == offset {
        return Ok(Vec::new());
    }
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity((len - offset) as usize);
    file.take(len - offset).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let Some(end) = buf.iter().rposition(|b| *b == b'\n') else {
        return Ok(Vec::new());
    };
    let kept = String::from_utf8_lossy(&buf[..end]);
    let found = kept.lines().filter_map(&parse).collect();
    db.set_file_offset(&key, offset + end as u64 + 1).map_err(|e| e.to_string())?;
    Ok(found)
}

/// Pulls new prose prompts from `history.jsonl` and every project transcript into the database.
/// `exclude_cwd` is Cadence's own coach folder, so the app never practises on its own prompts.
pub fn ingest(db: &Db, exclude_cwd: &Path) -> Result<usize, String> {
    let Some(root) = claude_dir() else {
        return Err("Could not locate the Claude config folder".into());
    };
    let exclude = normalize_exclude(exclude_cwd);
    let mut found = Vec::new();

    let history = root.join("history.jsonl");
    if history.is_file() {
        found.extend(tail(db, &history, |l| history_message(l, &exclude))?);
    }

    let projects = root.join("projects");
    if let Ok(dirs) = fs::read_dir(&projects) {
        for dir in dirs.flatten().filter(|d| d.path().is_dir()) {
            let Ok(files) = fs::read_dir(dir.path()) else { continue };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().is_some_and(|e| e == "jsonl") && path.is_file() {
                    found.extend(tail(db, &path, |l| transcript_message(l, &exclude))?);
                }
            }
        }
    }

    db.insert_messages(&found).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_db(name: &str) -> (Db, PathBuf) {
        let dir = std::env::temp_dir().join(format!("cadence-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        (Db::open(&dir.join("t.db")).unwrap(), dir)
    }

    #[test]
    fn prose_keeps_sentences_and_drops_noise() {
        assert!(prose("could it be the way spawner is running the apps?").is_some());
        assert!(prose("/model sonnet please now").is_none());
        assert!(prose("!winget upgrade Anthropic.ClaudeCode now").is_none());
        assert!(prose("[Request interrupted by user]").is_none());
        assert!(prose("This session is being continued from a previous conversation that ran out").is_none());
        assert!(prose("ok").is_none());
        let paste = (0..20).map(|i| format!("line {i} of a log")).collect::<Vec<_>>().join("\n");
        assert!(prose(&paste).is_none());
        assert!(prose("12345 67890 11111 22222 33333").is_none());
    }

    #[test]
    fn placeholders_are_removed_before_filtering() {
        let text = "[Pasted text #1 +20 lines] why does this fail on startup? [Image #2]";
        assert_eq!(prose(text).as_deref(), Some("why does this fail on startup?"));
    }

    #[test]
    fn same_text_with_different_spacing_shares_an_id() {
        assert_eq!(message_id("fix  the bug\nplease"), message_id("fix the bug please"));
        assert_ne!(message_id("fix the bug"), message_id("fix the bugs"));
    }

    #[test]
    fn a_path_becomes_its_file_name_and_the_id_hashes_the_original() {
        let original = "why does @src/Jobs/RetryPolicy.cs never stop retrying here";
        let line = format!("{{\"display\":\"{original}\",\"timestamp\":1,\"project\":\"p\"}}");
        let m = history_message(&line, "").unwrap();
        assert_eq!(m.text, "why does RetryPolicy.cs never stop retrying here");
        assert_eq!(m.id, message_id(original));
    }

    #[test]
    fn transcript_keeps_typed_prompts_only() {
        let typed = r#"{"type":"user","isSidechain":false,"turnOrigin":"human","promptSource":"typed","timestamp":"2026-10-22T20:19:27.887Z","cwd":"C:\\Projects\\x","sessionId":"s1","message":{"role":"user","content":"can you check why the build is slow?"}}"#;
        let m = transcript_message(typed, "").unwrap();
        assert_eq!(m.text, "can you check why the build is slow?");
        assert_eq!(m.ts, 1_792_700_367_887);
        let tool_result = r#"{"type":"user","toolUseResult":{},"timestamp":"2026-10-22T20:19:27.887Z","message":{"content":[{"type":"tool_result","content":"x"}]}}"#;
        assert!(transcript_message(tool_result, "").is_none());
        let note = r#"{"type":"user","turnOrigin":"task_notification","timestamp":"2026-10-22T20:19:27.887Z","message":{"content":"a long enough sentence for the filter"}}"#;
        assert!(transcript_message(note, "").is_none());
        assert!(transcript_message(typed, "c:/projects/x").is_none());
    }

    #[test]
    fn tail_waits_for_the_end_of_a_partial_line() {
        let (db, dir) = temp_db("tail");
        let path = dir.join("h.jsonl");
        let line = |t: &str| format!("{{\"display\":\"{t}\",\"timestamp\":1,\"project\":\"p\"}}\n");
        let mut f = File::create(&path).unwrap();
        write!(f, "{}{}", line("first message that is long enough"), "{\"display\":\"half writ").unwrap();
        drop(f);
        let first = tail(&db, &path, |l| history_message(l, "")).unwrap();
        assert_eq!(first.len(), 1);

        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(f, "ten\",\"timestamp\":2}}\n{}", line("second message that is long enough")).unwrap();
        drop(f);
        let second = tail(&db, &path, |l| history_message(l, "")).unwrap();
        let texts: Vec<_> = second.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["second message that is long enough"]);
        assert!(tail(&db, &path, |l| history_message(l, "")).unwrap().is_empty());
    }
}
