use crate::model::{Coaching, Issue, Rewrite};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const MODEL: &str = "sonnet";
const TIMEOUT: Duration = Duration::from_secs(150);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const SYSTEM_PROMPT: &str = "You are an English writing coach for a software engineer whose first language is Brazilian Portuguese. \
They want to sound natural when talking to colleagues and senior people at work. \
You get one message they wrote and a hint about what may sound off. \
Keep their meaning and level of detail. Do not add content. Do not make it more formal than needed. \
If the message already sounds natural, say so, and make the rewrites small variations. \
File names such as Program.cs and site names such as github.com stand in for full paths and links that were shortened on purpose: keep the names as they are in the rewrites and do not comment on them. \
Explain in plain words, and mention the Portuguese pattern behind a mistake when there is one.";

pub fn find_claude() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|dir| dir.join(if cfg!(windows) { "claude.exe" } else { "claude" }))
        .find(|p| p.is_file());
    on_path.or_else(|| {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
        let local = PathBuf::from(home).join(".local").join("bin").join(if cfg!(windows) { "claude.exe" } else { "claude" });
        local.is_file().then_some(local)
    })
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "rewrites": {
                "type": "array",
                "minItems": 2,
                "maxItems": 2,
                "items": {
                    "type": "object",
                    "properties": {
                        "register": { "type": "string", "enum": ["casual", "professional"] },
                        "text": { "type": "string" }
                    },
                    "required": ["register", "text"]
                }
            },
            "explanation": { "type": "string" },
            "tip": { "type": "string" },
            "issue": {
                "type": "string",
                "enum": ["none", "grammar", "preposition_collocation", "word_choice", "word_order", "pt_calque", "register"]
            }
        },
        "required": ["rewrites", "explanation", "tip", "issue"]
    })
}

fn user_prompt(text: &str, hint: Option<Issue>) -> String {
    let hint = match hint {
        Some(Issue::None) | None => "none".to_string(),
        Some(i) => i.key().to_string(),
    };
    format!(
        "Message:\n\"\"\"\n{text}\n\"\"\"\n\nHint from an automatic screen (may be wrong): {hint}\n\n\
         Return two rewrites, one casual (how you would say it in a chat with a teammate) and one professional \
         (for a manager or client). Then a short explanation of what sounded off (two or three sentences), \
         one reusable tip to remember, and the main issue."
    )
}

#[derive(Deserialize)]
struct Coached {
    rewrites: Vec<Rewrite>,
    explanation: String,
    tip: String,
    issue: String,
}

fn strip_fence(s: &str) -> &str {
    let s = s.trim();
    let s = s.strip_prefix("```json").or_else(|| s.strip_prefix("```")).unwrap_or(s);
    s.strip_suffix("```").unwrap_or(s).trim()
}

/// Pulls the JSON payload out of a `claude -p --output-format json` envelope: `structured_output` when
/// present, else the `result` string (a code fence is tolerated). An error envelope becomes an `Err`.
pub fn extract_payload(stdout: &str) -> Result<Value, String> {
    let envelope: Value = serde_json::from_str(stdout.trim()).map_err(|e| format!("claude output is not JSON: {e}"))?;
    if envelope.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
        let why = envelope.get("result").and_then(Value::as_str).unwrap_or("unknown error");
        return Err(format!("claude reported an error: {why}"));
    }
    match envelope.get("structured_output") {
        Some(v) if v.is_object() => Ok(v.clone()),
        _ => {
            let result = envelope.get("result").and_then(Value::as_str).ok_or("claude output has no result")?;
            serde_json::from_str(strip_fence(result)).map_err(|e| format!("claude answer is not valid JSON: {e}"))
        }
    }
}

fn parse_output(stdout: &str, hint: Option<Issue>, now: i64) -> Result<Coaching, String> {
    let payload = extract_payload(stdout)?;
    let coached: Coached = serde_json::from_value(payload).map_err(|e| format!("coaching has the wrong shape: {e}"))?;
    if coached.rewrites.is_empty() {
        return Err("coaching has no rewrites".into());
    }
    Ok(Coaching {
        rewrites: coached.rewrites,
        explanation: coached.explanation,
        tip: coached.tip,
        issue: Issue::parse(&coached.issue).or(hint).unwrap_or(Issue::None),
        created_at: now,
    })
}

/// Asks Claude Code (the user's own login) for rewrites and an explanation. `cwd` must be a folder
/// that ingestion skips, so the call does not end up in the user's practice material.
pub async fn coach(claude: &Path, cwd: &Path, text: &str, hint: Option<Issue>, now: i64) -> Result<Coaching, String> {
    let stdout = run_claude(claude, cwd, SYSTEM_PROMPT, &schema(), &user_prompt(text, hint)).await?;
    parse_output(&stdout, hint, now)
}

/// Runs one `claude -p` call (no tools, no settings, no session) and returns its stdout envelope.
/// `cwd` must be a folder that ingestion skips.
pub async fn run_claude(claude: &Path, cwd: &Path, system: &str, schema: &Value, prompt: &str) -> Result<String, String> {
    let mut command = Command::new(claude);
    command
        .args(["-p", "--model", MODEL, "--output-format", "json", "--no-session-persistence"])
        .args(["--tools", "", "--setting-sources", "", "--system-prompt", system])
        .arg("--json-schema")
        .arg(schema.to_string())
        .current_dir(cwd)
        .env_remove("ANTHROPIC_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|e| format!("could not start claude: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("claude stdin is unavailable")?;
    stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);

    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "claude took too long to answer".to_string())?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() && stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("claude exited with {}: {}", output.status, stderr.trim()));
    }
    Ok(stdout.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = r#"{"is_error":false,"result":"{\"rewrites\":[{\"register\":\"casual\",\"text\":\"I'll send you the report by the end of the day.\"},{\"register\":\"professional\",\"text\":\"I will send you the report by end of day.\"}],\"explanation\":\"Use by, not until.\",\"tip\":\"By marks a deadline.\",\"issue\":\"preposition_collocation\"}"}"#;

    #[test]
    fn parses_the_result_string_of_a_real_envelope() {
        let c = parse_output(REAL, None, 5).unwrap();
        assert_eq!(c.rewrites.len(), 2);
        assert_eq!(c.rewrites[0].register, "casual");
        assert_eq!(c.issue, Issue::PrepositionCollocation);
        assert_eq!(c.created_at, 5);
    }

    #[test]
    fn prefers_structured_output_when_present() {
        let env = r#"{"is_error":false,"structured_output":{"rewrites":[{"register":"casual","text":"x"}],"explanation":"e","tip":"t","issue":"grammar"},"result":"ignored"}"#;
        assert_eq!(parse_output(env, None, 0).unwrap().issue, Issue::Grammar);
    }

    #[test]
    fn tolerates_a_code_fence_and_falls_back_to_the_hint_for_an_unknown_issue() {
        let env = r#"{"is_error":false,"result":"```json\n{\"rewrites\":[{\"register\":\"casual\",\"text\":\"x\"}],\"explanation\":\"e\",\"tip\":\"t\",\"issue\":\"vibes\"}\n```"}"#;
        assert_eq!(parse_output(env, Some(Issue::WordOrder), 0).unwrap().issue, Issue::WordOrder);
    }

    #[test]
    fn surfaces_a_claude_error_instead_of_inventing_coaching() {
        let env = r#"{"is_error":true,"result":"Not logged in"}"#;
        assert!(parse_output(env, None, 0).unwrap_err().contains("Not logged in"));
        assert!(parse_output("not json", None, 0).is_err());
    }
}
