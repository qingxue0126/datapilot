import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "./model-provider.js";
import type { RuntimeModelConfig } from "./model-types.js";

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
