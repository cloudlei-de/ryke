import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_ATTEMPTS } from "../../../shared/types";
import type { Live } from "../../live";
import { useNow } from "../line/hooks";
import { computeDelta, deltaRequest, deltaView, fileFetcher, type DeltaRequest, type DeltaState } from "./delta";
import { attemptDetail, attemptRows, journeyView, lastSeqFor, loadedSeq, previewFor, selectAttempt, shouldRefetch, type Detail } from "./format";
import { AttemptPicker, Criteria, Deltas, Evidence, Gate, Header, Journey, PathList, SectHead } from "./parts";
import "./txn.css";

type Load = { status: "loading" } | { status: "missing" } | { status: "error"; message: string } | { status: "ready"; detail: Detail };

// No polling (PLAN.md §12): the detail is fetched once, then again whenever the live stream delivers a
// newer op for this transaction than the fetched detail already holds.
function useDetail(id: string, liveSeq: number) {
  const [state, setState] = useState<Load>({ status: "loading" });
  const loaded = useRef(-1);
  const ticket = useRef(0);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    try {
      const res = await fetch(`/api/txns/${encodeURIComponent(id)}`);
      if (mine !== ticket.current) return;
      if (res.status === 404) return setState({ status: "missing" });
      if (!res.ok) throw new Error(`The ledger answered ${res.status}.`);
      const detail = (await res.json()) as Detail;
      if (mine !== ticket.current) return;
      loaded.current = loadedSeq(detail);
      setState({ status: "ready", detail });
    } catch (e) {
      // A failed refetch keeps showing the last good detail; the next op tries again.
      if (mine === ticket.current) setState((prev) => (prev.status === "ready" ? prev : { status: "error", message: (e as Error).message }));
    }
  }, [id]);

  useEffect(() => {
    if (loaded.current < 0 || shouldRefetch(liveSeq, loaded.current)) void load();
  }, [load, liveSeq]);
  // Drops an answer that arrives after the view has gone.
  useEffect(
    () => () => {
      ticket.current++;
    },
    [],
  );

  return { state, reload: load };
}

export function TxnView({ repo, id, live }: { repo: string; id: string; live: Live }) {
  // Keyed by id so that moving to another transaction starts from a clean loading state, and by epoch so that
  // a repo that started over (swarm --fresh) does not keep showing a transaction of the run that was deleted.
  return <TxnPage key={`${id}#${live.epoch}`} repo={repo} id={id} liveSeq={lastSeqFor(live.ops, id)} />;
}

function TxnPage({ repo, id, liveSeq }: { repo: string; id: string; liveSeq: number }) {
  const { state, reload } = useDetail(id, liveSeq);
  return (
    <article className="txn">
      <nav className="txn-crumbs" aria-label="Breadcrumb">
        <a className="txn-back" href="#/">
          Line
        </a>
        <span className="muted">/</span>
        <span>Transaction</span>
      </nav>
      {state.status === "loading" && (
        <p className="txn-status muted">
          Loading <span className="mono">{id}</span>…
        </p>
      )}
      {state.status === "missing" && (
        <div className="txn-status callout">
          <p>
            There is no transaction <span className="mono">{id}</span> in this ledger.
          </p>
          <p className="muted">It may belong to a run that was started over with --fresh.</p>
        </div>
      )}
      {state.status === "error" && (
        <p className="callout txn-status" data-tone="stop" role="alert">
          <span>
            Could not load <span className="mono">{id}</span>: {state.message}
          </span>
          <button className="btn btn-sm" onClick={() => void reload()}>
            Retry
          </button>
        </p>
      )}
      {state.status === "ready" && <Loaded repo={repo} detail={state.detail} reload={() => void reload()} />}
    </article>
  );
}

// Snapshots are immutable trunk commits, so a comparison of two of them never changes and is kept for the
// page's lifetime: picking another attempt and back costs nothing. Failures are not kept, so reopening retries.
const computed = new Map<string, DeltaState>();

function usePastDelta(repo: string, request: DeltaRequest | null) {
  const key = request ? `${repo} ${request.key}` : null;
  const [loaded, setLoaded] = useState<DeltaState | null>(null);
  // A refetched detail rebuilds `request` with the same content; only a different comparison restarts the fetch.
  const latest = useRef(request);
  latest.current = request;
  useEffect(() => {
    const req = latest.current;
    if (!req || !key || computed.has(key)) return;
    let off = false;
    computeDelta(req, fileFetcher(repo)).then(
      (delta) => {
        const state: DeltaState = { key: req.key, status: "ready", delta };
        computed.set(key, state);
        if (!off) setLoaded(state);
      },
      (e: unknown) => {
        if (!off) setLoaded({ key: req.key, status: "error", message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      off = true;
    };
  }, [repo, key]);
  return deltaView(request, (key ? computed.get(key) : undefined) ?? loaded);
}

function Loaded({ repo, detail, reload }: { repo: string; detail: Detail; reload: () => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const attempts = detail.attempts.map((a) => a.attempt);
  const attempt = selectAttempt(picked, attempts);
  const rows = useMemo(() => attemptRows(detail.ops), [detail]);
  const view = useMemo(() => journeyView(detail), [detail]);
  const running = view?.attempts.some((a) => a.end === null) ?? false;
  // Only a running attempt needs a ticking clock; a finished one is drawn at the time of its last op.
  const now = useNow(running ? "live" : "replay", undefined, Math.max(0, ...detail.ops.map((o) => o.at)));
  const request = useMemo(() => deltaRequest(rows, attempt), [rows, attempt]);
  // The ledger knows which repo the transaction belongs to; the page's ?repo= only says which one the Line shows.
  const past = usePastDelta(detail.txn.repo, request);
  const ad = useMemo(() => attemptDetail(detail, attempt, repo, past.delta), [detail, attempt, repo, past.delta]);
  const landing = previewFor(repo, detail, detail.txn.attempt, rows.find((r) => r.attempt === detail.txn.attempt) ?? null);
  const staleWithoutDelta = ad.reads.some((r) => r.flags.includes("stale") && r.delta === null);

  return (
    <>
      <Header detail={detail} preview={landing} view={view} now={now} />
      {detail.txn.state === "needs_human" && <Gate id={detail.txn.id} reason={detail.txn.reason} reload={reload} />}

      <div className="txn-grid">
        <div className="txn-main">
          <section className="txn-sect">
            <SectHead title="Attempts" count={`${rows.length} of ${MAX_ATTEMPTS}`}>
              {rows.length > 1 && <span className="muted hint">Pick one to see its footprint, verdicts and evidence</span>}
            </SectHead>
            <Journey rows={rows} view={view} selected={attempt} onPick={setPicked} now={now} />
          </section>

          <section className="txn-sect">
            <SectHead title="Footprint">
              <AttemptPicker attempts={attempts} selected={attempt} onPick={setPicked} />
            </SectHead>
            <div>
              <div className="txn-pair">
                <PathList title="Read" rows={ad.reads} none="No reads recorded." />
                <PathList title="Written" rows={ad.writes} none="No writes recorded yet." />
              </div>
              <Deltas rows={[...ad.reads, ...ad.writes]} />
              {past.status === "loading" && <p className="muted txn-note">Reading the stale files at the two snapshots to show what changed on trunk…</p>}
              {past.status === "error" && (
                <p className="muted txn-note" role="status">
                  Could not read the files to show the delta ({past.message}).
                </p>
              )}
              {past.status === "ready" && request && request.omitted > 0 && (
                <p className="muted txn-note">
                  The delta shows the first {request.paths.length} of {request.paths.length + request.omitted} stale files.
                </p>
              )}
              {past.status === "none" && staleWithoutDelta && <p className="muted txn-note">No later snapshot to compare with: the delta needs the attempt that followed this one, or the transaction to be stale right now.</p>}
            </div>
          </section>
        </div>

        <aside className="txn-side">
          <Criteria criteria={detail.txn.criteria} verdicts={ad.verdicts} />
          <Evidence view={ad.evidence} failures={ad.failures} preview={ad.preview} />
        </aside>
      </div>
    </>
  );
}
