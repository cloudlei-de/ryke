// Replay view (PLAN.md §12 view 5): the Line, rendered from any point in the op log. Felix records the
// demo video from it, so the controls stay small and the Line keeps the room.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Live } from "../../live";
import { LineView } from "../line";
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
  // played so far: it only uses it to fix the time window once, and the folded state already hides the future.
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

  return (
    <section className="replay" aria-label="Replay">
      <div className="replay-stage">
        {n === 0 ? (
          <p className="replay-empty muted">
            {history.status.status === "loading" ? `Loading the op log of ${repo}.` : `No ops recorded for ${repo} yet. Run a swarm, then come back.`}
          </p>
        ) : (
          <LineView repo={repo} state={state} ops={ops} mode="replay" now={now} />
        )}
      </div>

      <footer className="scrubber">
        <div className="controls">
          <div className="group" role="group" aria-label="Playback">
            <button type="button" onClick={press({ type: "start" })} disabled={n === 0} title="Jump to the start (Home)" aria-label="Jump to the start">
              |&lt;
            </button>
            <button type="button" onClick={press({ type: "step", by: -1 })} disabled={n === 0} title="Back one op (←)" aria-label="Back one op">
              &lt;
            </button>
            <button type="button" className="play" onClick={press({ type: "toggle" })} disabled={n === 0} title="Play or pause (space)" aria-pressed={p.playing}>
              {p.playing ? "Pause" : "Play"}
            </button>
            <button type="button" onClick={press({ type: "step", by: 1 })} disabled={n === 0} title="Forward one op (→)" aria-label="Forward one op">
              &gt;
            </button>
            <button type="button" onClick={press({ type: "end" })} disabled={n === 0} title="Jump to the end (End)" aria-label="Jump to the end">
              &gt;|
            </button>
          </div>
          <div className="group" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} type="button" aria-pressed={p.speed === s} onClick={press({ type: "speed", speed: s })} title={`Play at ${s}× real time`}>
                {s}×
              </button>
            ))}
          </div>
          <div className="readout mono">
            <span className="elapsed">{fmtElapsed(now - start)}</span>
            <span className="muted"> / {fmtElapsed((times.at(-1) ?? 0) - start)}</span>
            {current && <span className="muted"> · {fmtClock(now)}</span>}
          </div>
          <span className="spacer" />
          <span className="muted status">
            {history.status.status === "loading" && "loading history · "}
            {history.status.status === "error" && `history unavailable (${history.status.message}) · `}
            <span className="mono">{n}</span> ops
          </span>
        </div>

        <div className="track">
          <div className="marks" aria-hidden="true">
            {marks.map((m, i) => (
              <i key={i} data-tone={m.tone} style={{ left: `calc(${m.at * 100}% + ${5 - m.at * 10}px)` }} />
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
          />
          <div className="ends mono muted">
            <span>{n > 0 ? fmtClock(start) : ""}</span>
            <span>{n > 0 ? fmtClock(times.at(-1)!) : ""}</span>
          </div>
        </div>

        <p className="current mono" data-signal={signal ?? undefined}>
          {fields ? (
            <>
              <span className="muted">op</span> <b>{fields.seq}</b>
              <span className="sep">·</span>
              <span className="kind">{fields.kind}</span>
              <span className="sep">·</span>
              <span className="muted">txn</span> {fields.txn}
              <span className="sep">·</span>
              <span className="muted">agent</span> {fields.agent}
            </>
          ) : (
            <span className="muted">no op</span>
          )}
        </p>
      </footer>
    </section>
  );
}

// Keyed by repo so switching repos starts a clean player and fold cache.
export function ReplayView({ repo, live }: { repo: string; live: Live }) {
  return <Replay key={repo} repo={repo} live={live} />;
}
