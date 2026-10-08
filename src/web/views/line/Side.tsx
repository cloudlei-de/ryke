import { useState } from "react";
import type { LineState } from "../../../shared/reducers";
import type { Op } from "../../../shared/types";
import { PathName, Swatch } from "../../ui";
import { feed, rawOps, type FeedItem, type Part } from "./activity";
import { formatClock, formatHeat, HEAT_HOT_AT, tickerLine, txnHref, type HeatRow } from "./geometry";
import { ago } from "./stats";

// ------------------------------------------------------------------ hot files

const SHOWN = 6;
const pct = (f: number) => `${(f * 100).toFixed(2)}%`;

export function HotFiles({ heat, leases, error }: { heat: HeatRow[]; leases: LineState["leases"]; error: string | null }) {
  const [all, setAll] = useState(false);
  const warm = heat.filter((h) => h.value > 0);
  const hot = warm.filter((h) => h.hot).length;
  const rows = all ? heat : warm.slice(0, SHOWN);
  const hidden = heat.length - rows.length;
  return (
    <section className="hot-files" aria-label="Heat map">
      <header className="sect-head">
        <h2>Hot files</h2>
        <span className="count">{hot > 0 ? `${hot} hot · ${heat.length} files` : `${heat.length} files`}</span>
      </header>
      {error && <p className="empty-note">File list unavailable ({error}).</p>}
      {!error && warm.length === 0 && !all && <p className="empty-note">Every file is cold. A file warms up each time a transaction writes it; past the mark it is hot and writers queue for it.</p>}
      {rows.length > 0 && (
        <ul className="heat-list">
          {rows.map((h) => {
            const lease = leases.get(h.path);
            return (
              <li key={h.path} data-hot={String(h.hot)} data-cold={String(h.value === 0)} title={`${h.path} · heat ${h.value.toFixed(2)}${h.hot ? " · hot" : ""}${lease ? ` · leased by ${lease.txn}` : ""}`}>
                <PathName path={h.path} className="heat-name" />
                {lease ? (
                  <span className="heat-lease" title={`leased by ${lease.txn}`}>
                    leased<span className="sr-only"> by {lease.txn}</span>
                  </span>
                ) : (
                  <span />
                )}
                {/* A measured scale: ink up to the hot mark, the signal past it. */}
                <span className="heat-track" style={{ ["--hot-at" as string]: pct(HEAT_HOT_AT) }}>
                  <span className="heat-fill" style={{ width: pct(Math.min(h.fraction, HEAT_HOT_AT)) }} />
                  {h.fraction > HEAT_HOT_AT && <span className="heat-over" style={{ left: pct(HEAT_HOT_AT), width: pct(h.fraction - HEAT_HOT_AT) }} />}
                </span>
                <span className="heat-val num">{formatHeat(h.value)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {(hidden > 0 || all) && (
        <button type="button" className="more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? "Show only warm files" : `Show all ${heat.length} files`}
        </button>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ activity

function Words({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : "txn" in p ? (
          <a key={i} className="feed-txn" href={txnHref(p.txn)} title={p.txn}>
            {p.label}
          </a>
        ) : (
          <code key={i}>{p.code}</code>
        ),
      )}
    </>
  );
}

function Item({ it, now, tz }: { it: FeedItem; now: number; tz: number }) {
  return (
    <li className="feed-item" data-tone={it.tone ?? undefined}>
      <time className="feed-time" title={`${ago(now - it.at)}${ago(now - it.at) === "now" ? "" : " ago"}`}>
        {formatClock(it.at, 1000, tz)}
      </time>
      <span className="feed-mark">
        <Swatch mark={it.mark} width={18} />
      </span>
      <div className="feed-text">
        <p className="feed-line">
          {it.actor && <b className="feed-actor">{it.actor} </b>}
          <Words parts={it.text} />
        </p>
        {it.subject && (
          <p className="feed-subject">
            <Words parts={[it.subject]} />
          </p>
        )}
        {it.detail && (
          <p className="feed-detail">
            <Words parts={it.detail} />
          </p>
        )}
      </div>
    </li>
  );
}

// The op log as a log book: clock time, the mark the Line draws for it, and what happened in words.
export function Activity({ ops, state, now }: { ops: Op[]; state: LineState; now: number }) {
  const [raw, setRaw] = useState(false);
  const items = raw ? [] : feed(ops, state.seq, state);
  const lines = raw ? rawOps(ops, state.seq) : [];
  const tz = -new Date().getTimezoneOffset();
  return (
    <section className="activity" aria-label="Activity">
      <header className="sect-head">
        <h2>Activity</h2>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
            Events
          </button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
            All ops
          </button>
        </div>
      </header>
      {raw ? (
        lines.length === 0 ? (
          <p className="empty-note">No ops yet.</p>
        ) : (
          <ol className="ops">
            {lines.map((o) => {
              const l = tickerLine(o);
              return (
                <li key={o.seq}>
                  <span className="op-seq">{l.seq}</span>
                  <span className="op-kind" data-tone={l.signal ?? undefined}>
                    {l.kind}
                  </span>
                  <span className="op-data" title={l.data}>
                    {l.txn && <span className="op-txn">{l.txn} </span>}
                    {l.data}
                  </span>
                </li>
              );
            })}
          </ol>
        )
      ) : items.length === 0 ? (
        <p className="empty-note">Nothing has happened on this repo yet.</p>
      ) : (
        <ol className="feed" aria-live="off">
          {items.map((it) => (
            <Item key={it.seq} it={it} now={now} tz={tz} />
          ))}
        </ol>
      )}
    </section>
  );
}
