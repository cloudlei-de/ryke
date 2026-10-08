# Ryke bench

> Synthetic agents: real git, real merges, real tests, scripted edits. Time factor 1 (median think 6 s), seed 7, 4-vCPU VM, Jev off (the tests are the only gate for every policy).

Generated 2026-10-08T11:00:03.044Z. Every cell ran for 120 s of wall time on a fresh `convert` trunk; only changes that landed inside that window count.

## Throughput

```
landed per minute (one # is 1.57)

10 agents
  lock  |####                                            | 6.5
  queue |###############                                 | 23
  ryke  |################                                | 24.5

50 agents
  lock  |###                                             | 5.5
  queue |###############                                 | 23
  ryke  |#######################################         | 61.5

100 agents
  lock  |###                                             | 5.5
  queue |############                                    | 18.5
  ryke  |################################################| 75.5

200 agents
  lock  |####                                            | 6
  queue |##############                                  | 22
  ryke  |############################                    | 43.5
```

## Does Ryke win?

| agents | ranking by landed/min             | winner |
| ------ | --------------------------------- | ------ |
| 10     | ryke 24.5 > queue 23 > lock 6.5   | ryke   |
| 50     | ryke 61.5 > queue 23 > lock 5.5   | ryke   |
| 100    | ryke 75.5 > queue 18.5 > lock 5.5 | ryke   |
| 200    | ryke 43.5 > queue 22 > lock 6     | ryke   |

Ryke has the highest landed/min at every N >= 50 in this run.

## Every cell

| policy | agents | landed | landed/min | p50 s | p95 s  | verify runs/landed | wasted agent-s | trunk breakages | aborts                                             |
| ------ | ------ | ------ | ---------- | ----- | ------ | ------------------ | -------------- | --------------- | -------------------------------------------------- |
| lock   | 10     | 13     | 6.5        | 60.56 | 88.98  | 1                  | 0              | 0               | none                                               |
| queue  | 10     | 46     | 23         | 15.64 | 28.66  | 1.3                | 156.5          | 0               | failed_verify 14, text_conflict 20, max_attempts 7 |
| ryke   | 10     | 49     | 24.5       | 13.64 | 43.24  | 0.94               | 168.3          | 0               | stale_read 24, failed_verify 3, max_attempts 1     |
| lock   | 50     | 11     | 5.5        | 70.99 | 108.55 | 1                  | 0              | 0               | none                                               |
| queue  | 50     | 46     | 23         | 63.91 | 103.51 | 1.39               | 313.9          | 0               | failed_verify 18, text_conflict 32                 |
| ryke   | 50     | 123    | 61.5       | 17.98 | 35.26  | 0.37               | 691.3          | 0               | stale_read 119, failed_verify 3, max_attempts 14   |
| lock   | 100    | 11     | 5.5        | 60.3  | 111.86 | 1                  | 0              | 0               | none                                               |
| queue  | 100    | 37     | 18.5       | 63.53 | 103.97 | 1.76               | 381.6          | 0               | text_conflict 33, failed_verify 28                 |
| ryke   | 100    | 151    | 75.5       | 29.75 | 59.02  | 0.2                | 1393.1         | 0               | stale_read 250, failed_verify 3, max_attempts 34   |
| lock   | 200    | 12     | 6          | 61.54 | 106.56 | 1                  | 0              | 0               | none                                               |
| queue  | 200    | 44     | 22         | 66.89 | 112.5  | 1.05               | 168.5          | 0               | text_conflict 31, failed_verify 2                  |
| ryke   | 200    | 87     | 43.5       | 57.9  | 106.87 | 0.21               | 2072.6         | 0               | stale_read 390, failed_verify 1, max_attempts 67   |

## Cell details

| policy | agents | incompatible pairs | attempts/landed | changes started | landed in grace | unfinished | refreshes | lease waits | agent errors | mean verify s | loop lag p99/max ms | load avg |
| ------ | ------ | ------------------ | --------------- | --------------- | --------------- | ---------- | --------- | ----------- | ------------ | ------------- | ------------------- | -------- |
| lock   | 10     | 10.47 % of 86      | 1               | 14              | 1               | 0          | 0         | 0           | 0            | 0.32          | 21.3/84.5           | 1.34     |
| queue  | 10     | 9.28 % of 1724     | 1.74            | 63              | 8               | 1          | 0         | 0           | 0            | 0.51          | 23.2/87             | 2.29     |
| ryke   | 10     | 11.72 % of 1604    | 1.55            | 60              | 3               | 7          | 57        | 9           | 0            | -             | 25.7/110.2          | 2.07     |
| lock   | 50     | 4.55 % of 66       | 1               | 12              | 1               | 0          | 0         | 0           | 0            | 0.33          | 21.6/72.8           | 0.42     |
| queue  | 50     | 9.99 % of 4295     | 2.09            | 96              | 6               | 42         | 0         | 0           | 0            | 0.41          | 23.6/67.4           | 3.54     |
| ryke   | 50     | 9.53 % of 15232    | 1.99            | 187             | 18              | 32         | 156       | 26          | 0            | -             | 47.7/719.3          | 4.89     |
| lock   | 100    | 5.45 % of 55       | 1               | 12              | 1               | 0          | 0         | 0           | 0            | 0.34          | 22.2/58.6           | 0.79     |
| queue  | 100    | 9.24 % of 8764     | 2.65            | 137             | 8               | 92         | 0         | 0           | 0            | 0.43          | 28.5/150.5          | 3.25     |
| ryke   | 100    | 7.65 % of 33315    | 2.68            | 285             | 26              | 68         | 103       | 43          | 0            | -             | 55.3/150.3          | 8.04     |
| lock   | 200    | 4.17 % of 72       | 1               | 13              | 1               | 0          | 0         | 0           | 0            | 0.32          | 21.7/49.9           | 1.4      |
| queue  | 200    | 12.94 % of 28489   | 1.75            | 244             | 9               | 191        | 0         | 0           | 0            | 0.43          | 42.1/90.1           | 2.82     |
| ryke   | 200    | 12 % of 56281      | 5.49            | 354             | 32              | 167        | 146       | 56          | 0            | -             | 79.4/663.2          | 8.3      |

### Ryke internals

| policy | agents | trains | mean size | max size | bisect probes | stale warnings | stale aborts (while ready) | text conflicts | train cycle p50/p95 s | lease wait s (gave up) | think lost to refresh s | stale aborts by path                                                                                      |
| ------ | ------ | ------ | --------- | -------- | ------------- | -------------- | -------------------------- | -------------- | --------------------- | ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| ryke   | 10     | 45     | 1.16      | 2        | 0             | 96             | 24 (22)                    | 0              | 2.77/3.33             | 316.7 (1)              | 125.9                   | src/format.ts 12, src/bench/pin-b5x1b.ts 4, src/ui/layout.ts 4, src/units/mass.ts 2                       |
| ryke   | 50     | 45     | 3.11      | 8        | 2             | 340            | 119 (107)                  | 0              | 4.07/4.96             | 1818.2 (42)            | 384                     | src/format.ts 34, src/bench/pin-seed-format.ts 12, src/bench/pin-seed-layout.ts 11, src/ui/layout.ts 10   |
| ryke   | 100    | 28     | 5.96      | 8        | 4             | 307            | 250 (239)                  | 0              | 7.17/9.49             | 2977 (37)              | 286.5                   | src/ui/layout.ts 58, src/bench/pin-seed-format.ts 45, src/format.ts 32, src/bench/pin-seed-layout.ts 24   |
| ryke   | 200    | 17     | 6.59      | 8        | 3             | 348            | 390 (383)                  | 0              | 9.47/21.99            | 4470.9 (88)            | 376.2                   | src/ui/layout.ts 154, src/format.ts 145, src/bench/pin-seed-layout.ts 75, src/bench/pin-seed-format.ts 57 |

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
- ryke x 100: load average 8.04 on 4 vCPUs at the end of the cell; the machine was oversubscribed.
- ryke x 200: load average 8.3 on 4 vCPUs at the end of the cell; the machine was oversubscribed.

