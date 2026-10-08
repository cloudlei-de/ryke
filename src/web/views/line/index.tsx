import { useState } from "react";
import { heatAt, type LineState } from "../../../shared/reducers";
import type { Op } from "../../../shared/types";
import { simulationTag } from "../../agents";
import { adminFetch, adminToken, setAdminToken } from "../../live";
import { Icon } from "../../ui";
import { RecallButton } from "../recall";
import { activityStart, AXIS_H, axisTicks, buildRows, demoResult, formatClock, heatRows, layoutTrunk, liveWindow, LIVE_MAX_MS, opBounds, plotBox, replayWindow, rowHeight, staleWaves, toX, type Scale } from "./geometry";
import { useFiles, useNow, useSize } from "./hooks";
import "./line.css";
import { Activity, HotFiles } from "./Side";
import { StatStrip } from "./Stats";
import { stats } from "./stats";
import { Lanes, Legend, Patterns, TRUNK_H } from "./Timeline";

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
          <Icon name="play" size={13} />
          {phase === "busy" ? "Starting…" : "Run demo"}
        </button>
      )}
    </div>
  );
}

// Renders the Line from any folded state: live (now = wall clock) or replay (now = scrubbed time).
export function LineView({ repo, state, ops, mode, now: nowProp }: { repo: string; state: LineState; ops: Op[]; mode: "live" | "replay"; now?: number }) {
  const now = useNow(mode, nowProp, state.now);
  const [bodyRef, { width, height }] = useSize<HTMLDivElement>();
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
  const phone = width < 640;
  const rowH = phone ? PHONE_ROW_H : rowHeight(rows.length, height - AXIS_H - TRUNK_H);
  const blocks = layoutTrunk(state.ticks, scale);
  const waves = staleWaves(rows, blocks);
  const ticks = axisTicks(win, plot.x1 - plot.x0, tzOffsetMin).map((k) => ({ ...k, x: toX(scale, k.t) }));
  const simulation = simulationTag([...state.txns.values()].map((t) => t.model));
  const s = stats(state, now);

  return (
    <div className="line" data-mode={mode}>
      <Patterns />
      <div className="line-head">
        <div className="line-title">
          <h1>{repo}</h1>
          {mode === "live" ? (
            <span className="pill" data-tone="go">
              <i className="dot" data-tone="go" />
              Live
            </span>
          ) : (
            <span className="pill">
              <Icon name="clock" size={12} />
              Replay · {formatClock(now, 1000, tzOffsetMin)}
            </span>
          )}
          {simulation && (
            <span className="tag sim-tag" title={simulation.title}>
              <Icon name="info" size={12} />
              {simulation.text}
            </span>
          )}
        </div>
        <div className="line-actions">
          {mode === "live" && <DemoButton repo={repo} />}
          {/* A recall acts on the live trunk, so the replay's historic state must not offer one. */}
          <RecallButton repo={repo} state={state} reason={mode === "replay" ? "Recall acts on the live trunk; open the Line view" : undefined} />
        </div>
      </div>
      <StatStrip s={s} now={now} />
      <div className="line-grid">
        <section className="card timeline" aria-label="Timeline">
          <header className="card-head">
            <h2>Agents</h2>
            <span className="count">{rows.length}</span>
            <span className="spacer" />
            <Legend />
          </header>
          <div className="tl-body" ref={bodyRef}>
            <Lanes
              state={state}
              rows={rows}
              rowH={rowH}
              width={width}
              labelW={plot.labelW}
              x0={plot.x0}
              x1={plot.x1}
              ticks={ticks}
              nowX={toX(scale, now)}
              nowLabel={mode === "live" ? "now" : formatClock(now, 1000, tzOffsetMin)}
              blocks={blocks}
              waves={waves}
              now={now}
            />
          </div>
        </section>
        <aside className="line-side">
          <HotFiles heat={heatRows(files.files, heatAt(state, now))} leases={state.leases} error={files.error} />
          <Activity ops={ops} state={state} now={now} />
        </aside>
      </div>
    </div>
  );
}
