"use client";

import { FormEvent, useEffect, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { apiUrl } from "./api-base";

type ModelType = "llm" | "embedding" | "rerank" | "vision" | "multimodal_llm" | "multimodal_embedding" | "multimodal_rerank";
type ModelCapability = "chat" | "reasoning" | "tool_calling" | "structured_output" | "text2sql" | "long_context" | "text_embedding" | "multilingual" | "text_rerank" | "vision" | "ocr" | "image_understanding" | "chart_understanding" | "document_understanding" | "image_embedding" | "multimodal_embedding" | "multimodal_rerank";
export type ModelOption = {
  id: string; name: string; modelType: ModelType; permission: "private" | "tenant"; capabilities: ModelCapability[]; provider: string; modelId: string; baseUrl: string; apiKeyMasked: string; apiKeyConfigured: boolean;
  contextWindow: number; embeddingDimension: number | null; maxInputTokens: number | null; topN: number | null; timeout: number; maxRetries: number; temperature: number; supportsTools: boolean;
  supportsStructuredOutput: boolean; supportsVision: boolean; enabled: boolean; lastTestStatus: "success" | "failed" | null;
  lastTestLatencyMs: number | null; lastTestError: string | null; lastTestedAt: string | null;
};
type ModelRoute = { task: string; primaryModelId: string | null; fallbackModelId: string | null; temperature: number; timeout: number; maxRetries: number };
const taskLabels: Record<string, string> = { intent: "问题理解 / 意图识别", text2sql: "SQL 生成", sqlRepair: "SQL 修复", agent: "Agent Loop / Tool Calling", answer: "结果解释与总结", schemaMapping: "Schema / Mapping 辅助分析" };
const providers = [
  ["openai-compatible", "OpenAI Compatible"], ["openai", "OpenAI"], ["qwen", "Qwen"], ["deepseek", "DeepSeek"],
  ["glm", "GLM"], ["vllm", "本地 vLLM"], ["ollama", "Ollama"],
];
const modelTypeLabels: Record<ModelType, string> = { llm: "LLM", embedding: "Embedding", rerank: "Rerank", vision: "Vision", multimodal_llm: "Multimodal LLM", multimodal_embedding: "Multimodal Embedding", multimodal_rerank: "Multimodal Rerank" };
const capabilityLabels: Record<ModelCapability, string> = { chat: "Chat", reasoning: "Reasoning", tool_calling: "Tools", structured_output: "Structured", text2sql: "Text2SQL", long_context: "Long Context", text_embedding: "Text Embedding", multilingual: "Multilingual", text_rerank: "Text Rerank", vision: "Vision", ocr: "OCR", image_understanding: "Image", chart_understanding: "Chart", document_understanding: "Document", image_embedding: "Image Embedding", multimodal_embedding: "Multimodal Embedding", multimodal_rerank: "Multimodal Rerank" };
const capabilitiesByType: Record<ModelType, ModelCapability[]> = {
  llm: ["chat", "reasoning", "tool_calling", "structured_output", "text2sql", "long_context", "vision"],
  embedding: ["text_embedding", "multilingual"],
  rerank: ["text_rerank", "multilingual"],
  vision: ["vision", "ocr", "image_understanding", "chart_understanding", "document_understanding"],
  multimodal_llm: ["chat", "reasoning", "tool_calling", "structured_output", "vision", "ocr", "image_understanding", "chart_understanding", "document_understanding", "long_context"],
  multimodal_embedding: ["text_embedding", "image_embedding", "multimodal_embedding", "multilingual"],
  multimodal_rerank: ["text_rerank", "image_understanding", "multimodal_rerank", "multilingual"],
};
const defaultCapabilities: Record<ModelType, ModelCapability[]> = {
  llm: ["chat", "tool_calling", "structured_output"], embedding: ["text_embedding"], rerank: ["text_rerank"],
  vision: ["vision", "image_understanding"], multimodal_llm: ["chat", "vision", "image_understanding"],
  multimodal_embedding: ["text_embedding", "image_embedding", "multimodal_embedding"], multimodal_rerank: ["text_rerank", "multimodal_rerank"],
};

export function ModelSelector({ models, value, onChange }: { models: ModelOption[]; value: string; onChange: (id: string) => void }) {
  const enabled = models.filter((model) => model.enabled && model.modelType === "llm");
  return <label className="model-selector"><span>模型</span><select aria-label="选择模型" value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">按任务路由</option>{enabled.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
  </select></label>;
}

export function ModelManagement({ models, selectedModel, onSelect, onRefresh }: { models: ModelOption[]; selectedModel: string; onSelect: (id: string) => void; onRefresh: () => Promise<void> }) {
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  const [editing, setEditing] = useState<ModelOption | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [typeFilter, setTypeFilter] = useState<ModelType | "all">("all");
  const [pendingDelete, setPendingDelete] = useState<ModelOption | null>(null);
  useEffect(() => { void loadRoutes(); }, []);

  async function loadRoutes() {
    try {
      const response = await apiFetch("/api/model-routes"); const data = await response.json();
      if (response.ok) setRoutes(data.items || []); else setNotice(data.error || "无法读取模型路由");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }
  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("save"); setNotice("");
    try {
      const data = new FormData(event.currentTarget);
      const capabilities = data.getAll("capabilities").map(String) as ModelCapability[];
      const payload = { name: value(data, "name"), modelType: value(data, "modelType"), capabilities, provider: value(data, "provider"), modelId: value(data, "modelId"), baseUrl: value(data, "baseUrl"), apiKey: value(data, "apiKey"),
        contextWindow: optionalNumber(data, "contextWindow"), embeddingDimension: optionalNumber(data, "embeddingDimension"), maxInputTokens: optionalNumber(data, "maxInputTokens"), topN: optionalNumber(data, "topN"),
        timeout: number(data, "timeout"), maxRetries: number(data, "maxRetries"), temperature: optionalNumber(data, "temperature"), permission: value(data, "permission") || (editing !== "new" && editing ? editing.permission : "private"),
        supportsTools: capabilities.includes("tool_calling"), supportsStructuredOutput: capabilities.includes("structured_output"),
        supportsVision: capabilities.some((item) => ["vision", "ocr", "image_understanding", "chart_understanding", "document_understanding"].includes(item)), enabled: data.has("enabled") };
      const path = editing === "new" ? "/api/models" : `/api/models/${editing?.id}`;
      const response = await apiFetch(path, { method: editing === "new" ? "POST" : "PATCH", body: JSON.stringify(payload) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "保存失败");
      setEditing(null); setNotice("模型配置已保存"); await onRefresh();
    } catch (error) { setNotice(errorMessage(error)); } finally { setBusy(""); }
  }
  async function patchModel(model: ModelOption, payload: Record<string, unknown>) {
    setBusy(model.id); setNotice("");
    try { const response = await apiFetch(`/api/models/${model.id}`, { method: "PATCH", body: JSON.stringify(payload) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); await onRefresh(); }
    catch (error) { setNotice(errorMessage(error)); } finally { setBusy(""); }
  }
  async function removeModel(model: ModelOption) {
    setBusy(model.id); const response = await apiFetch(`/api/models/${model.id}`, { method: "DELETE" });
    if (!response.ok) { const data = await response.json(); setNotice(data.error || "删除失败"); } else { setNotice("模型已删除"); await onRefresh(); await loadRoutes(); }
    setBusy("");
  }
  async function testModel(model: ModelOption) {
    setBusy(`test-${model.id}`); setNotice("");
    const response = await apiFetch(`/api/models/${model.id}/test`, { method: "POST" }); const data = await response.json();
    setNotice(data.success ? `连接成功，耗时 ${data.latencyMs} ms` : `连接失败：${data.error || "未知错误"}`); await onRefresh(); setBusy("");
  }
  async function saveRoute(route: ModelRoute) {
    setBusy(`route-${route.task}`); setNotice("");
    const response = await apiFetch(`/api/model-routes/${route.task}`, { method: "PUT", body: JSON.stringify(route) }); const data = await response.json();
    if (!response.ok) setNotice(data.error || "路由保存失败"); else { setNotice(`${taskLabels[route.task]}路由已保存`); await loadRoutes(); }
    setBusy("");
  }
  function changeRoute(task: string, field: keyof ModelRoute, next: string | number) {
    setRoutes((items) => items.map((item) => item.task === task ? { ...item, [field]: next || null } : item));
  }
  const visibleModels = typeFilter === "all" ? models : models.filter((model) => model.modelType === typeFilter);

  return <div className="module-content model-management-page">
    <div className="module-heading"><div><span className="eyebrow">MODEL REGISTRY</span><h2>模型管理</h2><p>统一管理大模型接入、能力、连通性与任务路由；ERP 语义配置仍归属于数据源。</p></div><button className="primary-action model-add" onClick={() => setEditing("new")}>＋ 新增模型</button></div>
    {notice && <div className="model-notice" role="status">{notice}</div>}
    <section className="model-list-section"><header><div><h3>Models</h3><p>API Key 仅在服务端加密保存，页面只显示掩码。</p></div><div className="model-list-tools"><select aria-label="按模型类型筛选" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as ModelType | "all")}><option value="all">全部类型</option>{Object.entries(modelTypeLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select><small>{visibleModels.length} 个模型</small></div></header>
      <div className="model-table-wrap"><table className="model-table"><thead><tr><th>模型名称</th><th>类型</th><th>Provider / Model ID</th><th>能力</th><th>状态</th><th>连接状态</th><th>操作</th></tr></thead><tbody>
        {visibleModels.map((model) => <tr key={model.id}><td><strong>{model.name}</strong>{selectedModel === model.id && <small className="default-tag">对话选择</small>}<small>{model.apiKeyMasked || "未配置 Key"}</small></td>
          <td><span className="model-type-label">{modelTypeLabels[model.modelType]}</span></td><td><span>{providerLabel(model.provider)}</span><code>{model.modelId}</code></td><td><div className="capability-tags">{model.capabilities.map((capability) => <small key={capability}>{capabilityLabels[capability]}</small>)}</div></td>
          <td><button className={`status-toggle ${model.enabled ? "enabled" : ""}`} disabled={busy === model.id} onClick={() => void patchModel(model, { enabled: !model.enabled })}>{model.enabled ? "已启用" : "已停用"}</button></td>
          <td><span className={`test-state ${model.lastTestStatus || "unknown"}`}>{model.lastTestStatus === "success" ? `成功 · ${model.lastTestLatencyMs} ms` : model.lastTestStatus === "failed" ? "失败" : "未测试"}</span>{model.lastTestError && <small title={model.lastTestError}>{model.lastTestError}</small>}</td>
          <td><div className="model-actions"><button onClick={() => setEditing(model)}>编辑</button><button disabled={busy === `test-${model.id}`} onClick={() => void testModel(model)}>测试连接</button><button onClick={() => onSelect(model.id)} disabled={!model.enabled || model.modelType !== "llm" || selectedModel === model.id}>选择</button><button className="danger" onClick={() => setPendingDelete(model)}>删除</button></div></td></tr>)}
        {!visibleModels.length && <tr><td colSpan={7} className="empty-cell">暂无符合条件的模型。</td></tr>}
      </tbody></table></div>
    </section>

    <section className="model-list-section routing-section"><header><div><h3>Routing</h3><p>按任务选择主模型、备用模型及调用参数，失败时自动切换备用模型。</p></div></header>
      <div className="routing-list">{routes.map((route) => <div className="routing-row" key={route.task}><div className="routing-task"><strong>{route.task}</strong><small>{taskLabels[route.task]}</small></div>
        <label>主模型<select value={route.primaryModelId || ""} onChange={(e) => changeRoute(route.task, "primaryModelId", e.target.value)}><option value="">自动选择</option>{models.filter((m) => m.enabled && m.modelType === "llm").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label>备用模型<select value={route.fallbackModelId || ""} onChange={(e) => changeRoute(route.task, "fallbackModelId", e.target.value)}><option value="">无</option>{models.filter((m) => m.enabled && m.modelType === "llm").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label>Temperature<input type="number" min="0" max="2" step="0.1" value={route.temperature} onChange={(e) => changeRoute(route.task, "temperature", Number(e.target.value))} /></label>
        <label>超时(ms)<input type="number" min="1000" step="1000" value={route.timeout} onChange={(e) => changeRoute(route.task, "timeout", Number(e.target.value))} /></label>
        <label>重试<input type="number" min="0" max="10" value={route.maxRetries} onChange={(e) => changeRoute(route.task, "maxRetries", Number(e.target.value))} /></label>
        <button disabled={busy === `route-${route.task}`} onClick={() => void saveRoute(route)}>保存</button></div>)}</div>
    </section>
    {editing && <ModelEditor model={editing === "new" ? undefined : editing} busy={busy === "save"} close={() => setEditing(null)} submit={saveModel} />}
    {pendingDelete && <ConfirmDialog title="删除模型" message={`确认删除模型“${pendingDelete.name}”？相关路由将自动清空。`} busy={busy === pendingDelete.id} close={() => setPendingDelete(null)} confirm={async () => { const model = pendingDelete; setPendingDelete(null); await removeModel(model); }} />}
  </div>;
}

function ModelEditor({ model, busy, close, submit }: { model?: ModelOption; busy: boolean; close: () => void; submit: (event: FormEvent<HTMLFormElement>) => void }) {
  const [modelType, setModelType] = useState<ModelType>(model?.modelType || "llm");
  const selectedCapabilities = model?.modelType === modelType ? model.capabilities : defaultCapabilities[modelType];
  const showsContext = modelType === "llm" || modelType === "multimodal_llm";
  const showsEmbedding = modelType === "embedding" || modelType === "multimodal_embedding";
  const showsRerank = modelType === "rerank" || modelType === "multimodal_rerank";
  return <div className="modal-backdrop"><form className="source-modal source-modal-wide" onSubmit={submit}><div className="modal-head"><div><h2>{model ? "编辑模型" : "新增模型"}</h2><p>模型类型决定连接测试协议和可配置能力；能力标签可按模型实际情况勾选。</p></div><button type="button" onClick={close}>×</button></div>
    <div className="connection-form-grid"><label>模型名称<input name="name" required defaultValue={model?.name || ""} /></label><label>模型类型<select name="modelType" value={modelType} onChange={(event) => setModelType(event.target.value as ModelType)}>{Object.entries(modelTypeLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label><label>Provider<select name="provider" defaultValue={model?.provider || "openai-compatible"}>{providers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>Model ID<input name="modelId" required defaultValue={model?.modelId || ""} /></label><label>Base URL<input name="baseUrl" type="url" required defaultValue={model?.baseUrl || "https://api.openai.com/v1"} /></label>
      <label className="span-two">API Key<input name="apiKey" type="password" autoComplete="new-password" placeholder={model?.apiKeyMasked || "仅发送到服务端，不会明文回显"} /><small>{model ? "留空将保留现有 API Key" : "Ollama 等无需鉴权的本地服务可留空"}</small></label>
      {showsContext && <><label>上下文窗口<input name="contextWindow" type="number" min="1" defaultValue={model?.contextWindow || 64000} /></label><label>Temperature<input name="temperature" type="number" min="0" max="2" step="0.1" defaultValue={model?.temperature ?? 0} /></label></>}
      {showsEmbedding && <><label>向量维度（可选）<input name="embeddingDimension" type="number" min="1" placeholder="由模型自动返回" defaultValue={model?.embeddingDimension || ""} /></label><label>最大输入长度<input name="maxInputTokens" type="number" min="1" defaultValue={model?.maxInputTokens || ""} /></label></>}
      {showsRerank && <><label>最大输入长度<input name="maxInputTokens" type="number" min="1" defaultValue={model?.maxInputTokens || ""} /></label><label>默认 Top N<input name="topN" type="number" min="1" defaultValue={model?.topN || 10} /></label></>}
      <label>超时 (ms)<input name="timeout" type="number" min="1000" required defaultValue={model?.timeout || 60000} /></label><label>最大重试<input name="maxRetries" type="number" min="0" max="10" required defaultValue={model?.maxRetries ?? 2} /></label>
    </div>
    <div className="model-capability-editor"><strong>能力标签</strong><div className="model-checks" key={modelType}>{capabilitiesByType[modelType].map((capability) => <label key={capability}><input name="capabilities" value={capability} type="checkbox" defaultChecked={selectedCapabilities.includes(capability)} />{capabilityLabels[capability]}</label>)}</div></div>
    <div className="model-checks model-enabled-check"><label><input name="enabled" type="checkbox" defaultChecked={model?.enabled ?? true} />启用</label></div>
    <div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary-action" disabled={busy}>{busy ? "保存中…" : "保存模型"}</button></div>
  </form></div>;
}

function apiFetch(path: string, init: RequestInit = {}) { return fetch(apiUrl(path), { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init.headers || {}) } }); }
function value(data: FormData, key: string) { return String(data.get(key) || "").trim(); }
function number(data: FormData, key: string) { return Number(data.get(key)); }
function optionalNumber(data: FormData, key: string) { const raw = value(data, key); return raw ? Number(raw) : null; }
function providerLabel(id: string) { return providers.find(([value]) => value === id)?.[1] || id; }
function errorMessage(error: unknown) {
  if (error instanceof TypeError && /fetch/i.test(error.message)) return "无法连接 DataPilot API，请稍后重试。";
  return error instanceof Error ? error.message : "操作失败";
}
