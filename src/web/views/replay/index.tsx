// Replay view (PLAN.md §12 view 5): the Line, rendered from any point in the op log. Felix records the
// demo video from it, so the controls stay small and the Line keeps the room.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Live } from "../../live";
import { LineView } from "../line";
import { describeOp, plain } from "../line/activity";
import { shortData } from "../line/geometry";
import {
  displayNow,
  fmtClock,
  fmtElapsed,
  foldTo,
  historyAt,
  initialPlayer,
  keyAction,
  loadHistory,
  logChanged,
  markers,
  mergeOps,
  newFoldCache,
  opFields,
  opSignal,
  playerReduce,
  prefixMaxTimes,
  SPEEDS,
  type History,
  type Page,
  type PlayerAction,
  type Seen,
} from "./scrub";
import "./replay.css";

// The range input's thumb is this wide (replay.css), so its centre runs from half of it to the width less half.
const THUMB_W = 10;

// 25 renders a second is smooth enough for bars growing on a timetable and leaves the Line room to paint.
const TICK_EVERY_MS = 40;

function useHistory(repo: string, epoch: number): History {
  const [state, setState] = useState<History>({ epoch, ops: [], status: { status: "loading" } });
  useEffect(() => {
    let off = false;
    // The socket may have delivered fewer ops than exist (it resumes from what it has), so page the full log.
    const page = async (after: number, limit: number): Promise<Page> => {
      const r = await fetch(`/api/repos/${encodeURIComponent(repo)}/ops?after=${after}&limit=${limit}`);
      if (!r.ok) throw new Error(`GET ops answered ${r.status}`);
      return (await r.json()) as Page;
    };
    loadHistory(page).then(
      (ops) => !off && setState({ epoch, ops, status: { status: "ok" } }),
      (e: unknown) => !off && setState({ epoch, ops: [], status: { status: "error", message: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      off = true;
    };
  }, [repo, epoch]);
  return historyAt(state, epoch);
}

function Replay({ repo, live }: { repo: string; live: Live }) {
  const history = useHistory(repo, live.epoch);
  const ops = useMemo(() => mergeOps(history.ops, live.ops), [history.ops, live.ops, live.version]);
  const times = useMemo(() => prefixMaxTimes(ops), [ops]);
  const [p, setP] = useState(initialPlayer);

  // Event handlers and the animation loop read the newest log through a ref instead of re-subscribing.
  const timesRef = useRef(times);
  timesRef.current = times;
  const dispatch = useCallback((a: PlayerAction) => setP((prev) => playerReduce(prev, timesRef.current, a)), []);

  const seen = useRef<Seen>({ epoch: live.epoch, length: 0 });
  useEffect(() => {
    const next = logChanged(seen.current, live.epoch, ops.length);
    seen.current = next.seen;
    for (const action of next.actions) dispatch(action);
  }, [ops.length, live.epoch, dispatch]);

  useEffect(() => {
    if (!p.playing) return;
    let raf = 0;
    let prev = performance.now();
    let acc = 0;
    const frame = (now: number) => {
      acc += now - prev;
      prev = now;
      if (acc >= TICK_EVERY_MS) {
        dispatch({ type: "tick", dt: acc });
        acc = 0;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [p.playing, dispatch]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const action = keyAction({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        targetTag: t?.tagName,
        targetType: t instanceof HTMLInputElement ? t.type : undefined,
        editable: t?.isContentEditable,
      });
      if (!action) return;
      e.preventDefault();
      dispatch(action);
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [dispatch]);

  const cache = useRef(newFoldCache());
  // A shallow copy gives the Line a new identity per position even when the fold only advanced the cached
  // state in place, so anything it memoises on `state` recomputes. The Line gets the whole log, not the part
  // played so far: it fixes the time window from it once, and its feed and raw ops stop at the folded state's seq.
  const state = useMemo(() => ({ ...foldTo(cache.current, ops, p.idx) }), [ops, p.idx]);
  const marks = useMemo(() => markers(ops), [ops]);

  const n = ops.length;
  const current = ops[p.idx];
  const start = times[0] ?? 0;
  const now = displayNow(p, times);
  const signal = current ? opSignal(current.kind) : null;
  const fields = current ? opFields(current) : null;
  // After a pointer click the button gives focus back, so space still toggles playback instead of re-pressing it.
  const press = (a: PlayerAction) => (e: MouseEvent<HTMLButtonElement>) => {
    dispatch(a);
    if (e.detail > 0) e.currentTarget.blur();
  };

  const sentence = current ? describeOp(current, state) : null;

  return (
    <section className="replay" aria-label="Replay">
      <div className="replay-stage">
        {n === 0 ? (
          <div className="replay-empty">
            <p className="replay-empty-title">{history.status.status === "loading" ? "Loading the op log" : "Nothing to replay yet"}</p>
            <p className="muted">{history.status.status === "loading" ? `Fetching every op recorded for ${repo}.` : `No ops recorded for ${repo} yet. Run a swarm, then come back.`}</p>
          </div>
        ) : (
          <LineView repo={repo} state={state} ops={ops} mode="replay" now={now} />
        )}
      </div>

      <footer className="scrubber">
        <div className="controls">
          <div className="transport" role="group" aria-label="Playback">
            <button type="button" className="btn btn-sm" onClick={press({ type: "start" })} disabled={n === 0} title="Jump to the start (Home)" aria-label="Jump to the start">
              Start
            </button>
            <button type="button" className="btn btn-sm" onClick={press({ type: "step", by: -1 })} disabled={n === 0} title="Back one op (←)" aria-label="Back one op">
              −1 op
            </button>
            <button type="button" className="btn btn-primary play" onClick={press({ type: "toggle" })} disabled={n === 0} title="Play or pause (space)" aria-pressed={p.playing} aria-label={p.playing ? "Pause" : "Play"}>
              {p.playing ? "Pause" : "Play"}
            </button>
            <button type="button" className="btn btn-sm" onClick={press({ type: "step", by: 1 })} disabled={n === 0} title="Forward one op (→)" aria-label="Forward one op">
              +1 op
            </button>
            <button type="button" className="btn btn-sm" onClick={press({ type: "end" })} disabled={n === 0} title="Jump to the end (End)" aria-label="Jump to the end">
              End
            </button>
          </div>
          <div className="seg" role="group" aria-label="Speed">
            {SPEEDS.map((sp) => (
              <button key={sp} type="button" aria-pressed={p.speed === sp} onClick={press({ type: "speed", speed: sp })} title={`Play at ${sp}× real time`}>
                {sp}×
              </button>
            ))}
          </div>
          <div className="readout num">
            <span className="elapsed">{fmtElapsed(now - start)}</span>
            <span className="muted"> / {fmtElapsed((times.at(-1) ?? 0) - start)}</span>
          </div>
          <p className="current" data-tone={signal ?? undefined}>
            {fields ? (
              <>
                <span className="current-seq mono">
                  op {fields.seq} · {fields.kind}
                </span>
                <span className="current-text">{sentence ? plain([sentence.actor ? `${sentence.actor} ` : "", ...sentence.text, sentence.subject ? " · " : "", sentence.subject]) : current ? [current.agent, shortData(current)].filter(Boolean).join(" · ") : ""}</span>
              </>
            ) : (
              <span className="muted">no op</span>
            )}
          </p>
          <span className="status muted">
            {history.status.status === "loading" && "loading history · "}
            {history.status.status === "error" && `history unavailable (${history.status.message}) · `}
            <span className="num">{n}</span> ops
          </span>
        </div>

        <div className="scrub-track">
          <div className="marks" aria-hidden="true">
            {marks.map((m, i) => (
              <i key={i} data-tone={m.tone} style={{ left: `calc(${m.at * 100}% + ${THUMB_W / 2 - m.at * THUMB_W}px)` }} />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, n - 1)}
            step={1}
            value={Math.min(p.idx, Math.max(0, n - 1))}
            disabled={n < 2}
            onChange={(e) => dispatch({ type: "seek", idx: Number(e.target.value) })}
            aria-label="Position in the op log"
            aria-valuetext={fields ? `op ${fields.seq}, ${fields.kind}` : undefined}
            style={{ ["--fill" as string]: `${n > 1 ? (Math.min(p.idx, n - 1) / (n - 1)) * 100 : 0}%` }}
          />
          <div className="ends num">
            <span>{n > 0 ? fmtClock(start) : ""}</span>
            <span>{current ? fmtClock(now) : ""}</span>
            <span>{n > 0 ? fmtClock(times.at(-1)!) : ""}</span>
          </div>
        </div>
      </footer>
    </section>
  );
}

// Keyed by repo so switching repos starts a clean player and fold cache.
export function ReplayView({ repo, live }: { repo: string; live: Live }) {
  return <Replay key={repo} repo={repo} live={live} />;
}
