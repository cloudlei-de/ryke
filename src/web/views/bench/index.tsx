// Bench view (PLAN.md §12 view 3): throughput curve, small multiples for aborts and wasted time, and a
// table of every cell. Charts are hand-written SVG sized to their container, so text stays at its real size.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { BENCH_SYNTHETIC_NOTICE, parseBench, POLICIES, type BenchCell, type BenchPolicy, type BenchResults } from "../../../shared/bench";
import {
  abortCauses,
  abortSegments,
  causeLabel,
  clusterLayout,
  endGutter,
  fmtCompact,
  fmtGenerated,
  fmtNum,
  headline,
  linePath,
  makeXScale,
  measuredAgents,
  niceTicks,
  seriesByPolicy,
  spreadLabels,
  stackLayout,
  tableRows,
} from "./chart";
import "./bench.css";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; data: BenchResults };

function useBench(): Load {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    let off = false;
    fetch("/api/bench")
      .then(async (r) => {
        if (!r.ok) throw new Error(`GET /api/bench answered ${r.status}`);
        const data = parseBench(await r.json());
        if (!data) throw new Error("GET /api/bench returned something that is not a bench result");
        if (!off) setLoad({ status: "ok", data });
      })
      .catch((e: unknown) => {
        if (!off) setLoad({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      off = true;
    };
  }, []);
  return load;
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Charts in one column share margins so the same N sits at the same relative x in each; the right gutter
// holds the direct labels on the line charts and stays empty on the bar chart to keep that alignment.
const PAD_X = 30; // keeps the end markers off the axis and leaves room for a cluster of bars
const POLICY_LABEL_GAP = 15;
const margins = (gutter: number) => ({ top: 18, right: gutter, bottom: 30, left: 44 });

function useWide(): boolean {
  const query = "(min-width: 960px)";
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

// Ryke is the story, so it is the only ink line; the baselines share the muted tone and differ by dash and marker.
const LINE_STYLE: Record<BenchPolicy, { stroke: string; width: number; dash?: string }> = {
  lock: { stroke: "var(--muted)", width: 1.5, dash: "5 3" },
  queue: { stroke: "var(--muted)", width: 1.5 },
  ryke: { stroke: "var(--ink)", width: 2.75 },
};

function Marker({ policy, x, y }: { policy: BenchPolicy; x: number; y: number }) {
  if (policy === "ryke") return <circle className="m-ryke" cx={x} cy={y} r={4} />;
  if (policy === "queue") return <circle className="m-base" cx={x} cy={y} r={3.5} />;
  return <rect className="m-base" x={x - 3.5} y={y - 3.5} width={7} height={7} />;
}

type LineProps = { cells: BenchCell[]; metric: (c: BenchCell) => number; unit: string; height: number; digits: number; gutter: number };

function LineChart(props: LineProps) {
  const [ref, width] = useWidth();
  return (
    <div ref={ref} className="chart" style={{ height: props.height }}>
      {width > 0 && <LineSvg {...props} width={width} />}
    </div>
  );
}

function LineSvg({ cells, metric, unit, width, height, digits, gutter }: LineProps & { width: number }) {
  const m = margins(gutter);
  const plotW = Math.max(40, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;
  const series = seriesByPolicy(cells, metric);
  const { ticks, max } = niceTicks(Math.max(0, ...POLICIES.flatMap((p) => series[p].map((pt) => pt.value))));
  const xs = makeXScale(measuredAgents(cells), m.left + PAD_X, m.left + plotW - PAD_X);
  const y = (v: number) => m.top + plotH - (v / max) * plotH;
  const labelX = m.left + plotW + 14;

  const ends = POLICIES.filter((p) => series[p].length > 0);
  const labelYs = spreadLabels(
    ends.map((p) => y(series[p].at(-1)!.value)),
    POLICY_LABEL_GAP,
    m.top + 4,
    m.top + plotH,
  );

  return (
    <svg width={width} height={height} role="img" aria-label={`${unit} by number of agents, for ${ends.join(", ")}`}>
      {ticks.map((t) => (
        <g key={t}>
          <line className="grid" x1={m.left} x2={m.left + plotW} y1={y(t)} y2={y(t)} />
          <text className="tick" x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
            {fmtCompact(t)}
          </text>
        </g>
      ))}
      <line className="axis" x1={m.left} x2={m.left} y1={m.top} y2={m.top + plotH} />
      <line className="axis" x1={m.left} x2={m.left + plotW} y1={m.top + plotH} y2={m.top + plotH} />
      {xs.ticks.map((n) => (
        <g key={n}>
          <line className="axis" x1={xs.x(n)} x2={xs.x(n)} y1={m.top + plotH} y2={m.top + plotH + 4} />
          <text className="tick" x={xs.x(n)} y={m.top + plotH + 17} textAnchor="middle">
            {n}
          </text>
        </g>
      ))}
      <text className="tick unit" x={labelX} y={m.top + plotH + 17}>
        agents
      </text>
      {POLICIES.map((p) => {
        const s = LINE_STYLE[p];
        const pts = series[p].map((pt) => ({ x: xs.x(pt.agents), y: y(pt.value) }));
        return pts.length === 0 ? null : (
          <path key={p} d={linePath(pts)} fill="none" style={{ stroke: s.stroke, strokeWidth: s.width, strokeDasharray: s.dash }} strokeLinejoin="round" strokeLinecap="round" />
        );
      })}
      {POLICIES.map((p) =>
        series[p].map((pt) => (
          <g key={`${p}-${pt.agents}`}>
            <Marker policy={p} x={xs.x(pt.agents)} y={y(pt.value)} />
            {/* The hit area is larger than the 8 px marker so the native tooltip is easy to reach. */}
            <circle className="hit" cx={xs.x(pt.agents)} cy={y(pt.value)} r={11}>
              <title>{`${p} · ${pt.agents} agents · ${fmtNum(pt.value, digits)} ${unit}`}</title>
            </circle>
          </g>
        )),
      )}
      {ends.map((p, i) => {
        const last = series[p].at(-1)!;
        const px = xs.x(last.agents);
        return (
          <g key={p} className={p === "ryke" ? "end ryke" : "end"}>
            <line className="leader" x1={px + 7} x2={labelX - 4} y1={y(last.value)} y2={labelYs[i]} />
            <text x={labelX} y={labelYs[i]} dy="0.32em">
              <tspan className="end-name">{p}</tspan>
              <tspan className="end-value" dx="6">
                {fmtNum(last.value, digits)}
              </tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Fills that tell causes apart without hue: signal colours are for signals, and every abort is a stop.
function Patterns({ id }: { id: string }) {
  const line = { style: { stroke: "var(--stop)", strokeWidth: 1.4 } };
  return (
    <defs>
      <pattern id={`${id}-0`} width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="4" height="4" style={{ fill: "var(--stop)" }} />
      </pattern>
      <pattern id={`${id}-1`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="4" {...line} />
      </pattern>
      <pattern id={`${id}-2`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
        <line x1="0" y1="0" x2="0" y2="4" {...line} />
      </pattern>
      <pattern id={`${id}-3`} width="5" height="5" patternUnits="userSpaceOnUse">
        <line x1="0" y1="2.5" x2="5" y2="2.5" {...line} />
        <line x1="2.5" y1="0" x2="2.5" y2="5" {...line} />
      </pattern>
      <pattern id={`${id}-4`} width="5" height="5" patternUnits="userSpaceOnUse">
        <circle cx="2.5" cy="2.5" r="1.1" style={{ fill: "var(--stop)" }} />
      </pattern>
    </defs>
  );
}

const POLICY_INITIAL: Record<BenchPolicy, string> = { lock: "L", queue: "Q", ryke: "R" };

function AbortsChart({ cells, causes, height, gutter }: { cells: BenchCell[]; causes: string[]; height: number; gutter: number }) {
  const [ref, width] = useWidth();
  // React ids contain characters that are not valid inside url(#...).
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  // Two label rows under the axis (policy initials, then N), so a taller bottom margin than the line charts.
  const m = { ...margins(gutter), bottom: 36 };
  const plotW = Math.max(40, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;
  const stacks = useMemo(() => cells.map((c) => ({ cell: c, segs: abortSegments(c.aborts, causes) })), [cells, causes]);
  const totals = stacks.map((s) => s.segs.reduce((sum, g) => sum + g.value, 0));
  const { ticks, max } = niceTicks(Math.max(0, ...totals));
  const xs = makeXScale(measuredAgents(cells), m.left + PAD_X, m.left + plotW - PAD_X);
  const bars = clusterLayout(xs.ticks.map(xs.x), POLICIES.length, 16, 2);
  const baseline = m.top + plotH;
  const px = (v: number) => (v / max) * plotH;
  return (
    <>
      <div ref={ref} className="chart" style={{ height }}>
        {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Aborted attempts by cause, for each number of agents and policy">
          <Patterns id={id} />
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={m.left} x2={m.left + plotW} y1={baseline - px(t)} y2={baseline - px(t)} />
              <text className="tick" x={m.left - 8} y={baseline - px(t)} dy="0.32em" textAnchor="end">
                {fmtCompact(t)}
              </text>
            </g>
          ))}
          <line className="axis" x1={m.left} x2={m.left} y1={m.top} y2={baseline} />
          <line className="axis" x1={m.left} x2={m.left + plotW} y1={baseline} y2={baseline} />
          {xs.ticks.map((n) => (
            <text key={n} className="tick" x={xs.x(n)} y={baseline + 28} textAnchor="middle">
              {n}
            </text>
          ))}
          {stacks.map(({ cell, segs }, i) => {
            const k = POLICIES.indexOf(cell.policy);
            const cx = xs.x(cell.agents) + bars.offsets[k]! - bars.width / 2;
            const label = bars.width >= 9;
            return (
              <g key={`${cell.policy}-${cell.agents}`}>
                {stackLayout(segs, px, baseline, 2).map((s) => (
                  <rect key={s.cause} x={cx} y={s.y} width={bars.width} height={s.h} fill={`url(#${id}-${causes.indexOf(s.cause)})`}>
                    <title>{`${cell.policy} · ${cell.agents} agents · ${causeLabel(s.cause)} ${s.value}`}</title>
                  </rect>
                ))}
                {totals[i] === 0 && <line className="axis" x1={cx} x2={cx + bars.width} y1={baseline - 0.5} y2={baseline - 0.5} />}
                {label && (
                  <text className={cell.policy === "ryke" ? "bar-total ryke" : "bar-total"} x={cx + bars.width / 2} y={baseline - px(totals[i]!) - 4} textAnchor="middle">
                    {fmtNum(totals[i]!, 0)}
                  </text>
                )}
                {label && (
                  <text className="tick" x={cx + bars.width / 2} y={baseline + 12} textAnchor="middle">
                    {POLICY_INITIAL[cell.policy]}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        )}
      </div>
      <PatternKey id={id} causes={causes} />
    </>
  );
}

function PatternKey({ id, causes }: { id: string; causes: string[] }) {
  return (
    <ul className="cause-key" aria-label="Abort causes">
      {causes.map((c, k) => (
        <li key={c}>
          <svg width="18" height="10" aria-hidden="true">
            <rect width="18" height="10" fill={`url(#${id}-${k})`} />
          </svg>
          {causeLabel(c)}
        </li>
      ))}
    </ul>
  );
}

function Figure({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <figure className="bench-fig">
      <figcaption>
        <span className="fig-title">{title}</span>
        <span className="muted">{note}</span>
      </figcaption>
      {children}
    </figure>
  );
}

function Results({ data }: { data: BenchResults }) {
  const causes = useMemo(() => abortCauses(data.cells), [data.cells]);
  const rows = useMemo(() => tableRows(data.cells), [data.cells]);
  const lead = useMemo(() => headline(data.cells), [data.cells]);
  const broken = rows.filter((r) => r.breakages > 0);
  const wide = useWide();
  const landed = (c: BenchCell) => c.landedPerMinute;
  const wasted = (c: BenchCell) => c.wastedAgentSeconds;
  // The two small multiples share a column, so they share a gutter and their plots line up.
  const sideGutter = endGutter(data.cells, wasted, 0);
  return (
    <>
      {lead && (
        <p className="bench-lead">
          <span className="muted">At {lead.agents} agents, landed per minute</span>
          {[...POLICIES].reverse().map((p) => (
            <span key={p} className={p === "ryke" ? "lead-item ryke" : "lead-item"}>
              <span className="lead-name">{p}</span>
              <span className="mono lead-num">{fmtNum(lead.values[p], 1)}</span>
            </span>
          ))}
        </p>
      )}
      <div className="bench-grid">
        <Figure title="Throughput" note="landed changes per minute, by number of agents">
          <LineChart cells={data.cells} metric={landed} unit="landed/min" height={wide ? 392 : 300} digits={1} gutter={endGutter(data.cells, landed, 1)} />
        </Figure>
        <div className="bench-side">
          <Figure title="Aborts" note="attempts sent back, stacked by cause · bars: lock, queue, ryke">
            <AbortsChart cells={data.cells} causes={causes} height={wide ? 190 : 220} gutter={sideGutter} />
          </Figure>
          <Figure title="Wasted agent-seconds" note="think time of attempts that did not land">
            <LineChart cells={data.cells} metric={wasted} unit="agent-s" height={wide ? 170 : 200} digits={0} gutter={sideGutter} />
          </Figure>
        </div>
      </div>
      <section className="bench-table" aria-label="Every cell">
        <h2>Every cell</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="l">Policy</th>
                <th>Agents</th>
                <th>Landed</th>
                <th>Landed/min</th>
                <th>p50 s</th>
                <th>p95 s</th>
                <th className="l">Aborts</th>
                <th>Verify runs / landed</th>
                <th>Wasted agent-s</th>
                <th>Trunk breakages</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key} className={[r.policy === "ryke" ? "ryke" : "", i > 0 && rows[i - 1]!.agents !== r.agents ? "group" : ""].join(" ").trim()}>
                  <td className="l">{r.policy}</td>
                  <td className="mono">{r.agents}</td>
                  <td className="mono">{r.landed}</td>
                  <td className="mono">{r.perMinute}</td>
                  <td className="mono">{r.p50}</td>
                  <td className="mono">{r.p95}</td>
                  <td className="l aborts">{r.aborts}</td>
                  <td className="mono">{r.verifyRuns}</td>
                  <td className="mono">{r.wasted}</td>
                  <td className={r.breakages > 0 ? "mono bad" : "mono"}>{r.breakages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted foot">
          Trunk breakages must be 0 for every policy; the bench asserts it.
          {broken.length > 0 && <strong className="bad"> Trunk broke in {broken.map((r) => `${r.policy} at ${r.agents}`).join(", ")}.</strong>}
        </p>
      </section>
    </>
  );
}

export function BenchView() {
  const load = useBench();
  const data = load.status === "ok" ? load.data : null;
  return (
    <section className="bench">
      <header className="bench-head">
        <h1>Bench</h1>
        <p className="muted">Three ways to land concurrent agents on one trunk: a global lock, a merge queue, and Ryke.</p>
      </header>
      <aside className="bench-note" role="note">
        <p className="notice">{BENCH_SYNTHETIC_NOTICE}</p>
        {data && (
          <p className="muted">
            {data.note}
            <span className="mono"> · {data.generatedAt === null ? "not generated yet" : `generated ${fmtGenerated(data.generatedAt)}`}</span>
            {data.durationSeconds > 0 && <span className="mono"> · {fmtNum(data.durationSeconds, 0)} s per cell</span>}
          </p>
        )}
      </aside>
      {load.status === "loading" && <p className="muted bench-status">Loading the latest bench run.</p>}
      {load.status === "error" && (
        <p className="bench-status bad" role="alert">
          Could not load the bench: {load.message}
        </p>
      )}
      {data && data.cells.length === 0 && (
        <div className="bench-empty">
          <p>No bench run yet.</p>
          <p className="muted">
            Run <code>npm run bench -- --agents 10,50,100,200 --policy lock,queue,ryke --duration 300</code> and commit <code>bench/results/latest.json</code>.
          </p>
        </div>
      )}
      {data && data.cells.length > 0 && <Results data={data} />}
    </section>
  );
}
