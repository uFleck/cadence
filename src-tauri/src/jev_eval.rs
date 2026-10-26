//! Threshold eval against the real TypeSafe API. It costs a few cents and needs `TYPESAFE_API_KEY`, so it is
//! ignored by default:
//!
//!     cargo test --lib jev_eval -- --ignored --nocapture
//!
//! `evals/cases.json` holds 113 labelled messages. Raw answers go to `evals/results.json` so the sweep can be
//! inspected without calling the API again.

use crate::ingest;
use crate::jev::{api_key, Jev};
use crate::model::{Screen, Settings, MIN_ENGLISH, MIN_PROSE};
use crate::redact::redact;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Deserialize, Serialize, Clone)]
struct Case {
    id: String,
    /// `native`, `flawed`, `paste` or `portuguese`. Only `flawed` belongs in the practice queue.
    kind: String,
    text: String,
    issue: Option<String>,
    /// Set after loading: whether ingestion and the minimum word count would let this message reach Jev.
    #[serde(default)]
    reached: bool,
}

#[derive(Serialize)]
struct Scored<'a> {
    case: &'a Case,
    words: usize,
    screen: &'a Screen,
}

#[derive(Clone, Copy, Debug)]
struct Rule {
    english: f64,
    prose: f64,
    threshold: f64,
    needs_issue: bool,
}

impl Rule {
    fn flags(&self, s: &Screen) -> bool {
        s.english >= self.english
            && s.prose >= self.prose
            && s.naturalness < self.threshold
            && (!self.needs_issue || s.issue.key() != "none")
    }
}

struct Tally {
    tp: usize,
    fp: usize,
    fn_: usize,
}

impl Tally {
    fn precision(&self) -> f64 {
        if self.tp + self.fp == 0 { 1.0 } else { self.tp as f64 / (self.tp + self.fp) as f64 }
    }
    fn recall(&self) -> f64 {
        if self.tp + self.fn_ == 0 { 1.0 } else { self.tp as f64 / (self.tp + self.fn_) as f64 }
    }
    fn f1(&self) -> f64 {
        let (p, r) = (self.precision(), self.recall());
        if p + r == 0.0 { 0.0 } else { 2.0 * p * r / (p + r) }
    }
}

/// Messages ingestion drops never get flagged, so a flawed one that is dropped counts as a miss.
fn tally(rule: &Rule, scored: &[(Case, Screen)]) -> Tally {
    let mut t = Tally { tp: 0, fp: 0, fn_: 0 };
    for (case, screen) in scored {
        match (case.kind == "flawed", case.reached && rule.flags(screen)) {
            (true, true) => t.tp += 1,
            (false, true) => t.fp += 1,
            (true, false) => t.fn_ += 1,
            (false, false) => {}
        }
    }
    t
}

fn words(text: &str) -> usize {
    text.split_whitespace().count()
}

fn spread(values: &[f64]) -> String {
    let n = values.len().max(1) as f64;
    let mean = values.iter().sum::<f64>() / n;
    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    format!("mean {mean:.2}  min {min:.2}  max {max:.2}")
}

async fn screen_all(cases: &[Case]) -> Vec<(Case, Screen)> {
    let jev = Arc::new(Jev::new(api_key().expect("TYPESAFE_API_KEY is not set")));
    let mut out = Vec::new();
    for chunk in cases.chunks(4) {
        let handles: Vec<_> = chunk
            .iter()
            .cloned()
            .map(|case| {
                let jev = jev.clone();
                tokio::spawn(async move {
                    let screen = jev.screen(&case.text).await;
                    (case, screen)
                })
            })
            .collect();
        for handle in handles {
            let (case, screen) = handle.await.unwrap();
            out.push((case.clone(), screen.unwrap_or_else(|e| panic!("{}: {e}", case.id))));
        }
    }
    out
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "calls the TypeSafe API"]
async fn thresholds_hold_on_the_labelled_cases() {
    let settings = Settings::default();
    let mut cases: Vec<Case> = serde_json::from_str(include_str!("../evals/cases.json")).unwrap();
    assert!(cases.len() >= 100, "the eval wants at least 100 cases");
    // Same order as the app: ingestion filters the raw text, then paths and links are redacted, then the word count.
    for c in &mut cases {
        let kept = ingest::prose(&c.text).is_some();
        c.text = redact(&c.text);
        c.reached = kept && words(&c.text) as i64 >= settings.min_words;
    }
    let scored = screen_all(&cases).await;

    let dump: Vec<_> = scored.iter().map(|(c, s)| Scored { case: c, words: words(&c.text), screen: s }).collect();
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/evals/results.json"), serde_json::to_string_pretty(&dump).unwrap())
        .unwrap();

    let eligible: Vec<(Case, Screen)> = scored.iter().filter(|(c, _)| c.reached).cloned().collect();
    println!("\n{} cases, {} get past ingestion and the {}-word minimum", scored.len(), eligible.len(), settings.min_words);
    for kind in ["native", "flawed", "paste", "portuguese"] {
        let total = scored.iter().filter(|(c, _)| c.kind == kind).count();
        let reached = eligible.iter().filter(|(c, _)| c.kind == kind).count();
        println!("  {kind}: {reached} of {total} reach Jev");
    }
    println!();

    for kind in ["native", "flawed", "paste", "portuguese"] {
        let of_kind: Vec<&(Case, Screen)> = eligible.iter().filter(|(c, _)| c.kind == kind).collect();
        let col = |f: fn(&Screen) -> f64| of_kind.iter().map(|(_, s)| f(s)).collect::<Vec<_>>();
        println!("{kind} ({})", of_kind.len());
        println!("  english     {}", spread(&col(|s| s.english)));
        println!("  prose       {}", spread(&col(|s| s.prose)));
        println!("  naturalness {}", spread(&col(|s| s.naturalness)));
    }

    println!("\nid  words  english  prose  naturalness  issue(conf)  expected");
    for (c, s) in &eligible {
        println!(
            "{:<20} {:>3}  {:.2}  {:.2}  {:.2}  {}({:.2})  {}",
            c.id,
            words(&c.text),
            s.english,
            s.prose,
            s.naturalness,
            s.issue.key(),
            s.issue_confidence,
            c.issue.as_deref().unwrap_or("-")
        );
    }

    let mut grid = Vec::new();
    for english in [0.5, 0.7, 0.9] {
        for prose in [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] {
            for t in 10..=30 {
                for needs_issue in [false, true] {
                    let rule = Rule { english, prose, threshold: t as f64 / 10.0, needs_issue };
                    let tally = tally(&rule, &eligible);
                    grid.push((rule, tally));
                }
            }
        }
    }
    grid.sort_by(|a, b| b.1.f1().total_cmp(&a.1.f1()).then(a.0.threshold.total_cmp(&b.0.threshold)));
    println!("\nbest rules by F1 (flawed is the positive class)");
    for (rule, t) in grid.iter().take(12) {
        println!(
            "english>={} prose>={} naturalness<{:.1} issue!=none:{:<5}  precision {:.2}  recall {:.2}  f1 {:.2}  (tp {} fp {} fn {})",
            rule.english, rule.prose, rule.threshold, rule.needs_issue, t.precision(), t.recall(), t.f1(), t.tp, t.fp, t.fn_
        );
    }

    let shipped = Rule { english: MIN_ENGLISH, prose: MIN_PROSE, threshold: settings.flag_threshold, needs_issue: false };
    let t = tally(&shipped, &eligible);
    println!(
        "\nshipped: english>={} prose>={} naturalness<{} -> precision {:.2} recall {:.2} f1 {:.2} (tp {} fp {} fn {})",
        shipped.english, shipped.prose, shipped.threshold, t.precision(), t.recall(), t.f1(), t.tp, t.fp, t.fn_
    );
    println!("wrongly flagged:");
    for (c, s) in eligible.iter().filter(|(c, s)| c.kind != "flawed" && shipped.flags(s)) {
        println!("  {} [{}] prose {:.2} naturalness {:.2}: {}", c.id, c.kind, s.prose, s.naturalness, &c.text[..c.text.len().min(70)]);
    }
    println!("missed:");
    for (c, s) in eligible.iter().filter(|(c, s)| c.kind == "flawed" && !shipped.flags(s)) {
        println!("  {} english {:.2} prose {:.2} naturalness {:.2}: {}", c.id, s.english, s.prose, s.naturalness, c.text);
    }

    let before = tally(&Rule { prose: 0.0, ..shipped }, &eligible);
    println!("
without the prose gate: precision {:.2} ({} false flags)", before.precision(), before.fp);

    // The gates must sit well inside the gaps between the groups, not on an edge.
    let range = |kind: &str, f: fn(&Screen) -> f64| {
        let v: Vec<f64> = eligible.iter().filter(|(c, _)| c.kind == kind).map(|(_, s)| f(s)).collect();
        (v.iter().cloned().fold(f64::INFINITY, f64::min), v.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
    };
    let people = ["native", "flawed", "portuguese"];
    let lowest_prose = people.iter().map(|k| range(k, |s| s.prose).0).fold(f64::INFINITY, f64::min);
    assert!(range("paste", |s| s.prose).1 + 0.2 < MIN_PROSE, "a paste scores too close to the prose gate");
    assert!(lowest_prose - 0.2 > MIN_PROSE, "a real message scores too close to the prose gate");
    let lowest_english = ["native", "flawed"].iter().map(|k| range(k, |s| s.english).0).fold(f64::INFINITY, f64::min);
    assert!(range("portuguese", |s| s.english).1 + 0.2 < MIN_ENGLISH, "Portuguese scores too close to the English gate");
    assert!(lowest_english - 0.2 > MIN_ENGLISH, "English scores too close to the English gate");
    assert!(range("native", |s| s.naturalness).0 - 0.2 > settings.flag_threshold, "a natural message sits on the flag threshold");

    assert!(t.precision() >= 0.95, "too many natural messages or pastes in the queue");
    assert!(t.recall() >= 0.85, "too many flawed messages left out of the queue");
}
