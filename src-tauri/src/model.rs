use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Issue {
    None,
    Grammar,
    PrepositionCollocation,
    WordChoice,
    WordOrder,
    PtCalque,
    Register,
}

impl Issue {
    pub fn key(self) -> &'static str {
        match self {
            Issue::None => "none",
            Issue::Grammar => "grammar",
            Issue::PrepositionCollocation => "preposition_collocation",
            Issue::WordChoice => "word_choice",
            Issue::WordOrder => "word_order",
            Issue::PtCalque => "pt_calque",
            Issue::Register => "register",
        }
    }

    pub fn parse(key: &str) -> Option<Issue> {
        Some(match key {
            "none" => Issue::None,
            "grammar" => Issue::Grammar,
            "preposition_collocation" => Issue::PrepositionCollocation,
            "word_choice" => Issue::WordChoice,
            "word_order" => Issue::WordOrder,
            "pt_calque" => Issue::PtCalque,
            "register" => Issue::Register,
            _ => return None,
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum InterviewTopic {
    Cloud,
    Testing,
    Backend,
    SystemDesign,
    Behavioral,
}

impl InterviewTopic {
    pub fn key(self) -> &'static str {
        match self {
            InterviewTopic::Cloud => "cloud",
            InterviewTopic::Testing => "testing",
            InterviewTopic::Backend => "backend",
            InterviewTopic::SystemDesign => "system_design",
            InterviewTopic::Behavioral => "behavioral",
        }
    }

    pub fn parse(key: &str) -> Option<InterviewTopic> {
        Some(match key {
            "cloud" => InterviewTopic::Cloud,
            "testing" => InterviewTopic::Testing,
            "backend" => InterviewTopic::Backend,
            "system_design" => InterviewTopic::SystemDesign,
            "behavioral" => InterviewTopic::Behavioral,
            _ => return None,
        })
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InterviewQuestion {
    pub id: i64,
    pub topic: InterviewTopic,
    pub text: String,
    pub custom: bool,
    pub answers: i64,
    pub last_answered_at: Option<i64>,
    pub best_depth: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InterviewFeedback {
    pub spoken: String,
    pub english_notes: String,
    pub tip: String,
    pub issue: Issue,
    pub depth: i64,
    pub depth_notes: String,
    pub missing: Vec<String>,
    pub follow_up: String,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InterviewAnswer {
    pub id: i64,
    pub question_id: i64,
    pub text: String,
    pub seconds: i64,
    pub created_at: i64,
    pub screen: Option<Screen>,
    pub feedback: Option<InterviewFeedback>,
}

/// Below these, a message is not something the user wrote in English prose, so its naturalness
/// says nothing. `db` builds its SQL from the same numbers.
pub const MIN_ENGLISH: f64 = 0.5;
pub const MIN_PROSE: f64 = 0.5;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub english: f64,
    /// Probability that the text is sentences a person wrote, not a pasted log, stack trace, code or tool output.
    pub prose: f64,
    pub naturalness: f64,
    pub confidence: f64,
    pub issue: Issue,
    pub issue_confidence: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Rewrite {
    pub register: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Coaching {
    pub rewrites: Vec<Rewrite>,
    pub explanation: String,
    pub tip: String,
    pub issue: Issue,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub id: i64,
    pub text: String,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub text: String,
    pub ts: i64,
    pub project: Option<String>,
    pub words: i64,
    pub source: String,
    pub screen: Option<Screen>,
    pub coaching: Option<Coaching>,
    pub attempts: Vec<Attempt>,
    pub reviewed_at: Option<i64>,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum MessageFilter {
    Queue,
    Reviewed,
    All,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MessageQuery {
    pub filter: MessageFilter,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub day: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub ok: bool,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub total: i64,
    pub screened: i64,
    pub queued: i64,
    pub reviewed: i64,
    pub pending: i64,
    pub last_run: Option<RunInfo>,
    pub next_run_at: i64,
    pub running: bool,
    pub typesafe_configured: bool,
    pub claude_found: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PatternRow {
    pub issue: Issue,
    pub count: i64,
    pub avg_naturalness: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrendRow {
    pub day: String,
    pub count: i64,
    pub avg_naturalness: f64,
}

/// Flagged messages of one issue in one local week (weeks start on Monday).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IssueWeekRow {
    pub week: String,
    pub issue: Issue,
    pub count: i64,
}

/// Local week with the number of screened messages, the denominator for `IssueWeekRow`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WeekRow {
    pub week: String,
    pub screened: i64,
}

/// How often one issue shows up before and after the first time it was coached.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CoachedImpact {
    pub issue: Issue,
    pub coached_at: i64,
    pub before_screened: i64,
    pub before_flagged: i64,
    pub after_screened: i64,
    pub after_flagged: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Patterns {
    pub issues: Vec<PatternRow>,
    pub trend: Vec<TrendRow>,
    /// `Settings::flag_threshold`, drawn as the goal line on the trend chart.
    pub threshold: f64,
    pub weeks: Vec<WeekRow>,
    pub issue_weeks: Vec<IssueWeekRow>,
    pub coached_impact: Vec<CoachedImpact>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub run_hour: u32,
    pub flag_threshold: f64,
    pub min_words: i64,
    pub auto_coach: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { run_hour: 22, flag_threshold: 2.0, min_words: 8, auto_coach: 5 }
    }
}

impl Settings {
    pub fn clamped(self) -> Settings {
        Settings {
            run_hour: self.run_hour.min(23),
            flag_threshold: self.flag_threshold.clamp(0.0, 3.0),
            min_words: self.min_words.clamp(1, 200),
            auto_coach: self.auto_coach.clamp(0, 50),
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunPhase {
    Ingest,
    Screen,
    Coach,
    Done,
    Error,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunProgress {
    pub phase: RunPhase,
    pub done: usize,
    pub total: usize,
    pub message: Option<String>,
}

pub struct NewMessage {
    pub id: String,
    pub text: String,
    pub ts: i64,
    pub project: Option<String>,
    pub session_id: Option<String>,
    pub source: &'static str,
}

impl NewMessage {
    pub fn words(&self) -> i64 {
        self.text.split_whitespace().count() as i64
    }
}
