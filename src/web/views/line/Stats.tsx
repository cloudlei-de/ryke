import type { ReactNode } from "react";
import { Icon, type IconName } from "../../ui";
import { txnHref } from "./geometry";
import { ago, SPARK_BUCKET_MS, SPARK_BUCKETS, type Stats } from "./stats";

function Stat({ icon, label, value, sub, tone, children }: { icon: IconName; label: string; value: ReactNode; sub: ReactNode; tone?: string; children?: ReactNode }) {
  return (
    <div className="stat card" data-tone={tone}>
      <div className="stat-label">
        <Icon name={icon} size={14} />
        {label}
      </div>
      <div className="stat-row">
        <div className="stat-value num">{value}</div>
        {children}
      </div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 4;
  const gap = 2;
  const h = 28;
  return (
    <svg className="spark" width={values.length * (w + gap) - gap} height={h} role="img" aria-label={`Landed per ${SPARK_BUCKET_MS / 1000} s over the last ${(SPARK_BUCKETS * SPARK_BUCKET_MS) / 60_000} minutes`}>
      {values.map((v, i) => {
        const bh = v === 0 ? 2 : Math.max(3, (v / max) * h);
        return <rect key={i} x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={1.5} className={v === 0 ? "spark-zero" : "spark-bar"} />;
      })}
    </svg>
  );
}

function Split({ items }: { items: [string, number, string][] }) {
  const shown = items.filter(([, n]) => n > 0);
  if (shown.length === 0) return <>nothing in flight</>;
  return (
    <>
      {shown.map(([label, n, tone], i) => (
        <span key={label} className="split">
          {i > 0 && <span className="sep">·</span>}
          <i className="dot" data-tone={tone} />
          {n} {label}
        </span>
      ))}
    </>
  );
}

export function StatStrip({ s, now }: { s: Stats; now: number }) {
  const causes = s.causes.slice(0, 2).map((c) => `${c.count} ${c.label}`);
  return (
    <div className="stats" aria-label="Counters">
      <Stat
        icon="pulse"
        label="In flight"
        value={s.inflight}
        sub={
          <Split
            items={[
              ["working", s.working, "work"],
              ["queued", s.queued, "run"],
              ["verifying", s.verifying, "run"],
              ["human", s.human, "caution"],
            ]}
          />
        }
      />
      <Stat icon="check" label="Landed" value={s.landed} sub={`${s.perMinute} in the last minute`} tone="go">
        <Spark values={s.spark} />
      </Stat>
      <Stat icon="train" label="Trains" value={s.trains} sub={s.trains === 0 ? "none formed yet" : [s.speculative > 0 ? `${s.speculative} speculative` : null, s.bisected > 0 ? `${s.bisected} bisected` : null].filter(Boolean).join(" · ") || "all on trunk"} />
      <Stat icon="retry" label="Aborted" value={s.aborts} sub={causes.length === 0 ? "none yet" : causes.join(" · ")} tone={s.aborts > 0 ? "stop" : undefined} />
      <Stat
        icon="user"
        label="Needs a human"
        value={s.human}
        tone={s.human > 0 ? "caution" : undefined}
        sub={
          s.human > 0 ? (
            <a href={txnHref(s.needsHuman[0]!)}>
              review {s.needsHuman[0]} <Icon name="next" size={11} />
            </a>
          ) : (
            "nothing waiting"
          )
        }
      />
      <Stat
        icon="commit"
        label="Trunk"
        value={s.head ? <span className="stat-seq">seq {s.head.seq}</span> : "—"}
        sub={s.head ? <span className="mono">{s.head.sha.slice(0, 8)}{s.head.at !== null ? ` · ${ago(now - s.head.at)}${ago(now - s.head.at) === "now" ? "" : " ago"}` : ""}</span> : "no commits yet"}
      />
    </div>
  );
}
