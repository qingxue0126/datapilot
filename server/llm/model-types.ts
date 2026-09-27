export const modelProviders = ["openai-compatible", "openai", "qwen", "deepseek", "glm", "vllm", "ollama"] as const;
export type ModelProviderId = typeof modelProviders[number];
export const modelTypes = ["chat", "embedding", "rerank"] as const;
export type ModelType = typeof modelTypes[number];

export const modelTasks = ["intent", "text2sql", "sqlRepair", "agent", "answer", "schemaMapping"] as const;
export type ModelTask = typeof modelTasks[number];

export type ModelConfigInput = {
  name: string;
  modelType?: ModelType;
  provider: ModelProviderId;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow: number;
  timeout: number;
  maxRetries: number;
  temperature: number;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  supportsVision: boolean;
  enabled: boolean;
};

export type ModelConfig = Omit<ModelConfigInput, "apiKey" | "modelType"> & {
  id: string;
  modelType: ModelType;
  apiKeyMasked: string;
  apiKeyConfigured: boolean;
  lastTestStatus: "success" | "failed" | null;
  lastTestLatencyMs: number | null;
  lastTestError: string | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
};
export type ChatResponse = { content: string; latencyMs: number };
