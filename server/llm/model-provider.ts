import type { ChatRequest, ChatResponse, MultimodalChatRequest, RerankRequest, RerankResponse, RuntimeModelConfig } from "./model-types.js";

type OpenAIResponse = {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
  error?: { message?: string };
  message?: string;
};
type OpenAIEmbeddingResponse = { data?: { index: number; embedding: number[] }[]; error?: { message?: string }; message?: string };
type RerankApiResponse = { results?: { index: number; relevance_score?: number; score?: number }[]; output?: { results?: { index: number; relevance_score?: number; score?: number }[] }; error?: { message?: string }; message?: string };

/** Unified protocol implemented by every model vendor adapter. */
export interface ModelProvider {
  chat(model: RuntimeModelConfig, request: ChatRequest): Promise<ChatResponse>;
  testConnection(model: RuntimeModelConfig): Promise<ChatResponse>;
  embed?(model: RuntimeModelConfig, texts: string[]): Promise<number[][]>;
  rerank?(model: RuntimeModelConfig, request: RerankRequest): Promise<RerankResponse>;
  vision?(model: RuntimeModelConfig, request: MultimodalChatRequest): Promise<ChatResponse>;
  multimodalChat?(model: RuntimeModelConfig, request: MultimodalChatRequest): Promise<ChatResponse>;
  multimodalEmbed?(model: RuntimeModelConfig, inputs: { text?: string; imageUrl?: string }[]): Promise<number[][]>;
  multimodalRerank?(model: RuntimeModelConfig, request: RerankRequest): Promise<RerankResponse>;
}

/** OpenAI, Qwen, DeepSeek, GLM, vLLM and Ollama can all use this compatible adapter. */
export class OpenAICompatibleProvider implements ModelProvider {
  async chat(model: RuntimeModelConfig, request: ChatRequest): Promise<ChatResponse> {
    return this.sendChat(model, request.messages, request.temperature, request.timeout, request.maxTokens,
      Boolean(request.structured && model.supportsStructuredOutput));
  }

  async multimodalChat(model: RuntimeModelConfig, request: MultimodalChatRequest): Promise<ChatResponse> {
    return this.sendChat(model, request.messages, request.temperature, request.timeout, request.maxTokens, false);
  }

  async vision(model: RuntimeModelConfig, request: MultimodalChatRequest): Promise<ChatResponse> {
    return this.multimodalChat(model, request);
  }

  async rerank(model: RuntimeModelConfig, request: RerankRequest): Promise<RerankResponse> {
    if (model.provider !== "qwen" && !/dashscope\.aliyuncs\.com/i.test(model.baseUrl)) throw new Error("当前 Provider 未实现 Rerank 协议");
    const startedAt = Date.now();
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), model.timeout);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
      const qwen3 = /^qwen3(?:\.|-|$)/i.test(model.modelId);
      const body = qwen3
        ? { model: model.modelId, query: request.query, documents: request.documents, top_n: request.topN }
        : { model: model.modelId, input: { query: request.query, documents: request.documents }, parameters: { top_n: request.topN, return_documents: false } };
      const response = await fetch(rerankEndpoint(model.baseUrl), { method: "POST", headers, signal: controller.signal, body: JSON.stringify(body) });
      const raw = await response.text(); let payload: RerankApiResponse;
      try { payload = JSON.parse(raw) as RerankApiResponse; } catch { throw new Error("Rerank 模型返回了无法解析的响应"); }
      if (!response.ok) throw new Error(`Rerank 请求失败（${response.status}）：${safeError(payload)}`);
      const source = payload.results || payload.output?.results || [];
      const results = source.map((item) => ({ index: Number(item.index), score: Number(item.relevance_score ?? item.score) }))
        .filter((item) => Number.isInteger(item.index) && Number.isFinite(item.score));
      if (!results.length && request.documents.length) throw new Error("Rerank 模型未返回有效排序结果");
      return { results, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`Rerank 请求超时（${model.timeout}ms）`);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async multimodalEmbed(): Promise<number[][]> {
    throw new Error("当前 Provider 未实现 Multimodal Embedding 协议");
  }

  async multimodalRerank(): Promise<RerankResponse> {
    throw new Error("当前 Provider 未实现 Multimodal Rerank 协议");
  }

  private async sendChat(
    model: RuntimeModelConfig,
    messages: ChatRequest["messages"] | MultimodalChatRequest["messages"],
    temperature: number,
    timeout: number,
    maxTokens?: number,
    structured = false,
    disableThinking = false,
  ): Promise<ChatResponse> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
      const response = await fetch(chatEndpoint(model.baseUrl), {
        method: "POST", headers, signal: controller.signal,
        body: JSON.stringify({ model: model.modelId, messages, temperature,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(structured ? { response_format: { type: "json_object" } } : {}),
          // DeepSeek may spend a short test's entire output budget on reasoning.
          // Connection tests only need a final answer, so explicitly disable it.
          ...(disableThinking ? { thinking: { type: "disabled" } } : {}) }),
      });
      const raw = await response.text();
      const body = parseResponse(raw);
      if (!response.ok) throw new Error(`模型请求失败（${response.status}）：${safeError(body)}`);
      const message = body.choices?.[0]?.message;
      // Some compatible reasoning APIs can return reasoning_content before content.
      // Treat it as a valid response for connection diagnostics rather than reporting
      // a false negative when the HTTP request itself succeeded.
      const content = message?.content?.trim() || message?.reasoning_content?.trim();
      if (!content) throw new Error("模型未返回有效内容");
      return { content, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`模型请求超时（${timeout}ms）`);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async testConnection(model: RuntimeModelConfig) {
    const startedAt = Date.now();
    if (model.modelType === "embedding") await this.embed(model, ["DataPilot connection test"]);
    else if (model.modelType === "llm") {
      const messages: ChatRequest["messages"] = [{ role: "user", content: "Reply only with OK." }];
      return this.sendChat(
        model,
        messages,
        0,
        model.timeout,
        32,
        false,
        model.provider === "deepseek",
      );
    }
    else if (model.modelType === "vision" || model.modelType === "multimodal_llm") {
      const request: MultimodalChatRequest = { temperature: 0, timeout: model.timeout, maxTokens: 8, messages: [{ role: "user", content: [
        { type: "text", text: "Describe this image with one word." }, { type: "image_url", image_url: { url: testImageDataUrl } },
      ] }] };
      return model.modelType === "vision" ? this.vision(model, request) : this.multimodalChat(model, request);
    } else if (model.modelType === "rerank") await this.rerank(model, { query: "DataPilot", documents: ["DataPilot connection test"], topN: 1 });
    else if (model.modelType === "multimodal_embedding") await this.multimodalEmbed();
    else await this.multimodalRerank();
    return { content: "OK", latencyMs: Date.now() - startedAt };
  }

  async embed(model: RuntimeModelConfig, texts: string[]) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), model.timeout);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
      const response = await fetch(embeddingEndpoint(model.baseUrl), { method: "POST", headers, signal: controller.signal,
        body: JSON.stringify({ model: model.modelId, input: texts }) });
      const raw = await response.text(); let body: OpenAIEmbeddingResponse;
      try { body = JSON.parse(raw) as OpenAIEmbeddingResponse; } catch { throw new Error("Embedding 模型返回了无法解析的响应"); }
      if (!response.ok) throw new Error(`Embedding 请求失败（${response.status}）：${safeError(body)}`);
      const ordered = [...(body.data || [])].sort((a, b) => a.index - b.index).map((item) => item.embedding);
      if (ordered.length !== texts.length || ordered.some((item) => !Array.isArray(item) || !item.length)) throw new Error("Embedding 模型返回的向量数量不正确");
      return ordered;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`Embedding 请求超时（${model.timeout}ms）`);
      throw error;
    } finally { clearTimeout(timer); }
  }
}

const testImageDataUrl = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

export class ModelProviderRegistry {
  private readonly compatible = new OpenAICompatibleProvider();
  get(provider: RuntimeModelConfig["provider"]): ModelProvider { void provider; return this.compatible; }
}

function chatEndpoint(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}
function embeddingEndpoint(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  return /\/embeddings$/i.test(base) ? base : `${base}/embeddings`;
}
function rerankEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  return `${url.origin}/api/v1/services/rerank/text-rerank/text-rerank`;
}
function parseResponse(raw: string): OpenAIResponse {
  try { return JSON.parse(raw) as OpenAIResponse; }
  catch { throw new Error("模型返回了无法解析的响应"); }
}
function safeError(body: OpenAIResponse | OpenAIEmbeddingResponse | RerankApiResponse) { return String(body.error?.message || body.message || "未知错误").slice(0, 300); }
