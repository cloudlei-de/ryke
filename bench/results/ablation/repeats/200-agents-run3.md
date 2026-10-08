# Ryke bench

> Synthetic agents: real git, real merges, real tests, scripted edits. Time factor 1 (median think 6 s), seed 7, 4-vCPU VM, Jev off (the tests are the only gate for every policy).

Generated 2026-10-08T10:29:33.093Z. Every cell ran for 120 s of wall time on a fresh `convert` trunk; only changes that landed inside that window count.

## Throughput

```
landed per minute (one # is 1.1)

200 agents
  ryke        |################################################| 53
  ryke-nopipe |##################################              | 37.5
```

## Does Ryke win?

| agents | ranking by landed/min | winner |
| ------ | --------------------- | ------ |
| 200    | ryke 53               | ryke   |

Ryke has the highest landed/min at every N >= 50 in this run.

## Speculative pipelining on and off

`ryke-nopipe` is Ryke with `pipeline: false` in the seeded ryke.json: the same agents and the same leases, but the Ledger never forms a second train on the first one's candidate, so one train runs at a time.

| agents | policy      | landed/min | p50 s | p95 s  | verify runs/landed | wasted agent-s | stale_read aborts | stale while ready | max_attempts | trains formed | speculative (formed / confirmed / discarded) |
| ------ | ----------- | ---------- | ----- | ------ | ------------------ | -------------- | ----------------- | ----------------- | ------------ | ------------- | -------------------------------------------- |
| 200    | ryke        | 53         | 50.87 | 98.23  | 0.17               | 2396.5         | 457               | 444               | 76           | 20            | 19 / 18 / 0                                  |
| 200    | ryke-nopipe | 37.5       | 56.5  | 106.81 | 0.16               | 2175.9         | 415               | 407               | 77           | 12            | 0 / 0 / 0                                    |

- 200 agents: pipelining on lands 53/min against 37.5/min with pipelining off (+41.33 %); p95 98.23 s against 106.81 s; verify runs per landed change 0.17 against 0.16; wasted agent-seconds 2396.5 against 2175.9; speculative trains 19 formed, 18 confirmed, 0 discarded.

## Every cell

| policy      | agents | landed | landed/min | p50 s | p95 s  | verify runs/landed | wasted agent-s | trunk breakages | aborts                                         |
| ----------- | ------ | ------ | ---------- | ----- | ------ | ------------------ | -------------- | --------------- | ---------------------------------------------- |
| ryke        | 200    | 106    | 53         | 50.87 | 98.23  | 0.17               | 2396.5         | 0               | stale_read 457, agent_error 1, max_attempts 76 |
| ryke-nopipe | 200    | 75     | 37.5       | 56.5  | 106.81 | 0.16               | 2175.9         | 0               | stale_read 415, max_attempts 77                |

## Cell details

| policy      | agents | incompatible pairs | attempts/landed | changes started | landed in grace | unfinished | refreshes | lease waits | agent errors | mean verify s | loop lag p99/max ms | load avg |
| ----------- | ------ | ------------------ | --------------- | --------------- | --------------- | ---------- | --------- | ----------- | ------------ | ------------- | ------------------- | -------- |
| ryke        | 200    | 11.37 % of 64975   | 5.32            | 383             | 16              | 179        | 206       | 83          | 1            | -             | 83.5/337.6          | 7.69     |
| ryke-nopipe | 200    | 11.3 % of 55104    | 6.53            | 352             | 16              | 182        | 120       | 55          | 0            | -             | 71.9/672.7          | 6.8      |

### Ryke internals

| policy      | agents | trains | mean size | max size | bisect probes | stale warnings | stale aborts (while ready) | text conflicts | train cycle p50/p95 s | lease wait s (gave up) | think lost to refresh s | stale aborts by path                                                                                      |
| ----------- | ------ | ------ | --------- | -------- | ------------- | -------------- | -------------------------- | -------------- | --------------------- | ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| ryke        | 200    | 20     | 6.1       | 8        | 0             | 470            | 458 (444)                  | 0              | 8.85/17.69            | 6580.5 (120)           | 481.5                   | src/format.ts 204, src/ui/layout.ts 102, src/bench/pin-seed-format.ts 64, src/bench/pin-seed-layout.ts 54 |
| ryke-nopipe | 200    | 12     | 6.92      | 8        | 0             | 281            | 415 (407)                  | 0              | 5.99/22.35            | 4564.9 (88)            | 359.2                   | src/format.ts 221, src/ui/layout.ts 107, src/bench/pin-seed-format.ts 58, src/bench/pin-seed-layout.ts 56 |

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
- ryke x 200: 1 agent error(s), for example: bench-156 b156x2: POST /api/txns/t_muze4l0n2qq0/retry → 503: store: store unreachable at http://127.0.0.1:8858: Network connection lost.
- ryke x 200: load average 7.69 on 4 vCPUs at the end of the cell; the machine was oversubscribed.
- ryke-nopipe x 200: load average 6.8 on 4 vCPUs at the end of the cell; the machine was oversubscribed.

