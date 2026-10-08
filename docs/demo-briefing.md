# Briefing: Video und Live-Demo

Für Felix. Das Video wird auf Englisch gesprochen, deshalb stehen die Sprechtexte auf Englisch.
Länge: 7–8 Minuten (Pflicht sind 5–10). Aufnahme am 13.10., Abgabe am 14.10. unter
https://www.cloudflare.com/git-competition.

## Die eine Botschaft

> Every other agent Git platform asks agents to declare what they will touch. Agents get that wrong —
> in about 90 % of failed multi-agent runs, the agents' changes drifted across module boundaries.
> Ryke doesn't ask. It records what each agent actually read, and treats every change as a database
> transaction.

Das Wort „Transaktion“ muss den Juroren am Ende hängen bleiben. Ryke ist „Git mit Transaktionen“.

## Vorbereitung

- **Lauf aufnehmen:** Zuerst den Jev-Key in der Shell exportieren (`export TYPESAFE_API_KEY=…`), dann `npm run dev:all` starten. Ohne Key ist das Duplikat-Screening aus und S5 zeigt nichts. Dann `npm run swarm -- --mode scripted --agents 12 --fresh` im Standardtempo. Langsamer als `--speed 4` wurde nie gemessen; mit `--speed 1` landeten nur 32 Tasks. Das Tempo im Video bestimmst du über den Replay. Gibt es bis dahin den Anthropic-Key und funktioniert `--mode claude --agents 8`, nimm stattdessen den Claude-Lauf. Mit echten Agents ist die Demo stärker. Sag dann im Video, dass es echte Claude-Agents sind.
- **Replay nutzen:** Spiel den Lauf über `#/replay` ab, statt live aufzunehmen. So bestimmst du das Tempo selbst und kein Fehlversuch landet im Video.
- **Aufnahme-Setup:** Browser auf 1440×900, heller Modus, Zoom 100 %. Aufnahme mit QuickTime, ohne Mauszeiger-Effekte.

## Szenen

| # | Zeit | Bild | Sprechtext (Kern) |
|---|---|---|---|
| S1 | 0:00–0:40 | Leerer Line-View, dann starten die Agents. Es sind 12 Worker; der Line-View zeigt 13 Zeilen, weil die Änderungen des „sloppy“-Modells immer als agent-13 laufen | "This is Ryke. Twelve scripted agents — they replay prepared changes, so the run is repeatable — one codebase, no branches, no pull requests. Each change is a transaction." Beim Claude-Lauf stattdessen sagen, dass es echte Claude-Agents sind. |
| S2 | 0:40–1:40 | Erste Trains landen: Striche erscheinen auf der Trunk-Linie oben, ein Train mit einer Klammer und der Zahl seiner Änderungen darüber, die grünen Bänder enden mit einer Diagonale Richtung Trunk; die Zähler „Landed“ und „Trains“ steigen | "Agents work in their own Artifacts fork. When they submit, Ryke checks one thing: has anything they *read* changed since they started? If not, non-overlapping changes land together in a train — one test run, one push." |
| S3 | 1:40–3:00 | T-precision landet: sein Trunk-Strich wird rot („9 stale“), von ihm fällt eine rote Hilfslinie mit einer gepunkteten Abzweigung zu jeder Änderung, die er stale gemacht hat, bis zu deren roter Kerbe (wer schon wartete, sofort; wer noch arbeitete, beim eigenen Submit); im Activity-Feed „went stale · src/format.ts changed by …“. Hover über eine Kerbe zeigt Pfad und Verursacher | "Here's the interesting part. One agent changed the rounding rule. Every agent still working on something that had read that file is now building on an old version. A normal merge would apply all of them cleanly — and break the product, silently. Ryke aborts exactly those, hands each one the diff, and they retry. Look — they land on the next pass." Keine Zahl nennen, oder sie aus dem Swarm-Report des aufgenommenen Laufs ablesen (Zeile `t-precision`, zuletzt 9). Dann eine Transaktion öffnen und Read-Set, Stale-Pfad und Delta zeigen |
| S4 | 3:00–3:50 | „Hot files“ rechts (`src/format.ts` und `src/ui/layout.ts` fett, Skala rot über der Marke), gelbe Warndreiecke über den Bändern | "Ryke measures where conflicts actually happen, and warns an agent the moment a file it read changes. When two agents want to write the same hot file, the second one waits instead of working on a doomed snapshot; everything else stays fully parallel. In our bench with synthetic agents that took Ryke from 42.5 to 67 changes per minute at 50 agents. No global locks — those collapse throughput, as Cursor reported." Im Skript-Lauf wartet nie jemand auf eine Lease, weil keine zwei Tasks gleichzeitig eine heiße Datei schreiben; die Lease-Wirkung deshalb ausdrücklich als Bench-Zahl sagen. |
| S5 | 3:50–4:40 | Duplikat abgelehnt oder gewarnt (dup-speed liegt mit 0,81–0,87 knapp über der Ablehnungsschwelle 0,80), Konfliktwarnung, Tamper-Versuch mit rotem Prellbock am Bandende und „wrote a protected path“ auf seiner Transaktionsseite | "Before work starts, Ryke catches duplicate intents with a calibrated judge model. And an agent that tries to edit a protected test is rejected — on tasks they cannot solve honestly, models tamper with the tests 39 to 76 percent of the time." |
| S6 | 4:40–5:40 | Recall-Dialog: `model = sloppy-v0`, Plan-Vorschau, Ausführen, durchgestrichene Ziele mit roten Knoten, Re-Runs; auf dem Line-View danach die Durchstreichung und die Raute des Revert-Commits auf Trunk | "Two changes from a bad model version slipped through. One command recalls everything that model landed, reverts it, and revalidates every change that depended on it." |
| S7 | 5:40–6:50 | Bench-Kurve | "Is it faster? We measured. Same repo, same workload, three policies: a global lock, a classic merge queue, and Ryke. At 50, 100, 200 agents …" Zahlen aus `bench/results/latest.md` vorlesen. Klar sagen: "The bench agents are synthetic — real git, real merges, real tests, scripted edits." |
| S8 | 6:50–7:40 | Architekturbild aus der README | "Built for Cloudflare: Artifacts for trunk and forks, one Durable Object per repo as the transaction ledger, Workflows for landing, Containers for git and tests, Dynamic Workers for a live preview of every change, and an MCP endpoint so any agent can join. MIT licensed." Nur wenn es bis dahin auf `ryke.ai` läuft, darfst du "runs on Cloudflare" sagen; sonst dazusagen: "What you saw ran locally, with stand-ins for Artifacts and Containers." |

## Live-Demo bei Cloudflare Connect (falls Finalist)

- **Ablauf:** Dashboard auf `ryke.ai` öffnen und den Lauf vom Laptop gegen die echte API starten: `RYKE_API_URL=https://ryke.ai RYKE_TOKEN=… npm run swarm -- --mode scripted --agents 12 --repo convert` (wie in `docs/deploy.md`). „Run demo“ im Dashboard funktioniert nur lokal; im Container-Modus antwortet es 503, weil der Swarm dort kein Job ist. Dann S2–S6 live zeigen.
- **Ausweichplan:** Fällt etwas aus, wechselst du auf den Replay des aufgenommenen Laufs, ohne Erklärung, einfach weiter.
- **Wahrscheinliche Juror-Fragen:**
  - *Agents reading via Bash `cat`?* → Reads laufen über Hooks am Read-, Grep- und Glob-Tool. Meldet eine Transaktion keine Reads, gilt sie so, als hätte sie jede Datei in den Verzeichnissen gelesen, in die sie schreibt.
  - *Symbol-level?* → Dateiebene ist bewusst gewählt: messbar und ehrlich. Symbole wären der nächste Schritt.
  - *Why Jev?* → Typisierte, kalibrierte Urteile. Die harten Prüfungen laufen im Code.

## Was du selbst noch tun musst

- **A1 Workers Paid aktivieren:** Danach den Cloudflare-Token anlegen (Rechte in `docs/deploy.md`) und `npm run deploy` ausführen.
- **A2 Anthropic-API-Key:** Für den lokalen Claude-Lauf in der Shell exportieren, denn der Agent liest die Umgebung des Swarms, nicht `.dev.vars`; der Befehl steht in `BLOCKERS.md`. Für Produktion als Worker-Secret setzen. Dann `--mode claude` testen.
- **A3 Video aufnehmen:** Nach diesem Drehbuch, und vor dem Hochladen die Bench-Zahlen gegen `bench/results/latest.md` prüfen.
- **A4 Einreichen:** Das Formular mit Video-Link, `https://github.com/cloudlei-de/ryke` und dem Quickstart aus der README ausfüllen.
