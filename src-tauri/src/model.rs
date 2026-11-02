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

/// The top of the naturalness scale.
pub const TOP_SCORE: f64 = 3.0;
/// Jev's `score` is the probability-weighted mean of its four levels, so it never reaches 3 even for a
/// sentence nothing is wrong with. A separate yes/no question asks whether a native speaker would change
/// anything. A message scores `TOP_SCORE` when that answer reaches `MIN_NATIVE`, Jev names no issue, and its
/// own score already reaches `MIN_TOP_FROM`. The yes/no answer alone also passes subtle mistakes (a false
/// friend, a wrong register), so the top only ever lifts a message that was not flagged anyway.
pub const MIN_NATIVE: f64 = 0.5;
pub const MIN_TOP_FROM: f64 = 2.0;

/// Jev's score misses mistakes that still read as grammatical: a false friend ("realize the migration"), a
/// Portuguese phrase translated word for word, a blunt register. A separate question looks for them; at or
/// above this confidence the message scores at most `SLIP_SCORE`, below the default goal, so it reaches the
/// queue, and takes that issue when Jev named none. The confidence is low because the answer is rare: on the
/// eval it never fired on a native message, while real slips came in at 0.39 and 0.41.
pub const MIN_SLIP: f64 = 0.3;
pub const SLIP_SCORE: f64 = 1.9;

/// The version of the questions Jev is asked (`jev::questions`). Bump it whenever they change: scores
/// made under different questions are not compared, and the original of a rewritten message is screened
/// again so it can be compared with the new version.
pub const RUBRIC: i64 = 2;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub english: f64,
    /// Probability that the text is sentences a person wrote, not a pasted log, stack trace, code or tool output.
    pub prose: f64,
    /// `TOP_SCORE` when `native` reaches `MIN_NATIVE`, otherwise Jev's score.
    pub naturalness: f64,
    /// Probability that a fluent native speaker would change nothing in the wording. None before rubric 1.
    #[serde(default)]
    pub native: Option<f64>,
    /// The `RUBRIC` this screen was made under; 0 for screens saved before rubrics existed.
    #[serde(default)]
    pub rubric: i64,
    /// The subtle mistake Jev's `slip` question found, if any, with its confidence. Only the eval reads them;
    /// `jev::with_rules` has already folded them into `naturalness` and `issue`, so they are not stored.
    #[serde(skip)]
    pub slip: Option<(Issue, f64)>,
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
    /// What the `claude -p` call that wrote this coaching cost, in USD. None for coaching saved before
    /// costs were tracked, or when the CLI did not report one.
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub id: i64,
    pub text: String,
    pub created_at: i64,
    /// How natural the attempt sounds, so the card can show progress against the original. None when
    /// the attempt was saved before attempts were scored, or when Jev could not be reached.
    pub screen: Option<Screen>,
    /// The review of this version. Every version keeps its own, so the history stays readable.
    pub coaching: Option<Coaching>,
}

/// What one `claude -p` call used, read from its JSON envelope. Every field is optional there, so a
/// missing one counts as zero or None.
#[derive(Clone, Debug, Default)]
pub struct Usage {
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_usd: Option<f64>,
    pub duration_ms: i64,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum UsageKind {
    /// A review of a rewrite (`claude -p`).
    Coach,
    /// Feedback on an interview answer (`claude -p`).
    Interview,
    /// One TypeSafe Jev screen. TypeSafe does not report a cost, so these are only counted.
    Screen,
}

impl UsageKind {
    pub fn key(self) -> &'static str {
        match self {
            UsageKind::Coach => "coach",
            UsageKind::Interview => "interview",
            UsageKind::Screen => "screen",
        }
    }

    pub fn parse(key: &str) -> UsageKind {
        match key {
            "coach" => UsageKind::Coach,
            "interview" => UsageKind::Interview,
            _ => UsageKind::Screen,
        }
    }
}

/// Spending over one period. `cost_usd` is Claude only: it is what `claude -p` reports at list prices,
/// so on a subscription it is the equivalent API cost, not a charge.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub claude_calls: i64,
    pub jev_calls: i64,
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_tokens: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DayCost {
    /// Local date, yyyy-mm-dd
    pub day: String,
    pub cost_usd: f64,
    pub claude_calls: i64,
    pub jev_calls: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KindCost {
    pub kind: UsageKind,
    pub calls: i64,
    pub cost_usd: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageCall {
    pub id: i64,
    pub at: i64,
    pub kind: UsageKind,
    /// The start of the message or interview answer the call was about.
    pub preview: Option<String>,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_usd: Option<f64>,
    pub duration_ms: i64,
    pub ok: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Spending {
    pub today: UsageTotals,
    /// The last 7 local days, today included.
    pub week: UsageTotals,
    /// The last 30 local days, today included.
    pub month: UsageTotals,
    pub all_time: UsageTotals,
    /// The last 30 local days, oldest first, with a row for every day (zeros where nothing was spent).
    pub days: Vec<DayCost>,
    pub by_kind: Vec<KindCost>,
    /// Newest first.
    pub recent: Vec<UsageCall>,
    /// Epoch ms of the first tracked call, or None before any. Spending from before tracking is not counted.
    pub since: Option<i64>,
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
    /// Set by hand when the message is not fit for practice; it then leaves the queue, the counts and the patterns.
    pub excluded_at: Option<i64>,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum MessageFilter {
    Queue,
    Reviewed,
    /// Messages the user wrote at least one new version of, most recently rewritten first.
    Rewritten,
    All,
    Excluded,
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
}

impl Default for Settings {
    fn default() -> Self {
        Settings { run_hour: 22, flag_threshold: 2.0, min_words: 8 }
    }
}

impl Settings {
    pub fn clamped(self) -> Settings {
        Settings {
            run_hour: self.run_hour.min(23),
            flag_threshold: self.flag_threshold.clamp(0.0, 3.0),
            min_words: self.min_words.clamp(1, 200),
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunPhase {
    Ingest,
    Screen,
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
