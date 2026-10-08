import { useState, type CSSProperties, type FormEvent } from "react";
import type { TxnView } from "../../../shared/reducers";
import { MAX_ATTEMPTS } from "../../../shared/types";
import { simulationOf } from "../../agents";
import { adminFetch, adminToken, setAdminToken } from "../../live";
import { Lamp, PathName, sentence, StateMark, Swatch } from "../../ui";
import { layoutBar } from "../line/geometry";
import { useSize } from "../line/hooks";
import { Band } from "../line/Timeline";
import {
  clock,
  criteriaWithVerdicts,
  diffLines,
  journeySpan,
  diffStat,
  duration,
  otherVerdicts,
  reasonLabel,
  shortSha,
  stateLabel,
  type AttemptDetail,
  type AttemptRow,
  type Detail,
  type DiffKind,
  type EvidenceView,
  type Failure,
  type PathFlag,
  type PathRow,
  type VerdictRow,
} from "./format";

// A state in words with its mark, the way the Line's key names it.
export function StateLabel({ state, large }: { state: string; large?: boolean }) {
  return <StateMark state={state} label={sentence(stateLabel(state))} large={large} />;
}

function TxnLink({ id }: { id: string }) {
  return /^t_[a-z0-9]+$/i.test(id) ? (
    <a className="txn-link mono" href={`#/t/${encodeURIComponent(id)}`}>
      {id}
    </a>
  ) : (
    <span className="mono">{id}</span>
  );
}

export function SectHead({ title, count, children }: { title: string; count?: string | number; children?: React.ReactNode }) {
  return (
    <header className="sect-head">
      <h2>{title}</h2>
      {count !== undefined && <span className="count">{count}</span>}
      {children && <span className="spacer" />}
      {children}
    </header>
  );
}

// ------------------------------------------------------------------------------------ header

function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      title="Copy the transaction id"
      aria-label={done ? "Copied the transaction id" : "Copy the transaction id"}
      onClick={() => {
        // A refused clipboard (no permission, an insecure origin) leaves the id on screen to select by hand.
        navigator.clipboard?.writeText(id).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => {},
        );
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="meta">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Header({ detail, preview, view, now }: { detail: Detail; preview: AttemptDetail["preview"]; view: TxnView | null; now: number }) {
  const { txn } = detail;
  const commit = preview?.kind === "commit" ? preview : null;
  const sim = simulationOf(txn.model);
  const first = view?.attempts[0];
  const last = view?.attempts.at(-1);
  const total = first ? (last?.end ?? now) - first.start : null;
  return (
    <header className="txn-head">
      <div className="txn-head-top">
        <StateLabel state={txn.state} large />
        {txn.reason && <span className="txn-reason-text">{reasonLabel(txn.reason)}</span>}
        {detail.detail.approved && (
          <span className="tag">approved by a human</span>
        )}
        <span className="spacer" />
        <span className="txn-id-wrap">
          <span className="txn-id mono">{txn.id}</span>
          <CopyId id={txn.id} />
        </span>
      </div>
      <h1 className="txn-intent">{txn.intent}</h1>
      <dl className="txn-meta">
        <Meta label="Agent">
          <span className="mono">{txn.agent}</span>
        </Meta>
        <Meta label="Model">
          {txn.model ? (
            <>
              <span className="mono">{txn.model}</span>
              {sim && <span className="tag">{sim}</span>}
            </>
          ) : (
            "—"
          )}
        </Meta>
        <Meta label="Attempt">
          <span className="num">
            {txn.attempt} of {MAX_ATTEMPTS}
          </span>
        </Meta>
        {txn.train && (
          <Meta label="Train">
            <span className="mono">{txn.train}</span>
          </Meta>
        )}
        {total !== null && (
          <Meta label={last?.end === null ? "Running" : "Took"}>
            <span className="num">{duration(total)}</span>
          </Meta>
        )}
        {commit && (
          <Meta label="Commit">
            <a className="mono ext" href={commit.url} target="_blank" rel="noreferrer" title={`${commit.sha}: open the preview of this commit`}>
              {shortSha(commit.sha)}
              {detail.txn.landedSeq !== null && <span className="muted"> · seq {detail.txn.landedSeq}</span>}
              {" ↗"}
            </a>
          </Meta>
        )}
      </dl>
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
      <div className="txn-gate-text">
        <strong>
          <Lamp tone="caution">Waiting for a human{reason ? `: ${reasonLabel(reason)}` : ""}</Lamp>
        </strong>
        <p>Approving sends it back through a train, so it still has to pass verify before it lands.</p>
        {!token && (
          <form className="txn-token" onSubmit={save}>
            <input className="input" type="password" autoComplete="off" aria-label="Admin token" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Admin token (RYKE_TOKEN)" />
            <button type="submit" className="btn" disabled={draft.trim() === ""}>
              Set token
            </button>
          </form>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="txn-gate-actions">
        <button type="button" className="btn" disabled={!token || busy !== null} onClick={() => void decide("reject")}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
        <button type="button" className="btn btn-primary" disabled={!token || busy !== null} onClick={() => void decide("approve")}>
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------ attempts

function Cause({ row }: { row: AttemptRow }) {
  const parts: React.ReactNode[] = [];
  if (row.stale.length > 0) {
    const shown = row.stale.slice(0, 3);
    parts.push(
      <span key="stale">
        {shown.map((p, i) => (
          <span key={p.path}>
            {i > 0 && ", "}
            <code>{p.path}</code>
            {p.by && (
              <>
                {" changed by "}
                <TxnLink id={p.by} />
              </>
            )}
          </span>
        ))}
        {row.stale.length > shown.length && <span className="muted"> +{row.stale.length - shown.length} more</span>}
      </span>,
    );
  }
  if (row.conflicts.length > 0) {
    parts.push(
      <span key="conflict">
        {"text conflict in "}
        {row.conflicts.map((p, i) => (
          <span key={p}>
            {i > 0 && ", "}
            <code>{p}</code>
          </span>
        ))}
      </span>,
    );
  }
  if (row.failures.length > 0) parts.push(<span key="fail">{row.failures.map((f) => f.name).join(", ")}</span>);
  const reason = reasonLabel(row.reason);
  if (parts.length === 0 && !reason) return null;
  return (
    <p className="attempt-cause">
      {reason && <span className="attempt-reason">{reason}</span>}
      {parts.length > 0 && reason && <span className="sep"> · </span>}
      {parts}
    </p>
  );
}

// The attempt drawn as the Line draws it, on a time track shared by every attempt of the transaction.
function AttemptBarSvg({ view, attempt, span, now, width }: { view: TxnView; attempt: number; span: { from: number; to: number }; now: number; width: number }) {
  const a = view.attempts.find((x) => x.attempt === attempt);
  const h = 14;
  const y = 6;
  if (!a || width <= 0) return <svg width={width} height={h + 12} aria-hidden="true" />;
  const bar = layoutBar({ txn: view, attempt: a, lane: 0, lanes: 1, scale: { t0: span.from, t1: span.to, x0: 2, x1: width - 14 }, now });
  if (!bar) return <svg width={width} height={h + 12} aria-hidden="true" />;
  return (
    <svg className={bar.strike ? "attempt-bar is-recalled" : "attempt-bar"} width={width} height={h + 12} aria-hidden="true">
      <line className="track" x1={2} x2={width - 2} y1={y + h / 2} y2={y + h / 2} />
      <Band bar={bar} y={y} h={h} />
    </svg>
  );
}

export function Journey({ rows, view, selected, onPick, now }: { rows: AttemptRow[]; view: TxnView | null; selected: number; onPick: (n: number) => void; now: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const span = view ? journeySpan(view, now) : null;
  if (rows.length === 0) return <p className="empty-note">No attempts recorded.</p>;
  return (
    <ol className="journey">
      {rows.map((r, i) => (
        <li key={r.attempt}>
          <button type="button" className="attempt" data-attempt={r.attempt} aria-pressed={r.attempt === selected} onClick={() => onPick(r.attempt)}>
            <span className="attempt-title">
              <span className="attempt-n">Attempt {r.attempt}</span>
              <StateLabel state={r.outcome ?? r.state} />
            </span>
            <span className="attempt-track" ref={i === 0 ? ref : undefined}>
              {view && span && <AttemptBarSvg view={view} attempt={r.attempt} span={span} now={now} width={width} />}
            </span>
            <span className="attempt-time num">
              <span>{clock(r.start)}</span>
              <span className="muted">{r.end === null ? "running" : duration(r.end - r.start)}</span>
            </span>
          </button>
          <div className="attempt-notes">
            <Cause row={r} />
            {(r.bisected || r.approved || r.snapshot) && (
              <p className="attempt-tags">
                {r.snapshot && (
                  <span className="muted" title={r.snapshot}>
                    from trunk <span className="mono">{shortSha(r.snapshot)}</span>
                  </span>
                )}
                {r.bisected && <span className="tag">isolated by bisection</span>}
                {r.approved && <span className="tag">approved</span>}
              </p>
            )}
            {r.warnings.length > 0 && (
              <ul className="attempt-warnings">
                {r.warnings.map((w, k) => (
                  <li key={k} title={w.paths.join("\n") || undefined}>
                    <Swatch mark="warning" width={16} />
                    <span className="mono muted">{clock(w.at)}</span> {w.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------------------------ attempt picker

export function AttemptPicker({ attempts, selected, onPick }: { attempts: number[]; selected: number; onPick: (n: number) => void }) {
  if (attempts.length < 2) return <span className="count">attempt {selected}</span>;
  return (
    <div className="txn-picker" role="group" aria-label="Attempt">
      <span className="label">Attempt</span>
      <div className="seg">
        {attempts.map((n) => (
          <button key={n} type="button" aria-pressed={n === selected} onClick={() => onPick(n)}>
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------ paths and delta

const FLAG_TEXT: Record<PathFlag, string> = { stale: "stale", conflict: "text conflict", protected: "protected", warned: "changed on trunk" };
const FLAG_TONE: Record<PathFlag, "stop" | "caution"> = { stale: "stop", conflict: "stop", protected: "stop", warned: "caution" };
const MARK: Record<DiffKind, string> = { file: "", meta: "", hunk: "", ctx: " ", add: "+", del: "−" };

export function Diff({ path, patch }: { path: string; patch: string }) {
  const lines = diffLines(patch).filter((l) => l.kind !== "file");
  const stat = diffStat(lines);
  return (
    <figure className="txn-diff">
      <figcaption>
        <PathName path={path} className="path-name" />
        <span className="diff-stat num">
          <span data-kind="add">+{stat.added}</span> <span data-kind="del">−{stat.removed}</span>
        </span>
      </figcaption>
      <div className="txn-diff-scroll">
        <div className="txn-diff-body">
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

// Stale reads and text conflicts, each with what trunk did to the file after the attempt's snapshot (§12).
export function Deltas({ rows }: { rows: PathRow[] }) {
  const shown = rows.filter((r) => r.delta);
  if (shown.length === 0) return null;
  return (
    <section className="txn-deltas" aria-label="Delta on trunk">
      <h3 className="col-title">
        What changed on trunk since the snapshot
        <span className="count num">{shown.length}</span>
      </h3>
      {shown.map((r) => (
        <Diff key={r.path} path={r.path} patch={r.delta!} />
      ))}
    </section>
  );
}

export function PathList({ title, rows, none }: { title: string; rows: PathRow[]; none: string }) {
  const flagged = rows.filter((r) => r.flags.some((f) => f !== "warned")).length;
  return (
    <section className="txn-col">
      <h3 className="col-title">
        {title}
        <span className="count num">{rows.length}</span>
        {flagged > 0 && <span className="col-flagged">{flagged} flagged</span>}
      </h3>
      {rows.length === 0 ? (
        <p className="muted col-none">{none}</p>
      ) : (
        <ul className="txn-paths">
          {rows.map((r) => (
            <li key={r.path} className="txn-path" data-flag={r.flags[0]}>
              <div className="txn-path-line">
                <PathName path={r.path} className="path-name" />
                {r.flags.map((f) => (
                  <span key={f} className="flag" data-tone={FLAG_TONE[f]}>
                    {FLAG_TEXT[f]}
                  </span>
                ))}
                {r.by && (
                  <span className="path-by">
                    by <TxnLink id={r.by} />
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------ criteria and verdicts

function Gauge({ v }: { v: VerdictRow }) {
  return (
    <span className="gauge" data-tone={v.signal} style={{ "--v": v.value } as CSSProperties} role="img" aria-label={`${v.name} ${v.value.toFixed(2)}`}>
      <i />
      {v.thresholds.map((t) => (
        <b key={t} style={{ "--at": t } as CSSProperties} />
      ))}
    </span>
  );
}

function VerdictLine({ v }: { v: VerdictRow }) {
  if (v.type === "off") return <span className="verdict-off muted">judge off</span>;
  return (
    <span className="verdict" title={v.text}>
      <Gauge v={v} />
      <span className={`verdict-value num tone-${v.signal}`}>{v.value.toFixed(2)}</span>
      {v.confidence !== null && <span className="muted num">conf {v.confidence.toFixed(2)}</span>}
      {v.source && v.source !== "live" && <span className="muted">{v.source}</span>}
    </span>
  );
}

export function Criteria({ criteria, verdicts }: { criteria: string[]; verdicts: VerdictRow[] }) {
  const items = criteriaWithVerdicts(criteria, verdicts);
  const others = otherVerdicts(criteria, verdicts);
  return (
    <section className="txn-sect">
      <SectHead title="Acceptance criteria" count={criteria.length || undefined} />
      <div className="criteria">
        {items.length === 0 ? (
          <p className="muted">None given; the intent is the one criterion.</p>
        ) : (
          <ol className="crit-list">
            {items.map((c, i) => (
              <li key={i} data-tone={c.verdict?.signal ?? undefined}>
                <span className="crit-n num">{i + 1}</span>
                <div className="crit-body">
                  <p>{c.text}</p>
                  {c.verdict ? <VerdictLine v={c.verdict} /> : <span className="muted crit-wait">no verdict for this attempt</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
        {others.length > 0 && (
          <ul className="other-verdicts">
            {others.map((v) => (
              <li key={v.name}>
                <span className="other-name">{v.name}</span>
                <VerdictLine v={v} />
              </li>
            ))}
          </ul>
        )}
        {verdicts.length === 0 && <p className="muted crit-note">Jev answers after verify has passed, so an attempt that did not get that far has no verdicts.</p>}
      </div>
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
            <Swatch mark="failed" width={18} />
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
  const image = view.imageUrl && broken !== view.imageUrl ? view.imageUrl : null;
  return (
    <section className="txn-sect txn-evidence">
      <SectHead title="Evidence" />
      <div className="evidence">
        {empty && <p className="muted">Nothing recorded for this attempt yet.</p>}
        {view.tests && (
          <div className="ev-tests" data-tone={view.tests.signal}>
            <p className="ev-tests-title">
              <Lamp tone={view.tests.signal}>{view.tests.failed === 0 ? "Tests passed" : view.tests.failed === null ? "Tests" : `${view.tests.failed} test${view.tests.failed === 1 ? "" : "s"} failed`}</Lamp>
            </p>
            <p className="mono ev-tests-sum">{view.tests.summary}</p>
          </div>
        )}
        {failures.length > 0 && <Failures failures={failures} />}
        {(view.agentScreenshot || image) && (
          <figure className="txn-shot">
            {image && (
              <a href={image} target="_blank" rel="noreferrer" title="Open the screenshot">
                <img src={image} alt="Screenshot of the app at the end of this attempt's verify" onError={() => setBroken(view.imageUrl)} />
              </a>
            )}
            {view.agentScreenshot && (
              <figcaption>
                <span className="ev-label">
                  Screenshot <span className="tag">agent-provided</span>
                </span>
                {view.agentScreenshot}
              </figcaption>
            )}
          </figure>
        )}
        {view.agentSummary && (
          <div className="ev-block">
            <span className="ev-label">
              Agent summary <span className="tag">agent-provided</span>
            </span>
            <p>{view.agentSummary}</p>
          </div>
        )}
        {view.other.map((o, i) => (
          <div key={i} className="ev-block">
            <span className="ev-label">{o.kind}</span>
            <p className="mono">{o.summary}</p>
          </div>
        ))}
        {preview && (
          <a className="btn ev-preview" href={preview.url} target="_blank" rel="noreferrer">
            {preview.kind === "commit" ? "Preview the landed commit" : "Preview the trunk it started from"}
            <span className="mono">{shortSha(preview.sha)} ↗</span>
          </a>
        )}
      </div>
    </section>
  );
}
