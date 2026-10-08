import type { Category } from "../types.ts";

export const length: Category = {
  id: "length",
  name: "Length",
  base: "m",
  units: [
    { id: "m", name: "Metre", symbol: "m", toBase: (v) => v, fromBase: (v) => v },
    { id: "km", name: "Kilometre", symbol: "km", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
    { id: "cm", name: "Centimetre", symbol: "cm", toBase: (v) => v * 0.01, fromBase: (v) => v / 0.01 },
    { id: "mm", name: "Millimetre", symbol: "mm", toBase: (v) => v * 0.001, fromBase: (v) => v / 0.001 },
    { id: "mi", name: "Mile", symbol: "mi", toBase: (v) => v * 1609.344, fromBase: (v) => v / 1609.344 },
    { id: "yd", name: "Yard", symbol: "yd", toBase: (v) => v * 0.9144, fromBase: (v) => v / 0.9144 },
    { id: "ft", name: "Foot", symbol: "ft", toBase: (v) => v * 0.3048, fromBase: (v) => v / 0.3048 },
    { id: "in", name: "Inch", symbol: "in", toBase: (v) => v * 0.0254, fromBase: (v) => v / 0.0254 },
  ],
};
