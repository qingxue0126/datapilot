import assert from "node:assert/strict";
import test from "node:test";
import { consumeSse } from "../../components/datapilot/sse-client";

function responseFrom(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

test("SSE client joins chunks without duplicating deltas", async () => {
  const events: string[] = [];
  await consumeSse(responseFrom([
    "event: start\ndata: {\"runId\":\"run-1\"}\n\nevent: del",
    "ta\ndata: {\"delta\":\"你\"}\n\nevent: delta\ndata: {\"delta\":\"好\"}\n\n",
    "event: done\ndata: {\"result\":{\"text\":\"你好\"}}\n\n",
  ]), {
    start: (payload) => events.push(`start:${payload.runId}`),
    delta: (payload) => events.push(`delta:${payload.delta}`),
    done: () => events.push("done"),
  });
  assert.deepEqual(events, ["start:run-1", "delta:你", "delta:好", "done"]);
});

test("SSE client surfaces error events", async () => {
  await assert.rejects(
    consumeSse(responseFrom(["event: error\ndata: {\"message\":\"模型不可用\"}\n\n"]), {}),
    /模型不可用/,
  );
});

test("SSE client rejects a stream that ends without done", async () => {
  await assert.rejects(
    consumeSse(responseFrom(["event: start\ndata: {\"runId\":\"run-1\"}\n\n"]), {}),
    /意外结束/,
  );
});

test("SSE client propagates interruption", async () => {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("event: start\ndata: {\"runId\":\"run-1\"}\n\n"));
      abort.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
  const reading = consumeSse(response, {});
  abort.abort();
  await assert.rejects(reading, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});
