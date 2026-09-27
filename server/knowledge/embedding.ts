import type { RequestContext } from "../core/types.js";
import type { ModelService } from "../llm/model-service.js";

const dimensions = 256;
export const localEmbeddingModelId = "local-hash-embedding-v1";

export interface EmbeddingProvider {
  embed(context: RequestContext, modelId: string, text: string): Promise<number[]>;
  embedBatch(context: RequestContext, modelId: string, texts: string[]): Promise<number[][]>;
}

/** Uses model management in production and permits the deterministic fallback only outside production. */
export class ManagedEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly models: ModelService) {}

  async embed(context: RequestContext, modelId: string, text: string) {
    return (await this.embedBatch(context, modelId, [text]))[0];
  }

  async embedBatch(context: RequestContext, modelId: string, texts: string[]) {
    if (modelId === localEmbeddingModelId && process.env.NODE_ENV !== "production") return texts.map(embedText);
    return this.models.embedBatch(context, modelId, texts);
  }
}

/** Explicit test provider; never selected by production bootstrap. */
export class TestEmbeddingProvider implements EmbeddingProvider {
  async embed(_context: RequestContext, _modelId: string, text: string) { return embedText(text); }
  async embedBatch(_context: RequestContext, _modelId: string, texts: string[]) { return texts.map(embedText); }
}

/** Deterministic hash embedding retained only for tests and local development. */
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
