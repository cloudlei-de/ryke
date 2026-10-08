// Unified diff for the stale `delta` of `retry` (PLAN.md §6.1). Output is git-format patch text
// for a single file, without the `index` line (blob ids are not known here) and without git's
// "function name" suffix after the hunk header, which is a per-language heuristic.

// Above this a line diff is not worth the CPU in a Worker request; one hunk that replaces the file
// is still a correct, if blunt, patch.
const MAX_LINES = 5000;
// Myers keeps one trace row per edit, so memory grows with the square of the edit distance. At
// 2000 that is about 16 MB, safe inside a Worker; beyond it the changed middle is replaced whole.
const MAX_EDIT_DISTANCE = 2000;

type Kind = " " | "-" | "+";
type Entry = { kind: Kind; text: string };

export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  if (before === after) return "";

  const a = splitLines(before);
  const b = splitLines(after);

  let out = `diff --git a/${path} b/${path}\n`;
  if (before === null) out += "new file mode 100644\n";
  if (after === null) out += "deleted file mode 100644\n";

  // Git prints no ---/+++ and no hunk when an empty file is created or deleted, because there is
  // no content to anchor them to. `git apply` takes the mode line alone.
  if (a.length === 0 && b.length === 0) return out;

  // Git adds a tab after the name when it contains a space so a patch reader can tell where the
  // name ends. /dev/null never needs one.
  const tab = path.includes(" ") ? "\t" : "";
  out += `--- ${before === null ? "/dev/null" : `a/${path}${tab}`}\n`;
  out += `+++ ${after === null ? "/dev/null" : `b/${path}${tab}`}\n`;

  return out + hunks(edit(a, b), Math.max(0, context));
}

// A line keeps its own "\n". A final line without one then differs from the same text with one,
// exactly as git treats "x" and "x\n" at the end of a file.
function splitLines(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n").map((line, i, all) => (i < all.length - 1 ? `${line}\n` : line));
  // A text ending in "\n" splits into a trailing empty piece that is not a line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function edit(a: string[], b: string[]): Entry[] {
  if (a.length > MAX_LINES || b.length > MAX_LINES) return replaceAll(a, b);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const middle = myers(midA, midB) ?? replaceAll(midA, midB);

  return [
    ...a.slice(0, head).map((text): Entry => ({ kind: " ", text })),
    ...middle,
    ...a.slice(a.length - tail).map((text): Entry => ({ kind: " ", text })),
  ];
}

function replaceAll(a: string[], b: string[]): Entry[] {
  return [...a.map((text): Entry => ({ kind: "-", text })), ...b.map((text): Entry => ({ kind: "+", text }))];
}

// Myers O(ND) shortest edit script. Returns null when the distance exceeds MAX_EDIT_DISTANCE.
function myers(a: string[], b: string[]): Entry[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return replaceAll(a, b);

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is the furthest-reaching x per diagonal k in [-d-1, d+1] before round d, stored at
  // index k + d + 1. Backtracking reads it to recover which move each round took.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], last: number): Entry[] {
  const reversed: Entry[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = last; d >= 0; d--) {
    const row = trace[d]!;
    const at = (k: number) => row[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ kind: " ", text: a[x - 1]! });
      x--;
      y--;
    }
    // Round 0 has no move; its only job was to follow the initial diagonal.
    if (d > 0) reversed.push(down ? { kind: "+", text: b[y - 1]! } : { kind: "-", text: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  return orderChanges(reversed.reverse());
}

// Myers can interleave a delete and an insert inside one changed block. Git always prints the
// block's deletions first, and patch readers expect it, so normalise here.
function orderChanges(entries: Entry[]): Entry[] {
  const out: Entry[] = [];
  let removed: Entry[] = [];
  let added: Entry[] = [];
  const flush = () => {
    out.push(...removed, ...added);
    removed = [];
    added = [];
  };
  for (const e of entries) {
    if (e.kind === " ") {
      flush();
      out.push(e);
    } else if (e.kind === "-") {
      removed.push(e);
    } else {
      added.push(e);
    }
  }
  flush();
  return out;
}

function hunks(entries: Entry[], context: number): string {
  // Number of old/new lines before each entry, to turn entry offsets into line numbers.
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0;
  let w = 0;
  for (const e of entries) {
    oldBefore.push(o);
    newBefore.push(w);
    if (e.kind !== "+") o++;
    if (e.kind !== "-") w++;
  }
  oldBefore.push(o);
  newBefore.push(w);

  const changes: number[] = [];
  for (const [i, e] of entries.entries()) if (e.kind !== " ") changes.push(i);

  // Two changes share a hunk while the unchanged gap between them is at most twice the context,
  // which is when their context windows overlap or touch. Git uses the same rule.
  const groups: [number, number][] = [];
  for (const i of changes) {
    const g = groups[groups.length - 1];
    if (g && i - g[1] - 1 <= 2 * context) g[1] = i;
    else groups.push([i, i]);
  }

  let out = "";
  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(entries.length, last + 1 + context);
    out += `@@ -${range(oldBefore[start]!, oldBefore[end]! - oldBefore[start]!)} +${range(newBefore[start]!, newBefore[end]! - newBefore[start]!)} @@\n`;
    for (const e of entries.slice(start, end)) {
      out += e.kind + (e.text.endsWith("\n") ? e.text : `${e.text}\n\\ No newline at end of file\n`);
    }
  }
  return out;
}

// Git's range format: the count is omitted when it is 1, and an empty range names the line before
// it (0-based start), so a pure insertion after line 2 reads "-2,0".
function range(start0: number, count: number): string {
  if (count === 0) return `${start0},0`;
  return count === 1 ? `${start0 + 1}` : `${start0 + 1},${count}`;
}
