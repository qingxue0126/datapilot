import type { RequestContext } from "../core/types.js";
import type { ModelStore } from "./model-store.js";
import { isChatCapableModel, type ModelRoute, type ModelTask, type RuntimeModelConfig } from "./model-types.js";

export type ResolvedModelRoute = { route: ModelRoute; primary: RuntimeModelConfig; fallback: RuntimeModelConfig | null };

/** Resolves every business task through ownership-scoped routing; callers never hard-code a vendor model. */
export class ModelRouter {
  constructor(private readonly store: ModelStore) {}
  getModel(context: RequestContext, task: ModelTask, preferredModelId?: string): ResolvedModelRoute {
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
