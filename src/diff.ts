// What changed between two versions of a message, word by word, so a new try can show its edits
// instead of repeating the whole sentence. Pure UI helper: nothing here is stored.

export type DiffPart = { kind: "same" | "add" | "del"; text: string };

// A word (letters, digits, apostrophes, hyphens) or a single punctuation mark, with the whitespace before it.
// "run?" is two tokens, so adding a question mark does not mark the whole word as changed.
const TOKEN = /\s*(?:[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-])/gu;

// The table needs one cell per pair of tokens. Longer texts than this just show without a diff.
const MAX_CELLS = 250_000;

/**
 * The edits that turn `before` into `after`, or null when the texts are too long to compare cheaply
 * or share nothing (a diff of a full rewrite is noise, the plain text reads better).
 */
export function wordDiff(before: string, after: string): DiffPart[] | null {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  if (a.length * b.length > MAX_CELLS) return null;

  const ka = a.map((t) => t.trim());
  const kb = b.map((t) => t.trim());
  const w = b.length + 1;
  // lcs[i * w + j]: longest common run of ka[i..] and kb[j..].
  const lcs = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = ka[i] === kb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (ka[i] === kb[j]) {
      push("same", b[j]);
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      push("del", a[i++]);
    } else {
      push("add", b[j++]);
    }
  }
  while (i < a.length) push("del", a[i++]);
  while (j < b.length) push("add", b[j++]);

  return parts.some((p) => p.kind === "same") ? parts : null;
}
