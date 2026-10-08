# Briefing: Video und Live-Demo

Für Felix. Das Video wird auf Englisch gesprochen, deshalb stehen die Sprechtexte auf Englisch.
Länge: 7–8 Minuten (Pflicht sind 5–10). Aufnahme am 13.10., Abgabe am 14.10. unter
https://www.cloudflare.com/git-competition.

## Die eine Botschaft

> Every other agent Git platform asks agents to declare what they will touch. Agents get that wrong —
> 90 % of failed multi-agent runs drift outside their declared scope. Ryke doesn't ask. It records what
> each agent actually read, and treats every change as a database transaction.

Das Wort „Transaktion“ muss den Juroren am Ende hängen bleiben. Ryke ist „Git mit Transaktionen“.

## Vorbereitung

- **Lauf aufnehmen:** `npm run swarm -- --mode scripted --agents 12 --fresh --speed 2`. Gibt es bis dahin den Anthropic-Key und funktioniert `--mode claude --agents 8`, nimm stattdessen den Claude-Lauf. Mit echten Agents ist die Demo stärker. Sag dann im Video, dass es echte Claude-Agents sind.
- **Replay nutzen:** Spiel den Lauf über `#/replay` ab, statt live aufzunehmen. So bestimmst du das Tempo selbst und kein Fehlversuch landet im Video.
- **Aufnahme-Setup:** Browser auf 1440×900, heller Modus, Zoom 100 %. Aufnahme mit QuickTime, ohne Mauszeiger-Effekte.

## Szenen

| # | Zeit | Bild | Sprechtext (Kern) |
|---|---|---|---|
| S1 | 0:00–0:40 | Leerer Line-View, dann starten 12 Agents | "This is Ryke. Twelve agents, one codebase, no branches, no pull requests. Each change is a transaction." |
| S2 | 0:40–1:40 | Erste Trains landen, die Ticks springen auf die Hauptlinie | "Agents work in their own Artifacts fork. When they submit, Ryke checks one thing: has anything they *read* changed since they started? If not, non-overlapping changes land together in a train — one test run, one push." |
| S3 | 1:40–3:00 | T-precision landet, mehrere rote Kerben `stale · src/format.ts` | "Here's the interesting part. One agent changed the rounding rule. Five others had read that file. A normal merge would apply all of them cleanly — and break the product, silently. Ryke aborts exactly those five, hands each one the diff, and they retry. Look — they land on the next pass." Dann eine Transaktion öffnen und Read-Set, Stale-Pfad und Delta zeigen |
| S4 | 3:00–3:50 | Heatmap rechts, gelbe gepunktete Lease-Segmente | "Ryke measures where conflicts actually happen. Hot files get serialized; everything else stays fully parallel. No global locks — those collapse throughput, as Cursor reported." |
| S5 | 3:50–4:40 | Duplikat abgelehnt, Konfliktwarnung, Tamper-Versuch rot durchgekreuzt | "Before work starts, Ryke catches duplicate intents with a calibrated judge model. And an agent that tries to edit a protected test is rejected — test tampering is the most common way agents cheat." |
| S6 | 4:40–5:40 | Recall-Dialog: `model = sloppy-v0`, Plan-Vorschau, Ausführen, lila Durchstreichungen, Re-Runs | "Two changes from a bad model version slipped through. One command recalls everything that model landed, reverts it, and revalidates every change that depended on it." |
| S7 | 5:40–6:50 | Bench-Kurve | "Is it faster? We measured. Same repo, same workload, three policies: a global lock, a classic merge queue, and Ryke. At 50, 100, 200 agents …" Zahlen aus `bench/results/latest.md` vorlesen. Klar sagen: "The bench agents are synthetic — real git, real merges, real tests, scripted edits." |
| S8 | 6:50–7:40 | Architekturbild aus der README | "Built entirely on Cloudflare: Artifacts for trunk and forks, one Durable Object per repo as the transaction ledger, Workflows for landing, Containers for git and tests, Dynamic Workers for a live preview of every change, and an MCP endpoint so any agent can join. MIT licensed." |

## Live-Demo bei Cloudflare Connect (falls Finalist)

- **Ablauf:** Dashboard auf `ryke.ai` öffnen, „Run demo“ drücken (Admin-Token vorher eingeben) und S2–S6 live zeigen.
- **Ausweichplan:** Fällt etwas aus, wechselst du auf den Replay des aufgenommenen Laufs, ohne Erklärung, einfach weiter.
- **Wahrscheinliche Juror-Fragen:**
  - *Agents reading via Bash `cat`?* → Reads laufen über Hooks am Read-, Grep- und Glob-Tool. Wer nichts meldet, wird konservativ serialisiert.
  - *Symbol-level?* → Dateiebene ist bewusst gewählt: messbar und ehrlich. Symbole wären der nächste Schritt.
  - *Why Jev?* → Typisierte, kalibrierte Urteile. Die harten Prüfungen laufen im Code.

## Was du selbst noch tun musst

- **A1 Workers Paid aktivieren:** Danach den Cloudflare-Token anlegen (Rechte in `docs/deploy.md`) und `npm run deploy` ausführen.
- **A2 Anthropic-API-Key:** Als Worker-Secret und in `.dev.vars` hinterlegen, dann `--mode claude` testen.
- **A3 Video aufnehmen:** Nach diesem Drehbuch, und vor dem Hochladen die Bench-Zahlen gegen `bench/results/latest.md` prüfen.
- **A4 Einreichen:** Das Formular mit Video-Link, `https://github.com/cloudlei-de/ryke` und dem Quickstart aus der README ausfüllen.
