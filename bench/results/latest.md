# Ryke bench

> Synthetic agents: real git, real merges, real tests, scripted edits. Time factor 1 (median think 6 s), seed 7, 4-vCPU VM, Jev off (the tests are the only gate for every policy).

Generated 2026-10-08T05:18:16.372Z. Every cell ran for 120 s of wall time on a fresh `convert` trunk; only changes that landed inside that window count.

## Throughput

```
landed per minute (one # is 1.42)

10 agents
  lock  |#####                                           | 7
  queue |##################                              | 25.5
  ryke  |################                                | 22

50 agents
  lock  |####                                            | 5.5
  queue |#################                               | 24
  ryke  |#########################################       | 58

100 agents
  lock  |####                                            | 5.5
  queue |#############                                   | 19
  ryke  |################################################| 68

200 agents
  lock  |#####                                           | 6.5
  queue |#################                               | 24.5
  ryke  |###########################                     | 38.5
```

## Does Ryke win?

| agents | ranking by landed/min             | winner |
| ------ | --------------------------------- | ------ |
| 10     | queue 25.5 > ryke 22 > lock 7     | queue  |
| 50     | ryke 58 > queue 24 > lock 5.5     | ryke   |
| 100    | ryke 68 > queue 19 > lock 5.5     | ryke   |
| 200    | ryke 38.5 > queue 24.5 > lock 6.5 | ryke   |

Ryke has the highest landed/min at every N >= 50 in this run.

## Every cell

| policy | agents | landed | landed/min | p50 s | p95 s  | verify runs/landed | wasted agent-s | trunk breakages | aborts                                             |
| ------ | ------ | ------ | ---------- | ----- | ------ | ------------------ | -------------- | --------------- | -------------------------------------------------- |
| lock   | 10     | 14     | 7          | 61.19 | 87.32  | 1                  | 0              | 0               | none                                               |
| queue  | 10     | 51     | 25.5       | 14.52 | 27.59  | 1.2                | 147.1          | 0               | failed_verify 10, text_conflict 23, max_attempts 5 |
| ryke   | 10     | 44     | 22         | 12.63 | 23.58  | 0.91               | 146.7          | 0               | stale_read 23, failed_verify 5, max_attempts 4     |
| lock   | 50     | 11     | 5.5        | 70.61 | 108.19 | 1                  | 0              | 0               | none                                               |
| queue  | 50     | 48     | 24         | 62.84 | 105.14 | 1.35               | 299.7          | 0               | failed_verify 17, text_conflict 31                 |
| ryke   | 50     | 116    | 58         | 18.38 | 41.33  | 0.26               | 720.7          | 0               | stale_read 129, failed_verify 3, max_attempts 16   |
| lock   | 100    | 11     | 5.5        | 59.39 | 110.21 | 1                  | 0              | 0               | none                                               |
| queue  | 100    | 38     | 19         | 66.08 | 104.7  | 1.74               | 399.8          | 0               | failed_verify 28, text_conflict 34                 |
| ryke   | 100    | 136    | 68         | 31.42 | 49.67  | 0.15               | 1514.1         | 0               | stale_read 274, max_attempts 39                    |
| lock   | 200    | 13     | 6.5        | 67.11 | 113.77 | 1                  | 0              | 0               | none                                               |
| queue  | 200    | 49     | 24.5       | 68.27 | 112.8  | 1.1                | 160.6          | 0               | text_conflict 27, failed_verify 5                  |
| ryke   | 200    | 77     | 38.5       | 57.38 | 98.07  | 0.16               | 2437.3         | 0               | stale_read 465, max_attempts 85                    |

## Cell details

| policy | agents | incompatible pairs | attempts/landed | changes started | landed in grace | unfinished | refreshes | lease waits | agent errors | mean verify s | loop lag p99/max ms | load avg |
| ------ | ------ | ------------------ | --------------- | --------------- | --------------- | ---------- | --------- | ----------- | ------------ | ------------- | ------------------- | -------- |
| lock   | 10     | 9.09 % of 99       | 1               | 15              | 1               | 0          | 0         | 0           | 0            | 0.3           | 21.1/27.7           | 0.63     |
| queue  | 10     | 10.61 % of 1903    | 1.65            | 66              | 7               | 1          | 0         | 0           | 0            | 0.53          | 23.1/38.6           | 2.94     |
| ryke   | 10     | 10.94 % of 1508    | 1.64            | 58              | 5               | 4          | 47        | 9           | 0            | -             | 23.7/63.4           | 2.45     |
| lock   | 50     | 4.55 % of 66       | 1               | 12              | 1               | 0          | 0         | 0           | 0            | 0.31          | 21/28.2             | 0.63     |
| queue  | 50     | 9.9 % of 4524      | 2               | 98              | 9               | 35         | 0         | 0           | 0            | 0.38          | 23.4/42.4           | 2.53     |
| ryke   | 50     | 10.18 % of 14637   | 2.14            | 182             | 15              | 33         | 130       | 34          | 0            | -             | 37/197.3            | 4.24     |
| lock   | 100    | 5.45 % of 55       | 1               | 12              | 1               | 0          | 0         | 0           | 0            | 0.3           | 21.2/26.7           | 0.97     |
| queue  | 100    | 8.67 % of 8861     | 2.63            | 138             | 7               | 93         | 0         | 0           | 0            | 0.4           | 26.1/113.2          | 2.72     |
| ryke   | 100    | 8.74 % of 30993    | 3.01            | 275             | 24              | 73         | 145       | 49          | 0            | -             | 49.6/239.5          | 4.7      |
| lock   | 200    | 3.61 % of 83       | 1               | 14              | 1               | 0          | 0         | 0           | 0            | 0.32          | 21.6/45.3           | 0.96     |
| queue  | 200    | 12.62 % of 29375   | 1.65            | 249             | 9               | 191        | 0         | 0           | 0            | 0.4           | 42.6/237.5          | 2.67     |
| ryke   | 200    | 11.38 % of 58521   | 7.04            | 362             | 8               | 186        | 132       | 59          | 0            | -             | 71.3/606.6          | 5.69     |

### Ryke internals

| policy | agents | trains | mean size | max size | bisect probes | stale warnings | stale aborts (while ready) | text conflicts | train cycle p50/p95 s | lease wait s (gave up) | think lost to refresh s | stale aborts by path                                                                                      |
| ------ | ------ | ------ | --------- | -------- | ------------- | -------------- | -------------------------- | -------------- | --------------------- | ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| ryke   | 10     | 37     | 1.38      | 4        | 3             | 79             | 23 (21)                    | 0              | 2.42/3.23             | 392.2 (1)              | 121.5                   | src/format.ts 8, src/ui/layout.ts 5, src/bench/pin-b5x1b.ts 4, src/ui/html.ts 2                           |
| ryke   | 50     | 31     | 3.97      | 8        | 0             | 339            | 129 (113)                  | 0              | 3.77/4.5              | 1941.8 (31)            | 398.3                   | src/format.ts 34, src/ui/layout.ts 23, src/bench/pin-seed-format.ts 17, src/ui/html.ts 10                 |
| ryke   | 100    | 21     | 6.86      | 8        | 0             | 329            | 274 (270)                  | 0              | 5.39/7.64             | 3506.4 (67)            | 430.8                   | src/ui/layout.ts 76, src/format.ts 71, src/bench/pin-seed-format.ts 48, src/bench/pin-seed-layout.ts 26   |
| ryke   | 200    | 13     | 6.54      | 8        | 0             | 370            | 466 (464)                  | 0              | 6.23/20.87            | 4704.1 (87)            | 396                     | src/format.ts 228, src/ui/layout.ts 104, src/bench/pin-seed-format.ts 64, src/bench/pin-seed-layout.ts 55 |

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

