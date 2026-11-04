//! Re-tests: some days after a message settles, the user writes it again from its idea (no old text shown),
//! and the answer is scored. A missed goal brings one more, later.

use crate::db::Db;
use crate::model::{Retest, RetestQueue, Screen, RETEST_FIRST_DAYS, RETEST_LATER_DAYS, RETEST_SECOND_DAYS};
use rusqlite::{params, Connection, OptionalExtension, Row};

const DAY_MS: i64 = 86_400_000;

const RETEST_SELECT: &str =
    "SELECT r.id, r.message_id, r.idea, r.step, r.due_at, r.original_score, r.settled_score, r.done_at, r.text, r.screen
     FROM retests r";

fn retest_row(r: &Row) -> rusqlite::Result<Retest> {
    let screen: Option<String> = r.get(9)?;
    Ok(Retest {
        id: r.get(0)?,
        message_id: r.get(1)?,
        idea: r.get(2)?,
        step: r.get(3)?,
        due_at: r.get(4)?,
        original_score: r.get(5)?,
        settled_score: r.get(6)?,
        done_at: r.get(7)?,
        text: r.get(8)?,
        screen: screen.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

fn fetch(conn: &Connection, id: i64) -> rusqlite::Result<Option<Retest>> {
    conn.query_row(&format!("{RETEST_SELECT} WHERE r.id = ?1"), params![id], retest_row).optional()
}

impl Db {
    /// Called after a review was saved. When the message is settled (`reviewed_at` set), its newest version
    /// has a review with a non-empty `idea`, and the message has no re-test yet, adds step 1 due
    /// `RETEST_FIRST_DAYS` days after `now`, with the original's and the newest scored version's
    /// naturalness. Returns whether one was added. Never adds a second re-test for the same message here.
    pub fn schedule_retest(&self, message_id: &str, now: i64) -> rusqlite::Result<bool> {
        let conn = self.conn();
        let settled: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM messages WHERE id = ?1 AND reviewed_at IS NOT NULL AND excluded_at IS NULL",
                params![message_id],
                |r| r.get(0),
            )
            .optional()?;
        if settled.is_none() {
            return Ok(false);
        }
        let existing: i64 =
            conn.query_row("SELECT COUNT(*) FROM retests WHERE message_id = ?1", params![message_id], |r| r.get(0))?;
        if existing > 0 {
            return Ok(false);
        }
        let idea: Option<String> = conn
            .query_row(
                "SELECT json_extract(coaching, '$.idea') FROM attempts WHERE message_id = ?1 ORDER BY id DESC LIMIT 1",
                params![message_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let idea = idea.map(|i| i.trim().to_string()).unwrap_or_default();
        if idea.is_empty() {
            return Ok(false);
        }
        let original: Option<f64> = conn
            .query_row("SELECT naturalness FROM screens WHERE message_id = ?1", params![message_id], |r| r.get(0))
            .optional()?;
        let settled_score: Option<f64> = conn
            .query_row(
                "SELECT json_extract(screen, '$.naturalness') FROM attempts
                 WHERE message_id = ?1 AND screen IS NOT NULL ORDER BY id DESC LIMIT 1",
                params![message_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        conn.execute(
            "INSERT INTO retests (message_id, idea, step, due_at, original_score, settled_score)
             VALUES (?1, ?2, 1, ?3, ?4, ?5)",
            params![message_id, idea, now + RETEST_FIRST_DAYS * DAY_MS, original, settled_score],
        )?;
        Ok(true)
    }

    /// `due` is the oldest unanswered re-test with `due_at <= now` (and of a message that is not excluded);
    /// `due_count` counts them all; `upcoming` is the next up to 5 not yet due, soonest first.
    pub fn retest_queue(&self, now: i64) -> rusqlite::Result<RetestQueue> {
        let conn = self.conn();
        let base = format!(
            "{RETEST_SELECT} JOIN messages m ON m.id = r.message_id
             WHERE r.done_at IS NULL AND m.excluded_at IS NULL"
        );
        let due_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM retests r JOIN messages m ON m.id = r.message_id
             WHERE r.done_at IS NULL AND m.excluded_at IS NULL AND r.due_at <= ?1",
            params![now],
            |r| r.get(0),
        )?;
        let due = conn
            .query_row(
                &format!("{base} AND r.due_at <= ?1 ORDER BY r.due_at ASC, r.id ASC LIMIT 1"),
                params![now],
                retest_row,
            )
            .optional()?;
        let mut stmt = conn.prepare(&format!("{base} AND r.due_at > ?1 ORDER BY r.due_at ASC, r.id ASC LIMIT 5"))?;
        let upcoming = stmt.query_map(params![now], retest_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(RetestQueue { due, due_count, upcoming })
    }

    pub fn get_retest(&self, id: i64) -> rusqlite::Result<Option<Retest>> {
        fetch(&self.conn(), id)
    }

    /// Stores the answer (text, its screen when there is one, `done_at = now`) of an unanswered re-test and
    /// returns it. When the screen is below `goal` and the re-test was step 1, adds step 2 due
    /// `RETEST_SECOND_DAYS` days after `now`. Answering twice is an error. An unscored answer ends the
    /// re-test without a follow-up.
    pub fn save_retest(&self, id: i64, text: &str, screen: Option<&Screen>, goal: f64, now: i64) -> Result<Retest, String> {
        let conn = self.conn();
        let current = fetch(&conn, id).map_err(|e| e.to_string())?.ok_or_else(|| "Re-test not found".to_string())?;
        if current.done_at.is_some() {
            return Err("This re-test was already answered".to_string());
        }
        let json = screen.map(|s| serde_json::to_string(s).unwrap_or_default());
        conn.execute(
            "UPDATE retests SET text = ?2, screen = ?3, done_at = ?4 WHERE id = ?1",
            params![id, text, json, now],
        )
        .map_err(|e| e.to_string())?;
        if current.step == 1 && screen.is_some_and(|s| s.naturalness < goal) {
            conn.execute(
                "INSERT INTO retests (message_id, idea, step, due_at, original_score, settled_score)
                 VALUES (?1, ?2, 2, ?3, ?4, ?5)",
                params![
                    current.message_id,
                    current.idea,
                    now + RETEST_SECOND_DAYS * DAY_MS,
                    current.original_score,
                    current.settled_score
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        fetch(&conn, id).map_err(|e| e.to_string())?.ok_or_else(|| "Re-test not found".to_string())
    }

    /// "Later": moves an unanswered re-test to `now` + `RETEST_LATER_DAYS` days.
    pub fn postpone_retest(&self, id: i64, now: i64) -> rusqlite::Result<()> {
        self.conn().execute(
            "UPDATE retests SET due_at = ?2 WHERE id = ?1 AND done_at IS NULL",
            params![id, now + RETEST_LATER_DAYS * DAY_MS],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Coaching, Issue, NewMessage, RUBRIC};
    use std::fs;

    fn open(name: &str) -> Db {
        let dir = std::env::temp_dir().join(format!("cadence-retest-{name}-{}", std::process::id()));
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

    fn screen(naturalness: f64) -> Screen {
        Screen {
            english: 0.95,
            prose: 0.9,
            naturalness,
            native: Some(0.1),
            rubric: RUBRIC,
            confidence: 0.5,
            issue: Issue::Grammar,
            issue_confidence: 0.5,
            slip: None,
        }
    }

    fn coaching(idea: &str) -> Coaching {
        Coaching {
            rewrites: vec![],
            explanation: String::new(),
            tip: String::new(),
            assumption: String::new(),
            idea: idea.into(),
            issue: Issue::Grammar,
            created_at: 1,
            cost_usd: None,
        }
    }

    /// A settled message with an original screen of 1.0, one scored attempt of 2.5 and the given idea.
    fn settled(db: &Db, id: &str, idea: &str) {
        db.insert_messages(&[message(id)]).unwrap();
        db.save_screen(id, &screen(1.0), "t", 1).unwrap();
        let a = db.save_attempt(id, "a better version", 2).unwrap();
        db.save_attempt_screen(a.id, &screen(2.5)).unwrap();
        db.save_attempt_coaching(a.id, &coaching(idea)).unwrap();
        db.mark_reviewed(id, Some(3)).unwrap();
    }

    const NOW: i64 = 1_000_000_000_000;

    #[test]
    fn schedules_only_when_settled_with_an_idea_and_none_yet() {
        let db = open("schedule");
        settled(&db, "ok", "Ask for a deploy plan.");
        assert!(db.schedule_retest("ok", NOW).unwrap());
        assert!(!db.schedule_retest("ok", NOW).unwrap());
        let r = db.retest_queue(NOW + RETEST_FIRST_DAYS * DAY_MS).unwrap().due.unwrap();
        assert_eq!((r.step, r.due_at), (1, NOW + RETEST_FIRST_DAYS * DAY_MS));
        assert_eq!((r.original_score, r.settled_score), (Some(1.0), Some(2.5)));
        assert_eq!(r.idea, "Ask for a deploy plan.");

        settled(&db, "blank", "   ");
        assert!(!db.schedule_retest("blank", NOW).unwrap());

        settled(&db, "open", "An idea.");
        db.mark_reviewed("open", None).unwrap();
        assert!(!db.schedule_retest("open", NOW).unwrap());

        settled(&db, "gone", "An idea.");
        db.set_excluded("gone", Some(5)).unwrap();
        assert!(!db.schedule_retest("gone", NOW).unwrap());
    }

    #[test]
    fn the_queue_splits_at_now_and_limits_upcoming() {
        let db = open("queue");
        for i in 0..8 {
            let id = format!("m{i}");
            settled(&db, &id, "An idea.");
            // Spread due dates by one day each: m0 is the oldest.
            assert!(db.schedule_retest(&id, NOW + i * DAY_MS).unwrap());
        }
        settled(&db, "x", "An idea.");
        db.schedule_retest("x", NOW - 100 * DAY_MS).unwrap();
        db.set_excluded("x", Some(1)).unwrap();

        let first_due = NOW + RETEST_FIRST_DAYS * DAY_MS;
        let q = db.retest_queue(first_due + DAY_MS).unwrap();
        assert_eq!(q.due_count, 2);
        assert_eq!(q.due.unwrap().message_id, "m0");
        assert_eq!(q.upcoming.len(), 5);
        assert_eq!(q.upcoming[0].message_id, "m2");

        let q = db.retest_queue(first_due - 1).unwrap();
        assert_eq!((q.due_count, q.due.is_none(), q.upcoming.len()), (0, true, 5));
    }

    #[test]
    fn answering_follows_up_on_a_miss_only_for_step_one() {
        let db = open("save");
        settled(&db, "a", "An idea.");
        db.schedule_retest("a", NOW).unwrap();
        let id = db.retest_queue(NOW + 10 * DAY_MS).unwrap().due.unwrap().id;

        let done = db.save_retest(id, "my try", Some(&screen(1.5)), 2.0, NOW + 5 * DAY_MS).unwrap();
        assert_eq!(done.done_at, Some(NOW + 5 * DAY_MS));
        assert_eq!(done.text.as_deref(), Some("my try"));
        assert_eq!(done.screen.unwrap().naturalness, 1.5);
        assert_eq!(db.save_retest(id, "again", None, 2.0, NOW).unwrap_err(), "This re-test was already answered");

        let q = db.retest_queue(NOW + 5 * DAY_MS).unwrap();
        assert_eq!(q.upcoming.len(), 1);
        let step2 = &q.upcoming[0];
        assert_eq!((step2.step, step2.due_at), (2, NOW + 5 * DAY_MS + RETEST_SECOND_DAYS * DAY_MS));
        assert_eq!((step2.original_score, step2.settled_score), (Some(1.0), Some(2.5)));

        // A miss on step 2 adds nothing.
        db.save_retest(step2.id, "second try", Some(&screen(0.5)), 2.0, NOW + 20 * DAY_MS).unwrap();
        let q = db.retest_queue(NOW + 100 * DAY_MS).unwrap();
        assert_eq!((q.due_count, q.upcoming.len()), (0, 0));
    }

    #[test]
    fn no_follow_up_when_the_goal_is_reached_or_unscored() {
        let db = open("nofollow");
        for id in ["hit", "unscored"] {
            settled(&db, id, "An idea.");
            db.schedule_retest(id, NOW).unwrap();
        }
        let q = db.retest_queue(NOW + 10 * DAY_MS).unwrap();
        assert_eq!(q.due_count, 2);
        let first = q.due.unwrap();
        let second = db.retest_queue(NOW + 10 * DAY_MS).unwrap();
        db.save_retest(first.id, "t", Some(&screen(2.5)), 2.0, NOW + 5 * DAY_MS).unwrap();
        let other = db.retest_queue(NOW + 10 * DAY_MS).unwrap().due.unwrap();
        assert_ne!(other.id, first.id);
        let _ = second;
        db.save_retest(other.id, "t", None, 2.0, NOW + 5 * DAY_MS).unwrap();
        let q = db.retest_queue(NOW + 1000 * DAY_MS).unwrap();
        assert_eq!((q.due_count, q.upcoming.len()), (0, 0));
    }

    #[test]
    fn later_moves_the_due_date() {
        let db = open("later");
        settled(&db, "a", "An idea.");
        db.schedule_retest("a", NOW).unwrap();
        let id = db.retest_queue(NOW + 10 * DAY_MS).unwrap().due.unwrap().id;
        let now = NOW + 10 * DAY_MS;
        db.postpone_retest(id, now).unwrap();
        assert_eq!(db.get_retest(id).unwrap().unwrap().due_at, now + RETEST_LATER_DAYS * DAY_MS);
        let q = db.retest_queue(now).unwrap();
        assert_eq!((q.due_count, q.upcoming.len()), (0, 1));
    }
}
