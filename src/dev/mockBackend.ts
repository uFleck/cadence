/* Dev-only stand-in for the Tauri backend, so the UI can be driven in a plain browser (`pnpm dev`).
   Twelve work messages (eight to practise, one reviewed, two not screened yet). A run is simulated and
   emits run-progress and messages-changed like the real one. `?nosetup` shows the missing-key and missing-CLI banners. */
import type { Attempt, Coaching, DayCost, InterviewAnswer, InterviewFeedback, InterviewQuestion, InterviewTopic, Issue, KeySource, KindCost, Message, MessageQuery, Overview, Patterns, Progress, ProgressWeek, Retest, RetestQueue, RunInfo, RunPhase, RunProgress, Screen, Settings, SlipRow, Spending, UsageCall, UsageKind, UsageTotals } from "../api";
import { MAX_TRIES } from "../api";

type Handler = (e: { event: string; id: number; payload: unknown }) => void;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const SETUP_MISSING = location.search.includes("nosetup");

const localDay = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const screen = (naturalness: number, issue: Issue): Screen => ({
  english: 0.97,
  prose: 0.93,
  naturalness,
  native: naturalness >= 3 ? 0.9 : 0.1,
  rubric: 1,
  confidence: 0.86,
  issue,
  issueConfidence: 0.8,
});

const coach = (issue: Issue, casual: string, professional: string, explanation: string, tip: string, idea: string): Coaching => ({
  rewrites: [
    { register: "casual", text: casual },
    { register: "professional", text: professional },
  ],
  explanation,
  tip,
  assumption: "",
  idea,
  issue,
  createdAt: Date.now(),
  costUsd: null,
});

const COACH: Record<string, Coaching> = {
  "m-report": coach(
    "preposition_collocation",
    "I'll send you the report by the end of the day.",
    "I will send you the report by the end of the day.",
    "'Until' sets a limit you reach and then stop at, but here you mean a deadline. English pairs 'by' with a deadline.",
    "Deadlines take 'by': by the end of the day, by Friday, by noon.",
    "Tell the team when the report will be ready, before the deadline.",
  ),
  "m-deploy": coach(
    "grammar",
    "Could you check the deploy when you have a moment?",
    "Could you check the deploy when you have time?",
    "'Please' goes straight before the verb, without 'to'. 'Could you' also sounds smoother in a chat.",
    "Use 'please + verb' or 'could you + verb', with no 'to' in between.",
    "Ask a colleague to check the deploy when they have a spare moment.",
  ),
  "m-proposal/0": coach(
    "grammar",
    "I agree with the proposal, so let's go ahead.",
    "I agree with the proposal. Let's go ahead.",
    "A comma joins two full sentences here, which is a comma splice. Use a full stop or 'so' instead.",
    "Join two full sentences with a full stop or 'so', not a bare comma.",
    "Agree with the proposal and suggest going ahead now.",
  ),
  "m-proposal/1": coach(
    "none",
    "I agree with the proposal. Let's go ahead.",
    "I agree with the proposal, so we can go ahead.",
    "This version sounds native: two short sentences, and 'let's go ahead' is the usual phrase in chat.",
    "Two short sentences read naturally in chat.",
    "Agree with the proposal and suggest going ahead now.",
  ),
  "m-proposal": coach(
    "grammar",
    "I agree with the proposal, let's go ahead.",
    "I agree with the proposal. Let's go ahead.",
    "'Agree' is a verb in English, so it takes no 'am'. The slip usually comes from Portuguese 'estou de acordo'.",
    "Say 'I agree', not 'I am agree'. Same for 'I understand', not 'I am understand'.",
    "Agree with the proposal and suggest going ahead now.",
  ),
  "m-pr": coach(
    "word_choice",
    "Can you take a look at the PR when you get a chance?",
    "Could you review the PR when you get a chance?",
    "'Give a look' is a literal translation. English says 'take a look' for a quick glance, or 'review' for a real check.",
    "'Take a look' for a quick glance, 'review' for a proper check.",
    "Ask a colleague to take a quick look at the PR when they can.",
  ),
  "m-migration": coach(
    "grammar",
    "I ran the migration yesterday and it worked well.",
    "I ran the migration yesterday, and it went through without issues.",
    "A finished action with a time word such as 'yesterday' takes the simple past, not the present perfect.",
    "Yesterday, last week, in 2024: simple past. 'Have done' is for things that still matter now.",
    "Say the migration ran yesterday and that it went well.",
  ),
  "m-release": coach(
    "pt_calque",
    "Just a reminder: the release is on Friday.",
    "A reminder that the release is on Friday.",
    "'Remember someone of something' is Portuguese word order carried into English. In English you remind someone.",
    "Say 'remind you that', not 'remember you that'.",
    "Remind the team that the release is on Friday.",
  ),
  "m-asap": coach(
    "register",
    "Hey, can you check this when you get a chance?",
    "Could you check this when you have a moment?",
    "Chat is informal, but 'dude' and 'asap' read as too casual when you work with clients or managers.",
    "Swap 'asap' for 'when you get a chance' or 'today if possible'.",
    "Ask someone to check this today, without sounding rushed.",
  ),
  "m-tests": coach(
    "word_order",
    "The tests are failing again in CI.",
    "The tests are failing again in the CI pipeline.",
    "The subject comes before the verb, and 'the thing is that' adds nothing. Start with the point.",
    "Start with the subject: 'The tests are failing', not 'The thing is that the tests they are failing'.",
    "Explain that the tests fail again in CI.",
  ),
  "m-call": coach(
    "word_choice",
    "Can we find a time later to sync on the roadmap?",
    "Could we set up a call later to sync on the roadmap?",
    "'Make a call' sounds like phoning someone. For a meeting, English says 'have a call' or 'set up a call'.",
    "For meetings: 'set up a call', 'have a call', 'jump on a call'.",
    "Suggest a call later to sync on the roadmap.",
  ),
};

interface Seed {
  id: string;
  text: string;
  hours: number;
  project: string | null;
  screen?: Screen;
  reviewed?: boolean;
  attempts?: string[];
  coached?: boolean;
  source?: Message["source"];
}

const SEEDS: Seed[] = [
  { id: "m-report", text: "I will send you the report until the end of the day.", hours: 2, project: "billing-api", screen: screen(1.2, "preposition_collocation") },
  { id: "m-deploy", text: "Please to check the deploy when you have time.", hours: 5, project: "web-app", screen: screen(0.8, "grammar"), coached: true, attempts: ["Please check the deploy when you get a moment."] },
  { id: "m-proposal", text: "I am agree with the proposal, let's go ahead.", hours: 9, project: "web-app", screen: screen(1.4, "grammar"), attempts: ["I agree with the proposal, let's go ahead.", "I agree with the proposal. Let's go ahead."] },
  { id: "m-pr", text: "Can you give a look at the PR when you can?", hours: 14, project: "ops", screen: screen(1.9, "word_choice"), source: "history" },
  { id: "m-migration", text: "Yesterday I have made the migration and it worked well.", hours: 20, project: "billing-api", screen: screen(1.6, "grammar") },
  { id: "m-release", text: "I am remembering you that the release is on Friday.", hours: 26, project: "web-app", screen: screen(1.1, "pt_calque") },
  { id: "m-asap", text: "Hey dude, can you check it asap?", hours: 30, project: "ops", screen: screen(1.8, "register") },
  { id: "m-tests", text: "The thing is that the tests they are failing again in the CI.", hours: 36, project: "billing-api", screen: screen(1.3, "word_order") },
  { id: "m-invoice", text: "I'm going to ping you tomorrow morning about the invoice.", hours: 3, project: "billing-api", screen: screen(3, "none") },
  { id: "m-side", text: "Let me know if you need anything else from my side.", hours: 7, project: "web-app", screen: screen(2.9, "none"), reviewed: true },
  { id: "m-call", text: "Let's try to make a call later to sync about the roadmap.", hours: 1, project: "web-app" },
  { id: "m-lunch", text: "I'll look at it after lunch.", hours: 2, project: "ops" },
];

/** Screens the pending messages get when a run reads them. */
const PENDING_SCREEN: Record<string, Screen> = {
  "m-call": screen(1.9, "word_choice"),
  "m-lunch": screen(2.9, "none"),
};


const QUESTION_SEEDS: [InterviewTopic, string][] = [
  ["cloud", "How would you deploy a backend service to the cloud so it can scale and survive a failed zone?"],
  ["cloud", "What is the difference between a queue and a topic, and when would you pick each one?"],
  ["testing", "How do you decide what to cover with unit tests and what with integration tests?"],
  ["testing", "Tell me about a flaky test you fixed. What was the cause?"],
  ["backend", "How does an index speed up a query, and when can it make writes worse?"],
  ["backend", "How would you make an endpoint that charges a card safe to retry?"],
  ["system_design", "Design a URL shortener. Where does it become hard to scale?"],
  ["system_design", "How would you design a rate limiter for a public API?"],
  ["behavioral", "Tell me about a production incident you handled. What did you change afterwards?"],
  ["behavioral", "Describe a technical disagreement with a teammate and how it ended."],
];

const FEEDBACKS: InterviewFeedback[] = [
  {
    spoken: "I would run the service in containers behind a load balancer, spread across at least two availability zones, and let an autoscaling group add instances when CPU goes up. The database would be managed, with a replica in another zone for failover.",
    englishNotes: "Some sentences ran together and a few words came from Portuguese word order. Shorter sentences will sound clearer when you speak.",
    tip: "Say 'spread across two zones', not 'spread in two zones'.",
    issue: "preposition_collocation",
    depth: 3,
    depthNotes: "You named the right pieces, but gave no trade-offs and no example from real work.",
    missing: ["Health checks and how traffic drains during a deploy", "How you would test the failover", "Cost trade-off of running in several zones"],
    followUp: "How would you roll out a new version without downtime?",
    createdAt: 0,
  },
  {
    spoken: "I usually write unit tests for business rules, because they are fast and precise. Then I add a few integration tests against a real database to check that the pieces fit together.",
    englishNotes: "Mostly clear. 'Make a test' should be 'write a test', and the verb tenses drifted between past and present.",
    tip: "Tests are written or run, not made.",
    issue: "word_choice",
    depth: 4,
    depthNotes: "Good split with a reason for each level. A concrete example would push it to a 5.",
    missing: ["Contract tests between services", "What you do not test, and why"],
    followUp: "How do you keep integration tests fast and reliable in CI?",
    createdAt: 0,
  },
];

const questionKey = (q: InterviewQuestion) => (q.lastAnsweredAt === null ? -1 : q.lastAnsweredAt);

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

export function installMock() {
  const callbacks = new Map<number, Handler>();
  const listeners = new Map<string, Handler[]>();
  let cb = 1;
  let attemptSeq = 1;
  let settings: Settings = { runHour: 21, flagThreshold: 2, minWords: 4 };
  let glossary = "";
  let keySource: KeySource = SETUP_MISSING ? "none" : "app";
  let running = false;
  let lastRun: RunInfo = {
    day: localDay(Date.now() - DAY),
    startedAt: Date.now() - 20 * HOUR,
    finishedAt: Date.now() - 20 * HOUR + 40_000,
    ok: true,
    detail: "Screened 10, queued 8",
  };

  const messages: Message[] = SEEDS.map((s) => {
    const attempts = (s.attempts ?? []).map((text, i, all): Attempt => ({
      id: attemptSeq++,
      text,
      createdAt: Date.now() - (s.hours - i) * HOUR,
      screen: s.screen ? screen(Math.min(3, s.screen.naturalness + 1.1 + i * 0.5), "none") : null,
      // A seeded coaching is keyed by message id, or by message id and attempt index when a version has its own.
      coaching: COACH[`${s.id}/${i}`] ?? (i === all.length - 1 && s.coached ? COACH[s.id] : null),
    }));
    return {
      id: s.id,
      text: s.text,
      ts: Date.now() - s.hours * HOUR,
      project: s.project,
      words: wordCount(s.text),
      source: s.source ?? "transcript",
      screen: s.screen ?? null,
      coaching: attempts[attempts.length - 1]?.coaching ?? null,
      attempts,
      reviewedAt: s.reviewed ? Date.now() - DAY : null,
      excludedAt: null,
    };
  });
  const find = (id: unknown) => {
    const m = messages.find((x) => x.id === id);
    if (!m) throw new Error(`mock: no message ${String(id)}`);
    return m;
  };
  const lastAttempt = (m: Message): Attempt | undefined => m.attempts[m.attempts.length - 1];
  // The message shows the coaching of its latest version only.
  const syncCoaching = (m: Message) => {
    m.coaching = lastAttempt(m)?.coaching ?? null;
  };
  // Queue order: the latest version's naturalness, or the original screen when that version has none.
  const queueKey = (m: Message) => lastAttempt(m)?.screen?.naturalness ?? m.screen?.naturalness ?? 0;


  let questionSeq = 1;
  let answerSeq = 1;
  const questions: InterviewQuestion[] = QUESTION_SEEDS.map(([topic, text]) => ({
    id: questionSeq++,
    topic,
    text,
    custom: false,
    answers: 0,
    lastAnsweredAt: null,
    bestDepth: null,
  }));
  const answers: InterviewAnswer[] = [];
  const findQuestion = (id: unknown) => {
    const q = questions.find((x) => x.id === id);
    if (!q) throw new Error(`mock: no question ${String(id)}`);
    return q;
  };
  const findAnswer = (id: unknown) => {
    const a = answers.find((x) => x.id === id);
    if (!a) throw new Error(`mock: no answer ${String(id)}`);
    return a;
  };
  const refreshQuestion = (q: InterviewQuestion) => {
    const mine = answers.filter((a) => a.questionId === q.id);
    q.answers = mine.length;
    q.lastAnsweredAt = mine.length ? Math.max(...mine.map((a) => a.createdAt)) : null;
    const depths = mine.flatMap((a) => (a.feedback ? [a.feedback.depth] : []));
    q.bestDepth = depths.length ? Math.max(...depths) : null;
  };

  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h({ event, id: 0, payload }));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const isQueued = (m: Message) =>
    !!m.screen && m.screen.english >= 0.5 && m.screen.prose >= 0.5 && m.screen.naturalness < settings.flagThreshold && m.words >= settings.minWords && m.reviewedAt === null && m.excludedAt === null;

  const nextRunAt = () => {
    const d = new Date();
    d.setHours(settings.runHour, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  };

  const overview = (): Overview => ({
    total: messages.length,
    screened: messages.filter((m) => m.screen).length,
    queued: messages.filter(isQueued).length,
    reviewed: messages.filter((m) => m.reviewedAt !== null).length,
    pending: messages.filter((m) => !m.screen).length,
    lastRun,
    nextRunAt: nextRunAt(),
    running,
    typesafeConfigured: keySource !== "none",
    claudeFound: !SETUP_MISSING,
  });

  const list = ({ filter, limit, offset }: MessageQuery): Message[] => {
    if (filter === "queue") {
      return messages
        .filter(isQueued)
        .sort((a, b) => queueKey(a) - queueKey(b) || b.ts - a.ts)
        .slice(offset, offset + limit);
    }
    if (filter === "excluded") {
      return messages.filter((m) => m.excludedAt !== null).sort((a, b) => b.ts - a.ts).slice(offset, offset + limit);
    }
    if (filter === "rewritten") {
      return messages
        .filter((m) => m.excludedAt === null && m.attempts.length > 0)
        .sort((a, b) => (lastAttempt(b)?.createdAt ?? 0) - (lastAttempt(a)?.createdAt ?? 0))
        .slice(offset, offset + limit);
    }
    return messages
      .filter((m) => m.excludedAt === null && (filter === "all" || m.reviewedAt !== null))
      .sort((a, b) => b.ts - a.ts)
      .slice(offset, offset + limit);
  };

  const patterns = (): Patterns => {
    const screened = messages.filter((m): m is Message & { screen: Screen } => m.screen !== null && m.excludedAt === null);
    const byIssue = new Map<Issue, { count: number; sum: number }>();
    const byDay = new Map<string, { count: number; sum: number }>();
    for (const m of screened) {
      const i = byIssue.get(m.screen.issue) ?? { count: 0, sum: 0 };
      byIssue.set(m.screen.issue, { count: i.count + 1, sum: i.sum + m.screen.naturalness });
      const day = localDay(m.ts);
      const d = byDay.get(day) ?? { count: 0, sum: 0 };
      byDay.set(day, { count: d.count + 1, sum: d.sum + m.screen.naturalness });
    }
    const counted = screened.filter((m) => m.screen.english >= 0.5 && m.screen.prose >= 0.5 && m.words >= settings.minWords);
    const flagged = (m: Message & { screen: Screen }) => m.screen.issue !== "none" && m.screen.naturalness < settings.flagThreshold;
    const weekOf = (ts: number) => {
      const d = new Date(ts);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return localDay(d.getTime());
    };
    const firstWeek = weekOf(Date.now() - 77 * DAY);
    const recent = counted.map((m) => ({ m, week: weekOf(m.ts) })).filter((x) => x.week >= firstWeek);
    const byWeek = new Map<string, number>();
    const byWeekIssue = new Map<string, { week: string; issue: Issue; count: number }>();
    for (const { m, week } of recent) {
      byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
      if (flagged(m)) {
        const key = `${week}|${m.screen.issue}`;
        const row = byWeekIssue.get(key) ?? { week, issue: m.screen.issue, count: 0 };
        byWeekIssue.set(key, { ...row, count: row.count + 1 });
      }
    }
    const coachedAt = new Map<Issue, number>();
    for (const m of messages) {
      if (m.coaching && m.coaching.issue !== "none") {
        coachedAt.set(m.coaching.issue, Math.min(m.coaching.createdAt, coachedAt.get(m.coaching.issue) ?? Infinity));
      }
    }
    const coachedImpact = [...coachedAt]
      .map(([issue, at]) => {
        const before = counted.filter((m) => m.ts < at);
        const after = counted.filter((m) => m.ts >= at);
        const hits = (list: typeof counted) => list.filter((m) => flagged(m) && m.screen.issue === issue).length;
        return { issue, coachedAt: at, beforeScreened: before.length, beforeFlagged: hits(before), afterScreened: after.length, afterFlagged: hits(after) };
      })
      .sort((a, b) => a.coachedAt - b.coachedAt);
    return {
      threshold: settings.flagThreshold,
      weeks: [...byWeek].sort(([a], [b]) => a.localeCompare(b)).map(([week, count]) => ({ week, screened: count })),
      issueWeeks: [...byWeekIssue.values()].sort((a, b) => a.week.localeCompare(b.week) || a.issue.localeCompare(b.issue)),
      coachedImpact,
      issues: [...byIssue].map(([issue, v]) => ({ issue, count: v.count, avgNaturalness: v.sum / v.count })).sort((a, b) => b.count - a.count),
      trend: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, count: v.count, avgNaturalness: v.sum / v.count })),
    };
  };

  // Usage records: one per Claude call, plus one per TypeSafe screen (priced from input tokens only, $0.042 per million).
  const usage: UsageCall[] = [];
  let usageSeq = 1;
  const recordUsage = (c: Omit<UsageCall, "id">) => {
    usage.push({ id: usageSeq++, ...c });
  };
  const USAGE_PREVIEWS = [
    "I will send you the report until the end of the day.",
    "Please to check the deploy when you have time.",
    "How would you make an endpoint that charges a card safe to retry?",
    "I am agree with the proposal, let's go ahead.",
    "Tell me about a production incident you handled.",
    "Yesterday I have made the migration and it worked well.",
  ];
  for (let i = 0; i < 25; i++) {
    recordUsage({
      at: Date.now() - ((i * 7) % 30) * DAY - (i % 5) * HOUR,
      kind: i % 3 === 0 ? "interview" : "coach",
      preview: i === 4 ? null : USAGE_PREVIEWS[i % USAGE_PREVIEWS.length],
      model: "claude-sonnet-5-5",
      inputTokens: 900 + i * 40,
      outputTokens: 300 + i * 12,
      cacheReadTokens: 600 + i * 20,
      cacheWriteTokens: i % 4 === 0 ? 1200 : 0,
      costUsd: Number((0.004 + ((i * 0.0137) % 0.056)).toFixed(4)),
      durationMs: 4000 + i * 230,
      ok: i !== 7,
    });
  }
  for (let i = 0; i < 12; i++) {
    recordUsage({
      at: Date.now() - ((i * 11) % 30) * DAY - i * HOUR,
      kind: "screen",
      preview: null,
      model: "jev-latest",
      inputTokens: 640,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 640 * 0.042e-6,
      durationMs: 310 + i * 20,
      ok: true,
    });
  }

  const usageTotals = (rows: UsageCall[]): UsageTotals => {
    const claude = rows.filter((r) => r.kind !== "screen");
    return {
      claudeCalls: claude.length,
      jevCalls: rows.length - claude.length,
      costUsd: claude.reduce((n, r) => n + (r.costUsd ?? 0), 0),
      inputTokens: claude.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: claude.reduce((n, r) => n + r.outputTokens, 0),
      cacheTokens: claude.reduce((n, r) => n + r.cacheReadTokens + r.cacheWriteTokens, 0),
    };
  };

  const spending = (): Spending => {
    // Local day keys for the last 30 days, oldest first. Same-format keys compare in date order.
    const keys: string[] = [];
    for (let n = 29; n >= 0; n--) {
      const d = new Date();
      d.setDate(d.getDate() - n);
      keys.push(localDay(d.getTime()));
    }
    const dayOf = (r: UsageCall) => localDay(r.at);
    const days: DayCost[] = keys.map((day) => {
      const t = usageTotals(usage.filter((r) => dayOf(r) === day));
      return { day, costUsd: t.costUsd, claudeCalls: t.claudeCalls, jevCalls: t.jevCalls };
    });
    const byKind: KindCost[] = (["coach", "interview", "screen"] as UsageKind[]).map((kind) => {
      const rows = usage.filter((r) => r.kind === kind);
      return { kind, calls: rows.length, costUsd: rows.reduce((n, r) => n + (r.costUsd ?? 0), 0) };
    });
    return {
      today: usageTotals(usage.filter((r) => dayOf(r) === keys[keys.length - 1])),
      week: usageTotals(usage.filter((r) => dayOf(r) >= keys[keys.length - 7])),
      month: usageTotals(usage.filter((r) => dayOf(r) >= keys[0])),
      allTime: usageTotals(usage),
      days,
      byKind,
      recent: usage
        .filter((r) => r.kind !== "screen")
        .sort((a, b) => b.at - a.at)
        .slice(0, 100)
        .map((r) => ({ ...r })),
      since: usage.length ? Math.min(...usage.map((r) => r.at)) : null,
    };
  };

  const runPipeline = async () => {
    running = true;
    const progress = (phase: RunPhase, done: number, total: number) => emit("run-progress", { phase, done, total, message: null } satisfies RunProgress);
    const startedAt = Date.now();
    progress("ingest", 0, 1);
    await sleep(500);
    progress("ingest", 1, 1);
    const pending = messages.filter((m) => !m.screen);
    for (const [i, m] of pending.entries()) {
      await sleep(700);
      m.screen = PENDING_SCREEN[m.id] ?? screen(2.5, "none");
      progress("screen", i + 1, pending.length);
    }
    running = false;
    lastRun = { day: localDay(startedAt), startedAt, finishedAt: Date.now(), ok: true, detail: `Screened ${pending.length}` };
    emit("messages-changed", undefined);
    progress("done", pending.length, pending.length);
  };

  // Progress: fixed weeks, oldest first (Mondays from 2026-09-15 to 2026-11-03).
  const PROGRESS_WEEKS: ProgressWeek[] = [
    { week: "2026-09-15", screened: 24, firstDraft: 1.4, afterRetries: 2.8, retried: 3 },
    { week: "2026-09-22", screened: 31, firstDraft: 1.5, afterRetries: 2.9, retried: 6 },
    { week: "2026-09-29", screened: 27, firstDraft: 1.4, afterRetries: 2.8, retried: 5 },
    { week: "2026-10-06", screened: 35, firstDraft: 1.7, afterRetries: null, retried: 0 },
    { week: "2026-10-13", screened: 29, firstDraft: 1.8, afterRetries: 2.9, retried: 4 },
    { week: "2026-10-20", screened: 33, firstDraft: 1.7, afterRetries: 3.0, retried: 8 },
    { week: "2026-10-27", screened: 38, firstDraft: 2.0, afterRetries: 2.9, retried: 6 },
    { week: "2026-11-03", screened: 26, firstDraft: 2.2, afterRetries: 3.0, retried: 5 },
  ];
  const PROGRESS_SLIPS: SlipRow[] = [
    { issue: "register", now: 7, before: 7 },
    { issue: "grammar", now: 3, before: 9 },
    { issue: "pt_calque", now: 0, before: 4 },
  ];
  const progressReport = (weeks: number): Progress => ({
    weeks: (weeks > 0 ? PROGRESS_WEEKS.slice(-weeks) : PROGRESS_WEEKS).map((w) => ({ ...w })),
    slips: PROGRESS_SLIPS.map((s) => ({ ...s })),
    goal: 2.5,
  });

  // Re-tests: kept in memory. A re-test is due once `dueAt` has passed and it is not answered (`doneAt`).
  let retestSeq = 1;
  const retests: Retest[] = [
    {
      id: retestSeq++,
      messageId: "m-deploy",
      idea: "Ask Claude to look into deployment options. The answer is needed by tomorrow.",
      step: 1,
      dueAt: Date.now() - HOUR,
      originalScore: 1.2,
      settledScore: 2.4,
      doneAt: null,
      text: null,
      screen: null,
    },
    {
      id: retestSeq++,
      messageId: "m-release",
      idea: "Tell the team the release is on Friday, so they can plan around it.",
      step: 1,
      dueAt: Date.now() + 2 * DAY,
      originalScore: 1.1,
      settledScore: null,
      doneAt: null,
      text: null,
      screen: null,
    },
    {
      id: retestSeq++,
      messageId: "m-pr",
      idea: "Ask a colleague to review the PR when they have a spare moment.",
      step: 1,
      dueAt: Date.now() + 6 * DAY,
      originalScore: 1.9,
      settledScore: null,
      doneAt: null,
      text: null,
      screen: null,
    },
  ];
  const findRetest = (id: unknown) => {
    const r = retests.find((x) => x.id === id && x.doneAt === null);
    if (!r) throw new Error(`mock: no open re-test ${String(id)}`);
    return r;
  };
  const retestQueue = (): RetestQueue => {
    const now = Date.now();
    const open = retests.filter((r) => r.doneAt === null).sort((a, b) => a.dueAt - b.dueAt);
    const dueNow = open.filter((r) => r.dueAt <= now);
    return {
      due: dueNow[0] ? { ...dueNow[0] } : null,
      dueCount: dueNow.length,
      upcoming: open.filter((r) => r.dueAt > now).slice(0, 5).map((r) => ({ ...r })),
    };
  };

  const commands: Record<string, (a: Record<string, unknown>) => unknown> = {
    overview,
    progress: (a) => progressReport(Number(a.weeks)),
    retest_queue: retestQueue,
    save_retest: (a) => {
      const r = findRetest(a.id);
      const text = String(a.text).trim();
      if (!text) throw "Write your version first";
      r.text = text;
      r.screen = screen(2.4, "none");
      r.doneAt = Date.now();
      return { ...r };
    },
    postpone_retest: (a) => {
      findRetest(a.id).dueAt = Date.now() + DAY;
    },
    list_messages: async (a) => (await sleep(150), list(a.query as MessageQuery)),
    get_message: (a) => {
      const m = messages.find((x) => x.id === a.id);
      if (!m) throw new Error("That message no longer exists");
      return structuredClone(m);
    },
    coach_message: async (a) => {
      await sleep(1500);
      const m = find(a.id);
      const latest = lastAttempt(m);
      if (!latest) throw new Error("Write your version first");
      const c = COACH[m.id];
      if (!c) throw new Error("mock: no coaching written for this message");
      const reviewed: Coaching = { ...c, createdAt: Date.now(), costUsd: 0.0187 };
      latest.coaching = reviewed;
      syncCoaching(m);
      recordUsage({
        at: Date.now(),
        kind: "coach",
        preview: m.text.slice(0, 80),
        model: "claude-sonnet-5-5",
        inputTokens: 1380,
        outputTokens: 410,
        cacheReadTokens: 860,
        cacheWriteTokens: 0,
        costUsd: 0.0187,
        durationMs: 6200,
        ok: true,
      });
      return reviewed;
    },
    save_attempt: (a) => {
      const m = find(a.id);
      if (m.attempts.length >= MAX_TRIES) throw new Error(`You already wrote ${MAX_TRIES} versions of this message`);
      const text = String(a.text);
      // Stands in for the Jev score: deterministic, 0 to 3, from the text length.
      const score = Math.min(3, (text.length % 31) / 10);
      const attempt: Attempt = { id: attemptSeq++, text, createdAt: Date.now(), screen: screen(score, "none"), coaching: null };
      m.attempts.push(attempt);
      syncCoaching(m);
      // Reaching the flag threshold counts as reviewed; falling short puts the message back in the queue.
      // The last allowed try settles the message whatever its score.
      const goal = settings.flagThreshold;
      if (score >= goal || m.attempts.length >= MAX_TRIES) {
        if (m.reviewedAt === null) m.reviewedAt = Date.now();
      } else {
        m.reviewedAt = null;
      }
      recordUsage({
        at: Date.now(),
        kind: "screen",
        preview: null,
        model: "jev-latest",
        inputTokens: 640,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 640 * 0.042e-6,
        durationMs: 310,
        ok: true,
      });
      return attempt;
    },
    mark_reviewed: (a) => {
      find(a.id).reviewedAt = a.reviewed ? Date.now() : null;
      emit("messages-changed", undefined);
    },
    set_excluded: (a) => {
      find(a.id).excludedAt = a.excluded ? Date.now() : null;
      emit("messages-changed", undefined);
    },
    patterns,
    spending,
    get_settings: () => ({ ...settings }),
    set_settings: (a) => {
      settings = { ...(a.settings as Settings) };
      emit("messages-changed", undefined);
      return { ...settings };
    },
    get_glossary: () => glossary,
    set_glossary: (a) => {
      glossary = String(a.glossary).trim();
      return glossary;
    },
    typesafe_key_source: () => keySource,
    set_typesafe_key: (a) => {
      if (!String(a.key).trim()) throw "Paste your TypeSafe API key first";
      keySource = "app";
      return keySource;
    },
    clear_typesafe_key: () => {
      keySource = "none";
      return keySource;
    },
    run_now: () => {
      if (!running) void runPipeline();
    },
    interview_questions: () => questions.map((q) => ({ ...q })),
    next_interview_question: (a) => {
      const pool = questions.filter((q) => (a.topic === null || q.topic === a.topic) && q.id !== a.exclude);
      const pick = [...(pool.length ? pool : questions.filter((q) => a.topic === null || q.topic === a.topic))].sort(
        (x, y) => questionKey(x) - questionKey(y) || x.id - y.id,
      )[0];
      if (!pick) throw new Error("mock: no question for this topic");
      return { ...pick };
    },
    add_interview_question: (a) => {
      const text = String(a.text).trim();
      if (!text) throw new Error("The question is empty");
      const q: InterviewQuestion = { id: questionSeq++, topic: a.topic as InterviewTopic, text, custom: true, answers: 0, lastAnsweredAt: null, bestDepth: null };
      questions.push(q);
      return { ...q };
    },
    delete_interview_question: (a) => {
      const q = findQuestion(a.id);
      if (!q.custom) throw new Error("Only custom questions can be deleted");
      questions.splice(questions.indexOf(q), 1);
      for (let i = answers.length - 1; i >= 0; i--) if (answers[i].questionId === q.id) answers.splice(i, 1);
    },
    save_interview_answer: (a) => {
      const q = findQuestion(a.questionId);
      const answer: InterviewAnswer = {
        id: answerSeq++,
        questionId: q.id,
        text: String(a.text),
        seconds: Number(a.seconds),
        createdAt: Date.now(),
        screen: null,
        feedback: null,
      };
      answers.push(answer);
      refreshQuestion(q);
      return { ...answer };
    },
    review_interview_answer: async (a) => {
      await sleep(2500);
      const answer = findAnswer(a.id);
      if (answer.feedback && !a.force) return { ...answer };
      const words = wordCount(answer.text);
      answer.screen = SETUP_MISSING ? null : screen(Math.min(3, 0.8 + words / 40), words > 40 ? "none" : "grammar");
      const q = findQuestion(answer.questionId);
      answer.feedback = { ...FEEDBACKS[q.id % FEEDBACKS.length], depth: Math.min(5, 1 + Math.floor(words / 25)), createdAt: Date.now() };
      refreshQuestion(q);
      return { ...answer };
    },
    interview_answers: (a) =>
      answers
        .filter((x) => a.questionId === null || x.questionId === a.questionId)
        .sort((x, y) => y.createdAt - x.createdAt)
        .slice(0, Number(a.limit)),
  };

  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (fn: Handler) => {
      const id = cb++;
      callbacks.set(id, fn);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === "plugin:event|listen") {
        const handlers = listeners.get(args.event as string) ?? [];
        handlers.push(callbacks.get(args.handler as number)!);
        listeners.set(args.event as string, handlers);
        return cb++;
      }
      if (cmd.startsWith("plugin:event|")) return undefined;
      if (cmd.startsWith("plugin:window|")) return cmd.endsWith("|is_maximized") ? false : undefined;
      const fn = commands[cmd];
      if (!fn) throw new Error(`mock: unknown command ${cmd}`);
      return fn(args);
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
}
