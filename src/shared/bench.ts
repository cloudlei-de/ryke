// The shape of `bench/results/latest.json` (PLAN.md §11.3). The bench harness writes it, the Worker
// serves it at GET /api/bench and the dashboard's Bench view reads it, so all three agree on one type.

export const POLICIES = ["lock", "queue", "ryke"] as const;
export type BenchPolicy = (typeof POLICIES)[number];

export type BenchCell = {
  policy: BenchPolicy;
  agents: number;
  landed: number;
  landedPerMinute: number;
  // Begin to land, in seconds.
  p50: number;
  p95: number;
  // Aborted attempts by cause, e.g. { stale_read: 12, failed_verify: 3 }.
  aborts: Record<string, number>;
  verifyRunsPerLanded: number;
  // Think time of attempts that did not land.
  wastedAgentSeconds: number;
  // Must be 0 for every policy; the harness asserts it.
  trunkBreakages: number;
};

export type BenchResults = {
  generatedAt: string | null;
  durationSeconds: number;
  // Always true: the agents are scripted, only git, merges and tests are real (PLAN.md §0.10).
  synthetic: true;
  note: string;
  cells: BenchCell[];
};

// Shown on the Bench page whatever the JSON says, so a stale or hand-edited file cannot hide it.
export const BENCH_SYNTHETIC_NOTICE = "Bench agents are synthetic: real git, real merges, real tests, scripted edits.";

const NUMERIC: (keyof BenchCell)[] = [
  "agents",
  "landed",
  "landedPerMinute",
  "p50",
  "p95",
  "verifyRunsPerLanded",
  "wastedAgentSeconds",
  "trunkBreakages",
];

function isCell(v: unknown): v is BenchCell {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  if (!POLICIES.includes(c.policy as BenchPolicy)) return false;
  if (!NUMERIC.every((k) => typeof c[k] === "number" && Number.isFinite(c[k]))) return false;
  const aborts = c.aborts;
  if (typeof aborts !== "object" || aborts === null || Array.isArray(aborts)) return false;
  return Object.values(aborts).every((n) => typeof n === "number" && Number.isFinite(n));
}

// The file is written by another module and fetched over HTTP, so the view checks it rather than trusting a cast.
export function parseBench(json: unknown): BenchResults | null {
  if (typeof json !== "object" || json === null) return null;
  const r = json as Record<string, unknown>;
  if (r.generatedAt !== null && typeof r.generatedAt !== "string") return null;
  if (typeof r.durationSeconds !== "number" || !Number.isFinite(r.durationSeconds)) return null;
  if (r.synthetic !== true) return null;
  if (typeof r.note !== "string") return null;
  if (!Array.isArray(r.cells) || !r.cells.every(isCell)) return null;
  return r as BenchResults;
}
