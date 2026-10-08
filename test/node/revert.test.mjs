import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickCascade } from "../../containers/runner/lib/revert.mjs";

const candidates = { T: { "src/a.ts": ["D3", "D1"], "src/b.ts": ["D2"] } };
const seqs = { T: 1, D1: 2, D2: 3, D3: 4 };

describe("pickCascade", () => {
  for (const [paths, reverted, expected, why] of [
    [["src/a.ts"], [], "D3", "the newest writer of the conflicting path"],
    [["src/a.ts"], ["D3"], "D1", "skips an already reverted dependent"],
    [["src/a.ts", "src/b.ts"], [], "D3", "newest across all conflicting paths"],
    [["src/a.ts", "src/b.ts"], ["D3"], "D2", "next newest across paths"],
    [["src/c.ts"], [], null, "no dependent wrote the path"],
    [["src/a.ts"], ["D3", "D1"], null, "all candidates reverted"],
  ]) {
    it(`${JSON.stringify(paths)} reverted=${JSON.stringify(reverted)} → ${expected}: ${why}`, () => {
      assert.equal(pickCascade(candidates, "T", paths, new Set(reverted), seqs), expected);
    });
  }

  it("returns null for a target without candidates", () => {
    assert.equal(pickCascade(candidates, "X", ["src/a.ts"], new Set(), seqs), null);
  });
});
