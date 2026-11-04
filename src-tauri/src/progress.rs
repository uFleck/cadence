//! The Progress view's numbers: first drafts per week against what the user reached after retries, and
//! the recurring slips of the last 7 days against the 7 before.

use crate::db::{counted_sql, Db};
use crate::model::{Issue, Progress, ProgressWeek, Settings, SlipRow, RUBRIC};
use chrono::Datelike;
use rusqlite::params;

const WEEK_MS: i64 = 604_800_000;

impl Db {
    /// `weeks` = how many local weeks (Monday start, counting the current one) to include; 0 means all.
    /// `today` is the local date; `now_ms` is epoch ms, the end of the "last 7 days" window.
    pub fn progress(&self, settings: &Settings, weeks: i64, today: chrono::NaiveDate, now_ms: i64) -> rusqlite::Result<Progress> {
        let conn = self.conn();
        let counted = counted_sql();
        let first_week = if weeks > 0 {
            let monday = today - chrono::Duration::days(today.weekday().num_days_from_monday() as i64);
            (monday - chrono::Duration::days(7 * (weeks - 1))).format("%Y-%m-%d").to_string()
        } else {
            String::new()
        };

        let day = "date(m.ts / 1000, 'unixepoch', 'localtime')";
        let week = format!("date({day}, '-' || ((CAST(strftime('%w', {day}) AS INTEGER) + 6) % 7) || ' days')");
        let mut stmt = conn.prepare(&format!(
            "SELECT week, COUNT(*), AVG(first), AVG(newest), COUNT(newest) FROM (
                 SELECT {week} AS week, s.naturalness AS first,
                        (SELECT json_extract(a.screen, '$.naturalness') FROM attempts a
                         WHERE a.message_id = m.id AND a.screen IS NOT NULL
                           AND json_extract(a.screen, '$.rubric') = ?3
                         ORDER BY a.id DESC LIMIT 1) AS newest
                 FROM messages m JOIN screens s ON s.message_id = m.id
                 WHERE {counted} AND m.words >= ?1 AND s.rubric = ?3
             ) WHERE week >= ?2
             GROUP BY week ORDER BY week ASC"
        ))?;
        let weeks_out = stmt
            .query_map(params![settings.min_words, first_week, RUBRIC], |r| {
                Ok(ProgressWeek {
                    week: r.get(0)?,
                    screened: r.get(1)?,
                    first_draft: r.get(2)?,
                    after_retries: r.get(3)?,
                    retried: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        let mut stmt = conn.prepare(&format!(
            "SELECT s.issue,
                    COALESCE(SUM(m.ts > ?3 AND m.ts <= ?4), 0),
                    COALESCE(SUM(m.ts > ?5 AND m.ts <= ?3), 0)
             FROM messages m JOIN screens s ON s.message_id = m.id
             WHERE {counted} AND m.words >= ?1 AND s.rubric = ?6 AND s.issue != 'none' AND s.naturalness < ?2
               AND m.ts > ?5 AND m.ts <= ?4
             GROUP BY s.issue"
        ))?;
        let mut slips = stmt
            .query_map(
                params![settings.min_words, settings.flag_threshold, now_ms - WEEK_MS, now_ms, now_ms - 2 * WEEK_MS, RUBRIC],
                |r| {
                    let key: String = r.get(0)?;
                    Ok((key, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        slips.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)).then(a.0.cmp(&b.0)));
        let slips = slips
            .into_iter()
            .filter(|(_, now, before)| *now > 0 || *before > 0)
            .map(|(key, now, before)| SlipRow { issue: Issue::parse(&key).unwrap_or(Issue::None), now, before })
            .collect();

        Ok(Progress { weeks: weeks_out, slips, goal: settings.flag_threshold })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NewMessage, Screen};
    use chrono::NaiveDate;

    fn open(name: &str) -> Db {
        let dir = std::env::temp_dir().join(format!("cadence-progress-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Db::open(&dir.join("t.db")).unwrap()
    }

    fn at(id: &str, ts: i64) -> NewMessage {
        NewMessage {
            id: id.into(),
            text: "one two three four five six seven eight nine".into(),
            ts,
            project: None,
            session_id: None,
            source: "history",
        }
    }

    fn screen(naturalness: f64, issue: Issue, rubric: i64) -> Screen {
        Screen {
            english: 1.0,
            prose: 1.0,
            naturalness,
            native: Some(0.1),
            rubric,
            confidence: 0.5,
            issue,
            issue_confidence: 0.5,
            slip: None,
        }
    }

    /// Noon UTC on a date, so local time lands on the same day in any timezone within +-11h.
    fn noon(y: i32, m: u32, d: u32) -> i64 {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(12, 0, 0).unwrap().and_utc().timestamp_millis()
    }

    fn add(db: &Db, id: &str, ts: i64, nat: f64, issue: Issue) {
        db.insert_messages(&[at(id, ts)]).unwrap();
        db.save_screen(id, &screen(nat, issue, RUBRIC), "m", 0).unwrap();
    }

    #[test]
    fn weekly_first_draft_buckets_on_monday_and_respects_the_window() {
        let db = open("weeks");
        let s = db.settings().unwrap();
        // 2026-11-01 is a Sunday, 2026-11-02 a Monday.
        add(&db, "a", noon(2026, 10, 26), 1.0, Issue::AgreementTense); // Mon, week 10-26
        add(&db, "b", noon(2026, 11, 1), 2.0, Issue::AgreementTense); // Sun, week 10-26
        add(&db, "c", noon(2026, 11, 2), 3.0, Issue::None); // Mon, week 11-02
        add(&db, "d", noon(2026, 10, 14), 0.5, Issue::AgreementTense); // Wed, week 10-12
        let today = NaiveDate::from_ymd_opt(2026, 11, 4).unwrap();
        let now = noon(2026, 11, 4);

        let all = db.progress(&s, 0, today, now).unwrap();
        let names: Vec<_> = all.weeks.iter().map(|w| w.week.as_str()).collect();
        assert_eq!(names, ["2026-10-12", "2026-10-26", "2026-11-02"]);
        assert_eq!(all.weeks[1].screened, 2);
        assert!((all.weeks[1].first_draft - 1.5).abs() < 1e-9);
        assert_eq!(all.weeks[2].screened, 1);
        assert_eq!(all.goal, s.flag_threshold);

        let two = db.progress(&s, 2, today, now).unwrap();
        let names: Vec<_> = two.weeks.iter().map(|w| w.week.as_str()).collect();
        assert_eq!(names, ["2026-10-26", "2026-11-02"]);
    }

    #[test]
    fn after_retries_uses_the_newest_scored_attempt_of_the_current_rubric() {
        let db = open("retries");
        let s = db.settings().unwrap();
        add(&db, "a", noon(2026, 11, 2), 1.0, Issue::AgreementTense);
        add(&db, "b", noon(2026, 11, 3), 1.0, Issue::AgreementTense);
        let today = NaiveDate::from_ymd_opt(2026, 11, 4).unwrap();
        let now = noon(2026, 11, 4);

        let none = db.progress(&s, 0, today, now).unwrap();
        assert_eq!(none.weeks[0].after_retries, None);
        assert_eq!(none.weeks[0].retried, 0);

        let a1 = db.save_attempt("a", "first", 1).unwrap();
        db.save_attempt_screen(a1.id, &screen(2.0, Issue::None, RUBRIC)).unwrap();
        let a2 = db.save_attempt("a", "second", 2).unwrap();
        db.save_attempt_screen(a2.id, &screen(3.0, Issue::None, RUBRIC)).unwrap();
        // The newest attempt has an old rubric: it is ignored, the previous one counts.
        let a3 = db.save_attempt("a", "third", 3).unwrap();
        db.save_attempt_screen(a3.id, &screen(0.0, Issue::None, RUBRIC - 1)).unwrap();
        // Message b has an attempt that was never scored.
        db.save_attempt("b", "unscored", 4).unwrap();

        let p = db.progress(&s, 0, today, now).unwrap();
        assert_eq!(p.weeks.len(), 1);
        assert_eq!(p.weeks[0].screened, 2);
        assert_eq!(p.weeks[0].retried, 1);
        assert!((p.weeks[0].after_retries.unwrap() - 3.0).abs() < 1e-9);
    }

    #[test]
    fn slips_compare_two_rolling_windows() {
        let db = open("slips");
        let s = db.settings().unwrap();
        let now = noon(2026, 11, 4);
        let day = 86_400_000;
        let low = s.flag_threshold - 0.5;
        let today = NaiveDate::from_ymd_opt(2026, 11, 4).unwrap();

        add(&db, "n1", now - day, low, Issue::AgreementTense);
        add(&db, "n2", now - 2 * day, low, Issue::AgreementTense);
        add(&db, "b1", now - 8 * day, low, Issue::AgreementTense);
        add(&db, "only_before1", now - 9 * day, low, Issue::AgreementTense);
        add(&db, "none_issue", now - day, low, Issue::None);
        add(&db, "high", now - day, s.flag_threshold + 0.1, Issue::AgreementTense);
        add(&db, "excluded", now - day, low, Issue::AgreementTense);
        db.set_excluded("excluded", Some(1)).unwrap();
        add(&db, "too_old", now - 15 * day, low, Issue::AgreementTense);
        add(&db, "future", now + day, low, Issue::AgreementTense);

        let p = db.progress(&s, 0, today, now).unwrap();
        assert_eq!(p.slips.len(), 1);
        assert_eq!(p.slips[0].issue.key(), Issue::AgreementTense.key());
        assert_eq!(p.slips[0].now, 2);
        assert_eq!(p.slips[0].before, 2);
    }

    #[test]
    fn slips_keep_a_row_that_only_has_the_earlier_window_and_sort_them() {
        let db = open("slip-order");
        let s = db.settings().unwrap();
        let now = noon(2026, 11, 4);
        let day = 86_400_000;
        let low = s.flag_threshold - 0.5;
        let today = NaiveDate::from_ymd_opt(2026, 11, 4).unwrap();
        add(&db, "g1", now - day, low, Issue::AgreementTense);
        add(&db, "o1", now - 8 * day, low, Issue::AwkwardPhrasing);
        add(&db, "o2", now - 9 * day, low, Issue::AwkwardPhrasing);

        let p = db.progress(&s, 0, today, now).unwrap();
        assert_eq!(p.slips.len(), 2);
        assert_eq!((p.slips[0].now, p.slips[0].before), (1, 0));
        assert_eq!((p.slips[1].now, p.slips[1].before), (0, 2));
    }
}
