import { useState } from "react";
import { heatAt, type LineState } from "../../../shared/reducers";
import type { Op } from "../../../shared/types";
import { simulationTag } from "../../agents";
import { adminFetch, adminToken, setAdminToken } from "../../live";
import { Lamp } from "../../ui";
import { RecallButton } from "../recall";
import { activityStart, AXIS_H, axisTicks, buildRows, demoResult, formatClock, heatRows, idleView, layoutTrunk, liveWindow, LIVE_MAX_MS, minorTicks, opBounds, plotBox, replayWindow, rowHeight, scaleNote, shortSha, staleWaves, toX, type Scale } from "./geometry";
import { useFiles, useMedia, useNow, useSize } from "./hooks";
import "./line.css";
import { Counters } from "./Counters";
import { Activity, HotFiles } from "./Side";
import { ago, stats, type Stats } from "./stats";
import { Lanes, Legend, TRUNK_H } from "./Timeline";

// A phone has no screen height to share out, so its rows keep one comfortable height and the page scrolls.
const PHONE_ROW_H = 26;

// Admin only: starts the scripted swarm inside the platform (PLAN.md §11.2). With no token stored it asks
// for one inline; any failure shows its HTTP status, because the endpoint may not exist on this deployment yet.
function DemoButton({ repo }: { repo: string }) {
  const [phase, setPhase] = useState<"idle" | "token" | "busy">("idle");
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async () => {
    setPhase("busy");
    setMsg(null);
    try {
      const res = await adminFetch(`/api/demo/${encodeURIComponent(repo)}/start`, { mode: "scripted", agents: 12 });
      const r = demoResult(res.status, await res.text().catch(() => ""));
      setMsg({ ok: r.ok, text: r.text });
      setPhase(r.needsToken ? "token" : "idle");
    } catch {
      setMsg({ ok: false, text: "network error" });
      setPhase("idle");
    }
  };

  return (
    <div className="demo">
      {msg && (
        <span className="demo-msg" data-ok={String(msg.ok)} role="status">
          {msg.text}
        </span>
      )}
      {phase === "token" ? (
        <form
          className="demo-token"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            setAdminToken(draft.trim());
            setDraft("");
            void run();
          }}
        >
          <input className="input" type="password" aria-label="Admin token" placeholder="Admin token" value={draft} autoFocus autoComplete="off" onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="btn btn-primary">
            Save and run
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setPhase("idle")}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="btn" disabled={phase === "busy"} onClick={() => (adminToken() ? void run() : setPhase("token"))}>
          {phase === "busy" ? "Starting…" : "Run demo"}
        </button>
      )}
    </div>
  );
}

// The corner of the sheet that says what is drawn: trunk's head, the scale of the time grid, and the moment shown.
function TitleBlock({ s, now, scale, mode, tz }: { s: Stats; now: number; scale: string; mode: "live" | "replay"; tz: number }) {
  const age = s.head?.at != null ? ago(now - s.head.at) : null;
  return (
    <dl className="title-block" aria-label="Title block">
      <div className="tb-head">
        <dt>Trunk head</dt>
        <dd>
          {s.head ? (
            <>
              seq {s.head.seq} · <span className="mono">{shortSha(s.head.sha)}</span>
              {age && <span className="muted"> · {age === "now" ? "just now" : `${age} ago`}</span>}
            </>
          ) : (
            "no commits yet"
          )}
        </dd>
      </div>
      <div>
        <dt>Scale</dt>
        <dd>{scale || "—"}</dd>
      </div>
      <div>
        <dt>{mode === "live" ? "Drawn at" : "Replayed at"}</dt>
        <dd>{formatClock(now, 1000, tz)}</dd>
      </div>
    </dl>
  );
}

// Renders the Line from any folded state: live (now = wall clock) or replay (now = scrubbed time).
// `connected` is the live socket's state; a live Line that lost it says so instead of claiming to be live.
export function LineView({ repo, state, ops, mode, now: nowProp, connected = true }: { repo: string; state: LineState; ops: Op[]; mode: "live" | "replay"; now?: number; connected?: boolean }) {
  const now = useNow(mode, nowProp, state.now);
  const [bodyRef, { width, height }] = useSize<HTMLDivElement>();
  // At 1080 px and below the sidings take their own height and the page scrolls (line.css); only a panel that
  // scrolls by itself has a height for the grid to fill.
  const sheet = useMedia("(min-width: 1081px)");
  const files = useFiles(repo, state.head ? (mode === "live" ? state.head.sha : "replay") : null);
  const tzOffsetMin = -new Date().getTimezoneOffset();

  const plot = plotBox(width);
  const idle = mode === "live" ? idleView(state, now) : null;
  const win =
    mode === "live"
      ? (idle?.window ?? liveWindow(now, activityStart(state, now - LIVE_MAX_MS)))
      : (() => {
          const { first, last } = opBounds(ops);
          return replayWindow(first, last, now);
        })();
  const scale: Scale = { t0: win.start, t1: win.end, x0: plot.x0, x1: plot.x1 };
  const rows = buildRows(state, scale, now);
  const phone = width < 640;
  // The 1 is the rule under the sticky axis and trunk.
  const rowsH = height - AXIS_H - TRUNK_H - 1;
  const rowH = phone ? PHONE_ROW_H : rowHeight(rows.length, rowsH);
  // A phone's plot is a third of a desktop's: its commits sit closer together.
  const blocks = layoutTrunk(state.ticks, scale, phone ? 6 : undefined);
  const waves = staleWaves(rows, blocks);
  const ticks = axisTicks(win, plot.x1 - plot.x0, tzOffsetMin).map((k) => ({ ...k, x: toX(scale, k.t) }));
  const minor = minorTicks(win, plot.x1 - plot.x0, tzOffsetMin).map((t) => toX(scale, t));
  const simulation = simulationTag([...state.txns.values()].map((t) => t.model));
  const s = stats(state, now);

  return (
    <div className="line" data-mode={mode}>
      <header className="line-head">
        <div className="line-title">
          <h1>{repo}</h1>
          {mode === "live" ? (
            <Lamp tone={connected ? "go" : "stop"} live={connected} title={connected ? "Receiving the op stream" : "The op stream is not connected; reconnecting"}>
              {connected ? "Live" : "Reconnecting"}
            </Lamp>
          ) : (
            <span className="lamp">Replay · {formatClock(now, 1000, tzOffsetMin)}</span>
          )}
          {idle && (
            <span className="line-note" title="The timeline shows the last activity; Replay plays it back.">
              Quiet for {ago(now - idle.last)} · showing the last activity
            </span>
          )}
          {simulation && (
            <span className="tag sim-tag" title={simulation.title}>
              {simulation.text}
            </span>
          )}
        </div>
        <div className="line-actions">
          {mode === "live" && <DemoButton repo={repo} />}
          {/* A recall acts on the live trunk, so the replay's historic state must not offer one. */}
          <RecallButton repo={repo} state={state} reason={mode === "replay" ? "Recall acts on the live trunk; open the Line view" : undefined} />
        </div>
      </header>
      <div className="line-grid">
        <section className="timeline" aria-label="Timeline">
          <header className="sect-head">
            <h2>Sidings</h2>
            <span className="count">
              {rows.length} {rows.length === 1 ? "agent" : "agents"} against trunk
            </span>
          </header>
          <div className="tl-body" ref={bodyRef}>
            <Lanes
              state={state}
              rows={rows}
              rowH={rowH}
              fillH={sheet && !phone ? rowsH : 0}
              width={width}
              labelW={plot.labelW}
              x0={plot.x0}
              x1={plot.x1}
              ticks={ticks}
              minor={minor}
              nowX={toX(scale, now)}
              nowLabel={mode === "live" ? "now" : formatClock(now, 1000, tzOffsetMin)}
              blocks={blocks}
              waves={waves}
              now={now}
              scrollTop={bodyRef.current?.scrollTop ?? 0}
            />
          </div>
        </section>
        <aside className="line-side">
          <Counters s={s} />
          <HotFiles heat={heatRows(files.files, heatAt(state, now))} leases={state.leases} error={files.error} />
          <Activity ops={ops} state={state} now={now} />
        </aside>
      </div>
      <footer className="line-foot">
        <div className="key">
          <span className="key-title">Key</span>
          <Legend />
        </div>
        <TitleBlock s={s} now={now} scale={scaleNote(win, plot.x1 - plot.x0)} mode={mode} tz={tzOffsetMin} />
      </footer>
    </div>
  );
}
