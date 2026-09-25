type Message = { role: "system" | "user"; content: string };
type LlmResponse = { choices?: { message?: { content?: string } }[] };

export interface ModelProvider {
  structured<T>(messages: Message[]): Promise<T>;
}

export class DeepSeekModelProvider implements ModelProvider {
  async structured<T>(messages: Message[]): Promise<T> {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) throw new Error("缺少环境变量 DEEPSEEK_API_KEY");
    const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || "deepseek-chat", temperature: 0, max_tokens: 1600, response_format: { type: "json_object" }, messages }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`LLM 请求失败（${response.status}）：${safeMessage(body)}`);
    const parsed = JSON.parse(body) as LlmResponse;
    const content = parsed.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM 未返回有效内容");
    return JSON.parse(content) as T;
  }
}

function safeMessage(body: string) {
  try { const parsed = JSON.parse(body); return String(parsed.error?.message || parsed.message || "未知错误").slice(0, 240); }
  catch { return "未知错误"; }
}
