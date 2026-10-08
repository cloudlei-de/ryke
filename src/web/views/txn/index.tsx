import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_ATTEMPTS } from "../../../shared/types";
import type { Live } from "../../live";
import { attemptDetail, attemptRows, lastSeqFor, loadedSeq, previewFor, selectAttempt, shouldRefetch, type Detail } from "./format";
import { AttemptPicker, Evidence, Gate, Header, Heading, PathList, Timeline, Verdicts } from "./parts";
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
  // Keyed by id so that moving to another transaction starts from a clean loading state.
  return <TxnPage key={id} repo={repo} id={id} liveSeq={lastSeqFor(live.ops, id)} />;
}

function TxnPage({ repo, id, liveSeq }: { repo: string; id: string; liveSeq: number }) {
  const { state, reload } = useDetail(id, liveSeq);
  return (
    <article className="txn">
      <a className="txn-back" href="#/">
        ← Line
      </a>
      {state.status === "loading" && (
        <p className="muted">
          Loading <span className="mono">{id}</span>…
        </p>
      )}
      {state.status === "missing" && (
        <p>
          There is no transaction <span className="mono">{id}</span> in this ledger.
        </p>
      )}
      {state.status === "error" && (
        <p role="alert">
          Could not load <span className="mono">{id}</span>: {state.message} <button onClick={() => void reload()}>Retry</button>
        </p>
      )}
      {state.status === "ready" && <Loaded repo={repo} detail={state.detail} reload={() => void reload()} />}
    </article>
  );
}

function Loaded({ repo, detail, reload }: { repo: string; detail: Detail; reload: () => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const attempts = detail.attempts.map((a) => a.attempt);
  const attempt = selectAttempt(picked, attempts);
  const rows = useMemo(() => attemptRows(detail.ops), [detail]);
  const view = useMemo(() => attemptDetail(detail, attempt, repo), [detail, attempt, repo]);
  const landing = previewFor(repo, detail, detail.txn.attempt, rows.find((r) => r.attempt === detail.txn.attempt) ?? null);
  const staleWithoutDelta = view.reads.some((r) => r.flags.includes("stale") && r.delta === null);

  return (
    <>
      <Header detail={detail} preview={landing} />
      {detail.txn.state === "needs_human" && <Gate id={detail.txn.id} reason={detail.txn.reason} reload={reload} />}

      <section className="txn-section">
        <Heading title="Attempts" count={`${rows.length} of ${MAX_ATTEMPTS}`} />
        <Timeline rows={rows} selected={attempt} />
      </section>

      <section className="txn-section">
        <Heading title="Footprint" />
        <AttemptPicker attempts={attempts} selected={attempt} onPick={setPicked} />
        <div className="txn-pair">
          <PathList title="Read set" rows={view.reads} none="No reads recorded." />
          <PathList title="Write set" rows={view.writes} none="No writes recorded yet." />
        </div>
        {staleWithoutDelta && <p className="muted txn-note">Ryke computes the delta while the attempt is stale. It is not kept once the agent has retried.</p>}
      </section>

      <section className="txn-section txn-pair">
        <Verdicts rows={view.verdicts} />
        <Evidence view={view.evidence} failures={view.failures} preview={view.preview} />
      </section>
    </>
  );
}
