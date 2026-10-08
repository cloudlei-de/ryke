import { AXIS_H, clipText, DIAG_DX, laneBox, SWARM_CMD, type AttemptBar, type Row } from "./geometry";

function Bar({ bar, rowH }: { bar: AttemptBar; rowH: number }) {
  const { y, h } = laneBox(bar.lane, bar.lanes, rowH);
  const mid = y + h / 2;
  const m = bar.mark;
  return (
    <a className="bar" href={bar.href}>
      <title>{bar.title}</title>
      <rect className="hit" x={bar.x - 1} y={y - 2} width={bar.w + 2 + (m?.kind === "landed" ? DIAG_DX : 0)} height={h + 4} />
      {bar.parts.map((p, i) => (
        <rect key={i} className={`seg seg-${p.tone}`} fill={p.tone === "queued" ? "url(#ryke-hatch)" : undefined} x={p.x} y={y} width={p.w} height={h} />
      ))}
      {bar.warnings.map((wx, i) => (
        <line key={i} className="warn" x1={wx} x2={wx} y1={y - 3} y2={y + h + 3} />
      ))}
      {m?.kind === "landed" && <line className="m-landed" x1={m.x} y1={mid} x2={m.x + DIAG_DX} y2={0} />}
      {m?.kind === "stale" && (
        <>
          <path className="m-stale" d={`M${m.x - 3.5},${y - 4} L${m.x + 3.5},${y - 4} L${m.x},${y + 1} Z`} />
          <line className="m-stale-line" x1={m.x} x2={m.x} y1={y} y2={y + h} />
        </>
      )}
      {m?.kind === "failed" && <rect className="m-failed" x={m.x - 1} y={y - 2} width={3} height={h + 4} />}
      {m?.kind === "rejected" && (
        <g className="m-rejected">
          <line x1={m.x - 3} y1={mid - 4} x2={m.x + 5} y2={mid + 4} />
          <line x1={m.x - 3} y1={mid + 4} x2={m.x + 5} y2={mid - 4} />
        </g>
      )}
      {m?.kind === "aborted" && <line className="m-aborted" x1={m.x} x2={m.x} y1={y - 2} y2={y + h + 2} />}
      {bar.strike && <line className="strike" x1={bar.strike.x1} x2={bar.strike.x2} y1={mid} y2={mid} />}
    </a>
  );
}

// Drawn after every bar of the row: the retry bar that follows a stale abort starts right under the label.
function StaleLabel({ bar, rowH }: { bar: AttemptBar; rowH: number }) {
  const m = bar.mark;
  // An empty label was hidden for lack of room; the bar's tooltip still carries it.
  if (m?.kind !== "stale" || m.label === "") return null;
  const { y, h } = laneBox(bar.lane, bar.lanes, rowH);
  return (
    <text className="stale-label" x={m.labelX} y={y + h / 2} dy=".35em" textAnchor={m.anchor}>
      {m.label}
    </text>
  );
}

export function Sidings(props: {
  rows: Row[];
  rowH: number;
  ticks: { t: number; x: number; label: string }[];
  nowX: number;
  nowLabel: string;
  width: number;
  labelW: number;
  x1: number;
  empty: boolean;
  // Set when the agents on the line are simulated (§0.10): said in the header, where nobody can miss it.
  simulation: { text: string; title: string } | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { rows, rowH, ticks, nowX, nowLabel, width, labelW, x1, empty, simulation, scrollRef } = props;
  const maxChars = Math.floor((labelW - 12) / 6);
  return (
    <section className="sidings" aria-label="Sidings">
      <header className="panel-head">
        <div className="head-title">
          <h2>Sidings</h2>
          {simulation && (
            <span className="sim-tag" title={simulation.title}>
              {simulation.text}
            </span>
          )}
        </div>
        <span className="muted mono">{rows.length} agent{rows.length === 1 ? "" : "s"}</span>
      </header>
      <div className="sidings-scroll" ref={scrollRef}>
        <svg className="axis" width={width} height={AXIS_H} aria-hidden="true">
          {ticks.map((k) => (
            <g key={k.t}>
              <line x1={k.x} x2={k.x} y1={AXIS_H - 6} y2={AXIS_H} />
              <text x={k.x} y={11} textAnchor="middle">
                {k.label}
              </text>
            </g>
          ))}
          {nowX >= labelW && nowX <= x1 && (
            <text className="now-label" x={nowX} y={21} textAnchor="middle">
              {nowLabel}
            </text>
          )}
        </svg>
        {empty ? (
          <div className="empty">
            <p>No transactions on the line yet.</p>
            <p className="muted">Start a scripted swarm against this repo:</p>
            <pre>{SWARM_CMD}</pre>
            <p className="muted">or press Run demo in the right rail.</p>
          </div>
        ) : (
          <svg className="rows" width={width} height={rows.length * rowH}>
            {ticks.map((k) => (
              <line key={k.t} className="grid" x1={k.x} x2={k.x} y1={0} y2={rows.length * rowH} />
            ))}
            {rows.map((row) => (
              <g key={row.agent} transform={`translate(0 ${row.index * rowH})`}>
                <line className="rowline" x1={0} x2={width} y1={rowH - 0.5} y2={rowH - 0.5} />
                <text className="agent" x={8} y={rowH / 2} dy=".35em">
                  <title>{row.agent}</title>
                  {clipText(row.agent, maxChars)}
                </text>
                {row.bars.map((b) => (
                  <Bar key={b.key} bar={b} rowH={rowH} />
                ))}
                {row.bars.map((b) => (
                  <StaleLabel key={b.key} bar={b} rowH={rowH} />
                ))}
              </g>
            ))}
            {nowX >= labelW && nowX <= x1 && <line className="now" x1={nowX} x2={nowX} y1={0} y2={rows.length * rowH} />}
          </svg>
        )}
      </div>
    </section>
  );
}
