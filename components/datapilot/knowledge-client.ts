export function apiRequest(path: string, init: RequestInit = {}) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
  return fetch(`${base}${path}`, { ...init, credentials: "include" });
}

export async function responseJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "知识库请求失败");
  return data;
}

export function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
export function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
