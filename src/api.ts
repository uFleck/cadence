import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Issue =
  | "none"
  | "grammar"
  | "preposition_collocation"
  | "word_choice"
  | "word_order"
  | "pt_calque"
  | "register";

export const ISSUE_LABEL: Record<Issue, string> = {
  none: "Sounds native",
  grammar: "Grammar",
  preposition_collocation: "Preposition or word pairing",
  word_choice: "Word choice",
  word_order: "Word order",
  pt_calque: "Portuguese-style phrasing",
  register: "Tone for a work chat",
};

export interface Screen {
  /** Probability 0..1 that the message is English. */
  english: number;
  /** Probability 0..1 that a person wrote it as sentences, not a pasted log, stack trace, code or tool output. */
  prose: number;
  /** 0 (clearly unnatural) .. 3 (fully natural). */
  naturalness: number;
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
  issue: Issue;
  /** Epoch ms */
  createdAt: number;
}

export interface Attempt {
  id: number;
  text: string;
  /** Epoch ms */
  createdAt: number;
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
  coaching: Coaching | null;
  attempts: Attempt[];
  /** Epoch ms when the user marked it reviewed, or null. */
  reviewedAt: number | null;
}

export type MessageFilter = "queue" | "reviewed" | "all";

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

export const api = {
  overview: () => invoke<Overview>("overview"),
  listMessages: (query: MessageQuery) => invoke<Message[]>("list_messages", { query }),
  /** `force` coaches again and replaces the saved coaching; the old one stays if the new call fails. */
  coachMessage: (id: string) => invoke<Coaching>("coach_message", { id }),
  saveAttempt: (id: string, text: string) => invoke<Attempt>("save_attempt", { id, text }),
  markReviewed: (id: string, reviewed: boolean) => invoke<void>("mark_reviewed", { id, reviewed }),
  patterns: () => invoke<Patterns>("patterns"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<Settings>("set_settings", { settings }),
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
