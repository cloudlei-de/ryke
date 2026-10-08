import type { Policy } from "./types";

export const DEFAULT_POLICY: Policy = {
  protected: ["ryke.json"],
  union: [],
  verify: "true",
  verifyTimeoutSeconds: 120,
  human: [],
  trainMax: 8,
};

export class PolicyError extends Error {}

// Paths arrive from agents, hooks and git; one canonical form keeps validation literal (V6).
export function normalizePath(input: string): string {
  const parts: string[] = [];
  for (const seg of input.replaceAll("\\", "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) throw new PolicyError(`path escapes the repo: ${input}`);
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (parts.length === 0) throw new PolicyError(`empty path: ${JSON.stringify(input)}`);
  return parts.join("/");
}

export function matchGlob(pattern: string, path: string): boolean {
  return matchSegments(pattern.split("/"), 0, path.split("/"), 0);
}

function matchSegments(pat: string[], pi: number, segs: string[], si: number): boolean {
  if (pi === pat.length) return si === segs.length;
  const p = pat[pi]!;
  if (p === "**") {
    for (let k = si; k <= segs.length; k++) if (matchSegments(pat, pi + 1, segs, k)) return true;
    return false;
  }
  if (si === segs.length) return false;
  return matchSegment(p, segs[si]!) && matchSegments(pat, pi + 1, segs, si + 1);
}

function matchSegment(pattern: string, seg: string): boolean {
  if (!pattern.includes("*")) return pattern === seg;
  const pieces = pattern.split("*");
  const first = pieces[0]!;
  const last = pieces[pieces.length - 1]!;
  if (!seg.startsWith(first) || seg.length < first.length + last.length || !seg.endsWith(last)) return false;
  let at = first.length;
  for (const mid of pieces.slice(1, -1)) {
    const found = seg.indexOf(mid, at);
    if (found < 0 || found + mid.length > seg.length - last.length) return false;
    at = found + mid.length;
  }
  return true;
}

export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}

// Patterns are matched against normalised paths, so they are normalised too: `./test/**` and
// `test/` must protect test/, not silently match nothing.
function normalizePattern(p: string, key: string): string {
  const dir = /[\\/]$/.test(p);
  const trimmed = p.replace(/^(\.\/|\/)+/, "").replace(/[\\/]+$/, "");
  if (trimmed === "" || trimmed === ".") throw new PolicyError(`${key} has an empty pattern`);
  const segs = trimmed.replaceAll("\\", "/").split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) throw new PolicyError(`${key} pattern escapes the repo: ${p}`);
  const norm = segs.join("/");
  return dir ? `${norm}/**` : norm;
}

function stringList(v: unknown, key: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === ""))
    throw new PolicyError(`${key} must be a list of non-empty strings`);
  return (v as string[]).map((p) => normalizePattern(p, key));
}

export function parsePolicy(text: string | null): Policy {
  if (text === null) return { ...DEFAULT_POLICY };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PolicyError("ryke.json is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new PolicyError("ryke.json must be an object");
  const o = raw as Record<string, unknown>;
  const protectedPaths = stringList(o.protected, "protected");
  // The policy file guards itself: without this an agent could unprotect tests in one transaction.
  if (!protectedPaths.includes("ryke.json")) protectedPaths.push("ryke.json");
  const policy: Policy = {
    protected: protectedPaths,
    union: stringList(o.union, "union"),
    verify: DEFAULT_POLICY.verify,
    verifyTimeoutSeconds: DEFAULT_POLICY.verifyTimeoutSeconds,
    human: stringList(o.human, "human"),
    trainMax: DEFAULT_POLICY.trainMax,
  };
  if (o.verify !== undefined) {
    if (typeof o.verify !== "string" || o.verify.trim() === "") throw new PolicyError("verify must be a non-empty command");
    policy.verify = o.verify;
  }
  if (o.verifyTimeoutSeconds !== undefined) {
    const n = o.verifyTimeoutSeconds;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) throw new PolicyError("verifyTimeoutSeconds must be positive");
    policy.verifyTimeoutSeconds = n;
  }
  if (o.trainMax !== undefined) {
    const n = o.trainMax;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 64) throw new PolicyError("trainMax must be an integer 1..64");
    policy.trainMax = n;
  }
  if (o.preview !== undefined) {
    const p = o.preview as Record<string, unknown> | null;
    if (typeof p !== "object" || p === null || typeof p.main !== "string") throw new PolicyError("preview.main must be a string");
    policy.preview = { main: p.main };
  }
  return policy;
}
