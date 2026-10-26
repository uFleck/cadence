use crate::model::RunInfo;
use chrono::{Duration, Local, NaiveDateTime, TimeZone};

const RETRY_AFTER_MS: i64 = 30 * 60 * 1000;

/// The most recent time of day `hour:00` that is not in the future.
pub fn last_slot(now: NaiveDateTime, hour: u32) -> NaiveDateTime {
    let today = now.date().and_hms_opt(hour.min(23), 0, 0).unwrap_or(now);
    if now >= today { today } else { today - Duration::days(1) }
}

pub fn next_slot(now: NaiveDateTime, hour: u32) -> NaiveDateTime {
    last_slot(now, hour) + Duration::days(1)
}

/// A slot is owed a run when none succeeded for its day. A failed or interrupted attempt is retried
/// only after a pause, so a missing API key does not trigger a run every tick.
pub fn needs_run(run: Option<&RunInfo>, now_ms: i64) -> bool {
    let Some(run) = run else { return true };
    if run.ok {
        return false;
    }
    let last_activity = run.finished_at.unwrap_or(run.started_at);
    now_ms - last_activity >= RETRY_AFTER_MS
}

pub fn to_millis(local: NaiveDateTime) -> i64 {
    Local.from_local_datetime(&local).earliest().map(|d| d.timestamp_millis()).unwrap_or_else(|| local.and_utc().timestamp_millis())
}

pub fn day_key(slot: NaiveDateTime) -> String {
    slot.date().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(d: u32, h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, d).unwrap().and_hms_opt(h, m, 0).unwrap()
    }

    fn run(ok: bool, started: i64, finished: Option<i64>) -> RunInfo {
        RunInfo { day: "d".into(), started_at: started, finished_at: finished, ok, detail: String::new() }
    }

    #[test]
    fn before_the_hour_the_owed_slot_is_yesterdays() {
        assert_eq!(last_slot(at(22, 9, 0), 22), at(21, 22, 0));
        assert_eq!(next_slot(at(22, 9, 0), 22), at(22, 22, 0));
    }

    #[test]
    fn after_the_hour_the_owed_slot_is_todays() {
        assert_eq!(last_slot(at(22, 22, 0), 22), at(22, 22, 0));
        assert_eq!(last_slot(at(22, 23, 30), 22), at(22, 22, 0));
        assert_eq!(next_slot(at(22, 23, 30), 22), at(23, 22, 0));
    }

    #[test]
    fn a_successful_run_is_never_repeated_and_a_failed_one_waits() {
        assert!(needs_run(None, 0));
        assert!(!needs_run(Some(&run(true, 0, Some(1))), 10_000_000_000));
        assert!(!needs_run(Some(&run(false, 0, Some(1_000)), ), 1_000 + RETRY_AFTER_MS - 1));
        assert!(needs_run(Some(&run(false, 0, Some(1_000))), 1_000 + RETRY_AFTER_MS));
        assert!(needs_run(Some(&run(false, 0, None)), RETRY_AFTER_MS));
    }
}
