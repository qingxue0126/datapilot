import { apiUrl } from "./api-base";

export type DataPilotSseEvent = "start" | "delta" | "done" | "error";
export type DataPilotSsePayload = Record<string, unknown>;

export async function streamApi(
  path: string,
  init: RequestInit,
  handlers: Partial<Record<DataPilotSseEvent, (payload: DataPilotSsePayload) => void>>,
) {
  const response = await fetch(apiUrl(path), { ...init, credentials: "include", headers: { Accept: "text/event-stream", ...init.headers } });
  if (!response.ok) throw new Error(await responseError(response));
  await consumeSse(response, handlers);
}

export async function consumeSse(
  response: Response,
  handlers: Partial<Record<DataPilotSseEvent, (payload: DataPilotSsePayload) => void>>,
) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("服务端未返回流式响应");
  if (!response.body) throw new Error("流式响应内容为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const consume = (block: string) => {
    let event = "";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!isEvent(event) || !data.length) return;
    let payload: DataPilotSsePayload;
    try { payload = JSON.parse(data.join("\n")) as DataPilotSsePayload; }
    catch { throw new Error("无法解析流式响应事件"); }
    handlers[event]?.(payload);
    if (event === "done") finished = true;
    if (event === "error") throw new Error(String(payload.message || "流式响应失败"));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) if (block.trim()) consume(block);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!finished) throw new Error("流式响应意外结束");
  } finally {
    reader.releaseLock();
  }
}

function isEvent(value: string): value is DataPilotSseEvent {
  return value === "start" || value === "delta" || value === "done" || value === "error";
}

async function responseError(response: Response) {
  const text = await response.text();
  try { return String((JSON.parse(text) as { error?: string }).error || `请求失败（${response.status}）`); }
  catch { return text || `请求失败（${response.status}）`; }
}
