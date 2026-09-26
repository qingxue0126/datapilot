export type ModelCatalogItem = {
  id: string;
  name: string;
  provider: "DeepSeek";
  description: string;
  capabilities: string[];
};

const knownModels: Record<string, Omit<ModelCatalogItem, "id">> = {
  "deepseek-chat": { name: "DeepSeek Chat", provider: "DeepSeek", description: "通用对话与结构化 Text2SQL，响应速度优先。", capabilities: ["结构化输出", "Text2SQL", "多轮对话"] },
  "deepseek-reasoner": { name: "DeepSeek Reasoner", provider: "DeepSeek", description: "适合复杂推理与多步骤财务分析。", capabilities: ["复杂推理", "Text2SQL", "多轮对话"] },
};

export function modelCatalog() {
  const configured = String(process.env.DEEPSEEK_MODELS || "deepseek-chat,deepseek-reasoner")
    .split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(configured)].map((id) => ({ id, ...(knownModels[id] || { name: id, provider: "DeepSeek" as const, description: "通过服务端环境配置的模型。", capabilities: ["Text2SQL"] }) }));
}

export function defaultModelId() {
  const models = modelCatalog();
  const configured = String(process.env.DEEPSEEK_MODEL || "deepseek-chat").trim();
  return models.some((model) => model.id === configured) ? configured : models[0]?.id || "deepseek-chat";
}

export function resolveModelId(requested: unknown) {
  const id = String(requested || defaultModelId()).trim();
  if (!modelCatalog().some((model) => model.id === id)) throw new Error("所选模型不可用");
  return id;
}
