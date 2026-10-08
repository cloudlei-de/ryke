import { useState } from "react";
import { counters, heatAt, type LineState } from "../../../shared/reducers";
import { adminFetch, adminToken, setAdminToken } from "../../live";
import { abortRows, demoResult, formatHeat, HEAT_HOT_AT, heatRows } from "./geometry";

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
      {phase === "token" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            setAdminToken(draft.trim());
            setDraft("");
            void run();
          }}
        >
          <input type="password" aria-label="Admin token" placeholder="admin token" value={draft} autoFocus autoComplete="off" onChange={(e) => setDraft(e.target.value)} />
          <button type="submit">Save and run</button>
          <button type="button" onClick={() => setPhase("idle")}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" disabled={phase === "busy"} onClick={() => (adminToken() ? void run() : setPhase("token"))}>
          {phase === "busy" ? "Starting…" : "Run demo"}
        </button>
      )}
      {msg && (
        <span className="demo-msg mono" data-ok={String(msg.ok)} role="status">
          {msg.text}
        </span>
      )}
    </div>
  );
}

export function Rail({ repo, state, now, files, filesError }: { repo: string; state: LineState; now: number; files: string[] | null; filesError: string | null }) {
  const c = counters(state, now);
  const aborts = abortRows(c.aborts);
  const heat = heatRows(files, heatAt(state, now));
  const hot = heat.filter((h) => h.hot).length;
  return (
    <aside className="rail" aria-label="Status">
      <header className="panel-head">
        <h2>Status</h2>
        <DemoButton repo={repo} />
      </header>
      <dl className="counters">
        <div>
          <dt>in flight</dt>
          <dd className="mono">{c.inflight}</dd>
        </div>
        <div>
          <dt>landed / min</dt>
          <dd className="mono">{c.landedPerMinute}</dd>
          <small className="muted mono">{c.landed} total</small>
        </div>
        <div>
          <dt>trains formed</dt>
          <dd className="mono">{c.trains}</dd>
        </div>
      </dl>
      <section className="aborts" aria-label="Aborts by cause">
        <h3>aborts by cause</h3>
        {aborts.length === 0 ? (
          <p className="muted">none yet</p>
        ) : (
          <ul>
            {aborts.map((a) => (
              <li key={a.cause}>
                <span>{a.label}</span>
                <span className="mono">{a.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="heat" aria-label="Heat map">
        <header className="panel-head">
          <h3>heat</h3>
          <span className="muted mono">{hot > 0 ? `${hot} hot` : `${heat.length} files`}</span>
        </header>
        {filesError && <p className="muted note">file list unavailable ({filesError})</p>}
        {heat.length === 0 && !filesError && <p className="muted note">no files yet</p>}
        <ul className="heat-list">
          {heat.map((h) => (
            <li key={h.path} data-hot={String(h.hot)} data-cold={String(h.value === 0)} title={`${h.path} · heat ${h.value.toFixed(2)}${h.hot ? " · hot" : ""}`}>
              <span className="path mono">{h.path}</span>
              <span className="track" style={{ ["--hot-at" as string]: `${HEAT_HOT_AT * 100}%` }}>
                <span className="fill" style={{ width: `${h.fraction * 100}%` }} />
              </span>
              <span className="val mono">{formatHeat(h.value)}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
