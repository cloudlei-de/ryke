import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("answers health", async () => {
  const res = await exports.default.fetch("http://ryke.test/api/health");
  expect(await res.json()).toEqual({ ok: true });
});
