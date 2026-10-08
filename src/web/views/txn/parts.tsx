import { useState, type CSSProperties, type FormEvent } from "react";
import { MAX_ATTEMPTS } from "../../../shared/types";
import { adminFetch, adminToken, setAdminToken } from "../../live";
import {
  clock,
  diffLines,
  diffStat,
  duration,
  reasonLabel,
  shortSha,
  stateLabel,
  stateSignal,
  type AttemptDetail,
  type AttemptRow,
  type Detail,
  type DiffKind,
  type EvidenceView,
  type Failure,
  type PathFlag,
  type PathRow,
  type Signal,
  type VerdictRow,
} from "./format";

// Open is an outline, submitted and ready are hatched, everything else is a signal (PLAN.md §12).
const HATCHED = new Set(["submitted", "ready"]);

export function Lamp({ signal, hatched = false }: { signal: Signal; hatched?: boolean }) {
  return <i className="txn-lamp" data-signal={signal} data-hatched={hatched || undefined} aria-hidden="true" />;
}

export function Chip({ state }: { state: string }) {
  return (
    <span className="txn-chip" data-state={state}>
      <Lamp signal={stateSignal(state)} hatched={HATCHED.has(state)} />
      {stateLabel(state)}
    </span>
  );
}

function TxnLink({ id }: { id: string }) {
  return /^t_[a-z0-9]+$/i.test(id) ? <a href={`#/t/${encodeURIComponent(id)}`}>{id}</a> : <>{id}</>;
}

export function Heading({ title, count }: { title: string; count?: number | string }) {
  return (
    <h2 className="txn-h">
      {title}
      {count !== undefined && <span className="count">{count}</span>}
    </h2>
  );
}

// ------------------------------------------------------------------------------------ header

export function Header({ detail, preview }: { detail: Detail; preview: AttemptDetail["preview"] }) {
  const { txn } = detail;
  const commit = preview?.kind === "commit" ? preview : null;
  return (
    <header className="txn-head">
      <div className="txn-title">
        <h1 className="txn-id mono">{txn.id}</h1>
        <Chip state={txn.state} />
        {txn.reason && <span className="muted">{reasonLabel(txn.reason)}</span>}
        {detail.detail.approved && <span className="txn-tag">approved by a human</span>}
      </div>
      <p className="txn-intent">{txn.intent}</p>
      <dl className="txn-meta">
        <div>
          <dt>Agent</dt>
          <dd className="mono">{txn.agent}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className="mono">{txn.model ?? "—"}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd className="mono">
            {txn.attempt}/{MAX_ATTEMPTS}
          </dd>
        </div>
        {commit && (
          <div>
            <dt>Commit</dt>
            <dd className="mono">
              <a href={commit.url} target="_blank" rel="noreferrer" title={`${commit.sha}: open the preview of this commit`}>
                {shortSha(commit.sha)} ↗
              </a>
            </dd>
          </div>
        )}
      </dl>
      <div className="txn-criteria">
        <h2 className="txn-label">Acceptance criteria</h2>
        {txn.criteria.length > 0 ? (
          <ol>
            {txn.criteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        ) : (
          <p className="muted">None given; the intent is the one criterion.</p>
        )}
      </div>
    </header>
  );
}

// ------------------------------------------------------------------------------------ human gate

export function Gate({ id, reason, reload }: { id: string; reason: string | null; reload: () => void }) {
  const [token, setToken] = useState(adminToken);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (verb: "approve" | "reject") => {
    setBusy(verb);
    setError(null);
    try {
      const res = await adminFetch(`/api/txns/${encodeURIComponent(id)}/${verb}`, {});
      if (res.status === 401) {
        setAdminToken(null);
        setToken(null);
        setError("The admin token was rejected. Enter it again.");
      } else if (!res.ok) {
        setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `The ledger answered ${res.status}.`);
      } else reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    setAdminToken(t);
    setToken(t);
    setDraft("");
    setError(null);
  };

  return (
    <section className="txn-gate" aria-label="Human decision">
      <div>
        <strong>Waiting for a human</strong>
        {reason && <span className="muted"> · {reasonLabel(reason)}</span>}
        <p className="muted">Approving sends it back through a train, so it still has to pass verify before it lands.</p>
      </div>
      <div className="txn-gate-actions">
        <button type="button" disabled={!token || busy !== null} onClick={() => void decide("approve")}>
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        <button type="button" disabled={!token || busy !== null} onClick={() => void decide("reject")}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {!token && (
        <form className="txn-token" onSubmit={save}>
          <label>
            <span className="txn-label">Admin token</span>
            <input type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="RYKE_TOKEN" />
          </label>
          <button type="submit" disabled={draft.trim() === ""}>
            Set token
          </button>
        </form>
      )}
      {error && (
        <p className="txn-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------ attempts

function StaleCause({ row }: { row: AttemptRow }) {
  const shown = row.stale.slice(0, 3);
  return (
    <>
      {shown.map((p) => (
        <span key={p.path} className="txn-cause">
          <code>{p.path}</code>
          {p.by && (
            <>
              {" ← "}
              <TxnLink id={p.by} />
            </>
          )}
        </span>
      ))}
      {row.stale.length > shown.length && <span className="muted"> +{row.stale.length - shown.length} more</span>}
    </>
  );
}

export function Timeline({ rows, selected }: { rows: AttemptRow[]; selected: number }) {
  if (rows.length === 0) return <p className="muted">No attempts recorded.</p>;
  return (
    <ol className="txn-line">
      <li className="txn-row txn-row-head" aria-hidden="true">
        <span>#</span>
        <span>Snapshot</span>
        <span>Start</span>
        <span>End</span>
        <span>Took</span>
        <span>Outcome</span>
        <span>Reason</span>
      </li>
      {rows.map((r) => (
        <li key={r.attempt} className="txn-row" data-selected={r.attempt === selected || undefined}>
          <span className="mono" data-label="Attempt">
            {r.attempt}
          </span>
          <span className="mono" data-label="Snapshot" title={r.snapshot ?? undefined}>
            {shortSha(r.snapshot) || "—"}
          </span>
          <span className="mono" data-label="Start">
            {clock(r.start)}
          </span>
          <span className="mono" data-label="End">
            {clock(r.end)}
          </span>
          <span className="mono" data-label="Took">
            {r.end === null ? "—" : duration(r.end - r.start)}
          </span>
          <span data-label="Outcome">
            <Chip state={r.outcome ?? r.state} />
          </span>
          <span className="txn-reason">
            {reasonLabel(r.reason)}
            {r.stale.length > 0 && (
              <>
                {r.reason ? " · " : ""}
                <StaleCause row={r} />
              </>
            )}
            {r.conflicts.length > 0 && (
              <>
                {r.reason === "text_conflict" ? " · " : " · text conflict "}
                {r.conflicts.map((p) => (
                  <span key={p} className="txn-cause">
                    <code>{p}</code>
                  </span>
                ))}
              </>
            )}
            {r.failures.length > 0 && <> · {r.failures.map((f) => f.name).join(", ")}</>}
            {r.bisected && <span className="txn-tag">isolated by bisection</span>}
            {r.approved && <span className="txn-tag">approved</span>}
          </span>
          {r.warnings.length > 0 && (
            <ul className="txn-warnings">
              {r.warnings.map((w, i) => (
                <li key={i} title={w.paths.join("\n") || undefined}>
                  <i className="txn-tick" aria-hidden="true" />
                  <span className="mono">{clock(w.at)}</span> {w.text}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------------------------ attempt picker

export function AttemptPicker({ attempts, selected, onPick }: { attempts: number[]; selected: number; onPick: (n: number) => void }) {
  return (
    <div className="txn-picker" role="group" aria-label="Attempt">
      <span className="txn-label">Attempt</span>
      {attempts.map((n) => (
        <button key={n} type="button" aria-pressed={n === selected} onClick={() => onPick(n)}>
          {n}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------ paths and delta

const FLAG_TEXT: Record<PathFlag, string> = { stale: "stale", conflict: "text conflict", protected: "protected", warned: "changed on trunk" };
const FLAG_SIGNAL: Record<PathFlag, Signal> = { stale: "stop", conflict: "stop", protected: "stop", warned: "caution" };
const MARK: Record<DiffKind, string> = { file: "", meta: "", hunk: "", ctx: " ", add: "+", del: "−" };

export function Diff({ patch }: { patch: string }) {
  const lines = diffLines(patch).filter((l) => l.kind !== "file");
  const stat = diffStat(lines);
  return (
    <figure className="txn-diff">
      <figcaption className="mono">
        delta on trunk since the snapshot <span data-kind="add">+{stat.added}</span> <span data-kind="del">−{stat.removed}</span>
      </figcaption>
      <div className="txn-diff-scroll">
        <div className="txn-diff-body mono">
          {lines.map((l, i) => (
            <div key={i} className="txn-ln" data-kind={l.kind}>
              <span className="no">{l.old ?? ""}</span>
              <span className="no">{l.new ?? ""}</span>
              <span className="no one">{l.new ?? l.old ?? ""}</span>
              <span className="mark">{MARK[l.kind]}</span>
              <span className="tx">{l.text}</span>
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

export function PathList({ title, rows, none }: { title: string; rows: PathRow[]; none: string }) {
  const flagged = rows.filter((r) => r.flags.some((f) => f !== "warned")).length;
  return (
    <section className="txn-col">
      <Heading title={title} count={flagged > 0 ? `${rows.length} · ${flagged} flagged` : rows.length} />
      {rows.length === 0 ? (
        <p className="muted">{none}</p>
      ) : (
        <ul className="txn-paths">
          {rows.map((r) => (
            <li key={r.path} className="txn-path" data-flag={r.flags[0]}>
              <div className="txn-path-line">
                {r.flags.map((f) => (
                  <span key={f} className="txn-flag">
                    <Lamp signal={FLAG_SIGNAL[f]} />
                    {FLAG_TEXT[f]}
                  </span>
                ))}
                <code>{r.path}</code>
                {r.by && (
                  <span className="muted">
                    {" ← "}
                    <TxnLink id={r.by} />
                  </span>
                )}
              </div>
              {r.delta ? <Diff patch={r.delta} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------ verdicts

export function Verdicts({ rows }: { rows: VerdictRow[] }) {
  return (
    <section className="txn-col">
      <Heading title="Verdicts" count={rows.length} />
      {rows.length === 0 ? (
        <p className="muted">None for this attempt. Jev answers after verify has passed.</p>
      ) : (
        <ul className="txn-verdicts">
          {rows.map((v) => (
            <li key={v.name} data-signal={v.signal}>
              <Lamp signal={v.signal} />
              <span className="mono txn-verdict-text">{v.text}</span>
              {v.type === "noul" && (
                <span className="txn-gauge" style={{ "--v": v.value } as CSSProperties} role="img" aria-label={`${v.name} ${v.value.toFixed(2)}`}>
                  <i />
                  {v.thresholds.map((t) => (
                    <b key={t} style={{ "--at": t } as CSSProperties} />
                  ))}
                </span>
              )}
              {v.source && <span className="muted txn-source">{v.source}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------ evidence

function Failures({ failures }: { failures: Failure[] }) {
  return (
    <ul className="txn-failures">
      {failures.map((f, i) => (
        <li key={i}>
          <div className="txn-fail-name">
            <Lamp signal="stop" />
            <code>{f.name}</code>
          </div>
          <pre>{f.message}</pre>
        </li>
      ))}
    </ul>
  );
}

export function Evidence({ view, failures, preview }: { view: EvidenceView; failures: Failure[]; preview: AttemptDetail["preview"] }) {
  // The screenshot route may not exist on every deployment; a broken image is hidden, not shown.
  const [broken, setBroken] = useState<string | null>(null);
  const empty = !view.tests && !view.agentScreenshot && !view.agentSummary && !view.imageUrl && view.other.length === 0 && failures.length === 0;
  return (
    <section className="txn-col txn-evidence">
      <Heading title="Evidence" />
      {empty && <p className="muted">Nothing recorded for this attempt yet.</p>}
      {view.tests && (
        <p className="txn-tests">
          <Lamp signal={view.tests.signal} />
          <span className="txn-label">Tests</span> <span className="mono">{view.tests.summary}</span>
        </p>
      )}
      {failures.length > 0 && <Failures failures={failures} />}
      {view.agentSummary && (
        <p>
          <span className="txn-label">Agent summary</span> <span className="txn-tag">agent-provided</span>
          <br />
          {view.agentSummary}
        </p>
      )}
      {(view.agentScreenshot || (view.imageUrl && broken !== view.imageUrl)) && (
        <figure className="txn-shot">
          {view.imageUrl && broken !== view.imageUrl && (
            <img src={view.imageUrl} alt="Screenshot of the converter at the end of this attempt" onError={() => setBroken(view.imageUrl)} />
          )}
          {view.agentScreenshot && (
            <figcaption>
              <span className="txn-label">Screenshot</span> <span className="txn-tag">agent-provided</span>
              <br />
              {view.agentScreenshot}
            </figcaption>
          )}
        </figure>
      )}
      {view.other.map((o, i) => (
        <p key={i}>
          <span className="txn-label">{o.kind}</span> <span className="mono">{o.summary}</span>
        </p>
      ))}
      {preview && (
        <p>
          <a href={preview.url} target="_blank" rel="noreferrer">
            {preview.kind === "commit" ? "Preview of the landed commit" : "Preview of the trunk this attempt started from"} <span className="mono">{shortSha(preview.sha)}</span> ↗
          </a>
        </p>
      )}
    </section>
  );
}
