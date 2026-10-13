import { modelTypes, type ModelConfig, type ModelType } from "../../shared/types/model.js";

export function normalizeModelType(value: unknown): ModelType {
  if (value === "chat") return "llm";
  return modelTypes.includes(value as ModelType) ? value as ModelType : "llm";
}
export function isChatCapableModel(model: Pick<ModelConfig, "modelType">) { return model.modelType === "llm" || model.modelType === "multimodal_llm"; }
export function isTextEmbeddingModel(model: Pick<ModelConfig, "modelType">) { return model.modelType === "embedding"; }
export function isRerankModel(model: Pick<ModelConfig, "modelType">) { return model.modelType === "rerank" || model.modelType === "multimodal_rerank"; }
