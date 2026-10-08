import type { LineState } from "../../../shared/reducers";
import { isArriving, shortSha, type TrunkBlock } from "./geometry";

const LINE_Y = 40;

// The main line (PLAN.md §12): a tick per landed commit, a train as a block of ticks, head and seq at the right.
export function Trunk({ blocks, head, x0, x1, width, now }: { blocks: TrunkBlock[]; head: LineState["head"]; x0: number; x1: number; width: number; now: number }) {
  return (
    <section className="trunk" aria-label="Trunk">
      <svg width={width} height={72} role="img" aria-label={head ? `Trunk head ${shortSha(head.sha)}, seq ${head.seq}` : "Trunk, no commits yet"}>
        <text className="cap" x={8} y={14}>
          Trunk
        </text>
        <text className="head" x={x1} y={14} textAnchor="end">
          {head ? (
            <>
              <tspan className="cap">head </tspan>
              {shortSha(head.sha)}
              <tspan className="cap"> · seq </tspan>
              {head.seq}
            </>
          ) : (
            <tspan className="cap">no commits yet</tspan>
          )}
        </text>
        <line className="mainline" x1={x0 - 12} x2={width - 2} y1={LINE_Y} y2={LINE_Y} />
        {blocks.map((b) => (
          <g key={b.key} className={isArriving(b.at, now) ? "block arrive" : "block"}>
            {b.ticks.length > 1 && <rect className="block-box" x={b.x - 4} y={24} width={b.w + 8} height={32} />}
            {b.ticks.map((t) => (
              <g key={t.key}>
                <title>{t.title}</title>
                <rect className="tick-hit" x={t.x - 3} y={22} width={7} height={36} />
                <line className={t.txn ? "tick" : t.recall ? "tick recall" : "tick seed"} x1={t.x} x2={t.x} y1={t.txn ? 30 : 24} y2={t.txn ? 50 : 56} />
              </g>
            ))}
            {b.ticks.length > 1 && (
              <text className="cap" x={b.x + b.w / 2} y={67} textAnchor="middle">
                ×{b.ticks.length}
              </text>
            )}
          </g>
        ))}
      </svg>
    </section>
  );
}
