"use client";

import { FormEvent, useEffect, useState } from "react";

export type ModelOption = {
  id: string; name: string; provider: string; modelId: string; baseUrl: string; apiKeyMasked: string; apiKeyConfigured: boolean;
  contextWindow: number; timeout: number; maxRetries: number; temperature: number; supportsTools: boolean;
  supportsStructuredOutput: boolean; supportsVision: boolean; enabled: boolean; lastTestStatus: "success" | "failed" | null;
  lastTestLatencyMs: number | null; lastTestError: string | null; lastTestedAt: string | null;
};
type ModelRoute = { task: string; primaryModelId: string | null; fallbackModelId: string | null; temperature: number; timeout: number; maxRetries: number };
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
const taskLabels: Record<string, string> = { intent: "问题理解 / 意图识别", text2sql: "SQL 生成", sqlRepair: "SQL 修复", agent: "Agent Loop / Tool Calling", answer: "结果解释与总结", schemaMapping: "Schema / Mapping 辅助分析" };
const providers = [
  ["openai-compatible", "OpenAI Compatible"], ["openai", "OpenAI"], ["qwen", "Qwen"], ["deepseek", "DeepSeek"],
  ["glm", "GLM"], ["vllm", "本地 vLLM"], ["ollama", "Ollama"],
];

export function ModelSelector({ models, value, onChange }: { models: ModelOption[]; value: string; onChange: (id: string) => void }) {
  const enabled = models.filter((model) => model.enabled);
  return <label className="model-selector"><span>模型</span><select aria-label="选择模型" value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">按任务路由</option>{enabled.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
  </select></label>;
}

export function ModelManagement({ models, selectedModel, onSelect, onRefresh }: { models: ModelOption[]; selectedModel: string; onSelect: (id: string) => void; onRefresh: () => Promise<void> }) {
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  const [editing, setEditing] = useState<ModelOption | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => { void loadRoutes(); }, []);

  async function loadRoutes() {
    const response = await apiFetch("/api/model-routes"); const data = await response.json();
    if (response.ok) setRoutes(data.items || []); else setNotice(data.error || "无法读取模型路由");
  }
  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("save"); setNotice("");
    try {
      const data = new FormData(event.currentTarget);
      const payload = { name: value(data, "name"), provider: value(data, "provider"), modelId: value(data, "modelId"), baseUrl: value(data, "baseUrl"), apiKey: value(data, "apiKey"),
        contextWindow: number(data, "contextWindow"), timeout: number(data, "timeout"), maxRetries: number(data, "maxRetries"), temperature: number(data, "temperature"),
        supportsTools: data.has("supportsTools"), supportsStructuredOutput: data.has("supportsStructuredOutput"), supportsVision: data.has("supportsVision"), enabled: data.has("enabled") };
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
    if (!window.confirm(`确认删除模型“${model.name}”？相关路由将自动清空。`)) return;
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

  return <div className="module-content model-management-page">
    <div className="module-heading"><div><span className="eyebrow">MODEL REGISTRY</span><h2>模型管理</h2><p>统一管理大模型接入、能力、连通性与任务路由；ERP 语义配置仍归属于数据源。</p></div><button className="primary-action model-add" onClick={() => setEditing("new")}>＋ 新增模型</button></div>
    {notice && <div className="model-notice" role="status">{notice}</div>}
    <section className="model-list-section"><header><div><h3>Models</h3><p>API Key 仅在服务端加密保存，页面只显示掩码。</p></div><small>{models.length} 个模型</small></header>
      <div className="model-table-wrap"><table className="model-table"><thead><tr><th>模型名称</th><th>Provider / Model ID</th><th>能力</th><th>状态</th><th>连接状态</th><th>操作</th></tr></thead><tbody>
        {models.map((model) => <tr key={model.id}><td><strong>{model.name}</strong>{selectedModel === model.id && <small className="default-tag">对话选择</small>}<small>{model.apiKeyMasked || "未配置 Key"}</small></td>
          <td><span>{providerLabel(model.provider)}</span><code>{model.modelId}</code></td><td><div className="capability-tags">{model.supportsTools && <small>Tools</small>}{model.supportsStructuredOutput && <small>Structured</small>}{model.supportsVision && <small>Vision</small>}</div></td>
          <td><button className={`status-toggle ${model.enabled ? "enabled" : ""}`} disabled={busy === model.id} onClick={() => void patchModel(model, { enabled: !model.enabled })}>{model.enabled ? "已启用" : "已停用"}</button></td>
          <td><span className={`test-state ${model.lastTestStatus || "unknown"}`}>{model.lastTestStatus === "success" ? `成功 · ${model.lastTestLatencyMs} ms` : model.lastTestStatus === "failed" ? "失败" : "未测试"}</span>{model.lastTestError && <small title={model.lastTestError}>{model.lastTestError}</small>}</td>
          <td><div className="model-actions"><button onClick={() => setEditing(model)}>编辑</button><button disabled={busy === `test-${model.id}`} onClick={() => void testModel(model)}>测试连接</button><button onClick={() => onSelect(model.id)} disabled={!model.enabled || selectedModel === model.id}>选择</button><button className="danger" onClick={() => void removeModel(model)}>删除</button></div></td></tr>)}
        {!models.length && <tr><td colSpan={6} className="empty-cell">暂无模型，请新增模型。</td></tr>}
      </tbody></table></div>
    </section>

    <section className="model-list-section routing-section"><header><div><h3>Routing</h3><p>按任务选择主模型、备用模型及调用参数，失败时自动切换备用模型。</p></div></header>
      <div className="routing-list">{routes.map((route) => <div className="routing-row" key={route.task}><div className="routing-task"><strong>{route.task}</strong><small>{taskLabels[route.task]}</small></div>
        <label>主模型<select value={route.primaryModelId || ""} onChange={(e) => changeRoute(route.task, "primaryModelId", e.target.value)}><option value="">自动选择</option>{models.filter((m) => m.enabled).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label>备用模型<select value={route.fallbackModelId || ""} onChange={(e) => changeRoute(route.task, "fallbackModelId", e.target.value)}><option value="">无</option>{models.filter((m) => m.enabled).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label>Temperature<input type="number" min="0" max="2" step="0.1" value={route.temperature} onChange={(e) => changeRoute(route.task, "temperature", Number(e.target.value))} /></label>
        <label>超时(ms)<input type="number" min="1000" step="1000" value={route.timeout} onChange={(e) => changeRoute(route.task, "timeout", Number(e.target.value))} /></label>
        <label>重试<input type="number" min="0" max="10" value={route.maxRetries} onChange={(e) => changeRoute(route.task, "maxRetries", Number(e.target.value))} /></label>
        <button disabled={busy === `route-${route.task}`} onClick={() => void saveRoute(route)}>保存</button></div>)}</div>
    </section>
    {editing && <ModelEditor model={editing === "new" ? undefined : editing} busy={busy === "save"} close={() => setEditing(null)} submit={saveModel} />}
  </div>;
}

function ModelEditor({ model, busy, close, submit }: { model?: ModelOption; busy: boolean; close: () => void; submit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop"><form className="source-modal source-modal-wide" onSubmit={submit}><div className="modal-head"><div><h2>{model ? "编辑模型" : "新增模型"}</h2><p>兼容 OpenAI Chat Completions 协议的模型服务。</p></div><button type="button" onClick={close}>×</button></div>
    <div className="connection-form-grid"><label>模型名称<input name="name" required defaultValue={model?.name || ""} /></label><label>Provider<select name="provider" defaultValue={model?.provider || "openai-compatible"}>{providers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>Model ID<input name="modelId" required defaultValue={model?.modelId || ""} /></label><label>Base URL<input name="baseUrl" type="url" required defaultValue={model?.baseUrl || "https://api.openai.com/v1"} /></label>
      <label className="span-two">API Key<input name="apiKey" type="password" autoComplete="new-password" placeholder={model?.apiKeyMasked || "仅发送到服务端，不会明文回显"} /><small>{model ? "留空将保留现有 API Key" : "Ollama 等无需鉴权的本地服务可留空"}</small></label>
      <label>上下文窗口<input name="contextWindow" type="number" min="1" required defaultValue={model?.contextWindow || 64000} /></label><label>超时 (ms)<input name="timeout" type="number" min="1000" required defaultValue={model?.timeout || 60000} /></label>
      <label>最大重试<input name="maxRetries" type="number" min="0" max="10" required defaultValue={model?.maxRetries ?? 2} /></label><label>Temperature<input name="temperature" type="number" min="0" max="2" step="0.1" required defaultValue={model?.temperature ?? 0} /></label>
    </div><div className="model-checks"><label><input name="supportsTools" type="checkbox" defaultChecked={model?.supportsTools ?? true} />Tool Calling</label><label><input name="supportsStructuredOutput" type="checkbox" defaultChecked={model?.supportsStructuredOutput ?? true} />Structured Output</label><label><input name="supportsVision" type="checkbox" defaultChecked={model?.supportsVision ?? false} />Vision</label><label><input name="enabled" type="checkbox" defaultChecked={model?.enabled ?? true} />启用</label></div>
    <div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary-action" disabled={busy}>{busy ? "保存中…" : "保存模型"}</button></div>
  </form></div>;
}

function apiFetch(path: string, init: RequestInit = {}) { return fetch(`${API_BASE}${path}`, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init.headers || {}) } }); }
function value(data: FormData, key: string) { return String(data.get(key) || "").trim(); }
function number(data: FormData, key: string) { return Number(data.get(key)); }
function providerLabel(id: string) { return providers.find(([value]) => value === id)?.[1] || id; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }
