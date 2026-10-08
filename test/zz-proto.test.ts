import { DurableObject } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";

class P extends DurableObject<Env> {
  sqlOk() { return this.ctx.storage.sql.exec("SELECT 1 AS a").one().a; }
  protected now() { return 5; }
  n() { return this.now(); }
}

it("builds a DO with a fake ctx and real sql", async () => {
  const stub = env.LEDGER.get(env.LEDGER.idFromName("proto-" + Math.random()));
  await runInDurableObject(stub, async (_i, state) => {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (a)");
    const ctx = { storage: { sql: state.storage.sql, getAlarm: async () => null }, container: { running: true } } as unknown as DurableObjectState;
    const p = new P(ctx, env);
    expect(p.sqlOk()).toBe(1);
    expect(p.n()).toBe(5);
    expect(p.ctx).toBe(ctx);
  });
});

it("spies on global fetch", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (r) => new Response("hi " + (r as Request).url));
  const res = await fetch(new Request("https://x.test/a"));
  expect(await res.text()).toBe("hi https://x.test/a");
  spy.mockRestore();
});
