import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "../../../../server/infrastructure/llm/model-provider.js";
import type { RuntimeModelConfig } from "../../../../server/shared/types/model.js";

test("OpenAI-compatible chat streams SSE tokens and returns the assembled response", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Agent"}}]}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    const tokens: string[] = [];
    const model = { baseUrl: "https://example.test/v1", modelId: "test-model", apiKey: "", supportsStructuredOutput: false } as RuntimeModelConfig;
    const result = await new OpenAICompatibleProvider().chat(model, {
      messages: [{ role: "user", content: "Hi" }], temperature: 0.2, timeout: 1_000, onToken: (token) => tokens.push(token),
    });
    assert.equal(result.content, "Hello Agent");
    assert.deepEqual(tokens, ["Hello ", "Agent"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming rejects a buffered JSON response instead of fake-streaming it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "buffered" } }] }), {
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const model = { baseUrl: "https://example.test/v1", modelId: "test-model", apiKey: "", supportsStructuredOutput: false } as RuntimeModelConfig;
    await assert.rejects(new OpenAICompatibleProvider().chat(model, {
      messages: [{ role: "user", content: "Hi" }], temperature: 0.2, timeout: 1_000, onToken: () => undefined,
    }), /未返回 SSE 流式响应/);
  } finally { globalThis.fetch = originalFetch; }
});

test("buffered chat exposes provider token usage when available", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: "OK" } }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const model = { baseUrl: "https://example.test/v1", modelId: "test-model", apiKey: "", supportsStructuredOutput: true } as RuntimeModelConfig;
    const result = await new OpenAICompatibleProvider().chat(model, {
      messages: [{ role: "user", content: "Hi" }], temperature: 0, timeout: 1_000, structured: true,
    });
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 3, totalTokens: 15 });
  } finally { globalThis.fetch = originalFetch; }
});

test("caller abort is propagated as AbortError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  try {
    const abort = new AbortController();
    const model = { baseUrl: "https://example.test/v1", modelId: "test-model", apiKey: "", supportsStructuredOutput: false } as RuntimeModelConfig;
    const request = new OpenAICompatibleProvider().chat(model, {
      messages: [{ role: "user", content: "Hi" }], temperature: 0.2, timeout: 10_000, onToken: () => undefined, signal: abort.signal,
    });
    abort.abort();
    await assert.rejects(request, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  } finally { globalThis.fetch = originalFetch; }
});
