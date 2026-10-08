import type { Category } from "../types.ts";

export const mass: Category = {
  id: "mass",
  name: "Mass",
  base: "kg",
  units: [
    { id: "kg", name: "Kilogram", symbol: "kg", toBase: (v) => v, fromBase: (v) => v },
    { id: "g", name: "Gram", symbol: "g", toBase: (v) => v * 0.001, fromBase: (v) => v / 0.001 },
    { id: "mg", name: "Milligram", symbol: "mg", toBase: (v) => v * 0.000001, fromBase: (v) => v / 0.000001 },
    { id: "t", name: "Tonne", symbol: "t", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
    { id: "lb", name: "Pound", symbol: "lb", toBase: (v) => v * 0.45359237, fromBase: (v) => v / 0.45359237 },
    { id: "oz", name: "Ounce", symbol: "oz", toBase: (v) => v * 0.028349523125, fromBase: (v) => v / 0.028349523125 },
  ],
};
