// The small shared pieces of the dashboard: sentence case for pills, the theme switch's order and the icon each
// transaction state is drawn with.
import { describe, expect, it } from "vitest";
import { TXN_STATES } from "../src/shared/types";
import { nextTheme, sentence, stateIcon, THEME_ICON } from "../src/web/ui";

describe("sentence", () => {
  it.each([
    ["needs human", "Needs human"],
    ["landed", "Landed"],
    ["Stale", "Stale"],
    ["", ""],
  ])("%j -> %j", (s, out) => expect(sentence(s)).toBe(out));
});

describe("nextTheme", () => {
  it("cycles system, light, dark and back", () => {
    expect([nextTheme("system"), nextTheme("light"), nextTheme("dark")]).toEqual(["light", "dark", "system"]);
  });
  it("has an icon for every theme", () => expect(Object.keys(THEME_ICON).sort()).toEqual(["dark", "light", "system"]));
});

describe("stateIcon", () => {
  it.each([
    ["landed", "check"],
    ["stale", "retry"],
    ["failed", "x"],
    ["rejected", "ban"],
    ["needs_human", "user"],
    ["verifying", "tests"],
    ["recalled", "undo"],
    ["something_new", "pulse"],
  ])("%s -> %s", (state, icon) => expect(stateIcon(state)).toBe(icon));

  it("gives every state of the state machine an icon, and the terminal ones their own", () => {
    const icons = TXN_STATES.map(stateIcon);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(["landed", "stale", "failed", "rejected", "recalled", "needs_human"].map(stateIcon)).size).toBe(6);
  });
});
