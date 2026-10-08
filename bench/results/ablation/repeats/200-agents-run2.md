# Ryke bench

> Synthetic agents: real git, real merges, real tests, scripted edits. Time factor 1 (median think 6 s), seed 7, 4-vCPU VM, Jev off (the tests are the only gate for every policy).

Generated 2026-10-08T10:23:31.575Z. Every cell ran for 120 s of wall time on a fresh `convert` trunk; only changes that landed inside that window count.

## Throughput

```
landed per minute (one # is 0.93)

200 agents
  ryke        |################################################| 44.5
  ryke-nopipe |#######################################         | 36.5
```

## Does Ryke win?

| agents | ranking by landed/min | winner |
| ------ | --------------------- | ------ |
| 200    | ryke 44.5             | ryke   |

Ryke has the highest landed/min at every N >= 50 in this run.

## Speculative pipelining on and off

`ryke-nopipe` is Ryke with `pipeline: false` in the seeded ryke.json: the same agents and the same leases, but the Ledger never forms a second train on the first one's candidate, so one train runs at a time.

| agents | policy      | landed/min | p50 s | p95 s  | verify runs/landed | wasted agent-s | stale_read aborts | stale while ready | max_attempts | trains formed | speculative (formed / confirmed / discarded) |
| ------ | ----------- | ---------- | ----- | ------ | ------------------ | -------------- | ----------------- | ----------------- | ------------ | ------------- | -------------------------------------------- |
| 200    | ryke        | 44.5       | 72.87 | 113.38 | 0.31               | 1834.6         | 328               | 317               | 40           | 19            | 15 / 11 / 3                                  |
| 200    | ryke-nopipe | 36.5       | 74.02 | 102.45 | 0.26               | 1777.4         | 325               | 321               | 41           | 12            | 0 / 0 / 0                                    |

- 200 agents: pipelining on lands 44.5/min against 36.5/min with pipelining off (+21.92 %); p95 113.38 s against 102.45 s; verify runs per landed change 0.31 against 0.26; wasted agent-seconds 1834.6 against 1777.4; speculative trains 15 formed, 11 confirmed, 3 discarded.

## Every cell

| policy      | agents | landed | landed/min | p50 s | p95 s  | verify runs/landed | wasted agent-s | trunk breakages | aborts                                           |
| ----------- | ------ | ------ | ---------- | ----- | ------ | ------------------ | -------------- | --------------- | ------------------------------------------------ |
| ryke        | 200    | 89     | 44.5       | 72.87 | 113.38 | 0.31               | 1834.6         | 0               | stale_read 328, failed_verify 3, max_attempts 40 |
| ryke-nopipe | 200    | 73     | 36.5       | 74.02 | 102.45 | 0.26               | 1777.4         | 0               | stale_read 325, failed_verify 2, max_attempts 41 |

## Cell details

| policy      | agents | incompatible pairs | attempts/landed | changes started | landed in grace | unfinished | refreshes | lease waits | agent errors | mean verify s | loop lag p99/max ms | load avg |
| ----------- | ------ | ------------------ | --------------- | --------------- | --------------- | ---------- | --------- | ----------- | ------------ | ------------- | ------------------- | -------- |
| ryke        | 200    | 11.97 % of 48791   | 4.72            | 329             | 24              | 173        | 163       | 77          | 0            | -             | 68.4/226.1          | 5.48     |
| ryke-nopipe | 200    | 11.79 % of 44381   | 5.48            | 314             | 24              | 176        | 98        | 55          | 0            | -             | 58.3/393.5          | 6.36     |

### Ryke internals

| policy      | agents | trains | mean size | max size | bisect probes | stale warnings | stale aborts (while ready) | text conflicts | train cycle p50/p95 s | lease wait s (gave up) | think lost to refresh s | stale aborts by path                                                                                      |
| ----------- | ------ | ------ | --------- | -------- | ------------- | -------------- | -------------------------- | -------------- | --------------------- | ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| ryke        | 200    | 19     | 6.84      | 8        | 11            | 206            | 328 (317)                  | 0              | 10.07/19.16           | 6488.7 (124)           | 409.2                   | src/format.ts 144, src/ui/layout.ts 108, src/bench/pin-seed-format.ts 58, src/bench/pin-seed-layout.ts 56 |
| ryke-nopipe | 200    | 12     | 6.92      | 8        | 8             | 154            | 325 (321)                  | 0              | 6.92/20.87            | 4354.7 (82)            | 308.8                   | src/format.ts 140, src/ui/layout.ts 103, src/bench/pin-seed-format.ts 59, src/bench/pin-seed-layout.ts 54 |

## How to read this

- Begin to land is measured from the moment an agent asks to begin, so the lock policy is charged for the time it waits for the lock.
- Aborts are counted per attempt by cause; `max_attempts` counts the changes given up after the third attempt (their last attempt is also counted under its own cause).
- Verify runs include bisection probes on Ryke; the baselines run one verify per attempt that merged cleanly.
- Wasted agent-seconds is think time of attempts that did not land inside the window.
- `incompatible pairs` is the realised share of pairs of changes with overlapping read sets in which one rewrites a constant the other's test pins; the target is about 10 %.
- Ryke agents take write leases before they think and wait (up to 90 s) while a hot file is held by a change that is still on its way. A stale warning, before or during the think, makes the agent `refresh` onto the current trunk without spending an attempt and spend a retry's worth of think time adapting; `refreshes` and `lease waits` count both. Think time before a refresh is not counted as wasted unless the attempt later fails.

## Caveats

- The agents are synthetic: they do not read or reason, they apply scripted edits after a random think time. The platform, git, the merges and the tests are real.
- `src/registry.ts` carries no numeric constant (the protected units test and `src/index.ts` read every export of it as a category), so only `src/format.ts` and `src/ui/layout.ts` can be semantically incompatible. The registry is still the third hottest file by reads and writes; on Ryke it is a union path and never aborts anything.
- The lock and queue policies run the same lander jobs as Ryke (`land.sh prepare`, `verify.sh`, `land.sh push`) with a train of one; they enforce no read tracking and no protected paths. Both baselines retry up to the same three attempts as Ryke.
- Agents, store, runner and worker share one machine, so absolute numbers depend on its load; compare policies within one run, not across runs.
- `ryke-nopipe` is Ryke with speculative pipelining off (`pipeline: false` in the seeded ryke.json): identical agents and leases, but the Ledger forms one train at a time. The dashboard's results format only knows lock, queue and ryke, so this run is not written to bench/results/latest.json.
- ryke-nopipe x 200: load average 6.36 on 4 vCPUs at the end of the cell; the machine was oversubscribed.

