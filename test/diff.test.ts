import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/shared/diff";

// Lines joined the way a file stores them: every line, the last one included, ends in "\n".
const text = (...lines: string[]) => lines.map((l) => `${l}\n`).join("");

type GitFixture = {
  name: string;
  path: string;
  context: number;
  before: string | null;
  after: string | null;
  expected: string;
};

const FORMAT = [
  'import { convert } from "./convert";',
  'import { units } from "./units";',
  "",
  'export type Category = "length" | "mass" | "temperature";',
  "",
  "export function format(value: number, unit: string): string {",
  "  const rounded = Math.round(value * 100) / 100;",
  '  return rounded + " " + unit;',
  "}",
  "",
  "export function list(category: Category): string[] {",
  "  return units[category].map((u) => u.name);",
  "}",
  "",
  "export function run(category: Category, from: string, to: string, value: number): string {",
  "  const result = convert(category, from, to, value);",
  "  return format(result, to);",
  "}",
];
const NUMS = Array.from({ length: 30 }, (_, i) => `l${String(i + 1).padStart(2, "0")}`);
const replaced = (lines: string[], at: Record<number, string>) => lines.map((l, i) => at[i] ?? l);
const spliced = (lines: string[], start: number, remove: number, ...add: string[]) => {
  const copy = [...lines];
  copy.splice(start, remove, ...add);
  return copy;
};

// Every `expected` below is the output of `git diff -U<context>` on the same two files, with the
// `index` line removed (blob ids are unknown to Ryke) and git's function-name suffix after the hunk
// header switched off through a diff driver whose xfuncname never matches. Regenerate them the same
// way instead of editing them by hand.
const GIT_FIXTURES: GitFixture[] = [
  {
    name: "one replaced line in the middle",
    path: "src/format.ts",
    context: 3,
    before: text(...FORMAT),
    after: text(...replaced(FORMAT, { 6: "  const rounded = Math.round(value * 1000) / 1000;" })),
    expected: text(
      "diff --git a/src/format.ts b/src/format.ts",
      "--- a/src/format.ts",
      "+++ b/src/format.ts",
      "@@ -4,7 +4,7 @@",
      " export type Category = \"length\" | \"mass\" | \"temperature\";",
      " ",
      " export function format(value: number, unit: string): string {",
      "-  const rounded = Math.round(value * 100) / 100;",
      "+  const rounded = Math.round(value * 1000) / 1000;",
      "   return rounded + \" \" + unit;",
      " }",
      " ",
    ),
  },
  {
    name: "same change with one line of context",
    path: "src/format.ts",
    context: 1,
    before: text(...FORMAT),
    after: text(...replaced(FORMAT, { 6: "  const rounded = Math.round(value * 1000) / 1000;" })),
    expected: text(
      "diff --git a/src/format.ts b/src/format.ts",
      "--- a/src/format.ts",
      "+++ b/src/format.ts",
      "@@ -6,3 +6,3 @@",
      " export function format(value: number, unit: string): string {",
      "-  const rounded = Math.round(value * 100) / 100;",
      "+  const rounded = Math.round(value * 1000) / 1000;",
      "   return rounded + \" \" + unit;",
    ),
  },
  {
    name: "two distant hunks",
    path: "src/format.ts",
    context: 3,
    before: text(...FORMAT),
    after: text(...replaced(FORMAT, { 3: 'export type Category = "length" | "mass" | "speed" | "temperature";', 16: "  return format(result, to).trim();" })),
    expected: text(
      "diff --git a/src/format.ts b/src/format.ts",
      "--- a/src/format.ts",
      "+++ b/src/format.ts",
      "@@ -1,7 +1,7 @@",
      " import { convert } from \"./convert\";",
      " import { units } from \"./units\";",
      " ",
      "-export type Category = \"length\" | \"mass\" | \"temperature\";",
      "+export type Category = \"length\" | \"mass\" | \"speed\" | \"temperature\";",
      " ",
      " export function format(value: number, unit: string): string {",
      "   const rounded = Math.round(value * 100) / 100;",
      "@@ -14,5 +14,5 @@",
      " ",
      " export function run(category: Category, from: string, to: string, value: number): string {",
      "   const result = convert(category, from, to, value);",
      "-  return format(result, to);",
      "+  return format(result, to).trim();",
      " }",
    ),
  },
  {
    name: "changes six lines apart merge, seven apart do not",
    path: "numbers.txt",
    context: 3,
    before: text(...NUMS),
    after: text(...replaced(NUMS, { 2: "L03", 9: "L10", 17: "L18" })),
    expected: text(
      "diff --git a/numbers.txt b/numbers.txt",
      "--- a/numbers.txt",
      "+++ b/numbers.txt",
      "@@ -1,13 +1,13 @@",
      " l01",
      " l02",
      "-l03",
      "+L03",
      " l04",
      " l05",
      " l06",
      " l07",
      " l08",
      " l09",
      "-l10",
      "+L10",
      " l11",
      " l12",
      " l13",
      "@@ -15,7 +15,7 @@",
      " l15",
      " l16",
      " l17",
      "-l18",
      "+L18",
      " l19",
      " l20",
      " l21",
    ),
  },
  {
    name: "delete at start, last line loses its newline",
    path: "notes.txt",
    context: 3,
    before: text("one", "two", "three", "four"),
    after: "two\nthree\nfour-edited",
    expected: text(
      "diff --git a/notes.txt b/notes.txt",
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,4 +1,3 @@",
      "-one",
      " two",
      " three",
      "-four",
      "+four-edited",
      "\\ No newline at end of file",
    ),
  },
  {
    name: "last line gains its newline",
    path: "notes.txt",
    context: 3,
    before: "one\ntwo\nthree",
    after: text("one", "two", "three"),
    expected: text(
      "diff --git a/notes.txt b/notes.txt",
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      " two",
      "-three",
      "\\ No newline at end of file",
      "+three",
    ),
  },
  {
    name: "append to a path with a space",
    path: "docs/read me.md",
    context: 3,
    before: text("# Title", "", "Body"),
    after: text("# Title", "", "Body", "More"),
    expected: text(
      "diff --git a/docs/read me.md b/docs/read me.md",
      "--- a/docs/read me.md\t",
      "+++ b/docs/read me.md\t",
      "@@ -1,3 +1,4 @@",
      " # Title",
      " ",
      " Body",
      "+More",
    ),
  },
  {
    name: "new file",
    path: "src/new.ts",
    context: 3,
    before: null,
    after: text("export const a = 1;", "export const b = 2;"),
    expected: text(
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const a = 1;",
      "+export const b = 2;",
    ),
  },
  {
    name: "deleted file",
    path: "src/old.ts",
    context: 3,
    before: text("export const a = 1;", "export const b = 2;"),
    after: null,
    expected: text(
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-export const a = 1;",
      "-export const b = 2;",
    ),
  },
  {
    name: "new empty file",
    path: "empty.txt",
    context: 3,
    before: null,
    after: "",
    expected: text(
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
    ),
  },
  {
    name: "deleted empty file",
    path: "empty.txt",
    context: 3,
    before: "",
    after: null,
    expected: text(
      "diff --git a/empty.txt b/empty.txt",
      "deleted file mode 100644",
    ),
  },
  {
    name: "empty file gains content",
    path: "empty.txt",
    context: 3,
    before: "",
    after: text("first"),
    expected: text(
      "diff --git a/empty.txt b/empty.txt",
      "--- a/empty.txt",
      "+++ b/empty.txt",
      "@@ -0,0 +1 @@",
      "+first",
    ),
  },
  {
    name: "file emptied",
    path: "empty.txt",
    context: 3,
    before: text("first", "second"),
    after: "",
    expected: text(
      "diff --git a/empty.txt b/empty.txt",
      "--- a/empty.txt",
      "+++ b/empty.txt",
      "@@ -1,2 +0,0 @@",
      "-first",
      "-second",
    ),
  },
  {
    name: "CRLF lines pass through",
    path: "win.txt",
    context: 3,
    before: "a\r\nb\r\nc\r\n",
    after: "a\r\nB\r\nc\r\n",
    expected: text(
      "diff --git a/win.txt b/win.txt",
      "--- a/win.txt",
      "+++ b/win.txt",
      "@@ -1,3 +1,3 @@",
      " a\r",
      "-b\r",
      "+B\r",
      " c\r",
    ),
  },
  {
    name: "pure insert in the middle",
    path: "mid.txt",
    context: 3,
    before: text(...NUMS.slice(0, 12)),
    after: text(...spliced(NUMS.slice(0, 12), 6, 0, "inserted")),
    expected: text(
      "diff --git a/mid.txt b/mid.txt",
      "--- a/mid.txt",
      "+++ b/mid.txt",
      "@@ -4,6 +4,7 @@",
      " l04",
      " l05",
      " l06",
      "+inserted",
      " l07",
      " l08",
      " l09",
    ),
  },
  {
    name: "pure delete in the middle",
    path: "mid.txt",
    context: 3,
    before: text(...NUMS.slice(0, 12)),
    after: text(...spliced(NUMS.slice(0, 12), 6, 2)),
    expected: text(
      "diff --git a/mid.txt b/mid.txt",
      "--- a/mid.txt",
      "+++ b/mid.txt",
      "@@ -4,8 +4,6 @@",
      " l04",
      " l05",
      " l06",
      "-l07",
      "-l08",
      " l09",
      " l10",
      " l11",
    ),
  },
  {
    name: "pure insert at start",
    path: "mid.txt",
    context: 3,
    before: text(...NUMS.slice(0, 10)),
    after: text("inserted", ...NUMS.slice(0, 10)),
    expected: text(
      "diff --git a/mid.txt b/mid.txt",
      "--- a/mid.txt",
      "+++ b/mid.txt",
      "@@ -1,3 +1,4 @@",
      "+inserted",
      " l01",
      " l02",
      " l03",
    ),
  },
  {
    name: "pure insert at end",
    path: "mid.txt",
    context: 3,
    before: text(...NUMS.slice(0, 10)),
    after: text(...NUMS.slice(0, 10), "inserted"),
    expected: text(
      "diff --git a/mid.txt b/mid.txt",
      "--- a/mid.txt",
      "+++ b/mid.txt",
      "@@ -8,3 +8,4 @@",
      " l08",
      " l09",
      " l10",
      "+inserted",
    ),
  },
  {
    name: "pure delete at start",
    path: "mid.txt",
    context: 3,
    before: text(...NUMS.slice(0, 10)),
    after: text(...NUMS.slice(1, 10)),
    expected: text(
      "diff --git a/mid.txt b/mid.txt",
      "--- a/mid.txt",
      "+++ b/mid.txt",
      "@@ -1,4 +1,3 @@",
      "-l01",
      " l02",
      " l03",
      " l04",
    ),
  },
  {
    name: "pure delete at end",
    path: "mid.txt",
    context: 3,
    before: text(...NUMS.slice(0, 10)),
    after: text(...NUMS.slice(0, 9)),
    expected: text(
      "diff --git a/mid.txt b/mid.txt",
      "--- a/mid.txt",
      "+++ b/mid.txt",
      "@@ -7,4 +7,3 @@",
      " l07",
      " l08",
      " l09",
      "-l10",
    ),
  },
  {
    name: "block replaced by a different-sized block",
    path: "mid.txt",
    context: 3,
    before: text("keep", "old one", "old two", "old three", "keep too"),
    after: text("keep", "new one", "new two", "keep too"),
    expected: text(
      "diff --git a/mid.txt b/mid.txt",
      "--- a/mid.txt",
      "+++ b/mid.txt",
      "@@ -1,5 +1,4 @@",
      " keep",
      "-old one",
      "-old two",
      "-old three",
      "+new one",
      "+new two",
      " keep too",
    ),
  },
  {
    name: "line endings only change",
    path: "win.txt",
    context: 3,
    before: "a\r\nb\r\n",
    after: "a\nb\n",
    expected: text(
      "diff --git a/win.txt b/win.txt",
      "--- a/win.txt",
      "+++ b/win.txt",
      "@@ -1,2 +1,2 @@",
      "-a\r",
      "-b\r",
      "+a",
      "+b",
    ),
  },
  {
    name: "zero context",
    path: "mid.txt",
    context: 0,
    before: text(...NUMS.slice(0, 12)),
    after: text(...spliced(replaced(NUMS.slice(0, 12), { 2: "L03" }), 8, 0, "inserted")),
    expected: text(
      "diff --git a/mid.txt b/mid.txt",
      "--- a/mid.txt",
      "+++ b/mid.txt",
      "@@ -3 +3 @@",
      "-l03",
      "+L03",
      "@@ -8,0 +9 @@",
      "+inserted",
    ),
  },
  {
    name: "unchanged last line without newline is context",
    path: "n.txt",
    context: 3,
    before: "a\nb",
    after: "x\nb",
    expected: text(
      "diff --git a/n.txt b/n.txt",
      "--- a/n.txt",
      "+++ b/n.txt",
      "@@ -1,2 +1,2 @@",
      "-a",
      "+x",
      " b",
      "\\ No newline at end of file",
    ),
  },
  {
    name: "changed last line, neither side has the newline",
    path: "n.txt",
    context: 3,
    before: "a\nb",
    after: "a\nc",
    expected: text(
      "diff --git a/n.txt b/n.txt",
      "--- a/n.txt",
      "+++ b/n.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+c",
      "\\ No newline at end of file",
    ),
  },
  {
    name: "single line without newline replaced",
    path: "n.txt",
    context: 3,
    before: "x",
    after: "y",
    expected: text(
      "diff --git a/n.txt b/n.txt",
      "--- a/n.txt",
      "+++ b/n.txt",
      "@@ -1 +1 @@",
      "-x",
      "\\ No newline at end of file",
      "+y",
      "\\ No newline at end of file",
    ),
  },
  {
    name: "new file without trailing newline",
    path: "fresh.txt",
    context: 3,
    before: null,
    after: "a\nb",
    expected: text(
      "diff --git a/fresh.txt b/fresh.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/fresh.txt",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "\\ No newline at end of file",
    ),
  },
  {
    name: "blank line inserted into a blank-only file",
    path: "n.txt",
    context: 3,
    before: "\n",
    after: "\n\n",
    expected: text(
      "diff --git a/n.txt b/n.txt",
      "--- a/n.txt",
      "+++ b/n.txt",
      "@@ -1 +1,2 @@",
      " ",
      "+",
    ),
  },
  {
    name: "nothing in common",
    path: "n.txt",
    context: 3,
    before: text("a", "b"),
    after: text("1", "2"),
    expected: text(
      "diff --git a/n.txt b/n.txt",
      "--- a/n.txt",
      "+++ b/n.txt",
      "@@ -1,2 +1,2 @@",
      "-a",
      "-b",
      "+1",
      "+2",
    ),
  },
  {
    name: "new file at a path with a space",
    path: "my docs/new note.md",
    context: 3,
    before: null,
    after: text("hello"),
    expected: text(
      "diff --git a/my docs/new note.md b/my docs/new note.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/my docs/new note.md\t",
      "@@ -0,0 +1 @@",
      "+hello",
    ),
  },
  {
    name: "deleted file at a path with a space",
    path: "my docs/old note.md",
    context: 3,
    before: text("hello"),
    after: null,
    expected: text(
      "diff --git a/my docs/old note.md b/my docs/old note.md",
      "deleted file mode 100644",
      "--- a/my docs/old note.md\t",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-hello",
    ),
  },
];

describe("unifiedDiff against real git output", () => {
  it.each(GIT_FIXTURES)("$name", ({ path, before, after, context, expected }) => {
    expect(unifiedDiff(path, before, after, context)).toBe(expected);
  });

  it("never emits an index line", () => {
    for (const f of GIT_FIXTURES) {
      expect(unifiedDiff(f.path, f.before, f.after, f.context)).not.toMatch(/^index /m);
    }
  });
});

describe("identical inputs", () => {
  it.each([
    ["empty files", "", ""],
    ["one line", "a\n", "a\n"],
    ["no trailing newline", "a\nb", "a\nb"],
    ["CRLF", "a\r\nb\r\n", "a\r\nb\r\n"],
    ["both absent", null, null],
  ] as [string, string | null, string | null][])("%s give an empty string", (_name, before, after) => {
    expect(unifiedDiff("f.txt", before, after)).toBe("");
  });
});

describe("context and hunk merging", () => {
  const hunkCount = (patch: string) => patch.split("\n").filter((l) => l.startsWith("@@")).length;
  // Two changed lines with `gap` unchanged lines between them.
  const base = Array.from({ length: 40 }, (_, i) => `n${i}`);
  const twoChanges = (gap: number) => [text(...base), text(...replaced(base, { 9: "X", [9 + gap + 1]: "Y" }))] as const;

  // Hunks share context when the unchanged gap is at most twice the context, which is also git's rule.
  it.each([
    { gap: 0, context: 0, hunks: 1 },
    { gap: 1, context: 0, hunks: 2 },
    { gap: 2, context: 1, hunks: 1 },
    { gap: 3, context: 1, hunks: 2 },
    { gap: 5, context: 3, hunks: 1 },
    { gap: 6, context: 3, hunks: 1 },
    { gap: 7, context: 3, hunks: 2 },
    { gap: 20, context: 3, hunks: 2 },
    { gap: 8, context: 4, hunks: 1 },
    { gap: 9, context: 4, hunks: 2 },
  ])("gap $gap with context $context gives $hunks hunk(s)", ({ gap, context, hunks }) => {
    const [before, after] = twoChanges(gap);
    expect(hunkCount(unifiedDiff("f.txt", before, after, context))).toBe(hunks);
  });

  it("uses 3 lines of context by default", () => {
    const [before, after] = twoChanges(10);
    expect(unifiedDiff("f.txt", before, after)).toBe(unifiedDiff("f.txt", before, after, 3));
    expect(unifiedDiff("f.txt", before, after)).not.toBe(unifiedDiff("f.txt", before, after, 1));
  });

  it("treats a negative context as none", () => {
    const [before, after] = twoChanges(10);
    expect(unifiedDiff("f.txt", before, after, -2)).toBe(unifiedDiff("f.txt", before, after, 0));
  });
});

describe("large inputs", () => {
  const numbered = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i}`);
  const header = (path: string) => text(`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`);

  it("replaces the whole file in one hunk above 5000 lines", () => {
    const before = numbered(5001);
    const after = replaced(before, { 2500: "changed" });
    expect(unifiedDiff("big.txt", text(...before), text(...after))).toBe(
      header("big.txt") + "@@ -1,5001 +1,5001 @@\n" + text(...before.map((l) => `-${l}`), ...after.map((l) => `+${l}`)),
    );
  });

  it("applies the limit when only the old side is over it", () => {
    const before = numbered(5001);
    expect(unifiedDiff("big.txt", text(...before), text("a", "b", "c"))).toBe(
      header("big.txt") + "@@ -1,5001 +1,3 @@\n" + text(...before.map((l) => `-${l}`), "+a", "+b", "+c"),
    );
  });

  it("applies the limit when only the new side is over it", () => {
    const after = numbered(5001);
    expect(unifiedDiff("big.txt", text("a", "b", "c"), text(...after))).toBe(
      header("big.txt") + "@@ -1,3 +1,5001 @@\n" + text("-a", "-b", "-c", ...after.map((l) => `+${l}`)),
    );
  });

  it("still diffs line by line at exactly 5000 lines", () => {
    const before = numbered(5000);
    const after = replaced(before, { 2499: "changed" });
    expect(unifiedDiff("big.txt", text(...before), text(...after))).toBe(
      header("big.txt") +
        "@@ -2497,7 +2497,7 @@\n" +
        text(" line 2496", " line 2497", " line 2498", "-line 2499", "+changed", " line 2500", " line 2501", " line 2502"),
    );
  });

  // The middle of both files shares one "KEEP" line, so a minimal diff keeps it as context while a
  // wholesale replacement has to delete and re-add it. That tells the two behaviours apart.
  const sandwich = (n: number, tag: string) => [...numbered(n, `${tag}-u`), "KEEP", ...numbered(n, `${tag}-v`)];

  it("keeps the shared line when the edit distance is within reach", () => {
    const patch = unifiedDiff(
      "f.txt",
      text("top", ...sandwich(400, "old"), "bottom"),
      text("top", ...sandwich(400, "new"), "bottom"),
    );
    expect(patch).toContain("\n KEEP\n");
    expect(patch).not.toContain("-KEEP\n");
    expect(patch).not.toContain("+KEEP\n");
  });

  it("replaces the changed region, keeping the common ends, when the edit distance is too large", () => {
    const patch = unifiedDiff(
      "f.txt",
      text("top", ...sandwich(1100, "old"), "bottom"),
      text("top", ...sandwich(1100, "new"), "bottom"),
    );
    // 1 line of context above, 2201 replaced lines, 1 line of context below.
    expect(patch).toContain("@@ -1,2203 +1,2203 @@\n");
    expect(patch).toContain("\n top\n-old-u 0\n");
    expect(patch).toContain("-old-v 1099\n+new-u 0\n");
    expect(patch).toContain("+new-v 1099\n bottom\n");
    expect(patch).toContain("-KEEP\n");
    expect(patch).toContain("+KEEP\n");
    expect(patch).not.toContain("\n KEEP\n");
  });
});

// A reader of the patch, independent of the implementation: it checks every context and removed
// line against the old text, the hunk counts against the header, and rebuilds the new text.
function splitLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function applyPatch(before: string, patch: string) {
  expect(patch.endsWith("\n")).toBe(true);
  const rows = patch.split("\n").slice(0, -1);
  const old = splitLines(before);
  const out: string[] = [];
  let pos = 0;
  let removed = 0;
  let added = 0;
  for (let i = 0; i < rows.length; ) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(rows[i]!);
    if (!head) {
      i++;
      continue;
    }
    const oldCount = head[2] === undefined ? 1 : Number(head[2]);
    const newCount = head[4] === undefined ? 1 : Number(head[4]);
    // An empty old range names the line before it, so its number is already a 0-based offset.
    const start = oldCount === 0 ? Number(head[1]) : Number(head[1]) - 1;
    expect(start).toBeGreaterThanOrEqual(pos);
    out.push(...old.slice(pos, start));
    pos = start;
    let seenOld = 0;
    let seenNew = 0;
    for (i++; i < rows.length && !rows[i]!.startsWith("@@"); i++) {
      const row = rows[i]!;
      if (row.startsWith("\\")) continue;
      const line = row.slice(1) + (rows[i + 1]?.startsWith("\\") ? "" : "\n");
      if (row[0] !== "+") {
        expect(old[pos]).toBe(line);
        pos++;
        seenOld++;
      }
      if (row[0] !== "-") {
        out.push(line);
        seenNew++;
      }
      if (row[0] === "-") removed++;
      if (row[0] === "+") added++;
    }
    expect([seenOld, seenNew]).toEqual([oldCount, newCount]);
  }
  out.push(...old.slice(pos));
  return { result: out.join(""), removed, added };
}

function lcsLength(a: string[], b: string[]): number {
  let prev: number[] = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const cur = [0];
    for (let j = 0; j < b.length; j++) cur.push(x === b[j] ? prev[j]! + 1 : Math.max(prev[j + 1]!, cur[j]!));
    prev = cur;
  }
  return prev[b.length]!;
}

describe("random pairs", () => {
  // Fixed seed so a failure reproduces. The alphabet is tiny on purpose: repeated lines make the
  // shortest edit script ambiguous, which is where an off-by-one in the backtracking would show.
  let seed = 20261008;
  const next = (n: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * n);
  };
  const ALPHABET = ["a", "b", "c", "", "}", "  d"];
  const randomText = (lines: string[]) => lines.join("\n") + (lines.length > 0 && next(5) > 0 ? "\n" : "");

  it("yields a shortest patch that applies back to the new text, at every context size", () => {
    let checked = 0;
    for (let i = 0; i < 600; i++) {
      const oldLines = Array.from({ length: next(31) }, () => ALPHABET[next(ALPHABET.length)]!);
      const newLines = [...oldLines];
      for (let e = next(7); e > 0; e--) {
        const at = next(newLines.length + 1);
        const op = next(3);
        if (op === 0) newLines.splice(at, 0, ALPHABET[next(ALPHABET.length)]!);
        else if (op === 1) newLines.splice(at, 1);
        else newLines.splice(at, 1, ALPHABET[next(ALPHABET.length)]!);
      }
      const before = randomText(oldLines);
      const after = randomText(newLines);
      if (before === after) continue;
      checked++;

      const context = next(5);
      const patch = unifiedDiff("f.txt", before, after, context);
      const label = JSON.stringify({ before, after, context });
      const applied = applyPatch(before, patch);
      expect(applied.result, label).toBe(after);
      // Lines compare with their newline, so "b" and "b\n" at the end of a file are different lines.
      const a = splitLines(before);
      const b = splitLines(after);
      expect(applied.removed + applied.added, label).toBe(a.length + b.length - 2 * lcsLength(a, b));
    }
    expect(checked).toBeGreaterThan(500);
  });
});
