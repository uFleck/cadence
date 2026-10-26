/* Dev-only stand-in for the Tauri backend, so the UI can be driven in a plain browser (`pnpm dev`).
   Twelve work messages (eight to practise, one reviewed, two not screened yet). A run is simulated and
   emits run-progress and messages-changed like the real one. `?nosetup` shows the missing-key and missing-CLI banners. */
import type { Attempt, Coaching, InterviewAnswer, InterviewFeedback, InterviewQuestion, InterviewTopic, Issue, Message, MessageQuery, Overview, Patterns, RunInfo, RunPhase, RunProgress, Screen, Settings } from "../api";

type Handler = (e: { event: string; id: number; payload: unknown }) => void;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const SETUP_MISSING = location.search.includes("nosetup");

const localDay = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const screen = (naturalness: number, issue: Issue): Screen => ({ english: 0.97, prose: 0.93, naturalness, confidence: 0.86, issue, issueConfidence: 0.8 });

const coach = (issue: Issue, casual: string, professional: string, explanation: string, tip: string): Coaching => ({
  rewrites: [
    { register: "casual", text: casual },
    { register: "professional", text: professional },
  ],
  explanation,
  tip,
  issue,
  createdAt: Date.now(),
});

const COACH: Record<string, Coaching> = {
  "m-report": coach(
    "preposition_collocation",
    "I'll send you the report by the end of the day.",
    "I will send you the report by the end of the day.",
    "'Until' sets a limit you reach and then stop at, but here you mean a deadline. English pairs 'by' with a deadline.",
    "Deadlines take 'by': by the end of the day, by Friday, by noon.",
  ),
  "m-deploy": coach(
    "grammar",
    "Could you check the deploy when you have a moment?",
    "Could you check the deploy when you have time?",
    "'Please' goes straight before the verb, without 'to'. 'Could you' also sounds smoother in a chat.",
    "Use 'please + verb' or 'could you + verb', with no 'to' in between.",
  ),
  "m-proposal": coach(
    "grammar",
    "I agree with the proposal, let's go ahead.",
    "I agree with the proposal. Let's go ahead.",
    "'Agree' is a verb in English, so it takes no 'am'. The slip usually comes from Portuguese 'estou de acordo'.",
    "Say 'I agree', not 'I am agree'. Same for 'I understand', not 'I am understand'.",
  ),
  "m-pr": coach(
    "word_choice",
    "Can you take a look at the PR when you get a chance?",
    "Could you review the PR when you get a chance?",
    "'Give a look' is a literal translation. English says 'take a look' for a quick glance, or 'review' for a real check.",
    "'Take a look' for a quick glance, 'review' for a proper check.",
  ),
  "m-migration": coach(
    "grammar",
    "I ran the migration yesterday and it worked well.",
    "I ran the migration yesterday, and it went through without issues.",
    "A finished action with a time word such as 'yesterday' takes the simple past, not the present perfect.",
    "Yesterday, last week, in 2024: simple past. 'Have done' is for things that still matter now.",
  ),
  "m-release": coach(
    "pt_calque",
    "Just a reminder: the release is on Friday.",
    "A reminder that the release is on Friday.",
    "'Remember someone of something' is Portuguese word order carried into English. In English you remind someone.",
    "Say 'remind you that', not 'remember you that'.",
  ),
  "m-asap": coach(
    "register",
    "Hey, can you check this when you get a chance?",
    "Could you check this when you have a moment?",
    "Chat is informal, but 'dude' and 'asap' read as too casual when you work with clients or managers.",
    "Swap 'asap' for 'when you get a chance' or 'today if possible'.",
  ),
  "m-tests": coach(
    "word_order",
    "The tests are failing again in CI.",
    "The tests are failing again in the CI pipeline.",
    "The subject comes before the verb, and 'the thing is that' adds nothing. Start with the point.",
    "Start with the subject: 'The tests are failing', not 'The thing is that the tests they are failing'.",
  ),
  "m-call": coach(
    "word_choice",
    "Can we find a time later to sync on the roadmap?",
    "Could we set up a call later to sync on the roadmap?",
    "'Make a call' sounds like phoning someone. For a meeting, English says 'have a call' or 'set up a call'.",
    "For meetings: 'set up a call', 'have a call', 'jump on a call'.",
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
  { id: "m-proposal", text: "I am agree with the proposal, let's go ahead.", hours: 9, project: "web-app", screen: screen(1.4, "grammar") },
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
  let running = false;
  let lastRun: RunInfo = {
    day: localDay(Date.now() - DAY),
    startedAt: Date.now() - 20 * HOUR,
    finishedAt: Date.now() - 20 * HOUR + 40_000,
    ok: true,
    detail: "Screened 10, queued 8",
  };

  const messages: Message[] = SEEDS.map((s) => {
    const coaching = s.coached ? COACH[s.id] : null;
    return {
      id: s.id,
      text: s.text,
      ts: Date.now() - s.hours * HOUR,
      project: s.project,
      words: wordCount(s.text),
      source: s.source ?? "transcript",
      screen: s.screen ?? null,
      coaching,
      attempts: (s.attempts ?? []).map((text): Attempt => ({ id: attemptSeq++, text, createdAt: Date.now() - s.hours * HOUR })),
      reviewedAt: s.reviewed ? Date.now() - DAY : null,
    };
  });
  const find = (id: unknown) => {
    const m = messages.find((x) => x.id === id);
    if (!m) throw new Error(`mock: no message ${String(id)}`);
    return m;
  };


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
    !!m.screen && m.screen.english >= 0.5 && m.screen.prose >= 0.5 && m.screen.naturalness < settings.flagThreshold && m.words >= settings.minWords && m.reviewedAt === null;

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
    typesafeConfigured: !SETUP_MISSING,
    claudeFound: !SETUP_MISSING,
  });

  const list = ({ filter, limit, offset }: MessageQuery): Message[] => {
    if (filter === "queue") {
      return messages
        .filter(isQueued)
        .sort((a, b) => (a.screen?.naturalness ?? 0) - (b.screen?.naturalness ?? 0))
        .slice(offset, offset + limit);
    }
    return messages
      .filter((m) => filter === "all" || m.reviewedAt !== null)
      .sort((a, b) => b.ts - a.ts)
      .slice(offset, offset + limit);
  };

  const patterns = (): Patterns => {
    const screened = messages.filter((m): m is Message & { screen: Screen } => m.screen !== null);
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

  const commands: Record<string, (a: Record<string, unknown>) => unknown> = {
    overview,
    list_messages: async (a) => (await sleep(150), list(a.query as MessageQuery)),
    coach_message: async (a) => {
      await sleep(1500);
      const m = find(a.id);
      if (m.attempts.length === 0) throw new Error("Write your version first");
      const c = COACH[m.id];
      if (!c) throw new Error("mock: no coaching written for this message");
      m.coaching = c;
      return c;
    },
    save_attempt: (a) => {
      const attempt: Attempt = { id: attemptSeq++, text: String(a.text), createdAt: Date.now() };
      find(a.id).attempts.push(attempt);
      return attempt;
    },
    mark_reviewed: (a) => {
      find(a.id).reviewedAt = a.reviewed ? Date.now() : null;
      emit("messages-changed", undefined);
    },
    patterns,
    get_settings: () => ({ ...settings }),
    set_settings: (a) => {
      settings = { ...(a.settings as Settings) };
      emit("messages-changed", undefined);
      return { ...settings };
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
