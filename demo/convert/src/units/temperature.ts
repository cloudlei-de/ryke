import type { Category } from "../types.ts";

// Affine units: Celsius is the base, so the other two need an offset as well as a scale.
export const temperature: Category = {
  id: "temperature",
  name: "Temperature",
  base: "°C",
  units: [
    { id: "c", name: "Celsius", symbol: "°C", toBase: (v) => v, fromBase: (v) => v },
    { id: "f", name: "Fahrenheit", symbol: "°F", toBase: (v) => ((v - 32) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 32 },
    { id: "k", name: "Kelvin", symbol: "K", toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
  ],
};
