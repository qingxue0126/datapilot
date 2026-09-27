import type { ChatRequest, ChatResponse, RuntimeModelConfig } from "./model-types.js";

type OpenAIResponse = { choices?: { message?: { content?: string } }[]; error?: { message?: string }; message?: string };
type OpenAIEmbeddingResponse = { data?: { index: number; embedding: number[] }[]; error?: { message?: string }; message?: string };

/** Unified protocol implemented by every model vendor adapter. */
export interface ModelProvider {
  chat(model: RuntimeModelConfig, request: ChatRequest): Promise<ChatResponse>;
  testConnection(model: RuntimeModelConfig): Promise<ChatResponse>;
  embed?(model: RuntimeModelConfig, texts: string[]): Promise<number[][]>;
}

/** OpenAI, Qwen, DeepSeek, GLM, vLLM and Ollama can all use this compatible adapter. */
export class OpenAICompatibleProvider implements ModelProvider {
  async chat(model: RuntimeModelConfig, request: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeout);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
      const response = await fetch(chatEndpoint(model.baseUrl), {
        method: "POST", headers, signal: controller.signal,
        body: JSON.stringify({ model: model.modelId, messages: request.messages, temperature: request.temperature,
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          ...(request.structured && model.supportsStructuredOutput ? { response_format: { type: "json_object" } } : {}) }),
      });
      const raw = await response.text();
      const body = parseResponse(raw);
      if (!response.ok) throw new Error(`模型请求失败（${response.status}）：${safeError(body)}`);
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("模型未返回有效内容");
      return { content, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`模型请求超时（${request.timeout}ms）`);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async testConnection(model: RuntimeModelConfig) {
    if (model.modelType === "embedding") {
      const startedAt = Date.now();
      await this.embed(model, ["DataPilot connection test"]);
      return { content: "OK", latencyMs: Date.now() - startedAt };
    }
    return this.chat(model, { messages: [{ role: "user", content: "Reply only with OK." }], temperature: 0, timeout: model.timeout, maxTokens: 8 });
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
function parseResponse(raw: string): OpenAIResponse {
  try { return JSON.parse(raw) as OpenAIResponse; }
  catch { throw new Error("模型返回了无法解析的响应"); }
}
function safeError(body: OpenAIResponse | OpenAIEmbeddingResponse) { return String(body.error?.message || body.message || "未知错误").slice(0, 300); }
