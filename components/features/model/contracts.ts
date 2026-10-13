export type ModelType = "llm" | "embedding" | "rerank" | "vision" | "multimodal_llm" | "multimodal_embedding" | "multimodal_rerank";
export type ModelCapability = "chat" | "reasoning" | "tool_calling" | "structured_output" | "text2sql" | "long_context" | "text_embedding" | "multilingual" | "text_rerank" | "vision" | "ocr" | "image_understanding" | "chart_understanding" | "document_understanding" | "image_embedding" | "multimodal_embedding" | "multimodal_rerank";
export type ModelOption = {
  id: string; name: string; modelType: ModelType; permission: "private" | "tenant"; capabilities: ModelCapability[]; provider: string; modelId: string; baseUrl: string; apiKeyMasked: string; apiKeyConfigured: boolean;
  contextWindow: number; embeddingDimension: number | null; maxInputTokens: number | null; topN: number | null; timeout: number; maxRetries: number; temperature: number; supportsTools: boolean;
  supportsStructuredOutput: boolean; supportsVision: boolean; enabled: boolean; lastTestStatus: "success" | "failed" | null;
  lastTestLatencyMs: number | null; lastTestError: string | null; lastTestedAt: string | null;
};
