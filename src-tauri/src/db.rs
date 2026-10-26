use crate::interview;
use crate::model::{
    InterviewAnswer, InterviewFeedback, InterviewQuestion, InterviewTopic, Attempt, CoachedImpact, Coaching, Issue, IssueWeekRow, WeekRow, Message, MessageFilter, MessageQuery, Overview, PatternRow, Patterns,
    NewMessage, RunInfo, Rewrite, Screen, Settings, TrendRow, MIN_ENGLISH, MIN_PROSE,
};
use crate::redact::{self, redact};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    project TEXT,
    session_id TEXT,
    words INTEGER NOT NULL,
    source TEXT NOT NULL,
    reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
CREATE TABLE IF NOT EXISTS screens (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    english REAL NOT NULL,
    prose REAL,
    naturalness REAL NOT NULL,
    confidence REAL NOT NULL,
    issue TEXT NOT NULL,
    issue_confidence REAL NOT NULL,
    model TEXT NOT NULL,
    screened_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coaching (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    rewrites TEXT NOT NULL,
    explanation TEXT NOT NULL,
    tip TEXT NOT NULL,
    issue TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_message ON attempts(message_id);
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    offset INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    day TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    ok INTEGER NOT NULL,
    detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interview_questions (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    text TEXT NOT NULL UNIQUE,
    custom INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS interview_answers (
    id INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES interview_questions(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    seconds INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    screen TEXT,
    feedback TEXT
);
CREATE INDEX IF NOT EXISTS interview_answers_question ON interview_answers(question_id);
";

const QUESTION_SELECT: &str = "
SELECT q.id, q.topic, q.text, q.custom, COUNT(a.id), MAX(a.created_at), MAX(json_extract(a.feedback, '$.depth'))
FROM interview_questions q
LEFT JOIN interview_answers a ON a.question_id = q.id
";

const MESSAGE_SELECT: &str = "
SELECT m.id, m.text, m.ts, m.project, m.words, m.source, m.reviewed_at,
       s.english, s.naturalness, s.confidence, s.issue, s.issue_confidence,
       c.rewrites, c.explanation, c.tip, c.issue, c.created_at, s.prose
FROM messages m
LEFT JOIN screens s ON s.message_id = m.id
LEFT JOIN coaching c ON c.message_id = m.id
";

/// The screens whose naturalness means something: English, written by the user. A screen saved before `prose`
/// existed has no value, so it is left out until the next run screens it again.
fn is_prose_sql() -> String {
    format!("s.english >= {MIN_ENGLISH} AND s.prose >= {MIN_PROSE}")
}

fn queue_where() -> String {
    format!("s.message_id IS NOT NULL AND {} AND s.naturalness < ?1 AND m.reviewed_at IS NULL AND m.words >= ?2", is_prose_sql())
}

/// An earlier build redacted to `[file]` and `[link]`, which Jev scored worse than prose. The original path is
/// gone, so the old placeholders are renamed in place.
fn legacy_placeholders(text: &str) -> String {
    text.replace("[file]", "this file").replace("[link]", "this link")
}

/// Messages stored before paths were redacted still hold them. Their text, word count and score all described
/// the path too, so the screen and the coaching go and the next run makes both again. Attempts and the
/// reviewed mark stay.
fn redact_stored(conn: &Connection) -> Result<()> {
    let rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, text FROM messages")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_>>()?
    };
    for (id, text) in rows {
        let redacted = redact(&legacy_placeholders(&text));
        if redacted != text {
            replace_text(conn, &id, &redacted)?;
        }
    }
    Ok(())
}

/// Swaps a stored message's text. The screen and the coaching described the old text, so they go; attempts
/// and the reviewed mark stay.
fn replace_text(conn: &Connection, id: &str, text: &str) -> Result<()> {
    let words = text.split_whitespace().count() as i64;
    conn.execute("UPDATE messages SET text = ?2, words = ?3 WHERE id = ?1", params![id, text, words])?;
    conn.execute("DELETE FROM screens WHERE message_id = ?1", [id])?;
    conn.execute("DELETE FROM coaching WHERE message_id = ?1", [id])?;
    Ok(())
}

/// When `redact` changes what it produces, every source is read again from the start so `insert_messages`
/// can rewrite the rows whose redaction now differs. Runs once per `redact::VERSION`.
fn reread_sources_after_redaction_change(conn: &Connection) -> Result<()> {
    let stored: Option<String> =
        conn.query_row("SELECT value FROM kv WHERE key = 'redaction'", [], |r| r.get(0)).optional()?;
    let stored = stored.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    if stored >= redact::VERSION {
        return Ok(());
    }
    conn.execute("DELETE FROM files", [])?;
    conn.execute(
        "INSERT INTO kv (key, value) VALUES ('redaction', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [redact::VERSION.to_string()],
    )?;
    Ok(())
}

/// Inserts the built-in questions that are not stored yet, so a question added to the bank later shows up on the next start.
fn seed_interview_bank(conn: &Connection) -> Result<()> {
    let now = chrono::Local::now().timestamp_millis();
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO interview_questions (topic, text, custom, created_at) VALUES (?1, ?2, 0, ?3)",
    )?;
    for (topic, text) in interview::BANK {
        stmt.execute(params![topic.key(), text, now])?;
    }
    Ok(())
}

fn read_question(r: &Row) -> Result<InterviewQuestion> {
    let topic: String = r.get(1)?;
    Ok(InterviewQuestion {
        id: r.get(0)?,
        topic: InterviewTopic::parse(&topic).unwrap_or(InterviewTopic::Backend),
        text: r.get(2)?,
        custom: r.get::<_, i64>(3)? != 0,
        answers: r.get(4)?,
        last_answered_at: r.get(5)?,
        best_depth: r.get(6)?,
    })
}

const ANSWER_SELECT: &str = "SELECT id, question_id, text, seconds, created_at, screen, feedback FROM interview_answers";

fn read_answer(r: &Row) -> Result<InterviewAnswer> {
    let screen: Option<String> = r.get(5)?;
    let feedback: Option<String> = r.get(6)?;
    Ok(InterviewAnswer {
        id: r.get(0)?,
        question_id: r.get(1)?,
        text: r.get(2)?,
        seconds: r.get(3)?,
        created_at: r.get(4)?,
        screen: screen.and_then(|s| serde_json::from_str::<Screen>(&s).ok()),
        feedback: feedback.and_then(|s| serde_json::from_str::<InterviewFeedback>(&s).ok()),
    })
}

/// Cheap shuffle without a new dependency: the clock's nanoseconds are random enough to pick a question.
fn random_below(n: usize) -> usize {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    nanos as usize % n.max(1)
}

pub struct Db {
    conn: Mutex<Connection>,
}

type Result<T> = rusqlite::Result<T>;

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        let has_prose = conn
            .prepare("SELECT 1 FROM pragma_table_info('screens') WHERE name = 'prose'")?
            .exists([])?;
        if !has_prose {
            conn.execute("ALTER TABLE screens ADD COLUMN prose REAL", [])?;
        }
        redact_stored(&conn)?;
        reread_sources_after_redaction_change(&conn)?;
        seed_interview_bank(&conn)?;
        Ok(Db { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn insert_messages(&self, messages: &[NewMessage]) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut added = 0;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO messages (id, text, ts, project, session_id, words, source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for m in messages {
                let inserted = stmt.execute(params![m.id, m.text, m.ts, m.project, m.session_id, m.words(), m.source])?;
                added += inserted;
                if inserted == 0 {
                    let stored: Option<String> =
                        tx.query_row("SELECT text FROM messages WHERE id = ?1", [&m.id], |r| r.get(0)).optional()?;
                    if stored.is_some_and(|old| !old.split_whitespace().eq(m.text.split_whitespace())) {
                        replace_text(&tx, &m.id, &m.text)?;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(added)
    }

    pub fn file_offset(&self, path: &str) -> Result<u64> {
        let offset: Option<i64> = self
            .conn()
            .query_row("SELECT offset FROM files WHERE path = ?1", [path], |r| r.get(0))
            .optional()?;
        Ok(offset.unwrap_or(0).max(0) as u64)
    }

    pub fn set_file_offset(&self, path: &str, offset: u64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO files (path, offset) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET offset = excluded.offset",
            params![path, offset as i64],
        )?;
        Ok(())
    }

    pub fn unscreened(&self, min_words: i64, limit: i64) -> Result<Vec<(String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.text FROM messages m
             WHERE m.words >= ?1
               AND NOT EXISTS (SELECT 1 FROM screens s WHERE s.message_id = m.id AND s.prose IS NOT NULL)
             ORDER BY m.ts DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![min_words, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    pub fn save_screen(&self, id: &str, screen: &Screen, model: &str, now: i64) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO screens
             (message_id, english, prose, naturalness, confidence, issue, issue_confidence, model, screened_at)
             VALUES (?1, ?2, ?9, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                screen.english,
                screen.naturalness,
                screen.confidence,
                screen.issue.key(),
                screen.issue_confidence,
                model,
                now,
                screen.prose
            ],
        )?;
        Ok(())
    }

    pub fn list_messages(&self, query: &MessageQuery, settings: &Settings) -> Result<Vec<Message>> {
        let conn = self.conn();
        let limit = query.limit.clamp(1, 500);
        let offset = query.offset.max(0);
        let mut messages = match query.filter {
            MessageFilter::Queue => {
                let queue = queue_where();
                let sql = format!(
                    "{MESSAGE_SELECT} WHERE {queue} ORDER BY s.naturalness ASC, m.ts DESC LIMIT ?3 OFFSET ?4"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    params![settings.flag_threshold, settings.min_words, limit, offset],
                    read_message,
                )?;
                rows.collect::<Result<Vec<_>>>()?
            }
            MessageFilter::Reviewed => {
                let sql = format!(
                    "{MESSAGE_SELECT} WHERE m.reviewed_at IS NOT NULL ORDER BY m.reviewed_at DESC LIMIT ?1 OFFSET ?2"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit, offset], read_message)?;
                rows.collect::<Result<Vec<_>>>()?
            }
            MessageFilter::All => {
                let sql = format!(
                    "{MESSAGE_SELECT} WHERE m.words >= ?1 ORDER BY m.ts DESC LIMIT ?2 OFFSET ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![settings.min_words, limit, offset], read_message)?;
                rows.collect::<Result<Vec<_>>>()?
            }
        };
        attach_attempts(&conn, &mut messages)?;
        Ok(messages)
    }

    pub fn get_message(&self, id: &str) -> Result<Option<Message>> {
        let conn = self.conn();
        let sql = format!("{MESSAGE_SELECT} WHERE m.id = ?1");
        let found = conn.query_row(&sql, [id], read_message).optional()?;
        match found {
            Some(m) => {
                let mut one = vec![m];
                attach_attempts(&conn, &mut one)?;
                Ok(one.pop())
            }
            None => Ok(None),
        }
    }

    pub fn save_coaching(&self, id: &str, coaching: &Coaching) -> Result<()> {
        let rewrites = serde_json::to_string(&coaching.rewrites).unwrap_or_else(|_| "[]".into());
        self.conn().execute(
            "INSERT OR REPLACE INTO coaching (message_id, rewrites, explanation, tip, issue, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, rewrites, coaching.explanation, coaching.tip, coaching.issue.key(), coaching.created_at],
        )?;
        Ok(())
    }

    pub fn save_attempt(&self, id: &str, text: &str, now: i64) -> Result<Attempt> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO attempts (message_id, text, created_at) VALUES (?1, ?2, ?3)",
            params![id, text, now],
        )?;
        Ok(Attempt { id: conn.last_insert_rowid(), text: text.to_string(), created_at: now })
    }

    pub fn mark_reviewed(&self, id: &str, reviewed_at: Option<i64>) -> Result<()> {
        self.conn().execute("UPDATE messages SET reviewed_at = ?2 WHERE id = ?1", params![id, reviewed_at])?;
        Ok(())
    }

    pub fn counts(&self, settings: &Settings) -> Result<Overview> {
        let conn = self.conn();
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM messages WHERE words >= ?1", [settings.min_words], |r| r.get(0))?;
        let screened: i64 = conn.query_row(
            "SELECT COUNT(*) FROM messages m JOIN screens s ON s.message_id = m.id WHERE s.prose IS NOT NULL AND m.words >= ?1",
            [settings.min_words],
            |r| r.get(0),
        )?;
        let queued: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM messages m LEFT JOIN screens s ON s.message_id = m.id WHERE {}", queue_where()),
            params![settings.flag_threshold, settings.min_words],
            |r| r.get(0),
        )?;
        let reviewed: i64 =
            conn.query_row("SELECT COUNT(*) FROM messages WHERE reviewed_at IS NOT NULL", [], |r| r.get(0))?;
        Ok(Overview {
            total,
            screened,
            queued,
            reviewed,
            pending: total - screened,
            last_run: None,
            next_run_at: 0,
            running: false,
            typesafe_configured: false,
            claude_found: false,
        })
    }

    pub fn patterns(&self, settings: &Settings) -> Result<Patterns> {
        let conn = self.conn();
        let prose = is_prose_sql();
        let mut stmt = conn.prepare(&format!(
            "SELECT s.issue, COUNT(*), AVG(s.naturalness) FROM messages m JOIN screens s ON s.message_id = m.id
             WHERE {prose} AND s.issue != 'none' AND s.naturalness < ?1 AND m.words >= ?2
             GROUP BY s.issue ORDER BY COUNT(*) DESC",
        ))?;
        let issues = stmt
            .query_map(params![settings.flag_threshold, settings.min_words], |r| {
                let key: String = r.get(0)?;
                Ok(PatternRow {
                    issue: Issue::parse(&key).unwrap_or(Issue::None),
                    count: r.get(1)?,
                    avg_naturalness: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        drop(stmt);
        let mut stmt = conn.prepare(&format!(
            "SELECT date(m.ts / 1000, 'unixepoch', 'localtime') AS day, COUNT(*), AVG(s.naturalness)
             FROM messages m JOIN screens s ON s.message_id = m.id
             WHERE {prose} AND m.words >= ?1
             GROUP BY day ORDER BY day DESC LIMIT 60",
        ))?;
        let mut trend = stmt
            .query_map([settings.min_words], |r| {
                Ok(TrendRow { day: r.get(0)?, count: r.get(1)?, avg_naturalness: r.get(2)? })
            })?
            .collect::<Result<Vec<_>>>()?;
        drop(stmt);
        trend.reverse();

        let day = "date(m.ts / 1000, 'unixepoch', 'localtime')";
        let week = format!("date({day}, '-' || ((CAST(strftime('%w', {day}) AS INTEGER) + 6) % 7) || ' days')");
        let today = "date('now', 'localtime')";
        let first_week =
            format!("date({today}, '-' || ((CAST(strftime('%w', {today}) AS INTEGER) + 6) % 7) || ' days', '-77 days')");
        let mut stmt = conn.prepare(&format!(
            "SELECT {week} AS week, COUNT(*) FROM messages m JOIN screens s ON s.message_id = m.id
             WHERE {prose} AND m.words >= ?1 AND {week} >= {first_week}
             GROUP BY week ORDER BY week ASC",
        ))?;
        let weeks = stmt
            .query_map([settings.min_words], |r| Ok(WeekRow { week: r.get(0)?, screened: r.get(1)? }))?
            .collect::<Result<Vec<_>>>()?;
        drop(stmt);
        let mut stmt = conn.prepare(&format!(
            "SELECT {week} AS week, s.issue, COUNT(*) FROM messages m JOIN screens s ON s.message_id = m.id
             WHERE {prose} AND m.words >= ?1 AND s.issue != 'none' AND s.naturalness < ?2 AND {week} >= {first_week}
             GROUP BY week, s.issue ORDER BY week ASC, s.issue ASC",
        ))?;
        let issue_weeks = stmt
            .query_map(params![settings.min_words, settings.flag_threshold], |r| {
                let key: String = r.get(1)?;
                Ok(IssueWeekRow { week: r.get(0)?, issue: Issue::parse(&key).unwrap_or(Issue::None), count: r.get(2)? })
            })?
            .collect::<Result<Vec<_>>>()?;
        drop(stmt);

        // coaching.created_at and messages.ts are both epoch ms.
        let mut stmt = conn.prepare(&format!(
            "SELECT f.issue, f.coached_at,
                    COALESCE(SUM(m.ts < f.coached_at), 0), COALESCE(SUM(m.ts < f.coached_at AND s.issue = f.issue AND s.naturalness < ?2), 0),
                    COALESCE(SUM(m.ts >= f.coached_at), 0), COALESCE(SUM(m.ts >= f.coached_at AND s.issue = f.issue AND s.naturalness < ?2), 0)
             FROM (SELECT issue, MIN(created_at) AS coached_at FROM coaching WHERE issue != 'none' GROUP BY issue) f
             CROSS JOIN messages m JOIN screens s ON s.message_id = m.id
             WHERE {prose} AND m.words >= ?1
             GROUP BY f.issue ORDER BY f.coached_at ASC",
        ))?;
        let coached_impact = stmt
            .query_map(params![settings.min_words, settings.flag_threshold], |r| {
                let key: String = r.get(0)?;
                Ok(CoachedImpact {
                    issue: Issue::parse(&key).unwrap_or(Issue::None),
                    coached_at: r.get(1)?,
                    before_screened: r.get(2)?,
                    before_flagged: r.get(3)?,
                    after_screened: r.get(4)?,
                    after_flagged: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        drop(stmt);
        Ok(Patterns { issues, trend, threshold: settings.flag_threshold, weeks, issue_weeks, coached_impact })
    }

    pub fn settings(&self) -> Result<Settings> {
        let stored: Option<String> = self
            .conn()
            .query_row("SELECT value FROM kv WHERE key = 'settings'", [], |r| r.get(0))
            .optional()?;
        Ok(stored
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default()
            .clamped())
    }

    pub fn set_settings(&self, settings: &Settings) -> Result<()> {
        let value = serde_json::to_string(settings).unwrap_or_default();
        self.conn().execute(
            "INSERT INTO kv (key, value) VALUES ('settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [value],
        )?;
        Ok(())
    }

    pub fn interview_questions(&self) -> Result<Vec<InterviewQuestion>> {
        let conn = self.conn();
        let sql = format!("{QUESTION_SELECT} GROUP BY q.id ORDER BY q.topic ASC, q.id ASC");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], read_question)?;
        rows.collect()
    }

    pub fn interview_question(&self, id: i64) -> Result<Option<InterviewQuestion>> {
        let conn = self.conn();
        let sql = format!("{QUESTION_SELECT} WHERE q.id = ?1 GROUP BY q.id");
        conn.query_row(&sql, [id], read_question).optional()
    }

    /// Never-answered questions first (random among them), then the one answered longest ago.
    /// `exclude` is skipped unless it is the only candidate.
    pub fn next_interview_question(&self, topic: Option<InterviewTopic>, exclude: Option<i64>) -> Result<Option<InterviewQuestion>> {
        let mut candidates: Vec<InterviewQuestion> =
            self.interview_questions()?.into_iter().filter(|q| topic.is_none_or(|t| q.topic == t)).collect();
        if candidates.len() > 1 {
            candidates.retain(|q| Some(q.id) != exclude);
        }
        let fresh: Vec<usize> = (0..candidates.len()).filter(|&i| candidates[i].answers == 0).collect();
        let pick = if fresh.is_empty() {
            (0..candidates.len()).min_by_key(|&i| (candidates[i].last_answered_at, candidates[i].id))
        } else {
            Some(fresh[random_below(fresh.len())])
        };
        Ok(pick.map(|i| candidates.swap_remove(i)))
    }

    /// Returns the existing row when the text is already stored.
    pub fn add_interview_question(&self, topic: InterviewTopic, text: &str, now: i64) -> Result<InterviewQuestion> {
        let conn = self.conn();
        conn.execute(
            "INSERT OR IGNORE INTO interview_questions (topic, text, custom, created_at) VALUES (?1, ?2, 1, ?3)",
            params![topic.key(), text, now],
        )?;
        let sql = format!("{QUESTION_SELECT} WHERE q.text = ?1 GROUP BY q.id");
        conn.query_row(&sql, [text], read_question)
    }

    /// Deletes a custom question and, through the cascade, its answers. `Ok(false)` means it is built-in or missing.
    pub fn delete_interview_question(&self, id: i64) -> Result<bool> {
        let n = self.conn().execute("DELETE FROM interview_questions WHERE id = ?1 AND custom = 1", [id])?;
        Ok(n > 0)
    }

    pub fn save_interview_answer(&self, question_id: i64, text: &str, seconds: i64, now: i64) -> Result<InterviewAnswer> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO interview_answers (question_id, text, seconds, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![question_id, text, seconds, now],
        )?;
        Ok(InterviewAnswer {
            id: conn.last_insert_rowid(),
            question_id,
            text: text.to_string(),
            seconds,
            created_at: now,
            screen: None,
            feedback: None,
        })
    }

    pub fn get_interview_answer(&self, id: i64) -> Result<Option<InterviewAnswer>> {
        self.conn().query_row(&format!("{ANSWER_SELECT} WHERE id = ?1"), [id], read_answer).optional()
    }

    /// Saves the feedback, and the screen when there is one (an old screen is kept otherwise).
    pub fn save_interview_review(&self, id: i64, screen: Option<&Screen>, feedback: &InterviewFeedback) -> Result<()> {
        let feedback = serde_json::to_string(feedback).unwrap_or_default();
        let screen = screen.and_then(|s| serde_json::to_string(s).ok());
        self.conn().execute(
            "UPDATE interview_answers SET feedback = ?2, screen = COALESCE(?3, screen) WHERE id = ?1",
            params![id, feedback, screen],
        )?;
        Ok(())
    }

    pub fn interview_answers(&self, question_id: Option<i64>, limit: i64) -> Result<Vec<InterviewAnswer>> {
        let conn = self.conn();
        let limit = limit.clamp(1, 200);
        let sql = format!("{ANSWER_SELECT} WHERE (?1 IS NULL OR question_id = ?1) ORDER BY created_at DESC, id DESC LIMIT ?2");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![question_id, limit], read_answer)?;
        rows.collect()
    }

    pub fn last_run(&self) -> Result<Option<RunInfo>> {
        self.conn()
            .query_row(
                "SELECT day, started_at, finished_at, ok, detail FROM runs ORDER BY started_at DESC LIMIT 1",
                [],
                read_run,
            )
            .optional()
    }

    pub fn run_for_day(&self, day: &str) -> Result<Option<RunInfo>> {
        self.conn()
            .query_row("SELECT day, started_at, finished_at, ok, detail FROM runs WHERE day = ?1", [day], read_run)
            .optional()
    }

    pub fn begin_run(&self, day: &str, now: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO runs (day, started_at, finished_at, ok, detail) VALUES (?1, ?2, NULL, 0, 'running')
             ON CONFLICT(day) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL, ok = 0, detail = 'running'",
            params![day, now],
        )?;
        Ok(())
    }

    pub fn finish_run(&self, day: &str, now: i64, ok: bool, detail: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE runs SET finished_at = ?2, ok = ?3, detail = ?4 WHERE day = ?1",
            params![day, now, ok, detail],
        )?;
        Ok(())
    }
}

fn read_run(r: &Row) -> Result<RunInfo> {
    Ok(RunInfo { day: r.get(0)?, started_at: r.get(1)?, finished_at: r.get(2)?, ok: r.get(3)?, detail: r.get(4)? })
}

fn read_message(r: &Row) -> Result<Message> {
    let english: Option<f64> = r.get(7)?;
    let screen = match english {
        Some(english) => {
            let issue: String = r.get(10)?;
            Some(Screen {
                english,
                prose: r.get::<_, Option<f64>>(17)?.unwrap_or(1.0),
                naturalness: r.get(8)?,
                confidence: r.get(9)?,
                issue: Issue::parse(&issue).unwrap_or(Issue::None),
                issue_confidence: r.get(11)?,
            })
        }
        None => None,
    };
    let rewrites: Option<String> = r.get(12)?;
    let coaching = match rewrites {
        Some(rewrites) => {
            let issue: String = r.get(15)?;
            Some(Coaching {
                rewrites: serde_json::from_str::<Vec<Rewrite>>(&rewrites).unwrap_or_default(),
                explanation: r.get(13)?,
                tip: r.get(14)?,
                issue: Issue::parse(&issue).unwrap_or(Issue::None),
                created_at: r.get(16)?,
            })
        }
        None => None,
    };
    Ok(Message {
        id: r.get(0)?,
        text: r.get(1)?,
        ts: r.get(2)?,
        project: r.get(3)?,
        words: r.get(4)?,
        source: r.get(5)?,
        reviewed_at: r.get(6)?,
        screen,
        coaching,
        attempts: Vec::new(),
    })
}

fn attach_attempts(conn: &Connection, messages: &mut [Message]) -> Result<()> {
    let mut stmt =
        conn.prepare("SELECT id, text, created_at FROM attempts WHERE message_id = ?1 ORDER BY created_at ASC")?;
    for m in messages {
        m.attempts = stmt
            .query_map([&m.id], |r| Ok(Attempt { id: r.get(0)?, text: r.get(1)?, created_at: r.get(2)? }))?
            .collect::<Result<Vec<_>>>()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn open(name: &str) -> Db {
        let dir = std::env::temp_dir().join(format!("cadence-db-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Db::open(&dir.join("t.db")).unwrap()
    }

    fn message(id: &str) -> NewMessage {
        NewMessage {
            id: id.into(),
            text: "one two three four five six seven eight nine".into(),
            ts: 1,
            project: None,
            session_id: None,
            source: "history",
        }
    }

    fn screen(english: f64, prose: f64, naturalness: f64) -> Screen {
        Screen { english, prose, naturalness, confidence: 0.5, issue: Issue::Grammar, issue_confidence: 0.5 }
    }

    fn queued(db: &Db) -> Vec<String> {
        let query = MessageQuery { filter: MessageFilter::Queue, limit: 50, offset: 0 };
        db.list_messages(&query, &Settings::default()).unwrap().into_iter().map(|m| m.id).collect()
    }

    #[test]
    fn only_english_prose_below_the_threshold_is_queued() {
        let db = open("queue");
        let ids = ["flawed", "paste", "portuguese", "native"];
        db.insert_messages(&ids.map(message)).unwrap();
        db.save_screen("flawed", &screen(0.95, 0.9, 1.2), "t", 1).unwrap();
        db.save_screen("paste", &screen(0.9, 0.04, 0.4), "t", 1).unwrap();
        db.save_screen("portuguese", &screen(0.05, 0.9, 1.4), "t", 1).unwrap();
        db.save_screen("native", &screen(0.95, 0.9, 2.8), "t", 1).unwrap();
        assert_eq!(queued(&db), ["flawed"]);
        assert_eq!(db.counts(&Settings::default()).unwrap().queued, 1);
        assert!(db.patterns(&Settings::default()).unwrap().issues.iter().all(|p| p.count == 1));
    }

    #[test]
    fn the_interview_seed_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("cadence-db-seed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let first = Db::open(&path).unwrap().interview_questions().unwrap();
        let second = Db::open(&path).unwrap().interview_questions().unwrap();
        assert_eq!(first.len(), interview::BANK.len());
        assert_eq!(second.len(), first.len());
        assert!(first.iter().all(|q| !q.custom && q.answers == 0 && q.last_answered_at.is_none() && q.best_depth.is_none()));
    }

    fn feedback(depth: i64) -> InterviewFeedback {
        InterviewFeedback {
            spoken: "s".into(),
            english_notes: "n".into(),
            tip: "t".into(),
            issue: Issue::None,
            depth,
            depth_notes: "d".into(),
            missing: vec![],
            follow_up: "f".into(),
            created_at: 1,
        }
    }

    #[test]
    fn next_question_prefers_unanswered_then_the_least_recent_and_respects_exclude() {
        let db = open("next");
        let cloud: Vec<i64> = db.interview_questions().unwrap().into_iter().filter(|q| q.topic == InterviewTopic::Cloud).map(|q| q.id).collect();
        let cloud_topic = Some(InterviewTopic::Cloud);
        // Answer all but the last two, oldest first.
        for (i, id) in cloud[..cloud.len() - 2].iter().enumerate() {
            db.save_interview_answer(*id, "a", 10, 100 + i as i64).unwrap();
        }
        for _ in 0..20 {
            let next = db.next_interview_question(cloud_topic, Some(cloud[cloud.len() - 1])).unwrap().unwrap();
            assert_eq!(next.id, cloud[cloud.len() - 2]);
            let next = db.next_interview_question(cloud_topic, None).unwrap().unwrap();
            assert!(next.id == cloud[cloud.len() - 2] || next.id == cloud[cloud.len() - 1]);
        }
        db.save_interview_answer(cloud[cloud.len() - 2], "a", 10, 500).unwrap();
        db.save_interview_answer(cloud[cloud.len() - 1], "a", 10, 501).unwrap();
        assert_eq!(db.next_interview_question(cloud_topic, None).unwrap().unwrap().id, cloud[0]);
        assert_eq!(db.next_interview_question(cloud_topic, Some(cloud[0])).unwrap().unwrap().id, cloud[1]);
    }

    #[test]
    fn built_in_questions_cannot_be_deleted_and_custom_ones_take_their_answers_along() {
        let db = open("delete");
        let built_in = db.interview_questions().unwrap()[0].id;
        assert!(!db.delete_interview_question(built_in).unwrap());
        assert!(db.interview_question(built_in).unwrap().is_some());

        let custom = db.add_interview_question(InterviewTopic::Testing, "What is a spy?", 1).unwrap();
        assert!(custom.custom);
        let answer = db.save_interview_answer(custom.id, "a spy records calls", 30, 2).unwrap();
        db.save_interview_review(answer.id, None, &feedback(4)).unwrap();
        assert_eq!(db.interview_question(custom.id).unwrap().unwrap().best_depth, Some(4));
        assert!(db.delete_interview_question(custom.id).unwrap());
        assert!(db.get_interview_answer(answer.id).unwrap().is_none());
        assert!(db.interview_answers(None, 10).unwrap().is_empty());
    }

    #[test]
    fn adding_a_duplicate_question_returns_the_existing_row() {
        let db = open("dup");
        let a = db.add_interview_question(InterviewTopic::Cloud, "What is a spy?", 1).unwrap();
        let b = db.add_interview_question(InterviewTopic::Cloud, "What is a spy?", 2).unwrap();
        assert_eq!(a.id, b.id);
        let built_in = interview::BANK[0];
        let c = db.add_interview_question(built_in.0, built_in.1, 3).unwrap();
        assert!(!c.custom);
        assert_eq!(db.interview_questions().unwrap().len(), interview::BANK.len() + 1);
    }

    #[test]
    fn a_review_saves_feedback_and_keeps_the_old_screen_when_there_is_no_new_one() {
        let db = open("review");
        let q = db.interview_questions().unwrap()[0].id;
        let a = db.save_interview_answer(q, "text", 5, 1).unwrap();
        db.save_interview_review(a.id, Some(&screen(0.9, 0.9, 1.5)), &feedback(2)).unwrap();
        db.save_interview_review(a.id, None, &feedback(3)).unwrap();
        let got = db.get_interview_answer(a.id).unwrap().unwrap();
        assert_eq!(got.feedback.unwrap().depth, 3);
        assert_eq!(got.screen.unwrap().naturalness, 1.5);
        assert_eq!(db.interview_answers(Some(q), 0).unwrap().len(), 1);
    }

    fn at(id: &str, ts: i64) -> NewMessage {
        NewMessage { ts, ..message(id) }
    }

    #[test]
    fn weeks_and_issue_weeks_cover_the_last_twelve_weeks_in_order() {
        let db = open("weeks");
        let day = 86_400_000;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        // Two messages in the current stretch (flagged and fine), one far outside the 12 weeks.
        db.insert_messages(&[at("old", now - 200 * day), at("mid", now - 30 * day), at("flag", now - 1 * day), at("fine", now - 1 * day)])
            .unwrap();
        db.save_screen("old", &screen(0.95, 0.9, 1.0), "t", 1).unwrap();
        db.save_screen("mid", &screen(0.95, 0.9, 1.0), "t", 1).unwrap();
        db.save_screen("flag", &screen(0.95, 0.9, 1.0), "t", 1).unwrap();
        db.save_screen("fine", &screen(0.95, 0.9, 2.9), "t", 1).unwrap();
        let p = db.patterns(&Settings::default()).unwrap();
        assert_eq!(p.threshold, Settings::default().flag_threshold);
        assert_eq!(p.weeks.iter().map(|w| w.screened).sum::<i64>(), 3);
        assert!(p.weeks.windows(2).all(|w| w[0].week < w[1].week));
        assert_eq!(p.weeks.last().unwrap().screened, 2);
        assert_eq!(p.issue_weeks.len(), 2);
        assert!(p.issue_weeks.iter().all(|w| w.count == 1));
        assert_eq!(p.issue_weeks.last().unwrap().week, p.weeks.last().unwrap().week);
    }

    #[test]
    fn coached_impact_splits_screened_and_flagged_at_the_first_coaching_of_the_issue() {
        let db = open("impact");
        db.insert_messages(&[at("a", 100), at("b", 200), at("c", 1_000), at("d", 2_000), at("e", 3_000)]).unwrap();
        db.save_screen("a", &screen(0.95, 0.9, 1.0), "t", 1).unwrap(); // before, flagged
        db.save_screen("b", &screen(0.95, 0.9, 2.9), "t", 1).unwrap(); // before, fine
        db.save_screen("c", &screen(0.95, 0.9, 2.9), "t", 1).unwrap(); // after, fine
        db.save_screen("d", &screen(0.95, 0.9, 1.0), "t", 1).unwrap(); // after, flagged
        db.save_screen("e", &screen(0.9, 0.04, 0.1), "t", 1).unwrap(); // pasted, never counted
        let coaching = |created_at| Coaching {
            rewrites: vec![],
            explanation: String::new(),
            tip: String::new(),
            issue: Issue::Grammar,
            created_at,
        };
        db.save_coaching("a", &coaching(1_500)).unwrap();
        db.save_coaching("b", &coaching(900)).unwrap();
        let impact = db.patterns(&Settings::default()).unwrap().coached_impact;
        assert_eq!(impact.len(), 1);
        let i = &impact[0];
        assert_eq!((i.coached_at, i.before_screened, i.before_flagged, i.after_screened, i.after_flagged), (900, 2, 1, 2, 1));
    }

    #[test]
    fn a_screen_saved_before_prose_existed_is_screened_again_and_kept_out_of_the_queue_meanwhile() {
        let dir = std::env::temp_dir().join(format!("cadence-db-legacy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        {
            let old = Connection::open(&path).unwrap();
            old.execute_batch(
                "CREATE TABLE messages (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, project TEXT,
                     session_id TEXT, words INTEGER NOT NULL, source TEXT NOT NULL, reviewed_at INTEGER);
                 CREATE TABLE screens (message_id TEXT PRIMARY KEY, english REAL NOT NULL, naturalness REAL NOT NULL,
                     confidence REAL NOT NULL, issue TEXT NOT NULL, issue_confidence REAL NOT NULL,
                     model TEXT NOT NULL, screened_at INTEGER NOT NULL);
                 INSERT INTO messages VALUES ('old', 'one two three four five six seven eight nine', 1, NULL, NULL, 9, 'history', NULL);
                 INSERT INTO screens VALUES ('old', 0.9, 0.4, 0.5, 'none', 0.5, 'jev-latest', 1);",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert!(queued(&db).is_empty());
        assert_eq!(db.unscreened(8, 10).unwrap().len(), 1);
        db.save_screen("old", &screen(0.95, 0.9, 1.2), "t", 2).unwrap();
        assert!(db.unscreened(8, 10).unwrap().is_empty());
        assert_eq!(queued(&db), ["old"]);
    }

    #[test]
    fn a_stored_path_is_redacted_and_the_message_is_screened_again() {
        let dir = std::env::temp_dir().join(format!("cadence-db-redact-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        {
            let db = Db::open(&path).unwrap();
            let mut with_path = message("path");
            with_path.text = "when does a lead have no userid in @src/Options/ReferralTable.razor and no contract at all".into();
            db.insert_messages(&[with_path, message("plain")]).unwrap();
            db.save_screen("path", &screen(0.95, 0.9, 1.2), "t", 1).unwrap();
            db.save_screen("plain", &screen(0.95, 0.9, 1.2), "t", 1).unwrap();
            db.save_attempt("path", "my attempt", 1).unwrap();
        }
        let db = Db::open(&path).unwrap();
        let all = db.list_messages(&MessageQuery { filter: MessageFilter::All, limit: 10, offset: 0 }, &Settings::default()).unwrap();
        let stored = all.iter().find(|m| m.id == "path").unwrap();
        assert_eq!(stored.text, "when does a lead have no userid in ReferralTable.razor and no contract at all");
        assert_eq!(stored.words, 14);
        assert!(stored.screen.is_none());
        assert_eq!(stored.attempts.len(), 1);
        assert!(all.iter().find(|m| m.id == "plain").unwrap().screen.is_some());
        assert_eq!(db.unscreened(8, 10).unwrap().len(), 1);
    }

    #[test]
    fn reingesting_an_old_redaction_replaces_the_text_and_drops_screen_and_coaching() {
        let db = open("reingest");
        let mut m = message("x");
        m.text = "look at this file now please and tell me more".into();
        db.insert_messages(&[m]).unwrap();
        db.save_screen("x", &screen(0.95, 0.9, 1.2), "t", 1).unwrap();
        db.save_coaching(
            "x",
            &Coaching { rewrites: vec![], explanation: String::new(), tip: String::new(), issue: Issue::Grammar, created_at: 1 },
        )
        .unwrap();
        db.save_attempt("x", "my attempt", 1).unwrap();
        db.mark_reviewed("x", Some(5)).unwrap();
        let get = |db: &Db| {
            db.list_messages(&MessageQuery { filter: MessageFilter::All, limit: 10, offset: 0 }, &Settings::default())
                .unwrap()
                .remove(0)
        };
        let mut new = message("x");
        new.text = "look at Program.cs now please and tell me more".into();
        assert_eq!(db.insert_messages(&[new]).unwrap(), 0);
        let stored = get(&db);
        assert_eq!(stored.text, "look at Program.cs now please and tell me more");
        assert_eq!(stored.words, 9);
        assert!(stored.screen.is_none() && stored.coaching.is_none());
        assert_eq!(stored.attempts.len(), 1);
        assert_eq!(stored.reviewed_at, Some(5));

        db.save_screen("x", &screen(0.95, 0.9, 1.2), "t", 2).unwrap();
        let mut same = message("x");
        same.text = "look at Program.cs now please and tell me more".into();
        assert_eq!(db.insert_messages(&[same]).unwrap(), 0);
        assert!(get(&db).screen.is_some());

        let mut spaced = message("x");
        spaced.text = "look at  Program.cs now
please and tell me more ".into();
        assert_eq!(db.insert_messages(&[spaced]).unwrap(), 0);
        let after = get(&db);
        assert_eq!(after.text, "look at Program.cs now please and tell me more");
        assert!(after.screen.is_some());
    }

    #[test]
    fn a_new_redaction_version_rereads_the_sources_once() {
        let dir = std::env::temp_dir().join(format!("cadence-db-version-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        {
            let db = Db::open(&path).unwrap();
            db.set_file_offset("h", 10).unwrap();
        }
        Connection::open(&path)
            .unwrap()
            .execute("INSERT INTO kv (key, value) VALUES ('redaction', '1') ON CONFLICT(key) DO UPDATE SET value = '1'", [])
            .unwrap();
        let db = Db::open(&path).unwrap();
        assert_eq!(db.file_offset("h").unwrap(), 0);
        db.set_file_offset("h", 10).unwrap();
        drop(db);
        assert_eq!(Db::open(&path).unwrap().file_offset("h").unwrap(), 10);
    }

    #[test]
    fn the_old_bracket_placeholders_become_prose() {
        let dir = std::env::temp_dir().join(format!("cadence-db-brackets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        {
            let db = Db::open(&path).unwrap();
            let mut old = message("old");
            old.text = "is SetAsSignedAsync right in [file] ? see [link] too".into();
            db.insert_messages(&[old]).unwrap();
            db.save_screen("old", &screen(0.95, 0.9, 1.2), "t", 1).unwrap();
        }
        let db = Db::open(&path).unwrap();
        let all = db.list_messages(&MessageQuery { filter: MessageFilter::All, limit: 10, offset: 0 }, &Settings::default()).unwrap();
        assert_eq!(all[0].text, "is SetAsSignedAsync right in this file ? see this link too");
        assert!(all[0].screen.is_none());
    }
}
