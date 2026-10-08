import { useState } from "react";
import type { LineState } from "../../../shared/reducers";
import type { Op } from "../../../shared/types";
import { Icon } from "../../ui";
import { feed, rawOps, type FeedItem, type Part } from "./activity";
import { formatHeat, HEAT_HOT_AT, tickerLine, txnHref, type HeatRow } from "./geometry";
import { ago } from "./stats";

// ------------------------------------------------------------------ hot files

const SHOWN = 6;

function PathName({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span className="path" title={path}>
      {cut > 0 && <span className="path-dir">{path.slice(0, cut)}</span>}
      <span className="path-base">{path.slice(cut)}</span>
    </span>
  );
}

export function HotFiles({ heat, leases, error }: { heat: HeatRow[]; leases: LineState["leases"]; error: string | null }) {
  const [all, setAll] = useState(false);
  const warm = heat.filter((h) => h.value > 0);
  const hot = warm.filter((h) => h.hot).length;
  const rows = all ? heat : warm.slice(0, SHOWN);
  const hidden = heat.length - rows.length;
  return (
    <section className="card hot-files" aria-label="Heat map">
      <header className="card-head">
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
                <span className="heat-name">
                  {h.hot ? <Icon name="flame" size={13} className="heat-icon" /> : <Icon name="file" size={13} className="heat-icon cold" />}
                  <PathName path={h.path} />
                  {lease && <Icon name="lock" size={12} className="heat-lock" title={`leased by ${lease.txn}`} />}
                </span>
                <span className="heat-track" style={{ ["--hot-at" as string]: `${HEAT_HOT_AT * 100}%` }}>
                  <span className="heat-fill" style={{ width: `${h.fraction * 100}%` }} />
                </span>
                <span className="heat-val num">{formatHeat(h.value)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {(hidden > 0 || all) && heat.length > SHOWN && (
        <button type="button" className="more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? "Show only warm files" : `Show all ${heat.length} files`}
          <Icon name="chevron" size={13} className={all ? "flip" : undefined} />
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

function Item({ it, now }: { it: FeedItem; now: number }) {
  return (
    <li className="feed-item" data-tone={it.tone ?? undefined}>
      <span className="feed-icon">
        <Icon name={it.icon} size={13} />
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
      <time className="feed-time num" title={new Date(it.at).toLocaleTimeString()}>
        {ago(now - it.at)}
      </time>
    </li>
  );
}

export function Activity({ ops, state, now }: { ops: Op[]; state: LineState; now: number }) {
  const [raw, setRaw] = useState(false);
  const items = raw ? [] : feed(ops, state.seq, state);
  const lines = raw ? rawOps(ops, state.seq) : [];
  return (
    <section className="card activity" aria-label="Activity">
      <header className="card-head">
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
                  <span className="op-seq num">{l.seq}</span>
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
            <Item key={it.seq} it={it} now={now} />
          ))}
        </ol>
      )}
    </section>
  );
}
