import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.ts";
import * as registry from "../src/registry.ts";

const categories = Object.values(registry);

function get(path: string): Promise<Response> | Response {
  return worker.fetch(new Request(`http://localhost${path}`));
}

test("the home page lists every registered category", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const c of categories) assert.ok(html.includes(c.name), `missing tile for ${c.name}`);
});

for (const c of categories) {
  test(`/c/${c.id} renders the converter page`, async () => {
    const res = await get(`/c/${c.id}`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(c.name));
  });
}

test("an unknown category page is a 404", async () => {
  const res = await get("/c/unknown");
  assert.equal(res.status, 404);
});

test("an unknown path is a 404 page", async () => {
  const res = await get("/nope");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
});

test("/api/convert converts 1 km to 1000 m", async () => {
  const res = await get("/api/convert?c=length&from=km&to=m&v=1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { category: string; from: string; to: string; value: number; result: number; display: string };
  assert.equal(body.category, "length");
  assert.equal(body.from, "km");
  assert.equal(body.to, "m");
  assert.equal(body.value, 1);
  // Only the number is checked here: the display string depends on the number format.
  assert.ok(Math.abs(body.result - 1000) < 1e-9);
  assert.equal(typeof body.display, "string");
});

const errorCases: [string, string, number][] = [
  ["unknown category", "/api/convert?c=nope&from=km&to=m&v=1", 404],
  ["unknown from unit", "/api/convert?c=length&from=nope&to=m&v=1", 404],
  ["unknown to unit", "/api/convert?c=length&from=km&to=nope&v=1", 404],
  ["missing category", "/api/convert?from=km&to=m&v=1", 404],
  ["missing value", "/api/convert?c=length&from=km&to=m", 400],
  ["empty value", "/api/convert?c=length&from=km&to=m&v=", 400],
  ["non-numeric value", "/api/convert?c=length&from=km&to=m&v=abc", 400],
];

for (const [name, path, status] of errorCases) {
  test(`/api/convert rejects ${name} with ${status}`, async () => {
    const res = await get(path);
    assert.equal(res.status, status);
    const body = (await res.json()) as { error: string };
    assert.equal(typeof body.error, "string");
  });
}
