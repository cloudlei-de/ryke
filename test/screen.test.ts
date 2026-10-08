// §7.3 screening at begin: two near-identical intents that begin at the same moment still see each
// other, because each begin reserves its intent before it is screened.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AUTH, err, newRepo } from "./helpers";

describe("begin screening", () => {
  it("warns about a duplicate that is still being screened", async () => {
    const t = await newRepo();
    const begin = (agent: string, intent: string) =>
      exports.default.fetch(`http://ryke.test/api/repos/${t.name}/txns`, { method: "POST", headers: AUTH, body: JSON.stringify({ agent, intent }) }).then((r) => r.json());
    const [a, b] = (await Promise.all([begin("agent-a", "add a speed category"), begin("agent-b", "add a second speed category")])) as {
      txn: string;
      warnings: { kind: string; other: string }[];
    }[];
    const named = [...a!.warnings.map((w) => w.other), ...b!.warnings.map((w) => w.other)];
    expect(named.includes(a!.txn) || named.includes(b!.txn)).toBe(true);
  });

  it("refuses a reservation it never handed out", async () => {
    const t = await newRepo();
    expect(err(await t.L.begin({ agent: "a", intent: "x" }, { warnings: [] }, "t_forged"))).toBe(409);
  });
});
