use crate::model::{Issue, Screen};
use serde_json::{json, Value};
use std::time::Duration;

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-latest";
const MAX_ATTEMPTS: u32 = 5;

const KEY_VAR: &str = "TYPESAFE_API_KEY";

/// The user-level value of an environment variable as stored in `HKCU\Environment`. A process only
/// sees the environment of whoever launched it, so a variable set after Spawner or Explorer started
/// would be invisible to Cadence; the registry always has the current value.
#[cfg(windows)]
fn user_env(name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (subkey, value) = (wide("Environment"), wide(name));
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut bytes: u32 = 0;
    // SAFETY: both strings are NUL-terminated and outlive the calls; a null data pointer asks only for the size.
    let status = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, subkey.as_ptr(), value.as_ptr(), flags, std::ptr::null_mut(), std::ptr::null_mut(), &mut bytes)
    };
    if status != 0 || bytes < 2 {
        return None;
    }
    let mut buf = vec![0u16; (bytes as usize).div_ceil(2)];
    let mut size = (buf.len() * 2) as u32;
    // SAFETY: `buf` holds `size` bytes and stays alive for the call.
    let status = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, subkey.as_ptr(), value.as_ptr(), flags, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size)
    };
    if status != 0 {
        return None;
    }
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

#[cfg(not(windows))]
fn user_env(_name: &str) -> Option<String> {
    None
}

pub fn api_key() -> Option<String> {
    user_env(KEY_VAR)
        .or_else(|| std::env::var(KEY_VAR).ok())
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

pub struct Jev {
    client: reqwest::Client,
    key: String,
}

fn questions() -> Value {
    json!({
        "is_english": {
            "type": "noul",
            "instructions": "The `state` is written in English."
        },
        "is_prose": {
            "type": "noul",
            "instructions": "The `state` is sentences that a person typed to a colleague or an assistant.",
            "criteria": {
                "true": "Sentences or questions a person wrote, however casual or imperfect.",
                "false": "Text pasted from elsewhere: an error message, stack trace, log line, compiler warning, code, a command, a file path, JSON or other tool output."
            }
        },
        "naturalness": {
            "type": "score",
            "instructions": "How natural the `state` sounds, as written by a fluent native English speaker in a work chat.",
            "criteria": [
                "Clearly unnatural or ungrammatical",
                "Understandable but awkward or non-native phrasing",
                "Mostly natural with a small awkwardness",
                "Fully natural"
            ]
        },
        "issue": {
            "type": "choice",
            "instructions": "The main thing that makes the `state` sound non-native. Pick none if it sounds native.",
            "criteria": {
                "none": "Sounds native",
                "grammar": "Wrong or missing articles, tenses, plurals or agreement",
                "preposition_collocation": "Wrong preposition or an unusual word pairing",
                "word_choice": "A word that is correct but not the one a native speaker would use",
                "word_order": "Unusual order of words or clauses",
                "pt_calque": "Literal translation of a Portuguese expression",
                "register": "Too formal, too stiff or too blunt for a work chat"
            }
        }
    })
}

fn parse_screen(body: &Value) -> Result<Screen, String> {
    let answers = body.get("answers").ok_or("response has no answers")?;
    let number = |id: &str, field: &str| {
        answers
            .get(id)
            .and_then(|a| a.get(field))
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("answer `{id}` has no `{field}`"))
    };
    let choice = answers
        .get("issue")
        .and_then(|a| a.get("choice"))
        .and_then(Value::as_str)
        .ok_or("answer `issue` has no `choice`")?;
    Ok(Screen {
        english: number("is_english", "noul")?,
        prose: number("is_prose", "noul")?,
        naturalness: number("naturalness", "score")?,
        confidence: number("naturalness", "confidence")?,
        issue: Issue::parse(choice).ok_or_else(|| format!("unknown issue `{choice}`"))?,
        issue_confidence: number("issue", "confidence")?,
    })
}

impl Jev {
    pub fn new(key: String) -> Jev {
        Jev { client: reqwest::Client::builder().timeout(Duration::from_secs(60)).build().unwrap_or_default(), key }
    }

    pub async fn screen(&self, text: &str) -> Result<Screen, String> {
        let request = json!({ "model": MODEL, "state": text, "questions": questions() });
        let mut delay = Duration::from_secs(1);
        for attempt in 1..=MAX_ATTEMPTS {
            let sent = self.client.post(ENDPOINT).bearer_auth(&self.key).json(&request).send().await;
            let retry = match sent {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        let body: Value = response.json().await.map_err(|e| e.to_string())?;
                        return parse_screen(&body);
                    }
                    let retryable = status.as_u16() == 429 || status.as_u16() == 529 || status.is_server_error();
                    if !retryable {
                        let detail = response.text().await.unwrap_or_default();
                        return Err(format!("TypeSafe returned {status}: {detail}"));
                    }
                    format!("TypeSafe returned {status}")
                }
                Err(e) if e.is_timeout() || e.is_connect() => e.to_string(),
                Err(e) => return Err(e.to_string()),
            };
            if attempt == MAX_ATTEMPTS {
                return Err(retry);
            }
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
        Err("unreachable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_documented_response_shape() {
        let body = json!({
            "model": "jev-1.14.0",
            "answers": {
                "is_english": { "type": "noul", "noul": 0.91 },
                "is_prose": { "type": "noul", "noul": 0.84 },
                "naturalness": { "type": "score", "score": 1.28, "confidence": 0.67, "probabilities": {} },
                "issue": { "type": "choice", "choice": "preposition_collocation", "confidence": 0.36, "probabilities": {} }
            }
        });
        let s = parse_screen(&body).unwrap();
        assert_eq!(s.issue, Issue::PrepositionCollocation);
        assert!((s.naturalness - 1.28).abs() < 1e-9);
        assert!((s.english - 0.91).abs() < 1e-9);
        assert!((s.prose - 0.84).abs() < 1e-9);
    }

    #[test]
    fn a_missing_user_variable_reads_as_none() {
        assert!(user_env("CADENCE_SURELY_NOT_SET_ANYWHERE").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn reads_a_user_variable_that_exists_in_the_registry() {
        assert!(user_env("Path").is_some_and(|p| p.contains(';')));
    }

    #[test]
    fn rejects_an_unknown_issue_instead_of_guessing() {
        let body = json!({
            "answers": {
                "is_english": { "noul": 0.9 },
                "is_prose": { "noul": 0.9 },
                "naturalness": { "score": 2.0, "confidence": 0.5 },
                "issue": { "choice": "vibes", "confidence": 0.5 }
            }
        });
        assert!(parse_screen(&body).is_err());
    }

    #[test]
    fn every_issue_key_is_a_question_option() {
        let q = questions();
        let options = q["issue"]["criteria"].as_object().unwrap();
        for issue in [
            Issue::None,
            Issue::Grammar,
            Issue::PrepositionCollocation,
            Issue::WordChoice,
            Issue::WordOrder,
            Issue::PtCalque,
            Issue::Register,
        ] {
            assert!(options.contains_key(issue.key()), "{}", issue.key());
        }
    }
}
