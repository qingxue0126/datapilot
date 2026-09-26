"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type RetrievalConfig = {
  chunkSize: number; chunkOverlap: number; embeddingModel: string; topK: number;
  scoreThreshold: number; rerank: boolean; rerankModel: string;
};
type KnowledgeBase = {
  id: string; name: string; description: string; documentCount: number; chunkCount: number;
  config: RetrievalConfig; createdAt: string; updatedAt: string;
};
type KnowledgeDocument = {
  id: string; filename: string; fileType: string; size: number; status: string; error?: string;
  chunkCount: number; createdAt: string;
};
type Detail = { knowledgeBase: KnowledgeBase; documents: KnowledgeDocument[] };
type RetrievalItem = { chunkId: string; documentId: string; filename: string; chunkIndex: number; score: number; content: string };

const statusLabels: Record<string, string> = { uploaded: "已上传", parsing: "解析中", chunking: "分块中", embedding: "向量化中", ready: "可检索", failed: "处理失败" };

function request(path: string, init: RequestInit = {}) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
  return fetch(`${base}${path}`, { ...init, credentials: "include" });
}

export function KnowledgeBaseView() {
  const [items, setItems] = useState<KnowledgeBase[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RetrievalItem[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  // Initial load is intentionally scoped to the mounted knowledge-base view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadList(); }, []);

  async function json(response: Response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "知识库请求失败");
    return data;
  }

  async function loadList() {
    setLoading(true);
    try { const data = await json(await request("/api/knowledge-bases")); setItems(data.items || []); }
    catch (error) { setNotice(error instanceof Error ? error.message : "无法读取知识库"); }
    finally { setLoading(false); }
  }

  async function openKnowledgeBase(id: string, clearNotice = true) {
    setBusy(true); if (clearNotice) setNotice(""); setResults([]);
    try { setDetail(await json(await request(`/api/knowledge-bases/${encodeURIComponent(id)}`))); }
    catch (error) { setNotice(error instanceof Error ? error.message : "无法打开知识库"); }
    finally { setBusy(false); }
  }

  async function createKnowledgeBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setNotice("");
    try {
      const form = new FormData(event.currentTarget);
      const data = await json(await request("/api/knowledge-bases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.get("name"), description: form.get("description") }) }));
      setShowCreate(false); await loadList(); await openKnowledgeBase(data.knowledgeBase.id);
    } catch (error) { setNotice(error instanceof Error ? error.message : "新建知识库失败"); }
    finally { setBusy(false); }
  }

  async function uploadDocument(file?: File) {
    if (!file || !detail) return;
    setBusy(true); setNotice("正在解析、分块并写入向量库…");
    try {
      const body = new FormData(); body.append("file", file);
      const data = await json(await request(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}/documents`, { method: "POST", body }));
      const message = data.document.status === "ready" ? "文档已处理完成，可以开始检索" : data.document.error || "文档处理失败";
      await openKnowledgeBase(detail.knowledgeBase.id, false); await loadList(); setNotice(message);
    } catch (error) { setNotice(error instanceof Error ? error.message : "上传文档失败"); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function deleteDocument(document: KnowledgeDocument) {
    if (!detail || !window.confirm(`删除文档“${document.filename}”？`)) return;
    setBusy(true);
    try { await jsonOrEmpty(await request(`/api/documents/${encodeURIComponent(document.id)}`, { method: "DELETE" })); await openKnowledgeBase(detail.knowledgeBase.id); await loadList(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "删除文档失败"); }
    finally { setBusy(false); }
  }

  async function deleteKnowledgeBase() {
    if (!detail || !window.confirm(`删除知识库“${detail.knowledgeBase.name}”及其全部文档？`)) return;
    setBusy(true);
    try { await jsonOrEmpty(await request(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}`, { method: "DELETE" })); setDetail(null); await loadList(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "删除知识库失败"); }
    finally { setBusy(false); }
  }

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail) return;
    const form = new FormData(event.currentTarget);
    const config = {
      chunkSize: Number(form.get("chunkSize")), chunkOverlap: Number(form.get("chunkOverlap")), embeddingModel: String(form.get("embeddingModel")),
      topK: Number(form.get("topK")), scoreThreshold: Number(form.get("scoreThreshold")), rerank: form.get("rerank") === "on", rerankModel: String(form.get("rerankModel")),
    };
    setBusy(true);
    try { await json(await request(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }) })); await openKnowledgeBase(detail.knowledgeBase.id); setNotice("检索配置已保存"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "保存配置失败"); }
    finally { setBusy(false); }
  }

  async function retrieve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail || !query.trim()) return;
    setBusy(true); setNotice("");
    try { const data = await json(await request(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}/retrieve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) })); setResults(data.items || []); }
    catch (error) { setNotice(error instanceof Error ? error.message : "检索失败"); }
    finally { setBusy(false); }
  }

  if (detail) return <KnowledgeDetail detail={detail} busy={busy} notice={notice} query={query} results={results} fileInput={fileInput} back={() => { setDetail(null); setNotice(""); setResults([]); }} upload={uploadDocument} removeDocument={deleteDocument} removeKnowledgeBase={deleteKnowledgeBase} saveConfig={saveConfig} setQuery={setQuery} retrieve={retrieve} />;

  return <div className="module-content knowledge-page">
    <div className="module-heading"><div><span className="eyebrow">RAG KNOWLEDGE</span><h2>知识库</h2><p>上传业务文档，构建可检索的企业知识。</p></div><button className="primary-action" onClick={() => setShowCreate(true)}>＋ 新建知识库</button></div>
    {notice && <p className="knowledge-notice">{notice}</p>}
    {loading ? <div className="empty-state"><p>正在加载知识库…</p></div> : items.length === 0 ? <div className="empty-state knowledge-empty"><span>◇</span><h3>还没有知识库</h3><p>新建知识库后，可上传 PDF、DOCX、TXT、MD、XLSX 或 CSV 文档。</p><button onClick={() => setShowCreate(true)}>新建知识库</button></div> : <div className="knowledge-grid">{items.map((item) => <button key={item.id} className="knowledge-card" onClick={() => void openKnowledgeBase(item.id)} disabled={busy}><span className="knowledge-card-icon">◇</span><strong>{item.name}</strong><p>{item.description || "暂无描述"}</p><small>{item.documentCount} 个文档 · {item.chunkCount} 个分块</small><time>{formatTime(item.updatedAt)} 更新</time></button>)}</div>}
    {showCreate && <div className="modal-backdrop"><form className="knowledge-create-dialog" onSubmit={createKnowledgeBase}><header><div><h2>新建知识库</h2><p>创建后即可上传并处理文档。</p></div><button type="button" onClick={() => setShowCreate(false)}>×</button></header><label>知识库名称<input name="name" maxLength={80} autoFocus required placeholder="例如：财务制度与口径" /></label><label>描述<textarea name="description" maxLength={500} rows={3} placeholder="说明知识库包含的内容" /></label><footer><button type="button" onClick={() => setShowCreate(false)}>取消</button><button className="primary-action" disabled={busy}>创建</button></footer></form></div>}
  </div>;
}

function KnowledgeDetail({ detail, busy, notice, query, results, fileInput, back, upload, removeDocument, removeKnowledgeBase, saveConfig, setQuery, retrieve }: {
  detail: Detail; busy: boolean; notice: string; query: string; results: RetrievalItem[]; fileInput: React.RefObject<HTMLInputElement | null>;
  back: () => void; upload: (file?: File) => Promise<void>; removeDocument: (document: KnowledgeDocument) => Promise<void>; removeKnowledgeBase: () => Promise<void>;
  saveConfig: (event: FormEvent<HTMLFormElement>) => Promise<void>; setQuery: (value: string) => void; retrieve: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const kb = detail.knowledgeBase; const config = kb.config;
  return <div className="module-content knowledge-page">
    <button className="knowledge-back" onClick={back}>← 返回知识库</button>
    <div className="module-heading knowledge-detail-heading"><div><span className="eyebrow">KNOWLEDGE BASE</span><h2>{kb.name}</h2><p>{kb.description || "上传文档并配置检索参数。"}</p></div><div><input ref={fileInput} type="file" hidden accept=".pdf,.docx,.txt,.md,.xlsx,.csv" onChange={(event) => void upload(event.target.files?.[0])} /><button className="primary-action" onClick={() => fileInput.current?.click()} disabled={busy}>↑ 上传文档</button><button className="danger-action" onClick={() => void removeKnowledgeBase()} disabled={busy}>删除知识库</button></div></div>
    {notice && <p className="knowledge-notice">{notice}</p>}
    <section className="knowledge-section"><header><div><h3>文档</h3><p>上传 → 文本解析 → 分块 → Embedding → 写入向量库 → 可检索</p></div><small>支持 PDF / DOCX / TXT / MD / XLSX / CSV，单文件最大 20 MB</small></header>
      {detail.documents.length === 0 ? <div className="knowledge-document-empty">暂无文档，点击“上传文档”开始构建知识库。</div> : <div className="knowledge-document-table"><div className="knowledge-document-head"><span>文件名</span><span>类型</span><span>大小</span><span>状态</span><span>上传时间</span><span /></div>{detail.documents.map((document) => <div className="knowledge-document-row" key={document.id}><strong title={document.filename}>{document.filename}</strong><span>{document.fileType}</span><span>{formatSize(document.size)}</span><span className={`document-status ${document.status}`} title={document.error}>{statusLabels[document.status] || document.status}{document.status === "ready" && ` · ${document.chunkCount} 块`}</span><time>{formatTime(document.createdAt)}</time><button onClick={() => void removeDocument(document)} disabled={busy}>删除</button></div>)}</div>}
    </section>
    <div className="knowledge-lower-grid"><section className="knowledge-section"><header><div><h3>检索配置</h3><p>新上传的文档使用当前分块配置。</p></div></header><form className="retrieval-config" key={kb.updatedAt} onSubmit={saveConfig}>
      <label>chunk_size<input name="chunkSize" type="number" min="100" max="4000" defaultValue={config.chunkSize} /></label><label>chunk_overlap<input name="chunkOverlap" type="number" min="0" max="3999" defaultValue={config.chunkOverlap} /></label>
      <label className="span-two">embedding_model<input name="embeddingModel" defaultValue={config.embeddingModel} /></label><label>top_k<input name="topK" type="number" min="1" max="50" defaultValue={config.topK} /></label><label>score_threshold<input name="scoreThreshold" type="number" min="-1" max="1" step="0.01" defaultValue={config.scoreThreshold} /></label>
      <label className="rerank-switch"><input name="rerank" type="checkbox" defaultChecked={config.rerank} /><span>启用 rerank</span></label><label>rerank_model<input name="rerankModel" defaultValue={config.rerankModel} /></label><button className="primary-action" disabled={busy}>保存配置</button>
    </form></section>
    <section className="knowledge-section"><header><div><h3>检索测试</h3><p>返回符合阈值的 top_k 文档分块。</p></div></header><form className="retrieval-test" onSubmit={retrieve}><textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={3} placeholder="输入要检索的问题…" /><button className="primary-action" disabled={busy || !query.trim()}>{busy ? "检索中…" : "开始检索"}</button></form><div className="retrieval-results">{results.map((item) => <article key={item.chunkId}><header><strong>{item.filename}</strong><span>Score {item.score.toFixed(4)}</span></header><small>Chunk #{item.chunkIndex + 1}</small><p>{item.content}</p></article>)}</div>{!busy && query && results.length === 0 && <p className="retrieval-empty">暂无符合阈值的分块。</p>}</section></div>
  </div>;
}

async function jsonOrEmpty(response: Response) { if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "操作失败"); } }
function formatSize(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
