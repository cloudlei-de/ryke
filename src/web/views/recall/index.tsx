// Recall dialog (PLAN.md §12 view 4, §8). Admin only: plan a recall as a dry run, read what it would revert,
// then execute it. The Line behind the dialog animates from the recall ops the reducers already fold.
import { useEffect, useId, useReducer, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { LineState } from "../../../shared/reducers";
import { adminFetch, adminToken, setAdminToken } from "../../live";
import { Icon } from "../../ui";
import {
  buildSelector,
  candidates,
  canDismiss,
  describeSelector,
  flowStep,
  initialFlow,
  optionText,
  outcomeRows,
  parseDryRun,
  parseExecuted,
  parseJson,
  parseTxnIds,
  planRows,
  planSentence,
  requestProblem,
  summarizeOutcome,
  wrapTarget,
  type Flow,
  type Outcome,
  type OutcomeRow,
  type Plan,
  type PlanRow,
  type Selector,
  type SelectorKind,
} from "./plan";
import "./recall.css";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const KINDS: { kind: SelectorKind; label: string }[] = [
  { kind: "model", label: "Model" },
  { kind: "agent", label: "Agent" },
  { kind: "txns", label: "Txn ids" },
];

// `reason` disables the button with an explanation, for views where the dialog would act on a repo state
// other than the one on screen (the Replay).
export function RecallButton({ repo, state, reason }: { repo: string; state: LineState; reason?: string }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Focus goes back to the button once the dialog has unmounted: while it is open the page behind is inert,
  // and an inert element cannot take focus.
  useEffect(() => {
    if (wasOpen.current && !open) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return (
    <>
      <button ref={opener} type="button" className="btn recall-open" disabled={Boolean(reason)} title={reason ?? "Revert landed transactions by agent, model or id"} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="undo" size={14} />
        Recall…
      </button>
      {open && <RecallDialog repo={repo} state={state} onClose={() => setOpen(false)} />}
    </>
  );
}

function RecallDialog({ repo, state, onClose }: { repo: string; state: LineState; onClose: () => void }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState(adminToken);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<SelectorKind>("model");
  const [pick, setPick] = useState("");
  const [pasted, setPasted] = useState("");
  const [flow, dispatch] = useReducer(flowStep, initialFlow);
  // The document listener below is installed once; it must still call the newest onClose and see the newest flow.
  const close = useRef(onClose);
  close.current = onClose;
  const dismissible = useRef(true);
  dismissible.current = canDismiss(flow);

  const known = candidates(state.txns.values());
  const options = kind === "agent" ? known.agents : known.models;
  const ids = parseTxnIds(pasted);
  const selector = buildSelector(kind, pick, pasted);
  const busy = flow.phase === "planning" || flow.phase === "executing";

  // Everything outside the dialog is inert while it is open, so neither the pointer nor Tab reaches the Line.
  // The listener on the document covers focus that sits on the backdrop, where no dialog handler would see it.
  useEffect(() => {
    const root = document.getElementById("root");
    if (root) root.inert = true;
    const first = box.current?.querySelector<HTMLElement>("[data-autofocus]");
    (first ?? box.current)?.focus();
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (dismissible.current) close.current();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      const at = wrapTarget(items.length, document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1, e.shiftKey);
      if (items.length === 0) e.preventDefault();
      else if (at !== null) {
        e.preventDefault();
        items[at]!.focus();
      }
    };
    document.addEventListener("keydown", on);
    return () => {
      document.removeEventListener("keydown", on);
      if (root) root.inert = false;
    };
  }, []);

  const choose = (nextKind: SelectorKind, nextPick: string, nextPasted: string) => {
    setKind(nextKind);
    setPick(nextPick);
    setPasted(nextPasted);
    dispatch({ type: "select", selector: buildSelector(nextKind, nextPick, nextPasted) });
  };

  const fail = (status: number, body: string) => {
    const p = requestProblem(status, body);
    if (p.needsToken) {
      setAdminToken(null);
      setToken(null);
    }
    dispatch({ type: "failed", text: p.text });
  };

  const request = async (sel: Selector, dryRun: boolean): Promise<{ ok: true; body: unknown } | { ok: false }> => {
    try {
      const res = await adminFetch(`/api/repos/${encodeURIComponent(repo)}/recall`, { selector: sel, dryRun });
      const text = await res.text();
      if (!res.ok) {
        fail(res.status, text);
        return { ok: false };
      }
      return { ok: true, body: parseJson(text) };
    } catch {
      dispatch({ type: "failed", text: "Network error: the platform did not answer." });
      return { ok: false };
    }
  };

  const plan = async () => {
    if (!selector || busy) return;
    dispatch({ type: "plan", selector });
    const r = await request(selector, true);
    if (!r.ok) return;
    const p = parseDryRun(r.body);
    if (p) dispatch({ type: "planned", selector, plan: p });
    else dispatch({ type: "failed", text: "The platform answered with a plan this page does not understand." });
  };

  const execute = async () => {
    if (flow.phase !== "planned" || flow.plan.targets.length === 0) return;
    dispatch({ type: "execute" });
    // The selector that was planned, not whatever the inputs say now: Execute runs what the user was shown.
    const r = await request(flow.selector, false);
    if (!r.ok) return;
    const o = parseExecuted(r.body);
    if (o) dispatch({ type: "executed", outcome: o });
    else dispatch({ type: "failed", text: "The platform answered with an outcome this page does not understand." });
  };

  const saveToken = (e: FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    setAdminToken(t);
    setToken(t);
    setDraft("");
    // The input that had focus is gone; hand focus to the first control that appears in its place.
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus());
  };

  const absent = pick !== "" && !options.some((o) => o.value === pick);

  return createPortal(
    <div
      className="recall-scrim"
      onMouseDown={(e) => {
        // Only a press on the backdrop itself closes it, and never while a recall is running.
        if (e.target === e.currentTarget && canDismiss(flow)) onClose();
      }}
    >
      <div className="recall" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={box} tabIndex={-1}>
        <header className="recall-head">
          <span className="recall-badge" aria-hidden="true">
            <Icon name="undo" size={16} />
          </span>
          <div className="recall-heading">
            <h2 id={titleId}>Recall</h2>
            <p className="muted">
              Revert landed changes on <span className="mono">{repo}</span>
            </p>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost btn-sm recall-close" onClick={onClose} aria-label="Close">
            <kbd>Esc</kbd>
            <Icon name="x" size={15} />
          </button>
        </header>

        <div className="recall-body">
          <p className="recall-lede">
            A recall takes landed transactions back off trunk and revalidates everything that landed after them. Plan it first: the plan is a dry run and changes nothing.
          </p>

          {!token && (
            <form className="recall-token callout" onSubmit={saveToken}>
              <Icon name="lock" size={15} />
              <label className="field">
                <span className="label">Admin token</span>
                <input className="input" type="password" autoComplete="off" value={draft} placeholder="RYKE_TOKEN" data-autofocus onChange={(e) => setDraft(e.target.value)} />
              </label>
              <button type="submit" className="btn" disabled={draft.trim() === ""}>
                Set token
              </button>
            </form>
          )}

          <form
            className="recall-pick"
            onSubmit={(e) => {
              e.preventDefault();
              void plan();
            }}
          >
            <div className="recall-step">
              <span className="recall-num">1</span>
              <span className="label">Recall by</span>
              <div className="seg" role="group" aria-label="Recall by">
                {KINDS.map((k) => (
                  <button key={k.kind} type="button" aria-pressed={kind === k.kind} disabled={busy} onClick={() => choose(k.kind, "", pasted)}>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="recall-choose">
              {kind === "txns" ? (
                <label className="field recall-field">
                  <span className="label">Transaction ids</span>
                  <textarea className="input" rows={2} value={pasted} disabled={busy} placeholder="t_mq3f0k1a t_mq3f0k2b" spellCheck={false} data-autofocus={token ? "" : undefined} onChange={(e) => choose(kind, pick, e.target.value)} />
                  {ids.bad.length > 0 && (
                    <span className="recall-hint error-text">
                      Not a transaction id: <span className="mono">{ids.bad.join(", ")}</span>
                    </span>
                  )}
                </label>
              ) : (
                <label className="field recall-field">
                  <span className="label">{kind === "agent" ? "Agent" : "Model"}</span>
                  <select className="input" value={pick} disabled={busy} data-autofocus={token ? "" : undefined} onChange={(e) => choose(kind, e.target.value, pasted)}>
                    <option value="">{options.length === 0 ? `no ${kind} with a landed transaction` : `Choose a ${kind}…`}</option>
                    {absent && <option value={pick}>{optionText(kind, pick, 0)}</option>}
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {optionText(kind, o.value, o.count)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button type="submit" className="btn btn-primary recall-plan-btn" disabled={!token || !selector || busy}>
                {flow.phase === "planning" ? "Planning…" : "Plan recall"}
              </button>
            </div>
          </form>

          <div className="recall-result" aria-live="polite">
            {flow.error && (
              <p className="callout recall-error" data-tone="stop" role="alert">
                <Icon name="alert" size={15} />
                {flow.error}
              </p>
            )}
            {(flow.phase === "planned" || flow.phase === "executing") && <PlanView flow={flow} state={state} />}
            {flow.phase === "done" && <OutcomeView outcome={flow.outcome} state={state} />}
          </div>
        </div>

        {(flow.phase === "planned" || flow.phase === "executing") && (
          <footer className="recall-foot" data-busy={String(flow.phase === "executing")}>
            <span className="muted">
              {flow.phase === "executing" ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Reverting and running the tests. Closing this window does not stop it.
                </>
              ) : (
                "Nothing has changed yet."
              )}
            </span>
            <span className="spacer" />
            <button type="button" className="btn btn-danger recall-go" disabled={!token || flow.phase === "executing" || flow.plan.targets.length === 0} onClick={() => void execute()}>
              <Icon name="undo" size={14} />
              {flow.phase === "executing" ? "Executing…" : "Execute recall"}
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

type Tone = "revert" | "cascade" | "revalidate" | "stay";
type RowView = { row: PlanRow; tone: Tone; label: string; requeuedAs?: string | null };

// One row per transaction, newest first, on a vertical trunk. A filled node is taken off trunk (its intent struck
// through in --recall); an outlined node stays and is revalidated by the tests that run after the revert.
function Rows({ rows }: { rows: RowView[] }) {
  return (
    <ol className="recall-rows">
      {rows.map(({ row: r, tone, label, requeuedAs }) => (
        <li key={r.id} data-tone={tone}>
          <span className="node" aria-hidden="true" />
          <div className="recall-row-main">
            <span className="intent" title={r.intent ?? undefined}>
              {r.intent ?? r.id}
            </span>
            <span className="who mono">
              {[r.id, r.agent, r.model, r.seq !== null ? `seq ${r.seq}` : null, r.sha || null].filter(Boolean).join(" · ")}
              {requeuedAs && (
                <>
                  {" · re-queued as "}
                  <a href={`#/t/${encodeURIComponent(requeuedAs)}`}>{requeuedAs}</a>
                </>
              )}
            </span>
          </div>
          <span className="role">{label}</span>
        </li>
      ))}
    </ol>
  );
}

function PlanView({ flow, state }: { flow: Extract<Flow, { plan: Plan }>; state: LineState }) {
  const rows = planRows(flow.plan, state.txns).map((row): RowView => (row.role === "target" ? { row, tone: "revert", label: `revert ${row.order ?? ""}`.trim() } : { row, tone: "revalidate", label: "revalidate" }));
  return (
    <section className="recall-plan" aria-label="Plan">
      <header className="recall-plan-head">
        <span className="recall-num">2</span>
        <h3>
          Plan for <span className="mono">{describeSelector(flow.selector)}</span>
        </h3>
        <ul className="recall-key" aria-label="Key">
          <li>
            <i data-tone="revert" aria-hidden="true" /> reverted, newest first
          </li>
          <li>
            <i data-tone="revalidate" aria-hidden="true" /> revalidated
          </li>
        </ul>
      </header>
      <p className="recall-sentence">{planSentence(flow.plan)}</p>
      {rows.length > 0 && <Rows rows={rows} />}
    </section>
  );
}

const FATE: Record<OutcomeRow["fate"], { tone: Tone; label: string }> = {
  recalled: { tone: "revert", label: "recalled" },
  cascaded: { tone: "cascade", label: "cascaded" },
  stayed: { tone: "stay", label: "stays landed" },
};

function OutcomeView({ outcome, state }: { outcome: Outcome; state: LineState }) {
  const s = summarizeOutcome(outcome);
  const rows = outcome.outcome === "pass" ? outcomeRows(outcome, state.txns).map((row): RowView => ({ row, ...FATE[row.fate], requeuedAs: row.requeuedAs })) : [];
  return (
    <section className="recall-outcome" data-tone={s.tone} aria-label="Outcome">
      <div className="recall-outcome-head">
        <span className="recall-outcome-icon" aria-hidden="true">
          <Icon name={s.tone === "go" ? "check" : "alert"} size={16} />
        </span>
        <div>
          <h3>{s.headline}</h3>
          <p className="recall-sentence">{s.detail}</p>
        </div>
      </div>
      {rows.length > 0 && <Rows rows={rows} />}
      {(outcome.head || outcome.failures.length > 0) && (
        <dl>
          {outcome.head && (
            <div>
              <dt>trunk</dt>
              <dd className="mono">{outcome.head.slice(0, 8)}</dd>
            </div>
          )}
          {outcome.failures.length > 0 && (
            <div>
              <dt>failures</dt>
              <dd>
                <ul className="recall-failures">
                  {outcome.failures.map((f, i) => (
                    <li key={`${f.name}-${i}`}>
                      <span className="mono">{f.name}</span>
                      {f.message && <span className="muted"> · {f.message}</span>}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
