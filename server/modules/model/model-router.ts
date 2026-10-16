import type { RequestContext } from "../../shared/types/context.js";
import { type ModelConfig, type ModelRoute, type ModelTask, type RuntimeModelConfig } from "../../shared/types/model.js";
import type { ModelStore } from "./model-store.js";
import { isChatCapableModel } from "./model-types.js";

export type ResolvedModelRoute = { route: ModelRoute; primary: RuntimeModelConfig; fallback: RuntimeModelConfig | null };

/** Resolves managed routes, with an explicit environment-backed route for the built-in phone preset. */
export class ModelRouter {
  constructor(private readonly store: ModelStore) {}
  getModel(context: RequestContext, task: ModelTask, preferredModelId?: string): ResolvedModelRoute {
    const builtInIntentRoute = task === "intent" ? builtInPhoneIntentRoute() : null;
    if (builtInIntentRoute) return builtInIntentRoute;
    const models = this.store.list(context).filter((model) => model.enabled && isChatCapableModel(model))
      .sort((left, right) => Number(right.modelType === "llm") - Number(left.modelType === "llm"));
    if (!models.length) throw new Error("没有已启用的模型，请先在模型管理中配置模型");
    const route = this.store.listRoutes(context).find((item) => item.task === task);
    if (!route) throw new Error(`模型路由不存在：${task}`);
    const primaryId = preferredModelId || route.primaryModelId || models[0].id;
    const primary = this.store.runtime(context, primaryId);
    if (!primary.enabled || !isChatCapableModel(primary)) throw new Error("所选主模型不是已启用的 LLM 模型");
    let fallback: RuntimeModelConfig | null = null;
    if (route.fallbackModelId && route.fallbackModelId !== primary.id) {
      const candidate = this.store.runtime(context, route.fallbackModelId);
      if (candidate.enabled && isChatCapableModel(candidate)) fallback = candidate;
    }
    return { route, primary, fallback };
  }
}

/** The phone preset is usable out of the box; its intent route does not depend on model-management rows. */
function builtInPhoneIntentRoute(): ResolvedModelRoute | null {
  const deepseekKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
  const qwenKey = String(process.env.DASHSCOPE_API_KEY || "").trim();
  if (!deepseekKey || !qwenKey) return null;
  const now = new Date().toISOString();
  const primary = builtInModel("phone-intent-deepseek", "deepseek-v4-flash", "deepseek", process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1", deepseekKey, now);
  const fallback = builtInModel("phone-intent-qwen", "qwen3.5-flash", "qwen", process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1", qwenKey, now);
  return {
    route: { task: "intent", primaryModelId: primary.id, fallbackModelId: fallback.id, temperature: 0, timeout: 2_000, maxRetries: 0, updatedAt: now },
    primary,
    fallback,
  };
}

function builtInModel(id: string, modelId: string, provider: ModelConfig["provider"], baseUrl: string, apiKey: string, now: string): RuntimeModelConfig {
  return {
    id, name: modelId, modelType: "llm", capabilities: ["chat", "structured_output"], provider, modelId, baseUrl, apiKey,
    apiKeyMasked: `${apiKey.slice(0, 2)}****${apiKey.slice(-4)}`, apiKeyConfigured: true,
    contextWindow: 64_000, timeout: 2_000, maxRetries: 0, temperature: 0, supportsTools: false,
    supportsStructuredOutput: true, supportsVision: false, enabled: true, permission: "private",
    lastTestStatus: null, lastTestLatencyMs: null, lastTestError: null, lastTestedAt: null, createdAt: now, updatedAt: now,
  };
}
