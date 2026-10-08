import type { ReactNode } from "react";
import { Swatch, type MarkName } from "../../ui";
import type { Signal } from "../txn/format";
import { txnHref } from "./geometry";
import type { Stats } from "./stats";

// One ruled row: a lamp that lights when the count is a signal, the figure, and what it is made of.
function Row({ label, value, lamp, children }: { label: string; value: number; lamp?: Signal | null; children: ReactNode }) {
  return (
    <tr>
      <td className="c-lamp">{lamp !== undefined && <i className="dot" data-tone={lamp ?? undefined} />}</td>
      <th scope="row">{label}</th>
      <td className="c-fig">{value}</td>
      <td className="c-sub">{children}</td>
    </tr>
  );
}

function Split({ items }: { items: [string, number, MarkName][] }) {
  const shown = items.filter(([, n]) => n > 0);
  if (shown.length === 0) return <>nothing in flight</>;
  return (
    <>
      {shown.map(([label, n, mark]) => (
        <span key={label} className="split">
          <Swatch mark={mark} width={14} />
          {n} {label}
        </span>
      ))}
    </>
  );
}

// The Line's counters (PLAN.md §12 "live counters") as a ruled table in the sheet's margin, figures in one column.
export function Counters({ s }: { s: Stats }) {
  const causes = s.causes.slice(0, 2).map((c) => `${c.count} ${c.label}`);
  const trains = [s.speculative > 0 ? `${s.speculative} speculative` : null, s.bisected > 0 ? `${s.bisected} bisected` : null].filter(Boolean).join(" · ");
  return (
    <section className="counters" aria-label="Counters">
      <header className="sect-head">
        <h2>Counters</h2>
      </header>
      <table className="c-table">
        <tbody>
          <Row label="In flight" value={s.inflight}>
            <Split
              items={[
                ["working", s.working, "working"],
                ["queued", s.queued, "queued"],
                ["verifying", s.verifying, "verifying"],
                ["human", s.human, "human"],
              ]}
            />
          </Row>
          <Row label="Landed" value={s.landed} lamp={s.landed > 0 ? "go" : null}>
            {s.perMinute} in the last minute
          </Row>
          <Row label="Trains" value={s.trains} lamp={s.verifying > 0 ? "run" : null}>
            {s.trains === 0 ? "none formed yet" : trains || "all on trunk"}
          </Row>
          <Row label="Aborted" value={s.aborts} lamp={s.aborts > 0 ? "stop" : null}>
            {causes.length === 0 ? "none yet" : causes.join(" · ")}
          </Row>
          <Row label="Needs a human" value={s.human} lamp={s.human > 0 ? "caution" : null}>
            {s.human > 0 ? <a href={txnHref(s.needsHuman[0]!)}>review {s.needsHuman[0]} →</a> : "nothing waiting"}
          </Row>
        </tbody>
      </table>
    </section>
  );
}
