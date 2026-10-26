use crate::coach::extract_payload;
use crate::model::{InterviewFeedback, InterviewTopic, Issue};
use serde::Deserialize;
use serde_json::{json, Value};

use InterviewTopic::{Backend, Behavioral, Cloud, SystemDesign, Testing};

/// The built-in question bank. `Db::open` inserts every row that is missing (the text is unique), so
/// adding a question here is enough; editing the text of an existing one adds a new row.
pub const BANK: &[(InterviewTopic, &str)] = &[
    (Cloud, "What is the difference between a queue and a topic? When would you pick one over the other?"),
    (Cloud, "What does at-least-once delivery mean, and how does it change the way you write a consumer?"),
    (Cloud, "How do you apply the principle of least privilege with IAM roles and policies?"),
    (Cloud, "How would you set up autoscaling for a web API? What metrics would you scale on, and what can go wrong?"),
    (Cloud, "When would you use a managed database instead of running your own? What do you give up?"),
    (Cloud, "What are the trade-offs of serverless functions? When would you avoid them?"),
    (Cloud, "What is infrastructure as code, and why does it matter? Which tools have you used?"),
    (Cloud, "How do you approach observability in production? How do logs, metrics and traces work together?"),
    (Cloud, "How would you keep cloud costs under control for a growing product?"),
    (Cloud, "How would you deploy a new version of a service with no downtime?"),
    (Testing, "Can you explain the test pyramid? Do you agree with it?"),
    (Testing, "What is the difference between a unit test and an integration test? How do you decide which one to write?"),
    (Testing, "What is the difference between a mock and a fake? What is the risk of over-mocking?"),
    (Testing, "Why would you run integration tests against a real database, for example with Testcontainers?"),
    (Testing, "Do you practice TDD? What does it give you, and where does it not work well?"),
    (Testing, "What do you do when you find a flaky test?"),
    (Testing, "What are contract tests, and when are they useful?"),
    (Testing, "How would you test a message queue consumer?"),
    (Testing, "When you review a pull request, what do you expect to see in the tests?"),
    (Testing, "How do you decide how much test coverage is enough?"),
    (Backend, "What is idempotency? How would you make a payment endpoint idempotent?"),
    (Backend, "What is a database transaction? Explain isolation levels and the problems they prevent."),
    (Backend, "How do database indexes work? When can an index hurt you?"),
    (Backend, "Cache invalidation is a famously hard problem. How do you deal with it?"),
    (Backend, "What is the N+1 query problem, and how do you find and fix it?"),
    (Backend, "How do you design a REST API? How do you choose status codes and handle errors?"),
    (Backend, "How does async and await work, and how does it relate to the thread pool? What mistakes do people make?"),
    (Backend, "How do you implement retries with exponential backoff? What can go wrong with retries?"),
    (Backend, "What is a race condition? Give an example and explain how you would prevent it."),
    (Backend, "What is the difference between authentication and authorization? How would you implement both in an API?"),
    (SystemDesign, "Design a notification service that sends emails, SMS and push messages."),
    (SystemDesign, "Design a rate limiter for a public API."),
    (SystemDesign, "Design a file upload service for large files."),
    (SystemDesign, "Design a booking system for shared spaces in a condominium, like a party room or a barbecue area."),
    (SystemDesign, "Design the monthly condo-fee billing system, including payments and late fees."),
    (SystemDesign, "Design an audit log that records who changed what in a system."),
    (SystemDesign, "Design a URL shortener."),
    (SystemDesign, "Design a background job system with retries and scheduling."),
    (Behavioral, "Tell me about yourself."),
    (Behavioral, "Tell me about a hard bug you solved. How did you find the cause?"),
    (Behavioral, "Tell me about an incident in production. What happened, and what did you do?"),
    (Behavioral, "Tell me about a disagreement with a teammate. How did you handle it?"),
    (Behavioral, "Tell me about a technical decision you would make differently today."),
    (Behavioral, "Tell me about a project you are proud of. What was your part in it?"),
    (Behavioral, "Why do you want to leave your current job?"),
    (Behavioral, "How do you learn a new technology when you need to use it at work?"),
];

pub const SYSTEM_PROMPT: &str = "You are a senior backend engineer interviewing a mid-level backend candidate at an international product company, \
and you are also an English speaking coach. \
The candidate is a software engineer whose first language is Brazilian Portuguese. \
The answer was dictated with speech-to-text, so ignore missing punctuation, capitalisation and obvious transcription errors, \
and judge it as spoken English. \
Be honest and specific, not flattering.";

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "spoken": { "type": "string" },
            "englishNotes": { "type": "string" },
            "tip": { "type": "string" },
            "issue": {
                "type": "string",
                "enum": ["none", "grammar", "preposition_collocation", "word_choice", "word_order", "pt_calque", "register"]
            },
            "depth": { "type": "integer", "minimum": 1, "maximum": 5 },
            "depthNotes": { "type": "string" },
            "missing": { "type": "array", "maxItems": 5, "items": { "type": "string" } },
            "followUp": { "type": "string" }
        },
        "required": ["spoken", "englishNotes", "tip", "issue", "depth", "depthNotes", "missing", "followUp"]
    })
}

pub fn user_prompt(topic: InterviewTopic, question: &str, answer: &str) -> String {
    format!(
        "Topic: {topic}\n\nInterview question:\n\"\"\"\n{question}\n\"\"\"\n\nCandidate's answer (dictated):\n\"\"\"\n{answer}\n\"\"\"\n\n\
         Return:\n\
         - spoken: the candidate's answer rewritten as a fluent engineer would say it out loud in an interview. Keep their content and structure. \
         Do not add technical points; anything missing goes in `missing`. Conversational, not written-essay style.\n\
         - englishNotes: two or three sentences on what sounded off in the English. Name the Portuguese pattern behind it when there is one.\n\
         - tip: one reusable phrase or rule.\n\
         - issue: the main English issue, one of none, grammar, preposition_collocation, word_choice, word_order, pt_calque, register.\n\
         - depth: an integer from 1 to 5. 1 = vague or wrong. 2 = definitions only. 3 = correct, with some how and why. \
         4 = trade-offs and a concrete example from experience. \
         5 = senior-level: trade-offs, failure modes, and when they would choose otherwise. \
         For behavioral questions, judge structure (situation, action, result), specifics and ownership instead.\n\
         - depthNotes: one or two sentences explaining the depth score.\n\
         - missing: zero to five short items a strong answer would have covered and this one did not.\n\
         - followUp: one question the interviewer would most likely ask next.",
        topic = topic.key(),
    )
}

#[derive(Deserialize)]
struct Reviewed {
    spoken: String,
    #[serde(rename = "englishNotes")]
    english_notes: String,
    tip: String,
    issue: String,
    depth: f64,
    #[serde(rename = "depthNotes")]
    depth_notes: String,
    #[serde(default)]
    missing: Vec<String>,
    #[serde(rename = "followUp")]
    follow_up: String,
}

pub fn parse_output(stdout: &str, now: i64) -> Result<InterviewFeedback, String> {
    let payload = extract_payload(stdout)?;
    let r: Reviewed = serde_json::from_value(payload).map_err(|e| format!("feedback has the wrong shape: {e}"))?;
    Ok(InterviewFeedback {
        spoken: r.spoken,
        english_notes: r.english_notes,
        tip: r.tip,
        issue: Issue::parse(&r.issue).unwrap_or(Issue::None),
        depth: (r.depth.round() as i64).clamp(1, 5),
        depth_notes: r.depth_notes,
        missing: r.missing.into_iter().take(5).collect(),
        follow_up: r.follow_up,
        created_at: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bank_covers_every_topic_with_unique_questions() {
        for t in [Cloud, Testing, Backend, SystemDesign, Behavioral] {
            assert!(BANK.iter().filter(|(topic, _)| *topic == t).count() >= 8, "{t:?}");
        }
        let mut texts: Vec<_> = BANK.iter().map(|(_, q)| *q).collect();
        texts.sort();
        texts.dedup();
        assert_eq!(texts.len(), BANK.len());
    }

    #[test]
    fn parses_a_structured_output_envelope_and_clamps_depth() {
        let env = r#"{"is_error":false,"structured_output":{"spoken":"s","englishNotes":"n","tip":"t","issue":"pt_calque","depth":9,"depthNotes":"d","missing":["a","b"],"followUp":"f"}}"#;
        let f = parse_output(env, 7).unwrap();
        assert_eq!(f.issue, Issue::PtCalque);
        assert_eq!(f.depth, 5);
        assert_eq!(f.missing, ["a", "b"]);
        assert_eq!(f.follow_up, "f");
        assert_eq!(f.created_at, 7);
    }

    #[test]
    fn parses_a_result_string_with_a_code_fence_and_an_unknown_issue() {
        let env = r#"{"is_error":false,"result":"```json\n{\"spoken\":\"s\",\"englishNotes\":\"n\",\"tip\":\"t\",\"issue\":\"vibes\",\"depth\":0,\"depthNotes\":\"d\",\"missing\":[],\"followUp\":\"f\"}\n```"}"#;
        let f = parse_output(env, 0).unwrap();
        assert_eq!(f.issue, Issue::None);
        assert_eq!(f.depth, 1);
        assert!(f.missing.is_empty());
    }

    #[test]
    fn surfaces_an_error_envelope_and_bad_shapes() {
        let env = r#"{"is_error":true,"result":"Not logged in"}"#;
        assert!(parse_output(env, 0).unwrap_err().contains("Not logged in"));
        assert!(parse_output(r#"{"is_error":false,"structured_output":{"spoken":"x"}}"#, 0).is_err());
        assert!(parse_output("nope", 0).is_err());
    }
}
