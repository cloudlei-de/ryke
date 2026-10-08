import assert from "node:assert/strict";
import { test } from "node:test";
import * as registry from "../src/registry.ts";

const categories = Object.values(registry);

test("the registry exports at least the seed categories", () => {
  const ids = categories.map((c) => c.id);
  for (const id of ["length", "mass", "temperature"]) assert.ok(ids.includes(id), `missing ${id}`);
});

test("category ids are unique", () => {
  const ids = categories.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

for (const category of categories) {
  test(`${category.id}: has at least two units with unique ids`, () => {
    const ids = category.units.map((u) => u.id);
    assert.ok(ids.length >= 2, "needs two units to convert between");
    assert.equal(new Set(ids).size, ids.length);
  });

  for (const unit of category.units) {
    // The roundtrip catches a toBase/fromBase pair that disagree, not a wrong factor.
    for (const x of [1, 42.5]) {
      test(`${category.id}/${unit.id}: fromBase(toBase(${x})) is ${x}`, () => {
        const back = unit.fromBase(unit.toBase(x));
        assert.ok(Number.isFinite(back), `got ${back}`);
        assert.ok(Math.abs(back - x) <= 1e-9 * Math.max(1, Math.abs(x)), `got ${back}`);
      });
    }
  }
}
