import type { RequestContext } from "../core/types.js";
import { ModelProviderRegistry } from "./model-provider.js";
import type { ModelRouter } from "./model-router.js";
import type { ModelStore } from "./model-store.js";
import { isTextEmbeddingModel, type ChatMessage, type ModelConfigInput, type ModelTask, type RuntimeModelConfig } from "./model-types.js";

export type StructuredOptions = { context: RequestContext; task: ModelTask; preferredModelId?: string };
export interface StructuredModelClient { structured<T>(messages: ChatMessage[], options: StructuredOptions): Promise<T>; }

export class ModelService implements StructuredModelClient {
  constructor(private readonly store: ModelStore, private readonly router: ModelRouter, private readonly providers = new ModelProviderRegistry()) {}
  list(context: RequestContext) { return this.store.list(context); }
  get(context: RequestContext, id: string) { return this.store.get(context, id); }
  create(context: RequestContext, input: ModelConfigInput) { return this.store.create(context, input); }
  update(context: RequestContext, id: string, input: Partial<ModelConfigInput> & { clearApiKey?: boolean }) { return this.store.update(context, id, input); }
  delete(context: RequestContext, id: string) { this.store.delete(context, id); }
  routes(context: RequestContext) { return this.store.listRoutes(context); }
  saveRoute(context: RequestContext, task: ModelTask, input: Parameters<ModelStore["saveRoute"]>[2]) { return this.store.saveRoute(context, task, input); }
  embeddingModels(context: RequestContext) { return this.store.list(context).filter((model) => model.enabled && isTextEmbeddingModel(model)); }

  async embedBatch(context: RequestContext, modelId: string, texts: string[]) {
    if (!texts.length) return [];
    const model = this.store.runtime(context, modelId);
    if (!model.enabled || !isTextEmbeddingModel(model)) throw new Error("所选模型不是已启用的 Embedding 模型");
    const provider = this.providers.get(model.provider);
    if (!provider.embed) throw new Error("当前 Provider 不支持 Embedding");
    return provider.embed(model, texts);
  }

  async embed(context: RequestContext, modelId: string, text: string) {
    return (await this.embedBatch(context, modelId, [text]))[0];
  }

  async testConnection(context: RequestContext, id: string) {
    const model = this.store.runtime(context, id);
    const startedAt = Date.now();
    try {
      const result = await this.providers.get(model.provider).testConnection(model);
      const response = { success: true as const, latencyMs: result.latencyMs };
      this.store.setTestResult(context, id, response);
      return response;
    } catch (error) {
      const response = { success: false, latencyMs: Date.now() - startedAt, error: safeMessage(error) };
      this.store.setTestResult(context, id, response);
      return response;
    }
  }

  async structured<T>(messages: ChatMessage[], options: StructuredOptions): Promise<T> {
    const resolved = this.router.getModel(options.context, options.task, options.preferredModelId);
    const candidates = [resolved.primary, resolved.fallback].filter(Boolean) as RuntimeModelConfig[];
    let lastError: unknown;
    for (const model of candidates) {
      const attempts = Math.max(1, resolved.route.maxRetries + 1);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const result = await this.providers.get(model.provider).chat(model, { messages, structured: true,
            temperature: resolved.route.temperature, timeout: resolved.route.timeout, maxTokens: Math.min(4000, model.contextWindow) });
          return JSON.parse(stripFence(result.content)) as T;
        } catch (error) { lastError = error; }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("模型调用失败");
  }
}

function stripFence(value: string) { return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); }
function safeMessage(error: unknown) { return (error instanceof Error ? error.message : "未知错误").slice(0, 500); }
