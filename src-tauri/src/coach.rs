use crate::model::{Coaching, Issue, Rewrite, Screen, Usage};
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
Every message is a prompt they typed to a coding agent (Claude Code) while working, not a formal email. \
In that chat a missing final period, a lowercase first letter and short imperatives are normal: never mention them. \
A tool, command or package name that is also an English word (just, make, go, node) is fine when it is in quotes or backticks. \
You get one message they wrote, the new version they wrote after reading it again, and a hint about what may sound off in the original. \
Review their new version, not the original: say what still sounds off in it, and if it already sounds natural, say so and say what they improved. \
The message may also carry the verdict of an automatic naturalness screen (Jev) on the new version: it is the judge, so never contradict it. \
When the version passed, say it sounds natural and what they improved over the original, and do not list optional polish (capital letters, a synonym you would prefer, a different style). \
When it fell short, explain what holds it back, starting from the issue the screen named. If that issue does not match what they wrote, say what you actually see instead of forcing it. Do not quote the score: the app already shows it. \
Before you correct a word, check whether it is a noun or a work term in that sentence. 'lead' is a potential customer, 'referral' someone who was invited, 'tester' a role, 'signup' the act of registering, and none of them is a verb form. \
Never correct a word into one that changes what they meant. If a word has two readings, take the one that makes sense at work, and in 'assumption' say which reading you took. If you cannot tell, name both readings and what the fix is for each. \
When a term list comes with the message, those words are the person's own jargon: use them as defined and never correct them. \
Keep their meaning and level of detail. Do not add content. Do not make it more formal than needed. \
If the new version already sounds natural, make the rewrites small variations. \
File names such as Program.cs and site names such as github.com stand in for full paths and links that were shortened on purpose: keep the names as they are in the rewrites and do not comment on them. \
Explain in plain words, and mention the Portuguese pattern behind a mistake when there is one. \
When you quote their words, use single quotes. Never write a backslash.";

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
            "assumption": { "type": "string" },
            "idea": { "type": "string" },
            "issue": {
                "type": "string",
                "enum": ["none", "articles", "agreement_tense", "typo", "missing_word", "preposition", "awkward_phrasing", "word_order", "pt_calque", "register"]
            }
        },
        "required": ["rewrites", "explanation", "tip", "assumption", "idea", "issue"]
    })
}

/// What Jev made of the new version, handed to the coach so its review agrees with the score on the card.
#[derive(Clone, Copy, Debug)]
pub struct Verdict {
    pub score: f64,
    pub goal: f64,
    pub issue: Issue,
}

impl Verdict {
    pub fn of(screen: &Screen, goal: f64) -> Verdict {
        Verdict { score: screen.naturalness, goal, issue: screen.issue }
    }

    fn describe(&self) -> String {
        let issue = match self.issue {
            Issue::None => "named no issue".to_string(),
            i => format!("named this issue: {}", i.key()),
        };
        if self.score >= self.goal {
            format!(
                "Verdict of the automatic screen on their new version: {:.1} out of 3, the goal is {:.1}, so it PASSED and the screen {issue}. \
                 Treat it as natural: do not contradict it or list optional polish. Name a problem only if it is a plain error that would \
                 confuse a reader. Keep the rewrites to small variations.",
                self.score, self.goal
            )
        } else {
            format!(
                "Verdict of the automatic screen on their new version: {:.1} out of 3, below the goal of {:.1}, so it FELL SHORT and the screen {issue}. \
                 Do not call it natural. Explain what holds it back.",
                self.score, self.goal
            )
        }
    }
}

fn user_prompt(original: &str, attempt: &str, hint: Option<Issue>, verdict: Option<Verdict>, glossary: &str) -> String {
    let hint = match hint {
        Some(Issue::None) | None => "none".to_string(),
        Some(i) => i.key().to_string(),
    };
    let verdict = verdict.map(|v| format!("{}\n\n", v.describe())).unwrap_or_default();
    let glossary = glossary.trim();
    let glossary = if glossary.is_empty() {
        String::new()
    } else {
        format!("The person's own terms (work jargon, use them as defined and never correct them):\n{glossary}\n\n")
    };
    format!(
        "Original message:\n\"\"\"\n{original}\n\"\"\"\n\nTheir new version:\n\"\"\"\n{attempt}\n\"\"\"\n\n\
         Hint from an automatic screen of the original (may be wrong): {hint}\n\n{verdict}{glossary}\
         Return two rewrites of their new version, one casual (how you would say it in a chat with a teammate) and one \
         professional (for a manager or client). Then a short explanation of what still sounds off in the new version, \
         or why it sounds natural (two or three sentences), one reusable tip to remember, the main issue of the original, \
         and the assumption: one short sentence saying how you read any word that could mean two things \
         (for example 'I read lead as a potential customer'), or an empty string when nothing was ambiguous. \
         Finally the idea: one or two plain sentences saying what they meant to ask or say, as an instruction to someone else \
         ('Ask Claude to look into deployment options. The answer is needed by tomorrow.'). Describe the meaning, not the words: \
         do not reuse their phrasing, so that writing the message again from the idea is a real exercise. Keep the same level of detail."
    )
}

#[derive(Deserialize)]
struct Coached {
    rewrites: Vec<Rewrite>,
    explanation: String,
    tip: String,
    #[serde(default)]
    assumption: String,
    #[serde(default)]
    idea: String,
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

/// The model sometimes escapes the quotes it writes inside a JSON string twice, which leaves a literal
/// backslash before the quote in the text. Prose never wants that, so drop it.
fn clean(s: String) -> String {
    s.replace("\\\"", "\"")
}

pub fn parse_output(stdout: &str, hint: Option<Issue>, now: i64) -> Result<Coaching, String> {
    let payload = extract_payload(stdout)?;
    let coached: Coached = serde_json::from_value(payload).map_err(|e| format!("coaching has the wrong shape: {e}"))?;
    if coached.rewrites.is_empty() {
        return Err("coaching has no rewrites".into());
    }
    Ok(Coaching {
        rewrites: coached.rewrites.into_iter().map(|r| Rewrite { text: clean(r.text), ..r }).collect(),
        explanation: clean(coached.explanation),
        tip: clean(coached.tip),
        assumption: clean(coached.assumption),
        idea: clean(coached.idea),
        issue: Issue::parse(&coached.issue).or(hint).unwrap_or(Issue::None),
        created_at: now,
        cost_usd: None,
    })
}

/// What the call used, read from the envelope. A call that fails to parse still cost money, so this
/// never fails: whatever is missing counts as zero or None. The model is the one that cost the most
/// (the CLI sometimes adds a small helper call on another model).
pub fn usage_from(stdout: &str) -> Usage {
    let Ok(envelope) = serde_json::from_str::<Value>(stdout.trim()) else { return Usage::default() };
    let tokens = |v: &Value, key: &str| v.get(key).and_then(Value::as_i64).unwrap_or(0);
    let usage = envelope.get("usage").cloned().unwrap_or(Value::Null);
    let model = envelope
        .get("modelUsage")
        .and_then(Value::as_object)
        .and_then(|m| {
            let cost = |v: &Value| v.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0);
            m.iter().max_by(|a, b| cost(a.1).total_cmp(&cost(b.1)))
        })
        .map(|(name, _)| name.clone())
        .unwrap_or_default();
    Usage {
        model,
        input_tokens: tokens(&usage, "input_tokens"),
        output_tokens: tokens(&usage, "output_tokens"),
        cache_read_tokens: tokens(&usage, "cache_read_input_tokens"),
        cache_write_tokens: tokens(&usage, "cache_creation_input_tokens"),
        cost_usd: envelope.get("total_cost_usd").and_then(Value::as_f64),
        duration_ms: envelope.get("duration_ms").and_then(Value::as_i64).unwrap_or(0),
    }
}

/// Asks Claude Code (the user's own login) to review the user's new version of a message and returns the
/// raw envelope: the caller records its usage, then parses it with `parse_output`. `cwd` must be a folder
/// that ingestion skips, so the call does not end up in the user's practice material.
pub async fn ask(
    claude: &Path,
    cwd: &Path,
    original: &str,
    attempt: &str,
    hint: Option<Issue>,
    verdict: Option<Verdict>,
    glossary: &str,
) -> Result<String, String> {
    run_claude(claude, cwd, SYSTEM_PROMPT, &schema(), &user_prompt(original, attempt, hint, verdict, glossary)).await
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

    const REAL: &str = r#"{"is_error":false,"result":"{\"rewrites\":[{\"register\":\"casual\",\"text\":\"I'll send you the report by the end of the day.\"},{\"register\":\"professional\",\"text\":\"I will send you the report by end of day.\"}],\"explanation\":\"Use by, not until.\",\"tip\":\"By marks a deadline.\",\"issue\":\"preposition\"}"}"#;

    #[test]
    fn parses_the_result_string_of_a_real_envelope() {
        let c = parse_output(REAL, None, 5).unwrap();
        assert_eq!(c.rewrites.len(), 2);
        assert_eq!(c.rewrites[0].register, "casual");
        assert_eq!(c.issue, Issue::Preposition);
        assert_eq!(c.created_at, 5);
    }

    #[test]
    fn prefers_structured_output_when_present() {
        let env = r#"{"is_error":false,"structured_output":{"rewrites":[{"register":"casual","text":"x"}],"explanation":"e","tip":"t","issue":"agreement_tense"},"result":"ignored"}"#;
        assert_eq!(parse_output(env, None, 0).unwrap().issue, Issue::AgreementTense);
    }

    #[test]
    fn tolerates_a_code_fence_and_falls_back_to_the_hint_for_an_unknown_issue() {
        let env = r#"{"is_error":false,"result":"```json\n{\"rewrites\":[{\"register\":\"casual\",\"text\":\"x\"}],\"explanation\":\"e\",\"tip\":\"t\",\"issue\":\"vibes\"}\n```"}"#;
        assert_eq!(parse_output(env, Some(Issue::WordOrder), 0).unwrap().issue, Issue::WordOrder);
    }

    #[test]
    fn drops_the_backslash_the_model_puts_before_a_quote() {
        let env = r#"{"is_error":false,"structured_output":{"rewrites":[{"register":"casual","text":"say \\\"hi\\\""}],"explanation":"The problem is \\\"take this\\\".","tip":"Use \\\"look at\\\".","issue":"agreement_tense"}}"#;
        let c = parse_output(env, None, 0).unwrap();
        assert_eq!(c.rewrites[0].text, "say \"hi\"");
        assert_eq!(c.explanation, "The problem is \"take this\".");
        assert_eq!(c.tip, "Use \"look at\".");
    }

    #[test]
    fn the_prompt_carries_both_the_original_and_the_new_version() {
        let p = user_prompt("take this", "look at this", None, None, "");
        assert!(p.contains("take this") && p.contains("look at this"));
        assert!(!p.contains("Verdict") && !p.contains("own terms"));
    }

    #[test]
    fn the_prompt_carries_the_persons_glossary() {
        let p = user_prompt("a", "b", None, None, "  lead: a potential customer\n");
        assert!(p.contains("own terms") && p.contains("lead: a potential customer"));
        assert!(user_prompt("a", "b", None, None, "   \n").find("own terms").is_none());
    }

    #[test]
    fn the_prompt_asks_for_the_reading_taken_of_an_ambiguous_word() {
        assert!(user_prompt("a", "b", None, None, "").contains("assumption"));
        assert!(SYSTEM_PROMPT.contains("noun or a work term"));
        assert!(schema()["required"].as_array().unwrap().iter().any(|k| k == "assumption"));
    }

    #[test]
    fn the_assumption_is_kept_and_defaults_to_empty() {
        let with = r#"{"is_error":false,"structured_output":{"rewrites":[{"register":"casual","text":"x"}],"explanation":"e","tip":"t","assumption":"I read 'lead' as a potential customer","issue":"agreement_tense"}}"#;
        assert_eq!(parse_output(with, None, 0).unwrap().assumption, "I read 'lead' as a potential customer");
        assert_eq!(parse_output(REAL, None, 0).unwrap().assumption, "");
    }

    #[test]
    fn the_idea_is_asked_for_kept_and_defaults_to_empty() {
        assert!(user_prompt("a", "b", None, None, "").contains("the idea"));
        assert!(schema()["required"].as_array().unwrap().iter().any(|k| k == "idea"));
        let with = r#"{"is_error":false,"structured_output":{"rewrites":[{"register":"casual","text":"x"}],"explanation":"e","tip":"t","assumption":"","idea":"Ask Claude to look into deployment options.","issue":"agreement_tense"}}"#;
        assert_eq!(parse_output(with, None, 0).unwrap().idea, "Ask Claude to look into deployment options.");
        assert_eq!(parse_output(REAL, None, 0).unwrap().idea, "");
    }

    #[test]
    fn the_prompt_carries_jevs_verdict_on_the_new_version() {
        let passed = user_prompt("a", "b", None, Some(Verdict { score: 3.0, goal: 2.0, issue: Issue::None }), "");
        assert!(passed.contains("3.0 out of 3") && passed.contains("PASSED"));
        let short = user_prompt("a", "b", None, Some(Verdict { score: 1.2, goal: 2.0, issue: Issue::PtCalque }), "");
        assert!(short.contains("FELL SHORT") && short.contains("pt_calque"));
    }

    #[test]
    fn reads_cost_and_tokens_from_the_envelope_and_picks_the_main_model() {
        let env = r#"{"is_error":false,"result":"x","duration_ms":1608,"total_cost_usd":0.0026443,
            "usage":{"input_tokens":2,"cache_creation_input_tokens":619,"cache_read_input_tokens":7,"output_tokens":4},
            "modelUsage":{"claude-haiku-5-5":{"outputTokens":14,"costUSD":0.0001243},"claude-sonnet-5-5":{"outputTokens":4,"cacheCreationInputTokens":619,"costUSD":0.00252}}}"#;
        let u = usage_from(env);
        assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens), (2, 4, 7, 619));
        assert_eq!(u.cost_usd, Some(0.0026443));
        assert_eq!(u.duration_ms, 1608);
        assert_eq!(u.model, "claude-sonnet-5-5");
    }

    #[test]
    fn an_envelope_without_usage_counts_as_nothing_instead_of_failing() {
        let u = usage_from(REAL);
        assert_eq!((u.input_tokens, u.cost_usd), (0, None));
        assert_eq!(usage_from("not json").cost_usd, None);
    }

    #[test]
    fn surfaces_a_claude_error_instead_of_inventing_coaching() {
        let env = r#"{"is_error":true,"result":"Not logged in"}"#;
        assert!(parse_output(env, None, 0).unwrap_err().contains("Not logged in"));
        assert!(parse_output("not json", None, 0).is_err());
    }
}
