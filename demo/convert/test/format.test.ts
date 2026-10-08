import assert from "node:assert/strict";
import { test } from "node:test";
import { formatValue } from "../src/format.ts";

// Every case passes an explicit digit count, stays below 1000 and has no trailing zero to trim, so
// the table holds for the plain toFixed version and for the trimmed 3-digit and Intl versions.
const finiteCases: [number, number, string][] = [
  [3.14159, 2, "3.14"],
  [2.71828, 3, "2.718"],
  [123.456, 1, "123.5"],
  [0.5, 1, "0.5"],
  [99.9, 0, "100"],
  [-1.234, 2, "-1.23"],
  [1.23456, 3, "1.235"],
  [42, 0, "42"],
  [0.07, 2, "0.07"],
];

for (const [n, digits, expected] of finiteCases) {
  test(`formatValue(${n}, ${digits}) is ${expected}`, () => {
    assert.equal(formatValue(n, digits), expected);
  });
}

for (const n of [NaN, Infinity, -Infinity]) {
  test(`formatValue(${n}) is a dash`, () => {
    assert.equal(formatValue(n, 2), "—");
  });
}
