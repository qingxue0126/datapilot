import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Response } from "express";
import { closeSse, openSse, sseAbortSignal, writeSse } from "./sse";

class ResponseDouble extends EventEmitter {
  statusCode = 0;
  headers = new Map<string, string>();
  chunks: string[] = [];
  writableEnded = false;
  destroyed = false;
  flushed = false;
  status(value: number) { this.statusCode = value; return this; }
  setHeader(name: string, value: string) { this.headers.set(name, value); return this; }
  flushHeaders() { this.flushed = true; }
  write(value: string) { this.chunks.push(value); return true; }
  end() { this.writableEnded = true; return this; }
}

test("SSE writer emits the unified event format and disables buffering", () => {
  const response = new ResponseDouble();
  openSse(response as unknown as Response);
  writeSse(response as unknown as Response, "start", { runId: "run-1" });
  writeSse(response as unknown as Response, "delta", { runId: "run-1", delta: "你" });
  writeSse(response as unknown as Response, "done", { runId: "run-1" });
  closeSse(response as unknown as Response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("X-Accel-Buffering"), "no");
  assert.match(response.chunks.join(""), /event: start\ndata: {"runId":"run-1"}\n\n/);
  assert.match(response.chunks.join(""), /event: delta\ndata: {"runId":"run-1","delta":"你"}\n\n/);
  assert.equal(response.writableEnded, true);
});

test("closing the client aborts upstream work", () => {
  const response = new ResponseDouble();
  const signal = sseAbortSignal(response as unknown as Response);
  assert.equal(signal.aborted, false);
  response.emit("close");
  assert.equal(signal.aborted, true);
});
