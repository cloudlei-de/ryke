import { useState, type FocusEvent, type MouseEvent } from "react";
import type { LineState } from "../../../shared/reducers";
import { Icon, Pill, sentence, stateIcon } from "../../ui";
import { stateSignal } from "../txn/format";
import {
  agentStatus,
  AXIS_H,
  clipText,
  isArriving,
  LABEL_MIN_H,
  laneBox,
  shortSha,
  stateLabel,
  SWARM_CMD,
  tipFor,
  txnHref,
  type AttemptBar,
  type Row,
  type TrunkBlock,
  type Wave,
} from "./geometry";

export const TRUNK_H = 58;
const LINE_Y = 30;

type Hover = { bar: AttemptBar; x: number; y: number };

// ------------------------------------------------------------------ legend

const LEGEND: { key: string; label: string }[] = [
  { key: "open", label: "Working" },
  { key: "queued", label: "Queued" },
  { key: "verify", label: "Verifying" },
  { key: "landed", label: "Landed" },
  { key: "stale", label: "Stale" },
  { key: "failed", label: "Failed · rejected" },
  { key: "human", label: "Waiting · human" },
  { key: "recalled", label: "Recalled" },
];

function Swatch({ kind }: { kind: string }) {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true" className="lg-swatch">
      {kind === "open" && <rect x="0" y="1" width="22" height="8" rx="2.5" className="seg-open" />}
      {kind === "queued" && <rect x="0" y="1" width="22" height="8" rx="2.5" fill="url(#ryke-queue)" />}
      {kind === "verify" && <rect x="0" y="1" width="22" height="8" rx="2.5" className="seg-verify" />}
      {kind === "landed" && (
        <>
          <rect x="0" y="1" width="18" height="8" rx="2.5" className="seg-landed" />
          <circle cx="17" cy="5" r="4.5" className="m-landed" />
        </>
      )}
      {kind === "stale" && (
        <>
          <rect x="0" y="1" width="12" height="8" rx="2.5" className="seg-open" />
          <rect x="11.5" y="-1" width="2.5" height="12" className="m-stale" />
          <rect x="15" y="1" width="7" height="8" rx="2.5" className="seg-open" />
        </>
      )}
      {kind === "failed" && (
        <>
          <rect x="0" y="1" width="16" height="8" rx="2.5" className="seg-open" />
          <circle cx="16.5" cy="5" r="4.5" className="m-failed" />
        </>
      )}
      {kind === "human" && <rect x="0" y="1" width="22" height="8" rx="2.5" className="seg-human" />}
      {kind === "recalled" && (
        <>
          <rect x="0" y="1" width="22" height="8" rx="2.5" className="seg-landed recalled" />
          <line x1="0" x2="22" y1="5" y2="5" className="strike" />
        </>
      )}
    </svg>
  );
}

export function Legend() {
  return (
    <ul className="legend" aria-label="Key">
      {LEGEND.map((l) => (
        <li key={l.key}>
          <Swatch kind={l.key} />
          {l.label}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ trunk

function Trunk({ blocks, head, waves, width, labelW, x0, now }: { blocks: TrunkBlock[]; head: LineState["head"]; waves: Wave[]; width: number; labelW: number; x0: number; now: number }) {
  const culprits = new Map(waves.map((w) => [w.culprit, w]));
  return (
    <svg className="trunk" width={width} height={TRUNK_H} role="group" aria-label={head ? `Trunk head ${shortSha(head.sha)}, seq ${head.seq}` : "Trunk, no commits yet"}>
      <text className="trunk-name" x={labelW < 120 ? 8 : 16} y={25}>
        trunk
      </text>
      <text className="trunk-head" x={labelW < 120 ? 8 : 16} y={42}>
        {head ? (labelW < 120 ? `seq ${head.seq}` : `seq ${head.seq} · ${shortSha(head.sha)}`) : "no commits"}
      </text>
      <line className="mainline" x1={x0 - 6} x2={width - 8} y1={LINE_Y} y2={LINE_Y} />
      <line className="trunk-sep" x1={labelW} x2={labelW} y1={10} y2={TRUNK_H - 10} />
      {blocks.map((b) => (
        <g key={b.key} className={isArriving(b.at, now) ? "block arrive" : "block"}>
          {b.ticks.length > 1 && (
            <>
              <rect className="block-box" x={b.x - 8} y={LINE_Y - 9} width={b.w + 16} height={18} rx={9} />
              <text className="block-count" x={b.x + b.w / 2} y={LINE_Y - 13} textAnchor="middle">
                {b.ticks.length}
              </text>
            </>
          )}
          {b.ticks.map((t) => {
            const wave = t.txn ? culprits.get(t.txn) : undefined;
            const dot = (
              <>
                <title>{wave ? `${t.title} · made ${wave.victims.length} stale` : t.title}</title>
                {wave && <circle className="dot-ring" cx={t.x} cy={LINE_Y} r={7.5} />}
                <circle className={t.txn ? "tick" : t.recall ? "tick recall" : "tick seed"} cx={t.x} cy={LINE_Y} r={4} />
                <circle className="dot-hit" cx={t.x} cy={LINE_Y} r={7} />
              </>
            );
            return (
              <g key={t.key}>
                {t.txn ? (
                  <a href={txnHref(t.txn)} aria-label={t.title}>
                    {dot}
                  </a>
                ) : (
                  dot
                )}
                {wave && (
                  <>
                    <line className="wave" x1={t.x} x2={t.x} y1={LINE_Y + 8} y2={TRUNK_H} />
                    <text className="wave-label" x={t.x + 6} y={LINE_Y + 19}>
                      {wave.victims.length} stale
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

// ------------------------------------------------------------------ bars

const ID_SAFE = /[^a-zA-Z0-9_-]/g;

export function Glyph({ kind, x, mid, r }: { kind: string; x: number; mid: number; r: number }) {
  const k = r * 0.5;
  if (kind === "landed")
    return (
      <g className="glyph">
        <circle className="m-landed" cx={x} cy={mid} r={r} />
        <path className="glyph-ink" d={`M${x - k} ${mid + 0.1 * r}l${k * 0.7} ${k * 0.75}l${k * 1.3} -${k * 1.5}`} />
      </g>
    );
  if (kind === "failed" || kind === "rejected" || kind === "aborted")
    return (
      <g className="glyph">
        <circle className={kind === "aborted" ? "m-aborted" : "m-failed"} cx={x} cy={mid} r={r} />
        {kind === "rejected" ? (
          <path className="glyph-ink" d={`M${x - k} ${mid}h${2 * k}`} />
        ) : (
          <path className="glyph-ink" d={`M${x - k * 0.8} ${mid - k * 0.8}l${k * 1.6} ${k * 1.6}M${x + k * 0.8} ${mid - k * 0.8}l-${k * 1.6} ${k * 1.6}`} />
        )}
      </g>
    );
  return null;
}

function Bar({ bar, rowH, hovered, onHover }: { bar: AttemptBar; rowH: number; hovered: boolean; onHover: (e: MouseEvent | FocusEvent, bar: AttemptBar | null) => void }) {
  const { y, h } = laneBox(bar.lane, bar.lanes, rowH);
  const mid = y + h / 2;
  const m = bar.mark;
  const clip = `clip-${bar.key.replace(ID_SAFE, "_")}`;
  const r = Math.min(6, h / 2 + 1.5);
  const recalled = bar.strike !== null;
  return (
    <a
      className={`bar${hovered ? " hot" : ""}${recalled ? " is-recalled" : ""}`}
      href={bar.href}
      aria-label={bar.title}
      onMouseEnter={(e) => onHover(e, bar)}
      onMouseMove={(e) => onHover(e, bar)}
      onMouseLeave={(e) => onHover(e, null)}
      onFocus={(e) => onHover(e, bar)}
      onBlur={(e) => onHover(e, null)}
    >
      <clipPath id={clip}>
        <rect x={bar.x} y={y} width={Math.max(bar.w, 1)} height={h} rx={Math.min(4, h / 2)} />
      </clipPath>
      <rect className="hit" x={bar.x - 2} y={y - 4} width={bar.w + 4 + (m ? r : 0)} height={h + 8} />
      <g clipPath={`url(#${clip})`}>
        {bar.parts.map((p, i) => (
          <rect key={i} className={`part seg-${p.tone}`} fill={p.tone === "queued" ? "url(#ryke-queue)" : p.tone === "lease" ? "url(#ryke-lease)" : undefined} x={p.x} y={y} width={p.w + 0.5} height={h} />
        ))}
        {bar.label && h >= LABEL_MIN_H && (
          <text className="bar-label" x={bar.label.x} y={mid} dy="0.34em">
            {bar.label.text}
          </text>
        )}
      </g>
      {bar.warnings.map((wx, i) => (
        <circle key={i} className="warn" cx={wx} cy={y - 3.5} r={2.2} />
      ))}
      {m?.kind === "stale" && <rect className="m-stale" x={m.x - 1.25} y={y - 3} width={2.5} height={h + 6} rx={1} />}
      {m && m.kind !== "stale" && <Glyph kind={m.kind} x={m.x} mid={mid} r={r} />}
      {bar.strike && <line className="strike" x1={bar.strike.x1 - 2} x2={bar.strike.x2 + r} y1={mid} y2={mid} />}
    </a>
  );
}

// ------------------------------------------------------------------ hover card

function Card({ hover, state, now }: { hover: Hover; state: LineState; now: number }) {
  const txn = state.txns.get(hover.bar.txn);
  const attempt = txn?.attempts.find((a) => a.attempt === hover.bar.attempt);
  if (!txn || !attempt) return null;
  const tip = tipFor(txn, attempt, now);
  const w = 320;
  const left = hover.x + 16 + w > innerWidth ? Math.max(8, hover.x - w - 16) : hover.x + 16;
  const top = Math.min(hover.y + 16, innerHeight - 200);
  return (
    <div className="tip" style={{ left, top, width: w }} role="tooltip">
      <div className="tip-title">
        <Pill tone={stateSignal(tip.status)} icon={stateIcon(tip.status)}>
          {sentence(stateLabel(tip.status).replace(/_/g, " "))}
        </Pill>
        <span className="mono">{tip.id}</span>
        {txn.attempts.length > 1 && <span className="muted">attempt {tip.attempt}</span>}
      </div>
      <p className="tip-intent">{tip.intent}</p>
      <dl className="tip-rows">
        {tip.rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="tip-foot">Click to open the transaction</p>
    </div>
  );
}

// ------------------------------------------------------------------ the panel

export function Lanes(props: {
  state: LineState;
  rows: Row[];
  rowH: number;
  width: number;
  labelW: number;
  x0: number;
  x1: number;
  ticks: { t: number; x: number; label: string }[];
  nowX: number;
  nowLabel: string;
  blocks: TrunkBlock[];
  waves: Wave[];
  now: number;
}) {
  const { state, rows, rowH, width, labelW, x0, x1, ticks, nowX, nowLabel, blocks, waves, now } = props;
  const [hover, setHover] = useState<Hover | null>(null);
  // A phone's gutter is narrow: the dot moves in so a whole agent name still fits.
  const pad = labelW < 120 ? 8 : 16;
  const maxChars = Math.floor((labelW - pad - 16) / 6.4);
  const onHover = (e: MouseEvent | FocusEvent, bar: AttemptBar | null) => {
    if (!bar) return setHover(null);
    if ("clientX" in e) setHover({ bar, x: e.clientX, y: e.clientY });
    else {
      const r = (e.currentTarget as Element).getBoundingClientRect();
      setHover({ bar, x: r.right, y: r.bottom });
    }
  };
  const showNow = nowX >= x0 && nowX <= x1 + 1;
  // The flag fits its label: "now" live, the clock time in a replay.
  const flagW = nowLabel.length * 6.6 + 16;
  const total = rows.length * rowH;
  return (
    <>
      <div className="tl-head">
        <svg className="axis" width={width} height={AXIS_H} aria-hidden="true">
          {/* A clock label under the "now" flag would be half hidden; the flag says the time instead. */}
          {ticks
            .filter((k) => !showNow || Math.abs(k.x - nowX) > flagW / 2 + 28)
            .map((k) => (
              <text key={k.t} x={k.x} y={16} textAnchor="middle">
                {k.label}
              </text>
            ))}
          {showNow && (
            <g className="now-flag">
              <rect x={nowX - flagW / 2} y={5} width={flagW} height={16} rx={8} />
              <text x={nowX} y={16.5} textAnchor="middle">
                {nowLabel}
              </text>
            </g>
          )}
        </svg>
        <Trunk blocks={blocks} head={state.head} waves={waves} width={width} labelW={labelW} x0={x0} now={now} />
      </div>
      {rows.length === 0 ? (
        <div className="tl-empty">
          <Icon name="git" size={22} />
          <p className="tl-empty-title">No transactions on the line yet</p>
          <p className="muted">Start a scripted swarm against this repo, or press Run demo above.</p>
          <pre>{SWARM_CMD}</pre>
        </div>
      ) : (
        <svg className="rows" width={width} height={total}>
          {ticks.map((k) => (
            <line key={k.t} className="grid" x1={k.x} x2={k.x} y1={0} y2={total} />
          ))}
          {waves.map((w) => (
            <g key={w.culprit} className="wave-group">
              <line className="wave" x1={w.x} x2={w.x} y1={0} y2={w.bottom * rowH + laneBox(0, 1, rowH).y - 2} />
              {/* A branch along the top edge of each caught bar, from the guide to where its notch fell. */}
              {w.victims.map((v, i) => {
                const y = v.row * rowH + laneBox(v.lane, v.lanes, rowH).y - 2;
                return <path key={i} className="wave" d={`M${w.x} ${y}H${v.x}`} />;
              })}
            </g>
          ))}
          {rows.map((row) => {
            const status = agentStatus(state, row.agent);
            const active = hover && row.bars.some((b) => b.key === hover.bar.key);
            return (
              <g key={row.agent} transform={`translate(0 ${row.index * rowH})`} className={active ? "row hot" : "row"}>
                <rect className="row-bg" x={0} y={0} width={width} height={rowH} />
                <line className="rowline" x1={0} x2={width} y1={rowH - 0.5} y2={rowH - 0.5} />
                <circle className="agent-dot" data-tone={status ? stateSignal(status.state) : undefined} cx={pad + 4} cy={rowH / 2} r={3.5} />
                <text className="agent" x={pad + 14} y={rowH / 2} dy="0.34em">
                  <title>{status ? `${row.agent} · ${stateLabel(status.state).replace(/_/g, " ")}` : row.agent}</title>
                  {clipText(row.agent, maxChars)}
                </text>
                {row.bars.map((b) => (
                  <Bar key={b.key} bar={b} rowH={rowH} hovered={hover?.bar.key === b.key} onHover={onHover} />
                ))}
              </g>
            );
          })}
          {showNow && <line className="now" x1={nowX} x2={nowX} y1={0} y2={total} />}
        </svg>
      )}
      {hover && <Card hover={hover} state={state} now={now} />}
    </>
  );
}

// Patterns the bars fill with; one copy per page.
export function Patterns() {
  return (
    <svg className="defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="ryke-queue" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect className="queue-bg" width="6" height="6" />
          <line className="queue-line" x1="1" y1="0" x2="1" y2="6" />
        </pattern>
        <pattern id="ryke-lease" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect className="lease-bg" width="6" height="6" />
          <circle className="lease-dot" cx="3" cy="3" r="1.3" />
        </pattern>
      </defs>
    </svg>
  );
}
