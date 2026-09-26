const dimensions = 256;

/** Deterministic local embedding keeps the MVP runnable without an external model service. */
export function embedText(text: string) {
  const vector = Array<number>(dimensions).fill(0);
  const normalized = text.toLowerCase().normalize("NFKC");
  const terms = normalized.match(/[\p{Script=Han}]|[a-z0-9_]+/gu) || [];
  for (const term of terms) {
    let hash = 2166136261;
    for (const character of term) { hash ^= character.codePointAt(0) || 0; hash = Math.imul(hash, 16777619); }
    const index = Math.abs(hash) % dimensions;
    vector[index] += hash & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

export function lexicalScore(query: string, content: string) {
  const terms = new Set((query.toLowerCase().match(/[\p{Script=Han}]|[a-z0-9_]+/gu) || []).filter(Boolean));
  if (!terms.size) return 0;
  const haystack = content.toLowerCase();
  let matches = 0;
  for (const term of terms) if (haystack.includes(term)) matches += 1;
  return matches / terms.size;
}
