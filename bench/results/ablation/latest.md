# Ryke bench

> Synthetic agents: real git, real merges, real tests, scripted edits. Time factor 1 (median think 6 s), seed 7, 4-vCPU VM, Jev off (the tests are the only gate for every policy).

Generated 2026-10-08T05:50:41.738Z. Every cell ran for 120 s of wall time on a fresh `convert` trunk; only changes that landed inside that window count.

## Throughput

```
landed per minute (one # is 1.33)

50 agents
  ryke         |##########################################      | 56
  ryke-nolease |###################################             | 46

100 agents
  ryke         |################################################| 64
  ryke-nolease |#######################                         | 31
```

## Does Ryke win?

| agents | ranking by landed/min | winner |
| ------ | --------------------- | ------ |
| 50     | ryke 56               | ryke   |
| 100    | ryke 64               | ryke   |

Ryke has the highest landed/min at every N >= 50 in this run.

## Write leases on and off

`ryke-nolease` is Ryke with the same agents and the same refresh on a stale warning, but the agents never take write leases.

| agents | policy       | landed/min | p50 s | p95 s | wasted agent-s | stale_read aborts | max_attempts | refreshes | lease waits   | stale while ready |
| ------ | ------------ | ---------- | ----- | ----- | -------------- | ----------------- | ------------ | --------- | ------------- | ----------------- |
| 50     | ryke         | 56         | 18.79 | 40.53 | 576.9          | 106               | 13           | 81        | 31 (1898.5 s) | 95                |
| 50     | ryke-nolease | 46         | 24.92 | 60.63 | 1308.8         | 245               | 56           | 142       | 0 (0 s)       | 228               |
| 100    | ryke         | 64         | 25.5  | 60.36 | 1370.9         | 246               | 37           | 126       | 51 (3788.5 s) | 240               |
| 100    | ryke-nolease | 31         | 35.66 | 69.82 | 2571.1         | 502               | 133          | 81        | 0 (0 s)       | 484               |

- 50 agents: leases on land 56/min against 46/min with leases off (+21.74 %); stale_read aborts 106 against 245; wasted agent-seconds 576.9 against 1308.8.
- 100 agents: leases on land 64/min against 31/min with leases off (+106.45 %); stale_read aborts 246 against 502; wasted agent-seconds 1370.9 against 2571.1.

## Every cell

| policy       | agents | landed | landed/min | p50 s | p95 s | verify runs/landed | wasted agent-s | trunk breakages | aborts                                            |
| ------------ | ------ | ------ | ---------- | ----- | ----- | ------------------ | -------------- | --------------- | ------------------------------------------------- |
| ryke         | 50     | 112    | 56         | 18.79 | 40.53 | 0.31               | 576.9          | 0               | stale_read 106, failed_verify 5, max_attempts 13  |
| ryke-nolease | 50     | 92     | 46         | 24.92 | 60.63 | 0.4                | 1308.8         | 0               | stale_read 245, failed_verify 7, max_attempts 56  |
| ryke         | 100    | 128    | 64         | 25.5  | 60.36 | 0.2                | 1370.9         | 0               | stale_read 246, failed_verify 2, max_attempts 37  |
| ryke-nolease | 100    | 62     | 31         | 35.66 | 69.82 | 0.4                | 2571.1         | 0               | stale_read 502, failed_verify 5, max_attempts 133 |

## Cell details

| policy       | agents | incompatible pairs | attempts/landed | changes started | landed in grace | unfinished | refreshes | lease waits | agent errors | mean verify s | loop lag p99/max ms | load avg |
| ------------ | ------ | ------------------ | --------------- | --------------- | --------------- | ---------- | --------- | ----------- | ------------ | ------------- | ------------------- | -------- |
| ryke         | 50     | 10.18 % of 13503   | 1.99            | 175             | 13              | 35         | 81        | 31          | 0            | -             | 38.4/519            | 4.08     |
| ryke-nolease | 50     | 8.97 % of 17071    | 3.74            | 198             | 22              | 19         | 142       | 0           | 0            | -             | 45.5/203.7          | 4.67     |
| ryke         | 100    | 8.96 % of 29838    | 2.94            | 265             | 32              | 57         | 126       | 51          | 0            | -             | 50.2/362.5          | 5.96     |
| ryke-nolease | 100    | 8.27 % of 38189    | 9.18            | 295             | 15              | 82         | 81        | 0           | 0            | -             | 52/322.7            | 6.14     |

### Ryke internals

| policy       | agents | trains | mean size | max size | bisect probes | stale warnings | stale aborts (while ready) | text conflicts | train cycle p50/p95 s | lease wait s (gave up) | think lost to refresh s | stale aborts by path                                                                                      |
| ------------ | ------ | ------ | --------- | -------- | ------------- | -------------- | -------------------------- | -------------- | --------------------- | ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| ryke         | 50     | 27     | 4.52      | 8        | 9             | 201            | 106 (95)                   | 0              | 3.7/7.11              | 1898.5 (29)            | 243.5                   | src/format.ts 26, src/bench/pin-seed-format.ts 24, src/ui/layout.ts 21, src/units/temperature.ts 7        |
| ryke-nolease | 50     | 22     | 4.86      | 8        | 16            | 136            | 245 (228)                  | 0              | 4.5/9.47              | 0 (0)                  | 551.5                   | src/format.ts 71, src/bench/pin-seed-format.ts 40, src/ui/layout.ts 31, src/ui/html.ts 20                 |
| ryke         | 100    | 21     | 6.57      | 8        | 5             | 332            | 246 (240)                  | 0              | 5/7.3                 | 3788.5 (61)            | 392.8                   | src/bench/pin-seed-format.ts 52, src/ui/layout.ts 46, src/format.ts 30, src/units/temperature.ts 17       |
| ryke-nolease | 100    | 15     | 5         | 8        | 11            | 98             | 502 (484)                  | 0              | 7.04/14.14            | 0 (0)                  | 529                     | src/ui/layout.ts 164, src/format.ts 138, src/bench/pin-seed-format.ts 81, src/bench/pin-seed-layout.ts 45 |

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
- `ryke-nolease` is Ryke with write leases off: identical agents and refresh on a stale warning, but they never call intend-write. The dashboard's results format only knows lock, queue and ryke, so this run is not written to bench/results/latest.json.
- ryke-nolease x 100: load average 6.14 on 4 vCPUs at the end of the cell; the machine was oversubscribed.

