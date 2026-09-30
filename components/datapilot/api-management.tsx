"use client";

import { FormEvent, useEffect, useState } from "react";
import { apiUrl, resolveApiBase } from "./api-base";

type ApiKeyItem = { id: string; name: string; tenantId: string; enabled: boolean; createdAt: string; lastUsedAt?: string };

export function ApiManagement() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [items, setItems] = useState<ApiKeyItem[]>([]);
  const [createdKey, setCreatedKey] = useState("");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const apiBase = resolveApiBase();

  useEffect(() => {
    if (!dialogOpen) { setCreatedKey(""); setCreating(false); return; }
    void loadKeys();
  }, [dialogOpen]);

  async function request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(apiUrl(path), { ...init, credentials: "include", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    const data = response.status === 204 ? undefined : await response.json();
    if (!response.ok) throw new Error(data?.error || "操作失败");
    return data as T;
  }

  async function loadKeys() {
    setWorking(true); setError("");
    try { const data = await request<{ items: ApiKeyItem[] }>("/api/auth/api-keys"); setItems(data.items); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setWorking(false); }
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    setWorking(true); setError(""); setNotice("");
    try {
      const data = await request<{ apiKey: ApiKeyItem; key: string }>("/api/auth/api-keys", { method: "POST", body: JSON.stringify({ name: values.get("name") }) });
      setItems((current) => [data.apiKey, ...current]); setCreatedKey(data.key); setCreating(false); form.reset(); setNotice("API Key 已创建，请立即复制保存");
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setWorking(false); }
  }

  async function toggleKey(item: ApiKeyItem) {
    setWorking(true); setError(""); setNotice("");
    try {
      const data = await request<{ apiKey: ApiKeyItem }>(`/api/auth/api-keys/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !item.enabled }) });
      setItems((current) => current.map((key) => key.id === item.id ? data.apiKey : key)); setNotice(item.enabled ? "API Key 已禁用" : "API Key 已启用");
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setWorking(false); }
  }

  async function revokeKey(item: ApiKeyItem) {
    setWorking(true); setError(""); setNotice("");
    try { await request(`/api/auth/api-keys/${encodeURIComponent(item.id)}`, { method: "DELETE" }); setItems((current) => current.filter((key) => key.id !== item.id)); setNotice("API Key 已撤销"); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setWorking(false); }
  }

  return <div className="module-content api-management-page">
    <section className="api-overview-card">
      <div className="api-overview-title"><h2>DataPilot API</h2><button onClick={() => setDialogOpen(true)}>API KEY</button></div>
      <div className="api-server-row"><strong>API 服务器</strong><code>{apiBase}</code><button aria-label="复制 API 服务器地址" onClick={() => void navigator.clipboard.writeText(apiBase)}>复制</button></div>
    </section>
    <section className="api-guide-card"><span className="eyebrow">OPEN API</span><h3>通过 API 调用 DataPilot</h3><p>使用 Bearer API Key 调用智能问数、智能体运行和知识库能力。API Key 继承创建者当前团队与资源权限。</p><pre><code>{`Authorization: Bearer dp_xxx\nContent-Type: application/json`}</code></pre><div className="api-endpoint-list"><article><b>POST</b><code>/api/v1/query</code><span>智能问数</span></article><article><b>POST</b><code>/api/agents/:id/run/stream</code><span>流式运行智能体</span></article><article><b>POST</b><code>/api/knowledge-bases/:id/retrieve</code><span>知识库检索</span></article></div></section>
    {dialogOpen && <div className="modal-backdrop api-key-dialog-backdrop" onMouseDown={() => !working && setDialogOpen(false)}><section className="api-key-dialog" role="dialog" aria-modal="true" aria-labelledby="api-key-dialog-title" onMouseDown={(event) => event.stopPropagation()}><header><h2 id="api-key-dialog-title">API Key</h2><button aria-label="关闭" onClick={() => setDialogOpen(false)}>×</button></header><div className="api-key-dialog-content">
      {createdKey && <div className="api-key-created"><strong>完整密钥仅显示一次，请立即复制保存</strong><code>{createdKey}</code><button type="button" onClick={() => void navigator.clipboard.writeText(createdKey)}>复制</button></div>}
      {error && <div className="center-notice error" role="alert">{error}</div>}{notice && <div className="center-notice success" role="status">{notice}</div>}
      <div className="api-key-table"><div className="api-key-row api-key-head"><span>名称 / Token</span><span>创建于</span><span>状态</span><span>操作</span></div>{working && !items.length ? <p className="center-empty">正在加载…</p> : items.length ? items.map((item) => <div className="api-key-row" key={item.id}><div><strong>{item.name}</strong><small>dp_•••••••• · 最后使用：{item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : "从未"}</small></div><time>{new Date(item.createdAt).toLocaleString()}</time><span className={item.enabled ? "enabled" : "disabled"}>{item.enabled ? "已启用" : "已禁用"}</span><div className="api-key-actions"><button disabled={working} onClick={() => void toggleKey(item)}>{item.enabled ? "禁用" : "启用"}</button><button className="danger" disabled={working} onClick={() => void revokeKey(item)}>撤销</button></div></div>) : <p className="center-empty">当前团队还没有 API Key。</p>}</div>
      {creating ? <form className="api-key-create-form" onSubmit={(event) => void createKey(event)}><input name="name" minLength={2} maxLength={80} placeholder="密钥名称，例如：生产环境" required autoFocus /><button type="button" onClick={() => setCreating(false)}>取消</button><button className="primary-action" disabled={working}>创建</button></form> : <button className="api-key-create-trigger" onClick={() => setCreating(true)}>创建新密钥</button>}
    </div></section></div>}
  </div>;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }
