// Cheap prefilter for duplicate and conflicting intents at `begin` (PLAN.md §7.3 step 1).
// It only decides which candidates are worth a Jev question, so it favours recall over precision.

// Unicode-aware so a German or Japanese intent is not reduced to nothing; ASCII-only classes
// would collapse every non-Latin character into a separator.
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

export function trigrams(text: string): Set<string> {
  const words = text.toLowerCase().replace(SEPARATORS, " ").trim();
  // Text with no letters or digits has no content to compare. Without this guard "!!!" would pad
  // to three spaces and every punctuation-only intent would look identical to every other.
  if (words === "") return new Set();
  // Padding gives short words and word boundaries their own trigrams, so "add" and "address"
  // are told apart. Spread into code points so an emoji or astral letter stays one character.
  const chars = [...` ${words} `];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i++) out.add(chars[i]! + chars[i + 1]! + chars[i + 2]!);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

export function topSimilar(
  intent: string,
  candidates: { id: string; intent: string }[],
  k = 5,
  min = 0.15,
): { id: string; intent: string; similarity: number }[] {
  const own = trigrams(intent);
  return candidates
    .map((c) => ({ id: c.id, intent: c.intent, similarity: jaccard(own, trigrams(c.intent)) }))
    .filter((c) => c.similarity >= min)
    // Ties break on id so the same inputs always pick the same Jev candidates; a plain code-unit
    // compare keeps the order independent of the runtime's locale.
    .sort((x, y) => y.similarity - x.similarity || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    // slice(0, -1) would drop the last element instead of returning nothing.
    .slice(0, Math.max(0, k));
}
