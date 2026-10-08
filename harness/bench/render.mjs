// bench/results/latest.md: the table of every cell, an ASCII chart of landed/min against agents, and the
// caveats. Pure text in, text out.
import { BENCH_POLICIES, POLICIES } from "./metrics.mjs";

const pad = (v, n) => String(v).padEnd(n);
const lpad = (v, n) => String(v).padStart(n);
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
const abortsText = (a) => {
  const parts = Object.entries(a).map(([k, v]) => `${k} ${v}`);
  return parts.length === 0 ? "none" : parts.join(", ");
};

export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => `| ${cells.map((c, i) => pad(c, widths[i])).join(" | ")} |`;
  return [line(headers), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`, ...rows.map(line)].join("\n");
}

// One group of bars per agent count, one bar per policy, scaled to the best cell of the whole run.
export function chart(cells, { width = 48 } = {}) {
  const max = Math.max(...cells.map((c) => c.landedPerMinute), 0);
  const counts = [...new Set(cells.map((c) => c.agents))].sort((a, b) => a - b);
  const label = Math.max(5, ...cells.map((c) => c.policy.length));
  const lines = ["landed per minute (one # is " + fmt(max / width || 0) + ")", ""];
  for (const n of counts) {
    lines.push(`${n} agents`);
    for (const policy of BENCH_POLICIES) {
      const c = cells.find((x) => x.agents === n && x.policy === policy);
      if (!c) continue;
      const bar = max === 0 ? "" : "#".repeat(Math.round((c.landedPerMinute / max) * width));
      lines.push(`  ${pad(policy, label)} |${pad(bar, width)}| ${fmt(c.landedPerMinute)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// Who has the highest landed/min at each agent count, and whether Ryke wins every N of 50 and more.
export function verdict(cells) {
  const counts = [...new Set(cells.map((c) => c.agents))].sort((a, b) => a - b);
  const rows = counts.map((n) => {
    const at = cells.filter((c) => c.agents === n).sort((a, b) => b.landedPerMinute - a.landedPerMinute);
    return { agents: n, best: at[0], rykeFirst: at[0]?.policy === "ryke", ranking: at.map((c) => `${c.policy} ${fmt(c.landedPerMinute)}`).join(" > ") };
  });
  const large = rows.filter((r) => r.agents >= 50);
  return { rows, rykeWinsEveryLarge: large.length > 0 && large.every((r) => r.rykeFirst), large: large.length };
}

// Ryke with and without write leases, side by side per agent count. Only agent counts that ran both get a
// delta line; a lone `ryke-nolease` cell still gets its row.
export function leaseComparison(cells, details) {
  const rows = [];
  const lines = [];
  const counts = [...new Set(cells.filter((c) => c.policy === "ryke-nolease").map((c) => c.agents))].sort((a, b) => a - b);
  const stale = (c) => c.aborts.stale_read ?? 0;
  for (const n of counts) {
    const pair = ["ryke", "ryke-nolease"].map((policy) => ({ cell: cells.find((c) => c.agents === n && c.policy === policy), detail: details.find((d) => d.agents === n && d.policy === policy) }));
    for (const { cell: c, detail: d } of pair) {
      if (!c) continue;
      rows.push([n, c.policy, fmt(c.landedPerMinute), fmt(c.p50), fmt(c.p95), fmt(c.wastedAgentSeconds), stale(c), c.aborts.max_attempts ?? 0, d?.refreshes ?? 0, `${d?.leaseWaits ?? 0} (${d?.leaseWaitSeconds ?? 0} s)`, d?.ryke?.staleWhileReady ?? 0]);
    }
    const [on, off] = pair.map((p) => p.cell);
    if (on && off) {
      const delta = off.landedPerMinute === 0 ? "n/a" : `${on.landedPerMinute >= off.landedPerMinute ? "+" : ""}${fmt(((on.landedPerMinute - off.landedPerMinute) / off.landedPerMinute) * 100)} %`;
      lines.push(`- ${n} agents: leases on land ${fmt(on.landedPerMinute)}/min against ${fmt(off.landedPerMinute)}/min with leases off (${delta}); stale_read aborts ${stale(on)} against ${stale(off)}; wasted agent-seconds ${fmt(on.wastedAgentSeconds)} against ${fmt(off.wastedAgentSeconds)}.`);
    }
  }
  return { rows, lines };
}

// results: BenchResults; details: [{ policy, agents, ...detail }]; meta: { factor, seed, offset, commentary: [string] }
export function renderMarkdown({ results, details, meta }) {
  const cells = results.cells;
  const out = [];
  out.push("# Ryke bench", "");
  out.push(`> ${results.note}`, "");
  out.push(`Generated ${results.generatedAt}. Every cell ran for ${results.durationSeconds} s of wall time on a fresh \`convert\` trunk; only changes that landed inside that window count.`, "");

  out.push("## Throughput", "", "```", chart(cells), "```", "");
  // `ryke-nolease` is an ablation of Ryke, not a competitor, so it does not take part in the verdict.
  const v = verdict(cells.filter((c) => POLICIES.includes(c.policy)));
  out.push("## Does Ryke win?", "");
  out.push(table(["agents", "ranking by landed/min", "winner"], v.rows.map((r) => [r.agents, r.ranking, r.best.policy])), "");
  out.push(
    v.large === 0
      ? "No cell with 50 agents or more was run, so the M7 criterion (highest landed/min at every N >= 50) was not evaluated."
      : v.rykeWinsEveryLarge
        ? "Ryke has the highest landed/min at every N >= 50 in this run."
        : "Ryke does NOT have the highest landed/min at every N >= 50 in this run. The numbers are reported as measured; see the cell details below.",
    "",
  );

  const lease = leaseComparison(cells, details);
  if (lease.rows.length > 0) {
    out.push("## Write leases on and off", "");
    out.push("`ryke-nolease` is Ryke with the same agents and the same refresh on a stale warning, but the agents never take write leases.", "");
    out.push(table(["agents", "policy", "landed/min", "p50 s", "p95 s", "wasted agent-s", "stale_read aborts", "max_attempts", "refreshes", "lease waits", "stale while ready"], lease.rows), "");
    if (lease.lines.length > 0) out.push(...lease.lines, "");
  }

  out.push("## Every cell", "");
  out.push(
    table(
      ["policy", "agents", "landed", "landed/min", "p50 s", "p95 s", "verify runs/landed", "wasted agent-s", "trunk breakages", "aborts"],
      [...cells]
        .sort((a, b) => a.agents - b.agents || BENCH_POLICIES.indexOf(a.policy) - BENCH_POLICIES.indexOf(b.policy))
        .map((c) => [c.policy, c.agents, c.landed, fmt(c.landedPerMinute), fmt(c.p50), fmt(c.p95), fmt(c.verifyRunsPerLanded), fmt(c.wastedAgentSeconds), c.trunkBreakages, abortsText(c.aborts)]),
    ),
    "",
  );

  out.push("## Cell details", "");
  const rows = details.map((d) => [
    d.policy,
    d.agents,
    `${fmt((d.incompatibility.rate ?? 0) * 100)} % of ${d.incompatibility.overlapping}`,
    d.attemptsPerLanded,
    d.started,
    d.landedInGrace,
    d.abandoned,
    d.refreshes,
    d.leaseWaits,
    d.errors,
    d.meanVerifySeconds ?? "-",
    `${d.loopLagMs.p99}/${d.loopLagMs.max}`,
    d.loadAverage1m,
  ]);
  out.push(
    table(
      ["policy", "agents", "incompatible pairs", "attempts/landed", "changes started", "landed in grace", "unfinished", "refreshes", "lease waits", "agent errors", "mean verify s", "loop lag p99/max ms", "load avg"],
      rows,
    ),
    "",
  );
  const ryke = details.filter((d) => d.ryke);
  if (ryke.length > 0) {
    out.push("### Ryke internals", "");
    out.push(
      table(
        ["policy", "agents", "trains", "mean size", "max size", "bisect probes", "stale warnings", "stale aborts (while ready)", "text conflicts", "train cycle p50/p95 s", "lease wait s (gave up)", "think lost to refresh s", "stale aborts by path"],
        ryke.map((d) => [
          d.policy,
          d.agents,
          d.ryke.trains,
          d.ryke.meanTrainSize,
          d.ryke.maxTrainSize,
          d.ryke.bisectProbes,
          d.ryke.staleWarnings,
          `${d.ryke.staleAborts} (${d.ryke.staleWhileReady ?? 0})`,
          d.ryke.conflictAborts,
          `${d.ryke.trainCycleSecondsP50}/${d.ryke.trainCycleSecondsP95}`,
          `${d.leaseWaitSeconds ?? 0} (${d.leaseGaveUp ?? 0})`,
          d.lostThinkSeconds ?? 0,
          Object.entries(d.ryke.stalePaths)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([p, n]) => `${p} ${n}`)
            .join(", ") || "none",
        ]),
      ),
      "",
    );
  }

  out.push("## How to read this", "");
  out.push(
    "- Begin to land is measured from the moment an agent asks to begin, so the lock policy is charged for the time it waits for the lock.",
    "- Aborts are counted per attempt by cause; `max_attempts` counts the changes given up after the third attempt (their last attempt is also counted under its own cause).",
    "- Verify runs include bisection probes on Ryke; the baselines run one verify per attempt that merged cleanly.",
    "- Wasted agent-seconds is think time of attempts that did not land inside the window.",
    "- `incompatible pairs` is the realised share of pairs of changes with overlapping read sets in which one rewrites a constant the other's test pins; the target is about 10 %.",
    "- Ryke agents take write leases before they think and wait (up to 90 s) while a hot file is held by a change that is still on its way. A stale warning, before or during the think, makes the agent `refresh` onto the current trunk without spending an attempt and spend a retry's worth of think time adapting; `refreshes` and `lease waits` count both. Think time before a refresh is not counted as wasted unless the attempt later fails.",
    "",
  );

  const caveats = meta.caveats ?? [];
  out.push("## Caveats", "");
  for (const c of caveats) out.push(`- ${c}`);
  out.push("");
  return `${out.join("\n")}\n`;
}
