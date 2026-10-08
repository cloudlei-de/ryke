import type { Op } from "../../../shared/types";
import { tickerLine } from "./geometry";

// The latest ops, newest first, one line each: seq kind txn agent short-data (PLAN.md §12).
export function Ticker({ ops }: { ops: Op[] }) {
  return (
    <section className="ticker" aria-label="Op ticker">
      <header className="panel-head">
        <h2>Op ticker</h2>
      </header>
      {ops.length === 0 ? (
        <p className="muted ticker-empty">No ops yet.</p>
      ) : (
        <ol>
          {ops.map((o) => {
            const l = tickerLine(o);
            return (
              <li key={o.seq}>
                <span className="t-seq">{l.seq}</span>
                <span className="t-kind" data-signal={l.signal ?? undefined}>
                  {l.kind}
                </span>
                <span className="t-txn">{l.txn}</span>
                <span className="t-agent">{l.agent}</span>
                <span className="t-data">{l.data}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
