import type { LineState } from "../../../shared/reducers";
import type { Op } from "../../../shared/types";
import { activityStart, AXIS_H, axisTicks, buildRows, formatClock, layoutTrunk, liveWindow, LIVE_MAX_MS, opBounds, plotBox, replayWindow, rowHeight, toX, type Scale } from "./geometry";
import { useFiles, useNow, useSize } from "./hooks";
import "./line.css";
import { Rail } from "./Rail";
import { Sidings } from "./Sidings";
import { Ticker } from "./Ticker";
import { Trunk } from "./Trunk";

// Renders the Line from any folded state: live (now = wall clock) or replay (now = scrubbed time).
export function LineView({ repo, state, ops, mode, now: nowProp }: { repo: string; state: LineState; ops: Op[]; mode: "live" | "replay"; now?: number }) {
  const now = useNow(mode, nowProp, state.now);
  const [scrollRef, { width, height }] = useSize<HTMLDivElement>();
  const files = useFiles(repo, state.head ? (mode === "live" ? state.head.sha : "replay") : null);
  const tzOffsetMin = -new Date().getTimezoneOffset();

  const plot = plotBox(width);
  const win =
    mode === "live"
      ? liveWindow(now, activityStart(state, now - LIVE_MAX_MS))
      : (() => {
          const { first, last } = opBounds(ops);
          return replayWindow(first, last, now);
        })();
  const scale: Scale = { t0: win.start, t1: win.end, x0: plot.x0, x1: plot.x1 };
  const rows = buildRows(state, scale, now);
  const rowH = rowHeight(rows.length, height - AXIS_H);
  const blocks = layoutTrunk(state.ticks, scale);
  const ticks = axisTicks(win, plot.x1 - plot.x0, tzOffsetMin).map((k) => ({ ...k, x: toX(scale, k.t) }));

  return (
    <div className="line">
      <svg className="defs" width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <pattern id="ryke-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="hatch-bg" width="5" height="5" />
            <line className="hatch-line" x1="0.5" y1="0" x2="0.5" y2="5" />
          </pattern>
        </defs>
      </svg>
      <div className="line-main">
        <Trunk blocks={blocks} head={state.head} x0={plot.x0} x1={plot.x1} width={width} now={now} />
        <Sidings
          rows={rows}
          rowH={rowH}
          ticks={ticks}
          nowX={toX(scale, now)}
          nowLabel={mode === "live" ? "now" : formatClock(now, 1000, tzOffsetMin)}
          width={width}
          labelW={plot.labelW}
          x1={plot.x1}
          empty={state.txns.size === 0}
          scrollRef={scrollRef}
        />
        <Ticker ops={state.ticker} />
      </div>
      <Rail repo={repo} state={state} now={now} files={files.files} filesError={files.error} />
    </div>
  );
}
