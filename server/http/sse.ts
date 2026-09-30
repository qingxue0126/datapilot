import type { Response } from "express";

export type SseEventName = "start" | "delta" | "done" | "error";
export type SseEventPayload = Record<string, unknown>;

export function openSse(response: Response) {
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
}

export function writeSse(response: Response, event: SseEventName, payload: SseEventPayload) {
  if (response.writableEnded || response.destroyed) return false;
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  return true;
}

export function sseAbortSignal(response: Response) {
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  return controller.signal;
}

export function closeSse(response: Response) {
  if (!response.writableEnded && !response.destroyed) response.end();
}
