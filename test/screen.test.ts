// §7.3 screening at begin: two near-identical intents that begin at the same moment still see each
// other, because each begin reserves its intent before it is screened.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AUTH, err, newRepo, ok } from "./helpers";

describe("begin screening", () => {
  it("shows a begin that is still being screened to the next one as a candidate", async () => {
    const t = await newRepo();
    const [a, b] = await Promise.all([t.L.screenCandidates("add a speed category"), t.L.screenCandidates("add a second speed category")]);
    const [x, y] = [ok(a), ok(b)];
    const seen = [...x.candidates.map((c) => c.id), ...y.candidates.map((c) => c.id)];
    expect(seen.includes(x.txn) || seen.includes(y.txn)).toBe(true);
    // Each reservation carries its intent, which is what the judge compares.
    const other = y.candidates.find((c) => c.id === x.txn) ?? x.candidates.find((c) => c.id === y.txn);
    expect(["add a speed category", "add a second speed category"]).toContain(other!.intent);
  });

  it("hands the reserved id on to the begin that screened it", async () => {
    const t = await newRepo();
    const begin = (agent: string, intent: string) =>
      exports.default.fetch(`http://ryke.test/api/repos/${t.name}/txns`, { method: "POST", headers: AUTH, body: JSON.stringify({ agent, intent }) }).then((r) => r.json() as Promise<{ txn: string; state: string }>);
    const [a, b] = await Promise.all([begin("agent-a", "add a speed category"), begin("agent-b", "add a second speed category")]);
    expect(a.txn).not.toBe(b.txn);
    expect([a.state, b.state]).toEqual(["open", "open"]);
  });

  it("refuses a reservation it never handed out", async () => {
    const t = await newRepo();
    expect(err(await t.L.begin({ agent: "a", intent: "x" }, { warnings: [] }, "t_forged"))).toBe(409);
  });
});
