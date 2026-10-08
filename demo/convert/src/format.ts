// Hot by design: the home page, the converter tables and the API all format numbers here, so a
// change to the rounding rule is read by nearly every other change in flight.
export function formatValue(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}
