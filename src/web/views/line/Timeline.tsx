import { useState, type FocusEvent, type MouseEvent } from "react";
import type { LineState } from "../../../shared/reducers";
import { EndMark, endReach, sentence, StateMark, Swatch, type MarkName } from "../../ui";
import { stateSignal } from "../txn/format";
import {
  agentStatus,
  AXIS_H,
  blockLabels,
  clipText,
  isArriving,
  LABEL_MIN_H,
  laneBox,
  shortSha,
  stateLabel,
  SWARM_CMD,
  tipFor,
  trainPath,
  txnHref,
  type AttemptBar,
  type Row,
  type TrunkBlock,
  type Wave,
} from "./geometry";

export const TRUNK_H = 58;
const LINE_Y = 30;

type Hover = { bar: AttemptBar; x: number; y: number };

// ------------------------------------------------------------------ key

const LEGEND: { mark: MarkName; label: string }[] = [
  { mark: "working", label: "Working" },
  { mark: "queued", label: "Queued for a train" },
  { mark: "verifying", label: "Verifying" },
  { mark: "landed", label: "Landed" },
  { mark: "stale", label: "Stale, retried" },
  { mark: "warning", label: "Warned" },
  { mark: "failed", label: "Failed" },
  { mark: "rejected", label: "Rejected" },
  { mark: "aborted", label: "Gave up" },
  { mark: "lease", label: "Waiting for a lease" },
  { mark: "human", label: "Needs a human" },
  { mark: "recalled", label: "Recalled" },
];

// The sheet's key, printed along its foot as on a timetable: every mark the rows can carry, in the order a
// change meets them.
export function Legend() {
  return (
    <ul className="legend" aria-label="Key">
      {LEGEND.map((l) => (
        <li key={l.mark}>
          <Swatch mark={l.mark} />
          {l.label}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ trunk

function TrunkTick({ tick, culprit }: { tick: TrunkBlock["ticks"][number]; culprit: boolean }) {
  // The seed is where the line begins, a terminus; a recall's revert is a diamond, the one commit that takes work away.
  if (!tick.txn && !tick.recall) return <rect className="tick seed" x={tick.x - 3} y={LINE_Y - 3} width={6} height={6} />;
  if (!tick.txn) return <path className="tick recall" d={`M${tick.x} ${LINE_Y - 5}L${tick.x + 5} ${LINE_Y}L${tick.x} ${LINE_Y + 5}L${tick.x - 5} ${LINE_Y}Z`} />;
  return <rect className={culprit ? "tick culprit" : "tick"} x={tick.x - 1} y={LINE_Y - 7} width={2} height={14} />;
}

function Trunk({ blocks, head, waves, width, labelW, x0, now }: { blocks: TrunkBlock[]; head: LineState["head"]; waves: Wave[]; width: number; labelW: number; x0: number; now: number }) {
  const culprits = new Map(waves.map((w) => [w.culprit, w]));
  // "9 stale" beside a guide needs about 48 px; a label that would run into the one before it is left to the title.
  const labelled = new Set<string>();
  let lastLabel = -Infinity;
  for (const w of waves) {
    if (w.x - lastLabel < 52) continue;
    labelled.add(w.culprit);
    lastLabel = w.x;
  }
  const pad = labelW < 120 ? 8 : 16;
  const counted = blockLabels(blocks);
  return (
    <svg className="trunk" width={width} height={TRUNK_H} role="group" aria-label={head ? `Trunk head ${shortSha(head.sha)}, seq ${head.seq}` : "Trunk, no commits yet"}>
      <text className="trunk-name" x={pad} y={27}>
        Trunk
      </text>
      <text className="trunk-head" x={pad} y={42}>
        {head ? (labelW < 120 ? `seq ${head.seq}` : `seq ${head.seq} · ${shortSha(head.sha)}`) : "no commits"}
      </text>
      <line className="gutter" x1={labelW + 0.5} x2={labelW + 0.5} y1={0} y2={TRUNK_H} />
      <line className="mainline" x1={x0 - 6} x2={width - 8} y1={LINE_Y} y2={LINE_Y} />
      {blocks.map((b) => (
        <g key={b.key} className={isArriving(b.at, now) ? "block arrive" : "block"}>
          {b.ticks.length > 1 && (
            <>
              {/* A train is bracketed like a dimension on a drawing, its size written over it. */}
              <path className="block-box" d={`M${b.x - 4} ${LINE_Y - 10}V${LINE_Y - 13.5}H${b.x + b.w + 4}V${LINE_Y - 10}`}>
                <title>{`${b.train ?? "train"} · ${b.ticks.length} changes landed together`}</title>
              </path>
              {counted.has(b.key) && (
                <text className="block-count" x={b.x + b.w / 2} y={LINE_Y - 17} textAnchor="middle">
                  {b.ticks.length}
                </text>
              )}
            </>
          )}
          {b.ticks.map((t) => {
            const wave = t.txn ? culprits.get(t.txn) : undefined;
            const mark = (
              <>
                <title>{wave ? `${t.title} · made ${wave.victims.length} stale` : t.title}</title>
                <TrunkTick tick={t} culprit={Boolean(wave)} />
                <rect className="dot-hit" x={t.x - 5} y={LINE_Y - 10} width={10} height={20} />
              </>
            );
            return (
              <g key={t.key}>
                {t.txn ? (
                  <a href={txnHref(t.txn)} aria-label={t.title}>
                    {mark}
                  </a>
                ) : (
                  mark
                )}
                {wave && (
                  <>
                    <line className="wave" x1={t.x} x2={t.x} y1={LINE_Y + 8} y2={TRUNK_H} />
                    {labelled.has(wave.culprit) && (
                      <text className="wave-label" x={t.x + 5} y={LINE_Y + 19}>
                        {wave.victims.length} stale
                      </text>
                    )}
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

const PATTERN: Partial<Record<AttemptBar["parts"][number]["tone"], string>> = { queued: "url(#ryke-queue)", lease: "url(#ryke-lease)", human: "url(#ryke-human)" };

// An attempt's band: its stretches filled by state, one ink frame around the whole, open on the right while it
// runs, and the mark of how it ended.
export function Band({ bar, y, h, label }: { bar: AttemptBar; y: number; h: number; label?: boolean }) {
  const m = bar.mark;
  const recalled = bar.strike !== null;
  const x1 = bar.x + Math.max(bar.w, 1);
  const frame = bar.running ? `M${x1} ${y + 0.5}H${bar.x + 0.5}V${y + h - 0.5}H${x1}` : `M${bar.x + 0.5} ${y + 0.5}H${x1 - 0.5}V${y + h - 0.5}H${bar.x + 0.5}Z`;
  return (
    <>
      {bar.parts.map((p, i) => (
        <rect key={i} className={`part seg-${p.tone}`} fill={PATTERN[p.tone]} x={p.x} y={y} width={p.w + 0.5} height={h} />
      ))}
      <path className="bar-frame" d={frame} />
      {label && bar.label && h >= LABEL_MIN_H && (
        <text className="bar-label" x={bar.label.x} y={y + h / 2} dy="0.35em">
          {bar.label.text}
        </text>
      )}
      {bar.warnings.map((wx, i) => (
        <path key={i} className="warn" d={`M${wx - 3.5} ${y - 6.5}h7l-3.5 4.5z`} />
      ))}
      {m && <EndMark kind={m.kind} x={m.x} y={y} h={h} recalled={recalled} />}
      {bar.strike && <line className="strike" x1={bar.strike.x1 - 3} x2={bar.strike.x2 + 3} y1={y + h / 2} y2={y + h / 2} />}
    </>
  );
}

function Bar({ bar, rowH, hovered, onHover }: { bar: AttemptBar; rowH: number; hovered: boolean; onHover: (e: MouseEvent | FocusEvent, bar: AttemptBar | null) => void }) {
  const { y, h } = laneBox(bar.lane, bar.lanes, rowH);
  const reach = bar.mark ? endReach(bar.mark.kind, h) : 0;
  return (
    <a
      className={`bar${hovered ? " hot" : ""}${bar.strike ? " is-recalled" : ""}`}
      href={bar.href}
      aria-label={bar.title}
      onMouseEnter={(e) => onHover(e, bar)}
      onMouseMove={(e) => onHover(e, bar)}
      onMouseLeave={(e) => onHover(e, null)}
      onFocus={(e) => onHover(e, bar)}
      onBlur={(e) => onHover(e, null)}
    >
      <rect className="hit" x={bar.x - 2} y={y - 4} width={bar.w + 4 + reach} height={h + 8} />
      <Band bar={bar} y={y} h={h} label />
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
        <StateMark state={tip.status} label={sentence(stateLabel(tip.status).replace(/_/g, " "))} />
        {txn.attempts.length > 1 && <span className="muted">attempt {tip.attempt}</span>}
        <span className="mono">{tip.id}</span>
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
  // The height the rows have on screen: the grid runs down to it, as a timetable's grid runs to the foot of the sheet.
  fillH: number;
  width: number;
  labelW: number;
  x0: number;
  x1: number;
  ticks: { t: number; x: number; label: string }[];
  minor: number[];
  nowX: number;
  nowLabel: string;
  blocks: TrunkBlock[];
  waves: Wave[];
  now: number;
  // How far the rows have scrolled under the sticky axis and trunk, read as the Line draws (it redraws on its clock),
  // so a hovered path still meets the trunk without a redraw on every scroll.
  scrollTop: number;
}) {
  const { state, rows, rowH, fillH, width, labelW, x0, x1, ticks, minor, nowX, nowLabel, blocks, waves, now, scrollTop } = props;
  const [hover, setHover] = useState<Hover | null>(null);
  // A phone's gutter is narrow: the lamp moves in so a whole agent name still fits.
  const pad = labelW < 120 ? 8 : 16;
  const maxChars = Math.floor((labelW - pad - 16) / 6);
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
  const flagW = nowLabel.length * 6.4 + 12;
  const total = rows.length * rowH;
  const sheetH = Math.max(total, Math.floor(fillH));
  return (
    <>
      <div className="tl-head">
        <svg className="axis" width={width} height={AXIS_H} aria-hidden="true">
          <line className="gutter" x1={labelW + 0.5} x2={labelW + 0.5} y1={0} y2={AXIS_H} />
          <line className="axis-base" x1={x0} x2={x1} y1={AXIS_H - 0.5} y2={AXIS_H - 0.5} />
          {minor.map((x) => (
            <line key={x} className="axis-minor" x1={x} x2={x} y1={AXIS_H - 3} y2={AXIS_H} />
          ))}
          {ticks.map((k) => (
            <line key={`m${k.t}`} className="axis-major" x1={k.x} x2={k.x} y1={AXIS_H - 6} y2={AXIS_H} />
          ))}
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
              <rect x={nowX - flagW / 2} y={4} width={flagW} height={15} />
              <text x={nowX} y={15.25} textAnchor="middle">
                {nowLabel}
              </text>
              <line x1={nowX} x2={nowX} y1={19} y2={AXIS_H} />
            </g>
          )}
        </svg>
        <Trunk blocks={blocks} head={state.head} waves={waves} width={width} labelW={labelW} x0={x0} now={now} />
      </div>
      {rows.length === 0 ? (
        <div className="tl-empty">
          <p className="tl-empty-title">No transactions on the line yet</p>
          <p className="muted">Start a scripted swarm against this repo, or press Run demo above.</p>
          <pre>{SWARM_CMD}</pre>
        </div>
      ) : (
        <svg className="rows" width={width} height={sheetH}>
          {minor.map((x) => (
            <line key={x} className="grid-minor" x1={x} x2={x} y1={0} y2={sheetH} />
          ))}
          {ticks.map((k) => (
            <line key={k.t} className="grid" x1={k.x} x2={k.x} y1={0} y2={sheetH} />
          ))}
          <line className="gutter" x1={labelW + 0.5} x2={labelW + 0.5} y1={0} y2={sheetH} />
          {waves.map((w) => (
            <g key={w.culprit} className="wave-group">
              <line className="wave" x1={w.x} x2={w.x} y1={0} y2={w.bottom * rowH + laneBox(0, 1, rowH).y - 2} />
              {/* A branch along the top edge of each caught bar, from the guide to where its notch fell. */}
              {w.victims.map((v, i) => {
                const y = v.row * rowH + laneBox(v.lane, v.lanes, rowH).y - 2;
                return <path key={i} className="wave leader" d={`M${w.x} ${y}H${v.x}`} />;
              })}
            </g>
          ))}
          {rows.map((row) => {
            const status = agentStatus(state, row.agent);
            const active = hover && row.bars.some((b) => b.key === hover.bar.key);
            const signal = status ? stateSignal(status.state) : undefined;
            return (
              <g key={row.agent} transform={`translate(0 ${row.index * rowH})`} className={active ? "row hot" : "row"}>
                <rect className="row-bg" x={0} y={0} width={width} height={rowH} />
                <line className="rowline" x1={0} x2={width} y1={rowH - 0.5} y2={rowH - 0.5} />
                <rect className="row-mark" x={0} y={1} width={3} height={rowH - 2} />
                <circle className="agent-dot" data-tone={signal && signal !== "none" && signal !== "recall" ? signal : undefined} cx={pad + 4} cy={rowH / 2} r={3.5} />
                <text className="agent" x={pad + 14} y={rowH / 2} dy="0.35em">
                  <title>{status ? `${row.agent} · ${stateLabel(status.state).replace(/_/g, " ")}` : row.agent}</title>
                  {clipText(row.agent, maxChars)}
                </text>
                {row.bars.map((b) => (
                  <Bar key={b.key} bar={b} rowH={rowH} hovered={hover?.bar.key === b.key} onHover={onHover} />
                ))}
              </g>
            );
          })}
          {showNow && <line className="now" x1={nowX} x2={nowX} y1={0} y2={sheetH} />}
        </svg>
      )}
      {hover && <Path hover={hover} state={state} rows={rows} rowH={rowH} blocks={blocks} scrollTop={scrollTop} width={width} />}
      {hover && <Card hover={hover} state={state} now={now} />}
    </>
  );
}

// The hovered attempt's path, the way a graphic timetable draws a train: down from the commit it set out from to its
// siding, and for a landing, back up into the commit it became. The bar is looked up again in the rows: the one the
// hover holds was laid out when the pointer arrived, and the live window has moved since.
export function Path({ hover, state, rows, rowH, blocks, scrollTop, width }: { hover: Pick<Hover, "bar">; state: LineState; rows: Row[]; rowH: number; blocks: TrunkBlock[]; scrollTop: number; width: number }) {
  const row = rows.find((r) => r.bars.some((b) => b.key === hover.bar.key));
  const bar = row?.bars.find((b) => b.key === hover.bar.key);
  const start = state.txns.get(hover.bar.txn)?.attempts.find((a) => a.attempt === hover.bar.attempt)?.start;
  if (start === undefined || !row || !bar) return null;
  const { from, to } = trainPath(bar, start, state.ticks, blocks);
  if (from === null && to === null) return null;
  const { y, h } = laneBox(bar.lane, bar.lanes, rowH);
  const top = AXIS_H + TRUNK_H + 1 + row.index * rowH + y;
  const trunkY = scrollTop + AXIS_H + LINE_Y;
  return (
    <svg className="paths" width={width} height={top + h + 2} aria-hidden="true">
      {from !== null && (
        <>
          <path className="path-depart" d={`M${from} ${trunkY + 4}L${bar.x} ${top + h / 2}`} />
          <circle className="path-stop" cx={from} cy={trunkY} r={5} />
        </>
      )}
      {to !== null && bar.mark && (
        <>
          {/* A recalled change joined trunk once but no longer does, so its way back is drawn in ink, like its switch. */}
          <path className={bar.strike ? "path-arrive recalled" : "path-arrive"} d={`M${bar.mark.x} ${top}L${to} ${trunkY + 4}`} />
          <circle className={bar.strike ? "path-stop" : "path-stop arrive"} cx={to} cy={trunkY} r={5} />
        </>
      )}
    </svg>
  );
}
