export async function apiRequest(path: string, init: RequestInit = {}) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
  const attempts = !init.method || init.method.toUpperCase() === "GET" ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(`${base}${path}`, { ...init, credentials: "include" });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function responseJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "知识库请求失败");
  return data;
}

export function message(error: unknown, fallback: string) {
  if (error instanceof TypeError && /fetch/i.test(error.message)) return "无法连接 DataPilot API，请确认服务已启动后重试。";
  return error instanceof Error ? error.message : fallback;
}
export function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
