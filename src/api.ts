import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Issue =
  | "none"
  | "articles"
  | "agreement_tense"
  | "typo"
  | "missing_word"
  | "preposition"
  | "awkward_phrasing"
  | "word_order"
  | "pt_calque"
  | "register"
  // Kept so rows screened before the split still read; never produced by a new screen.
  | "grammar"
  | "preposition_collocation"
  | "word_choice";

export const ISSUE_LABEL: Record<Issue, string> = {
  none: "Sounds native",
  articles: "Articles (a, the)",
  agreement_tense: "Agreement or tense",
  typo: "Typos and apostrophes",
  missing_word: "Missing word",
  preposition: "Preposition",
  awkward_phrasing: "Awkward wording",
  word_order: "Word order",
  pt_calque: "Portuguese-style phrasing",
  register: "Tone for a work chat",
  grammar: "Grammar (older)",
  preposition_collocation: "Preposition or word pairing (older)",
  word_choice: "Word choice (older)",
};

export interface Screen {
  /** Probability 0..1 that the message is English. */
  english: number;
  /** Probability 0..1 that a person wrote it as sentences, not a pasted log, stack trace, code or tool output. */
  prose: number;
  /** 0 (clearly unnatural) .. 3 (fully natural). 3 exactly when `native` reaches the native gate. */
  naturalness: number;
  /** Probability 0..1 that a native speaker would change nothing in the wording; null before rubric 1. */
  native: number | null;
  /** The version of the questions Jev was asked. Scores from different rubrics are not compared. */
  rubric: number;
  /** 0..1 */
  confidence: number;
  issue: Issue;
  /** 0..1 */
  issueConfidence: number;
}

export interface Rewrite {
  register: "casual" | "professional";
  text: string;
}

export interface Coaching {
  rewrites: Rewrite[];
  /** What still sounds off in the user's new version, or why it sounds natural, in two or three sentences. */
  explanation: string;
  /** One reusable rule or phrase to remember. */
  tip: string;
  /** How the coach read a word that could mean two things ("I read 'lead' as a potential customer"). Empty when nothing was ambiguous, and for older coaching. */
  assumption: string;
  /** What the user meant, in plain words that do not reuse the message's wording. A re-test shows it. Empty for older coaching. */
  idea: string;
  issue: Issue;
  /** Epoch ms */
  createdAt: number;
  /** What the `claude -p` call behind this coaching cost, in USD. Null for older coaching, or when the CLI reported none. */
  costUsd: number | null;
}

export interface Attempt {
  id: number;
  text: string;
  /** Epoch ms */
  createdAt: number;
  /** How natural this version sounds. Null when it was saved before attempts were scored, or Jev was unreachable. */
  screen: Screen | null;
  /** The review of this version. Null until it was reviewed (or when the review failed and can be retried). */
  coaching: Coaching | null;
}

export interface Message {
  id: string;
  text: string;
  /** Epoch ms when the message was sent. */
  ts: number;
  project: string | null;
  words: number;
  source: "transcript" | "history";
  screen: Screen | null;
  /** The review of the latest attempt (the same object as `attempts[attempts.length - 1].coaching`). */
  coaching: Coaching | null;
  /** Oldest first. */
  attempts: Attempt[];
  /** Epoch ms when the user marked it reviewed, or null. */
  reviewedAt: number | null;
  /** Epoch ms when the user set it aside as not fit for practice, or null. Excluded messages leave the queue, the counts and the patterns. */
  excludedAt: number | null;
}

/** `rewritten`: messages the user wrote a new version of, most recently rewritten first. */
export type MessageFilter = "queue" | "reviewed" | "rewritten" | "all" | "excluded";

export interface MessageQuery {
  filter: MessageFilter;
  limit: number;
  offset: number;
}

export interface RunInfo {
  /** Local date, yyyy-mm-dd */
  day: string;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean;
  detail: string;
}

export interface Overview {
  total: number;
  screened: number;
  /** Screened, English, naturalness under the threshold, not reviewed yet. */
  queued: number;
  reviewed: number;
  /** Not screened yet. */
  pending: number;
  lastRun: RunInfo | null;
  /** Epoch ms of the next scheduled run. */
  nextRunAt: number;
  running: boolean;
  typesafeConfigured: boolean;
  claudeFound: boolean;
}

export interface PatternRow {
  issue: Issue;
  count: number;
  avgNaturalness: number;
}

export interface TrendRow {
  /** Local date, yyyy-mm-dd */
  day: string;
  count: number;
  avgNaturalness: number;
}

/** Flagged messages of one issue in one local week (weeks start on Monday). */
export interface IssueWeekRow {
  /** Monday of the week, yyyy-mm-dd */
  week: string;
  issue: Issue;
  count: number;
}

/** Screened messages in one local week, the denominator for IssueWeekRow. */
export interface WeekRow {
  week: string;
  screened: number;
}

/** How often one issue shows up before and after the first time it was coached. */
export interface CoachedImpact {
  issue: Issue;
  /** Epoch ms of the first coaching for this issue */
  coachedAt: number;
  beforeScreened: number;
  beforeFlagged: number;
  afterScreened: number;
  afterFlagged: number;
}

export interface Patterns {
  issues: PatternRow[];
  trend: TrendRow[];
  /** Settings.flagThreshold, the goal line on the trend chart. */
  threshold: number;
  weeks: WeekRow[];
  issueWeeks: IssueWeekRow[];
  coachedImpact: CoachedImpact[];
}

export interface Settings {
  /** Local hour 0..23 for the daily run. */
  runHour: number;
  /** Messages scoring below this (0..3) go to the queue. */
  flagThreshold: number;
  /** Shortest message, in words, that counts as practice material. */
  minWords: number;
}

/** Where the TypeSafe key in use comes from: typed into Cadence, the TYPESAFE_API_KEY variable, or nowhere. */
export type KeySource = "app" | "env" | "none";

export type RunPhase = "ingest" | "screen" | "done" | "error";

export interface RunProgress {
  phase: RunPhase;
  done: number;
  total: number;
  message: string | null;
}

export type InterviewTopic = "cloud" | "testing" | "backend" | "system_design" | "behavioral";

export const TOPIC_LABEL: Record<InterviewTopic, string> = {
  cloud: "Cloud",
  testing: "Testing",
  backend: "Backend depth",
  system_design: "System design",
  behavioral: "Your experience",
};

export interface InterviewQuestion {
  id: number;
  topic: InterviewTopic;
  text: string;
  /** Added by the user (a question from a real interview, or a follow-up), not part of the built-in bank. */
  custom: boolean;
  /** How many answers were saved for it. */
  answers: number;
  /** Epoch ms of the latest answer, or null. */
  lastAnsweredAt: number | null;
  /** Highest `InterviewFeedback.depth` across its answers, or null. */
  bestDepth: number | null;
}

export interface InterviewFeedback {
  /** The same answer, same content, as a fluent engineer would say it out loud in an interview. */
  spoken: string;
  /** What sounded off in the English, two or three sentences. */
  englishNotes: string;
  /** One phrase or rule worth reusing in interviews. */
  tip: string;
  issue: Issue;
  /** 1 (surface level) .. 5 (senior-level depth, with trade-offs and real examples). */
  depth: number;
  /** One or two sentences on the depth score. */
  depthNotes: string;
  /** Points a strong answer would have covered that this one did not. */
  missing: string[];
  /** The follow-up question an interviewer would most likely ask next. */
  followUp: string;
  /** Epoch ms */
  createdAt: number;
}

export interface InterviewAnswer {
  id: number;
  questionId: number;
  text: string;
  /** Seconds from showing the question to saving the answer. */
  seconds: number;
  /** Epoch ms */
  createdAt: number;
  /** Jev screen of the answer; null until reviewed, or when TypeSafe is not configured. */
  screen: Screen | null;
  feedback: InterviewFeedback | null;
}

export type UsageKind = "coach" | "interview" | "screen";

export const USAGE_KIND_LABEL: Record<UsageKind, string> = {
  coach: "Rewrite reviews",
  interview: "Interview feedback",
  screen: "TypeSafe screens",
};

/**
 * Spending over one period. `costUsd` adds Claude and TypeSafe. Claude's part is the list-price cost `claude -p`
 * reports, so on a subscription it is the equivalent API cost, not a charge. TypeSafe's part is an estimate:
 * Jev bills input tokens only ($0.042 per million) and its response has no token count, so the input is
 * estimated from the request size.
 */
export interface UsageTotals {
  claudeCalls: number;
  /** Included in `costUsd` as an estimate. */
  jevCalls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Cache reads plus cache writes. */
  cacheTokens: number;
}

export interface DayCost {
  /** Local date, yyyy-mm-dd */
  day: string;
  costUsd: number;
  claudeCalls: number;
  jevCalls: number;
}

export interface KindCost {
  kind: UsageKind;
  calls: number;
  costUsd: number;
}

/** One Claude call (Jev screens are counted and priced in the totals, but not listed one by one). */
export interface UsageCall {
  id: number;
  /** Epoch ms */
  at: number;
  kind: UsageKind;
  /** The start of the message or interview answer the call was about. */
  preview: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when the CLI reported none. */
  costUsd: number | null;
  durationMs: number;
  /** False when the call ran but its answer could not be read. */
  ok: boolean;
}

export interface Spending {
  today: UsageTotals;
  /** Last 7 local days, today included. */
  week: UsageTotals;
  /** Last 30 local days, today included. */
  month: UsageTotals;
  allTime: UsageTotals;
  /** Last 30 local days, oldest first, one row per day (zeros where nothing was spent). */
  days: DayCost[];
  byKind: KindCost[];
  /** Newest first, at most 100. */
  recent: UsageCall[];
  /** Epoch ms of the first tracked call, or null before any. Spending from before tracking is not counted. */
  since: number | null;
}

/** The most versions a user may write of one message. The Rust side enforces it (`MAX_TRIES`); the third try settles the message. */
export const MAX_TRIES = 3;

/** One local week (Monday start) of the progress chart. */
export interface ProgressWeek {
  /** The Monday, `YYYY-MM-DD`. */
  week: string;
  /** Counted messages written that week. */
  screened: number;
  /** Average naturalness of what the user wrote first (the originals of that week's messages). */
  firstDraft: number;
  /** Average naturalness of the newest scored version, over the week's messages that have one. Null when none. */
  afterRetries: number | null;
  /** How many messages `afterRetries` averages. */
  retried: number;
}

/** One kind of slip: flagged messages in the last 7 days against the 7 days before. */
export interface SlipRow {
  issue: Issue;
  now: number;
  before: number;
}

export interface Progress {
  /** Oldest first; weeks with no counted message are left out. */
  weeks: ProgressWeek[];
  /** Most frequent first. */
  slips: SlipRow[];
  /** `Settings.flagThreshold`: the goal line. */
  goal: number;
}

/** A message to write again from its idea some days after it settled. */
export interface Retest {
  id: number;
  messageId: string;
  /** What the user meant, in words that do not reuse the message's wording. */
  idea: string;
  /** 1 for the first re-test, 2 for the one that follows a missed goal. */
  step: number;
  /** Epoch ms */
  dueAt: number;
  originalScore: number | null;
  /** Naturalness of the newest scored version when the message settled. */
  settledScore: number | null;
  /** Epoch ms, set once the user answered. */
  doneAt: number | null;
  text: string | null;
  screen: Screen | null;
}

export interface RetestQueue {
  /** The oldest re-test that is due now. */
  due: Retest | null;
  /** How many are due now, including `due`. */
  dueCount: number;
  /** Not yet due, soonest first, at most 5. */
  upcoming: Retest[];
}

export const api = {
  overview: () => invoke<Overview>("overview"),
  /** `weeks` local weeks ending with the current one; 0 for all. */
  progress: (weeks: number) => invoke<Progress>("progress", { weeks }),
  retestQueue: () => invoke<RetestQueue>("retest_queue"),
  /** Scores what the user wrote from the idea and stores it; the Retest comes back with its screen. A Jev failure saves it unscored. */
  saveRetest: (id: number, text: string) => invoke<Retest>("save_retest", { id, text }),
  /** "Later": the re-test comes back tomorrow. */
  postponeRetest: (id: number) => invoke<void>("postpone_retest", { id }),
  listMessages: (query: MessageQuery) => invoke<Message[]>("list_messages", { query }),
  /** The message as it is stored now, with its attempts and their reviews. */
  getMessage: (id: string) => invoke<Message>("get_message", { id }),
  /** Reviews the latest saved version and stores the review on that version; an earlier version keeps its own. */
  coachMessage: (id: string) => invoke<Coaching>("coach_message", { id }),
  /**
   * Saves a new version and scores it. Reaching `Settings.flagThreshold` marks the message reviewed;
   * falling short puts it (back) in the queue, except the last try (`MAX_TRIES`), which settles the
   * message whatever it scored. A fourth try is refused. Read the message again to see the result.
   */
  saveAttempt: (id: string, text: string) => invoke<Attempt>("save_attempt", { id, text }),
  spending: () => invoke<Spending>("spending"),
  markReviewed: (id: string, reviewed: boolean) => invoke<void>("mark_reviewed", { id, reviewed }),
  setExcluded: (id: string, excluded: boolean) => invoke<void>("set_excluded", { id, excluded }),
  patterns: () => invoke<Patterns>("patterns"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<Settings>("set_settings", { settings }),
  /** The person's own work terms, one per line, which the coach reads as defined instead of correcting them. */
  getGlossary: () => invoke<string>("get_glossary"),
  setGlossary: (glossary: string) => invoke<string>("set_glossary", { glossary }),
  /** The key itself never reaches the UI, only where it comes from. */
  typesafeKeySource: () => invoke<KeySource>("typesafe_key_source"),
  /** Stores the key in the OS credential store. */
  setTypesafeKey: (key: string) => invoke<KeySource>("set_typesafe_key", { key }),
  /** Removes the stored key; a TYPESAFE_API_KEY variable, if any, takes over. */
  clearTypesafeKey: () => invoke<KeySource>("clear_typesafe_key"),
  runNow: () => invoke<void>("run_now"),
  /** Every question, built-in and custom, ordered by topic then id. */
  interviewQuestions: () => invoke<InterviewQuestion[]>("interview_questions"),
  /** Picks the question to practise next: never answered first, then the least recently answered. `null` means any topic. */
  nextInterviewQuestion: (topic: InterviewTopic | null, exclude: number | null) =>
    invoke<InterviewQuestion>("next_interview_question", { topic, exclude }),
  addInterviewQuestion: (topic: InterviewTopic, text: string) =>
    invoke<InterviewQuestion>("add_interview_question", { topic, text }),
  /** Only custom questions can be deleted; their answers go with them. */
  deleteInterviewQuestion: (id: number) => invoke<void>("delete_interview_question", { id }),
  saveInterviewAnswer: (questionId: number, text: string, seconds: number) =>
    invoke<InterviewAnswer>("save_interview_answer", { questionId, text, seconds }),
  /**
   * Screens the answer with Jev (skipped without a TypeSafe key) and asks Claude for feedback, then saves both.
   * `force` asks again and replaces the saved feedback; the old one stays if the new call fails.
   */
  reviewInterviewAnswer: (id: number, force = false) => invoke<InterviewAnswer>("review_interview_answer", { id, force }),
  /** Newest first. `questionId` null lists answers across all questions. */
  interviewAnswers: (questionId: number | null, limit: number) =>
    invoke<InterviewAnswer[]>("interview_answers", { questionId, limit }),
};

export function onRunProgress(cb: (p: RunProgress) => void): Promise<UnlistenFn> {
  return listen<RunProgress>("run-progress", (e) => cb(e.payload));
}

export function onMessagesChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("messages-changed", () => cb());
}
