export const modelProviders = ["openai-compatible", "openai", "qwen", "deepseek", "glm", "vllm", "ollama"] as const;
export type ModelProviderId = typeof modelProviders[number];
export const modelTypes = ["llm", "embedding", "rerank", "vision", "multimodal_llm", "multimodal_embedding", "multimodal_rerank"] as const;
export type ModelType = typeof modelTypes[number];
export type LegacyModelType = ModelType | "chat";

export const modelCapabilities = ["chat", "reasoning", "tool_calling", "structured_output", "text2sql", "long_context", "text_embedding", "multilingual", "text_rerank", "vision", "ocr", "image_understanding", "chart_understanding", "document_understanding", "image_embedding", "multimodal_embedding", "multimodal_rerank"] as const;
export type ModelCapability = typeof modelCapabilities[number];

export const modelTasks = ["intent", "text2sql", "sqlRepair", "agent", "answer", "schemaMapping"] as const;
export type ModelTask = typeof modelTasks[number];
export type ResourcePermission = "private" | "tenant";

export type ModelConfigInput = {
  name: string;
  modelType?: LegacyModelType;
  capabilities?: ModelCapability[];
  provider: ModelProviderId;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  embeddingDimension?: number | null;
  maxInputTokens?: number | null;
  topN?: number | null;
  timeout: number;
  maxRetries: number;
  temperature?: number;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  supportsVision: boolean;
  enabled: boolean;
  permission?: ResourcePermission;
};

export type ModelConfig = Omit<ModelConfigInput, "apiKey" | "modelType" | "contextWindow" | "temperature" | "capabilities"> & {
  id: string;
  modelType: ModelType;
  capabilities: ModelCapability[];
  contextWindow: number;
  temperature: number;
  apiKeyMasked: string;
  apiKeyConfigured: boolean;
  lastTestStatus: "success" | "failed" | null;
  lastTestLatencyMs: number | null;
  lastTestError: string | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  permission: ResourcePermission;
};

export type RuntimeModelConfig = ModelConfig & { apiKey: string };

export type ModelRoute = {
  task: ModelTask;
  primaryModelId: string | null;
  fallbackModelId: string | null;
  temperature: number;
  timeout: number;
  maxRetries: number;
  updatedAt: string;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatRequest = {
  messages: ChatMessage[];
  temperature: number;
  timeout: number;
  maxTokens?: number;
  structured?: boolean;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
};
export type ChatResponse = { content: string; latencyMs: number };

export type MultimodalContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type MultimodalChatRequest = { messages: { role: "user" | "assistant" | "system"; content: string | MultimodalContentPart[] }[]; temperature: number; timeout: number; maxTokens?: number };
export type RerankRequest = { query: string; documents: string[]; topN?: number };
export type RerankResponse = { results: { index: number; score: number }[]; latencyMs: number };

export function normalizeModelType(value: unknown): ModelType {
  if (value === "chat") return "llm";
  return modelTypes.includes(value as ModelType) ? value as ModelType : "llm";
}
export function isChatCapableModel(model: Pick<ModelConfig, "modelType">) { return model.modelType === "llm" || model.modelType === "multimodal_llm"; }
export function isTextEmbeddingModel(model: Pick<ModelConfig, "modelType">) { return model.modelType === "embedding"; }
export function isRerankModel(model: Pick<ModelConfig, "modelType">) { return model.modelType === "rerank" || model.modelType === "multimodal_rerank"; }
