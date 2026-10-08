# Ryke bench

> Synthetic agents: real git, real merges, real tests, scripted edits. Time factor 1 (median think 6 s), seed 7, 4-vCPU VM, Jev off (the tests are the only gate for every policy).

Generated 2026-10-08T10:16:26.042Z. Every cell ran for 120 s of wall time on a fresh `convert` trunk; only changes that landed inside that window count.

## Throughput

```
landed per minute (one # is 1.52)

50 agents
  ryke         |############################################    | 67
  ryke-nolease |############################                    | 42.5
  ryke-nopipe  |######################################          | 58

100 agents
  ryke         |################################################| 73
  ryke-nolease |#########################                       | 38.5
  ryke-nopipe  |####################################            | 55.5

200 agents
  ryke         |###################                             | 28.5
  ryke-nolease |############                                    | 17.5
  ryke-nopipe  |########################                        | 36
```

## Does Ryke win?

| agents | ranking by landed/min | winner |
| ------ | --------------------- | ------ |
| 50     | ryke 67               | ryke   |
| 100    | ryke 73               | ryke   |
| 200    | ryke 28.5             | ryke   |

Ryke has the highest landed/min at every N >= 50 in this run.

## Write leases on and off

`ryke-nolease` is Ryke with the same agents and the same refresh on a stale warning, but the agents never take write leases.

| agents | policy       | landed/min | p50 s | p95 s | wasted agent-s | stale_read aborts | max_attempts | refreshes | lease waits   | stale while ready |
| ------ | ------------ | ---------- | ----- | ----- | -------------- | ----------------- | ------------ | --------- | ------------- | ----------------- |
| 50     | ryke         | 67         | 16.35 | 37.03 | 712.6          | 118               | 9            | 171       | 29 (2009.2 s) | 104               |
| 50     | ryke-nolease | 42.5       | 23.54 | 58.01 | 1297.6         | 260               | 56           | 219       | 0 (0 s)       | 243               |
| 100    | ryke         | 73         | 27.64 | 59.68 | 1783.4         | 317               | 46           | 209       | 54 (3595 s)   | 291               |
| 100    | ryke-nolease | 38.5       | 37.78 | 70.35 | 2433.5         | 462               | 122          | 132       | 0 (0 s)       | 420               |
| 200    | ryke         | 28.5       | 68.44 | 110   | 1758.5         | 318               | 32           | 119       | 62 (5109.4 s) | 310               |
| 200    | ryke-nolease | 17.5       | 78.39 | 98.88 | 2544.4         | 510               | 109          | 51        | 0 (0 s)       | 500               |

- 50 agents: leases on land 67/min against 42.5/min with leases off (+57.65 %); stale_read aborts 118 against 260; wasted agent-seconds 712.6 against 1297.6.
- 100 agents: leases on land 73/min against 38.5/min with leases off (+89.61 %); stale_read aborts 317 against 462; wasted agent-seconds 1783.4 against 2433.5.
- 200 agents: leases on land 28.5/min against 17.5/min with leases off (+62.86 %); stale_read aborts 318 against 510; wasted agent-seconds 1758.5 against 2544.4.

## Speculative pipelining on and off

`ryke-nopipe` is Ryke with `pipeline: false` in the seeded ryke.json: the same agents and the same leases, but the Ledger never forms a second train on the first one's candidate, so one train runs at a time.

| agents | policy      | landed/min | p50 s | p95 s  | verify runs/landed | wasted agent-s | stale_read aborts | stale while ready | max_attempts | trains formed | speculative (formed / confirmed / discarded) |
| ------ | ----------- | ---------- | ----- | ------ | ------------------ | -------------- | ----------------- | ----------------- | ------------ | ------------- | -------------------------------------------- |
| 50     | ryke        | 67         | 16.35 | 37.03  | 0.33               | 712.6          | 118               | 104               | 9            | 46            | 39 / 37 / 1                                  |
| 50     | ryke-nopipe | 58         | 19.66 | 47.74  | 0.27               | 622            | 106               | 93                | 12           | 28            | 0 / 0 / 0                                    |
| 100    | ryke        | 73         | 27.64 | 59.68  | 0.18               | 1783.4         | 317               | 291               | 46           | 28            | 27 / 27 / 0                                  |
| 100    | ryke-nopipe | 55.5       | 32.16 | 69.12  | 0.2                | 1465           | 271               | 267               | 45           | 19            | 0 / 0 / 0                                    |
| 200    | ryke        | 28.5       | 68.44 | 110    | 0.46               | 1758.5         | 318               | 310               | 32           | 15            | 11 / 7 / 3                                   |
| 200    | ryke-nopipe | 36         | 57.02 | 105.58 | 0.15               | 2161.4         | 416               | 413               | 77           | 11            | 0 / 0 / 0                                    |

- 50 agents: pipelining on lands 67/min against 58/min with pipelining off (+15.52 %); p95 37.03 s against 47.74 s; verify runs per landed change 0.33 against 0.27; wasted agent-seconds 712.6 against 622; speculative trains 39 formed, 37 confirmed, 1 discarded.
- 100 agents: pipelining on lands 73/min against 55.5/min with pipelining off (+31.53 %); p95 59.68 s against 69.12 s; verify runs per landed change 0.18 against 0.2; wasted agent-seconds 1783.4 against 1465; speculative trains 27 formed, 27 confirmed, 0 discarded.
- 200 agents: pipelining on lands 28.5/min against 36/min with pipelining off (-20.83 %); p95 110 s against 105.58 s; verify runs per landed change 0.46 against 0.15; wasted agent-seconds 1758.5 against 2161.4; speculative trains 11 formed, 7 confirmed, 3 discarded.

## Every cell

| policy       | agents | landed | landed/min | p50 s | p95 s  | verify runs/landed | wasted agent-s | trunk breakages | aborts                                            |
| ------------ | ------ | ------ | ---------- | ----- | ------ | ------------------ | -------------- | --------------- | ------------------------------------------------- |
| ryke         | 50     | 134    | 67         | 16.35 | 37.03  | 0.33               | 712.6          | 0               | stale_read 118, failed_verify 3, max_attempts 9   |
| ryke-nolease | 50     | 85     | 42.5       | 23.54 | 58.01  | 0.51               | 1297.6         | 0               | stale_read 260, failed_verify 6, max_attempts 56  |
| ryke-nopipe  | 50     | 116    | 58         | 19.66 | 47.74  | 0.27               | 622            | 0               | stale_read 106, failed_verify 3, max_attempts 12  |
| ryke         | 100    | 146    | 73         | 27.64 | 59.68  | 0.18               | 1783.4         | 0               | stale_read 317, max_attempts 46                   |
| ryke-nolease | 100    | 77     | 38.5       | 37.78 | 70.35  | 0.34               | 2433.5         | 0               | stale_read 462, failed_verify 3, max_attempts 122 |
| ryke-nopipe  | 100    | 111    | 55.5       | 32.16 | 69.12  | 0.2                | 1465           | 0               | stale_read 271, failed_verify 2, max_attempts 45  |
| ryke         | 200    | 57     | 28.5       | 68.44 | 110    | 0.46               | 1758.5         | 0               | stale_read 318, failed_verify 3, max_attempts 32  |
| ryke-nolease | 200    | 35     | 17.5       | 78.39 | 98.88  | 0.37               | 2544.4         | 0               | stale_read 510, failed_verify 1, max_attempts 109 |
| ryke-nopipe  | 200    | 72     | 36         | 57.02 | 105.58 | 0.15               | 2161.4         | 0               | stale_read 416, max_attempts 77                   |

## Cell details

| policy       | agents | incompatible pairs | attempts/landed | changes started | landed in grace | unfinished | refreshes | lease waits | agent errors | mean verify s | loop lag p99/max ms | load avg |
| ------------ | ------ | ------------------ | --------------- | --------------- | --------------- | ---------- | --------- | ----------- | ------------ | ------------- | ------------------- | -------- |
| ryke         | 50     | 10.09 % of 16156   | 1.9             | 193             | 14              | 35         | 171       | 29          | 0            | -             | 43.8/280.8          | 6.38     |
| ryke-nolease | 50     | 9.94 % of 16012    | 4.13            | 191             | 10              | 9          | 219       | 0           | 0            | -             | 59.7/626.5          | 7.41     |
| ryke-nopipe  | 50     | 10.34 % of 13835   | 1.94            | 178             | 15              | 34         | 130       | 29          | 0            | -             | 40/155.6            | 3.34     |
| ryke         | 100    | 8.41 % of 35509    | 3.17            | 292             | 19              | 71         | 209       | 54          | 0            | -             | 73.3/253.1          | 9.02     |
| ryke-nolease | 100    | 8.03 % of 38842    | 7.04            | 299             | 40              | 49         | 132       | 0           | 0            | -             | 74.4/299.6          | 8.04     |
| ryke-nopipe  | 100    | 7.97 % of 27367    | 3.46            | 256             | 32              | 64         | 88        | 29          | 0            | -             | 52.6/369.9          | 4.98     |
| ryke         | 200    | 12.81 % of 38466   | 6.63            | 289             | 40              | 148        | 119       | 62          | 0            | -             | 75.8/487.6          | 6.39     |
| ryke-nolease | 200    | 11.91 % of 54265   | 15.6            | 344             | 7               | 185        | 51        | 0           | 0            | -             | 73.7/870.8          | 6.17     |
| ryke-nopipe  | 200    | 11.66 % of 54735   | 6.78            | 349             | 8               | 187        | 133       | 57          | 0            | -             | 72/714.6            | 5.71     |

### Ryke internals

| policy       | agents | trains | mean size | max size | bisect probes | stale warnings | stale aborts (while ready) | text conflicts | train cycle p50/p95 s | lease wait s (gave up) | think lost to refresh s | stale aborts by path                                                                                      |
| ------------ | ------ | ------ | --------- | -------- | ------------- | -------------- | -------------------------- | -------------- | --------------------- | ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| ryke         | 50     | 46     | 3.17      | 8        | 0             | 436            | 118 (104)                  | 0              | 4.45/5.11             | 2009.2 (42)            | 428.4                   | src/format.ts 24, src/bench/pin-seed-format.ts 23, src/ui/layout.ts 17, src/bench/pin-seed-layout.ts 11   |
| ryke-nolease | 50     | 36     | 2.83      | 8        | 9             | 216            | 260 (243)                  | 0              | 4.88/10.36            | 0 (0)                  | 566.3                   | src/format.ts 85, src/bench/pin-seed-format.ts 50, src/bench/pin-b41x1a.ts 25, src/ui/layout.ts 24        |
| ryke-nopipe  | 50     | 28     | 4.36      | 8        | 4             | 328            | 106 (93)                   | 0              | 3.76/6.5              | 2052.4 (35)            | 402.5                   | src/ui/layout.ts 26, src/bench/pin-seed-format.ts 17, src/format.ts 16, src/units/length.ts 9             |
| ryke         | 100    | 28     | 5.5       | 8        | 0             | 477            | 317 (291)                  | 0              | 7.34/10.14            | 3595 (67)              | 527.9                   | src/format.ts 93, src/bench/pin-seed-format.ts 53, src/ui/layout.ts 50, src/bench/pin-seed-layout.ts 29   |
| ryke-nolease | 100    | 20     | 4.5       | 8        | 7             | 165            | 462 (420)                  | 0              | 8.06/16.48            | 0 (0)                  | 596.5                   | src/format.ts 129, src/ui/layout.ts 109, src/bench/pin-seed-format.ts 79, src/bench/pin-seed-layout.ts 71 |
| ryke-nopipe  | 100    | 19     | 6.37      | 8        | 4             | 250            | 271 (267)                  | 0              | 5.99/8.26             | 1899.8 (21)            | 287.1                   | src/ui/layout.ts 55, src/bench/pin-seed-format.ts 52, src/format.ts 29, src/bench/pin-seed-layout.ts 23   |
| ryke         | 200    | 15     | 6.67      | 8        | 12            | 132            | 318 (310)                  | 0              | 13.67/22.53           | 5109.4 (93)            | 313.1                   | src/format.ts 151, src/ui/layout.ts 113, src/bench/pin-seed-layout.ts 58, src/bench/pin-seed-format.ts 55 |
| ryke-nolease | 200    | 10     | 5.6       | 8        | 5             | 61             | 510 (500)                  | 0              | 19.31/29.5            | 0 (0)                  | 293                     | src/ui/layout.ts 246, src/format.ts 144, src/bench/pin-seed-format.ts 86, src/bench/pin-seed-layout.ts 56 |
| ryke-nopipe  | 200    | 11     | 6.55      | 8        | 0             | 341            | 416 (413)                  | 0              | 6.45/22.22            | 4340.4 (75)            | 389.7                   | src/format.ts 215, src/ui/layout.ts 102, src/bench/pin-seed-format.ts 59, src/bench/pin-seed-layout.ts 54 |

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
- `ryke-nolease` is Ryke with write leases off: identical agents and refresh on a stale warning, but they never call intend-write. `ryke-nopipe` is Ryke with speculative pipelining off (`pipeline: false` in the seeded ryke.json): identical agents and leases, but the Ledger forms one train at a time. The dashboard's results format only knows lock, queue and ryke, so this run is not written to bench/results/latest.json.
- ryke x 50: load average 6.38 on 4 vCPUs at the end of the cell; the machine was oversubscribed.
- ryke-nolease x 50: load average 7.41 on 4 vCPUs at the end of the cell; the machine was oversubscribed.
- ryke x 100: load average 9.02 on 4 vCPUs at the end of the cell; the machine was oversubscribed.
- ryke-nolease x 100: load average 8.04 on 4 vCPUs at the end of the cell; the machine was oversubscribed.
- ryke x 200: load average 6.39 on 4 vCPUs at the end of the cell; the machine was oversubscribed.
- ryke-nolease x 200: load average 6.17 on 4 vCPUs at the end of the cell; the machine was oversubscribed.

