"use client";

import { FormEvent, RefObject, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, formatTime, message, responseJson } from "./knowledge-client";

export type ParserType = "general" | "table" | "qa";
export type Metadata = Record<string, string | number | boolean>;
export type RetrievalConfig = {
  parserType: ParserType; chunkSize: number; chunkOverlap: number; questionColumn: string; answerColumn: string;
  metadataFields: string[]; embeddingModel: string; topK: number; scoreThreshold: number; rerank: boolean; rerankModel: string;
};
export type KnowledgeBaseData = {
  id: string; name: string; description: string; documentCount: number; chunkCount: number; requiresReindex: boolean;
  config: RetrievalConfig; createdAt: string; updatedAt: string;
};
export type KnowledgeDocumentData = {
  id: string; knowledgeBaseId: string; filename: string; fileType: string; size: number; parserType: ParserType; columns: string[];
  status: string; error?: string; chunkCount: number; createdAt: string; updatedAt: string;
};
export type KnowledgeChunkData = {
  id: string; documentId: string; chunkIndex: number; content: string; metadata: Metadata; enabled: boolean;
  characterCount: number; tokenCount: number; updatedAt: string;
};
type DocumentPreview =
  | { kind: "table"; sheets: { name: string; columns: string[]; rows: Metadata[] }[] }
  | { kind: "text"; text: string };
export type KnowledgeDetailData = { knowledgeBase: KnowledgeBaseData; documents: KnowledgeDocumentData[] };
type RetrievalItem = { rank: number; chunkId: string; documentId: string; filename: string; chunkIndex: number; score: number; content: string; metadata: Metadata };
type EmbeddingModel = { id: string; name: string; modelId: string; modelType: string; enabled: boolean };
type Tab = "documents" | "chunks" | "config" | "retrieval";

const statusLabels: Record<string, string> = { uploaded: "已上传", parsing: "解析中", chunking: "分块中", embedding: "向量化中", ready: "可检索", failed: "处理失败" };

export function KnowledgeBaseDetail({ detail, setDetail, busy, setBusy, notice, setNotice, refreshList, back }: {
  detail: KnowledgeDetailData; setDetail: (value: KnowledgeDetailData | null) => void;
  busy: boolean; setBusy: (value: boolean) => void; notice: string; setNotice: (value: string) => void;
  refreshList: () => Promise<void>; back: () => void;
}) {
  const [tab, setTab] = useState<Tab>("documents");
  const [selectedDocumentId, setSelectedDocumentId] = useState(detail.documents[0]?.id || "");
  const [chunks, setChunks] = useState<KnowledgeChunkData[]>([]);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [models, setModels] = useState<EmbeddingModel[]>([]);
  const [query, setQuery] = useState("");
  const [metadataFilter, setMetadataFilter] = useState("");
  const [results, setResults] = useState<RetrievalItem[]>([]);
  const [uploadParser, setUploadParser] = useState<ParserType | "auto">("auto");
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedDocument = detail.documents.find((item) => item.id === selectedDocumentId);
  const columns = useMemo(() => [...new Set(detail.documents.flatMap((document) => document.columns))], [detail.documents]);

  useEffect(() => {
    void apiRequest("/api/models").then(responseJson).then((data) => setModels((data.items || []).filter((item: EmbeddingModel) => item.enabled && item.modelType === "embedding"))).catch(() => setModels([]));
  }, []);

  async function refresh(clearNotice = false) {
    if (clearNotice) setNotice("");
    setDetail(await responseJson(await apiRequest(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}`)));
  }

  async function uploadDocument(file?: File) {
    if (!file) return;
    setBusy(true); setNotice("正在解析、分块、Embedding 并写入向量库…");
    try {
      const isTable = /\.(xlsx|csv)$/i.test(file.name);
      const parserType = uploadParser === "auto" ? (isTable ? "table" : "general") : uploadParser;
      const body = new FormData(); body.append("file", file); body.append("parserType", parserType);
      body.append("questionColumn", detail.knowledgeBase.config.questionColumn); body.append("answerColumn", detail.knowledgeBase.config.answerColumn);
      body.append("metadataFields", JSON.stringify(detail.knowledgeBase.config.metadataFields));
      const data = await responseJson(await apiRequest(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}/documents`, { method: "POST", body }));
      await refresh(); await refreshList();
      setSelectedDocumentId(data.document.id); setNotice(data.document.status === "ready" ? "文档处理完成，可以检索。" : data.document.error || "文档处理失败");
    } catch (error) { setNotice(message(error, "上传文档失败")); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function openChunks(documentId: string, chunkId?: string) {
    setBusy(true); setSelectedDocumentId(documentId); setTab("chunks");
    try {
      const [data, previewData] = await Promise.all([
        responseJson(await apiRequest(`/api/documents/${encodeURIComponent(documentId)}/chunks`)),
        responseJson(await apiRequest(`/api/documents/${encodeURIComponent(documentId)}/preview`)),
      ]);
      setChunks(data.items || []);
      setPreview(previewData.preview || null);
      if (chunkId) window.setTimeout(() => document.getElementById(`chunk-${chunkId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    } catch (error) { setNotice(message(error, "无法读取 Chunk")); }
    finally { setBusy(false); }
  }

  function openTab(value: Tab) {
    if (value === "chunks" && selectedDocumentId) {
      void openChunks(selectedDocumentId);
      return;
    }
    setTab(value);
  }

  async function deleteDocument(document: KnowledgeDocumentData) {
    if (!window.confirm(`删除文档“${document.filename}”及其全部 Chunk？`)) return;
    setBusy(true);
    try {
      await requestEmpty(`/api/documents/${encodeURIComponent(document.id)}`, { method: "DELETE" });
      if (selectedDocumentId === document.id) { setSelectedDocumentId(""); setChunks([]); setPreview(null); }
      await refresh(); await refreshList(); setNotice("文档已删除");
    } catch (error) { setNotice(message(error, "删除文档失败")); }
    finally { setBusy(false); }
  }

  async function deleteKnowledgeBase() {
    if (!window.confirm(`删除知识库“${detail.knowledgeBase.name}”及其全部文档？`)) return;
    setBusy(true);
    try { await requestEmpty(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}`, { method: "DELETE" }); setDetail(null); await refreshList(); }
    catch (error) { setNotice(message(error, "删除知识库失败")); }
    finally { setBusy(false); }
  }

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const config = {
      parserType: String(form.get("parserType")), chunkSize: Number(form.get("chunkSize")), chunkOverlap: Number(form.get("chunkOverlap")),
      questionColumn: String(form.get("questionColumn")), answerColumn: String(form.get("answerColumn")),
      metadataFields: form.getAll("metadataFields").map(String), embeddingModel: String(form.get("embeddingModel")),
      topK: Number(form.get("topK")), scoreThreshold: Number(form.get("scoreThreshold")),
      rerank: form.get("rerank") === "on", rerankModel: String(form.get("rerankModel")),
    };
    setBusy(true);
    try {
      const previousModel = detail.knowledgeBase.config.embeddingModel;
      const data = await responseJson(await apiRequest(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }),
      }));
      await refresh();
      setNotice(data.knowledgeBase.requiresReindex && previousModel !== config.embeddingModel ? "Embedding 模型已切换，已有向量需要重新向量化。" : "知识库配置已保存");
    } catch (error) { setNotice(message(error, "保存配置失败")); }
    finally { setBusy(false); }
  }

  async function reparseDocument() {
    if (!selectedDocument) return;
    setBusy(true); setNotice("正在重新解析文档…");
    try {
      const config = detail.knowledgeBase.config;
      const data = await responseJson(await apiRequest(`/api/documents/${encodeURIComponent(selectedDocument.id)}/reparse`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          parserType: selectedDocument.parserType, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap,
          questionColumn: config.questionColumn, answerColumn: config.answerColumn, metadataFields: config.metadataFields,
        }),
      }));
      await refresh(); await openChunks(selectedDocument.id); setNotice(data.document.status === "ready" ? "文档已重新解析并向量化" : data.document.error || "重新解析失败");
    } catch (error) { setNotice(message(error, "重新解析失败")); }
    finally { setBusy(false); }
  }

  async function saveChunk(chunk: KnowledgeChunkData, content: string, metadataText: string, enabled: boolean) {
    setBusy(true);
    try {
      const metadata = parseMetadataJson(metadataText);
      const data = await responseJson(await apiRequest(`/api/chunks/${encodeURIComponent(chunk.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, metadata, enabled }),
      }));
      setChunks((current) => current.map((item) => item.id === chunk.id ? data.chunk : item)); setNotice("Chunk 已保存并同步向量库");
    } catch (error) { setNotice(message(error, "保存 Chunk 失败")); }
    finally { setBusy(false); }
  }

  async function revectorize() {
    setBusy(true); setNotice("正在重新生成全部向量…");
    try {
      const data = await responseJson(await apiRequest(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}/revectorize`, { method: "POST" }));
      await refresh(); setNotice(`重新向量化完成，共写入 ${data.chunks} 个启用 Chunk`);
    } catch (error) { setNotice(message(error, "重新向量化失败")); }
    finally { setBusy(false); }
  }

  async function retrieve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!query.trim()) return;
    const form = new FormData(event.currentTarget); setBusy(true); setNotice("");
    try {
      const filter = metadataFilter.trim() ? parseMetadataJson(metadataFilter) : {};
      const data = await responseJson(await apiRequest(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}/retrieve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          query, metadataFilter: filter, topK: Number(form.get("topK")), scoreThreshold: Number(form.get("scoreThreshold")),
        }),
      }));
      setResults(data.items || []);
    } catch (error) { setNotice(message(error, "检索失败")); }
    finally { setBusy(false); }
  }

  const kb = detail.knowledgeBase;
  return <div className="module-content knowledge-page">
    <button className="knowledge-back" onClick={back}>← 返回知识库</button>
    <div className="module-heading knowledge-detail-heading"><div><span className="eyebrow">KNOWLEDGE BASE</span><h2>{kb.name}</h2><p>{kb.description || "管理文档、Chunk、解析配置与检索测试。"}</p></div><div>
      <button className="danger-action" onClick={() => void deleteKnowledgeBase()} disabled={busy}>删除知识库</button>
    </div></div>
    {notice && <p className="knowledge-notice">{notice}</p>}
    {kb.requiresReindex && <div className="knowledge-reindex-warning"><span>Embedding 模型已变更，现有向量需要重建。</span><button onClick={() => void revectorize()} disabled={busy}>重新向量化</button></div>}
    <nav className="knowledge-tabs" aria-label="知识库详情">
      {([['documents', '文档'], ['chunks', 'Chunk'], ['config', '配置'], ['retrieval', '检索测试']] as [Tab, string][]).map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => openTab(value)}>{label}</button>)}
    </nav>
    {tab === "documents" && <DocumentsPanel documents={detail.documents} busy={busy} fileInput={fileInput} uploadParser={uploadParser} setUploadParser={setUploadParser} upload={uploadDocument} openChunks={openChunks} remove={deleteDocument} />}
    {tab === "chunks" && <ChunksPanel document={selectedDocument} documents={detail.documents} chunks={chunks} preview={preview} busy={busy} select={openChunks} reparse={reparseDocument} save={saveChunk} />}
    {tab === "config" && <ConfigPanel kb={kb} columns={columns} models={models} busy={busy} save={saveConfig} revectorize={revectorize} />}
    {tab === "retrieval" && <RetrievalPanel config={kb.config} query={query} setQuery={setQuery} metadataFilter={metadataFilter} setMetadataFilter={setMetadataFilter} results={results} busy={busy} retrieve={retrieve} locate={openChunks} />}
  </div>;
}

function DocumentsPanel({ documents, busy, fileInput, uploadParser, setUploadParser, upload, openChunks, remove }: {
  documents: KnowledgeDocumentData[]; busy: boolean; fileInput: RefObject<HTMLInputElement | null>; uploadParser: ParserType | "auto";
  setUploadParser: (value: ParserType | "auto") => void; upload: (file?: File) => Promise<void>; openChunks: (id: string) => Promise<void>; remove: (document: KnowledgeDocumentData) => Promise<void>;
}) {
  return <section className="knowledge-section"><header><div><h3>文档</h3><p>文件 → Parser → Chunk → Metadata → Embedding → Milvus</p></div><div className="knowledge-upload-actions">
    <select value={uploadParser} onChange={(event) => setUploadParser(event.target.value as ParserType | "auto")}><option value="auto">自动（表格推荐 Table）</option><option value="general">General Parser</option><option value="table">Table Parser</option><option value="qa">QA Parser</option></select>
    <input ref={fileInput} type="file" hidden accept=".pdf,.docx,.txt,.md,.xlsx,.csv" onChange={(event) => void upload(event.target.files?.[0])} />
    <button className="primary-action" onClick={() => fileInput.current?.click()} disabled={busy}>↑ 上传文档</button>
  </div></header>
  {documents.length === 0 ? <div className="knowledge-document-empty">暂无文档。XLSX / CSV 默认推荐使用 Table Parser。</div> : <div className="knowledge-document-table">
    <div className="knowledge-document-head"><span>文件名</span><span>类型</span><span>大小</span><span>状态 / Parser</span><span>上传时间</span><span /></div>
    {documents.map((document) => <div className="knowledge-document-row" key={document.id}>
      <button className="document-name" title={document.filename} onClick={() => void openChunks(document.id)}>{document.filename}</button><span>{document.fileType}</span><span>{formatSize(document.size)}</span>
      <span className={`document-status ${document.status}`} title={document.error}>{statusLabels[document.status] || document.status} · {document.parserType} · {document.chunkCount}</span>
      <time>{formatTime(document.createdAt)}</time><button className="document-delete" onClick={() => void remove(document)} disabled={busy}>删除</button>
    </div>)}</div>}
  </section>;
}

function ChunksPanel({ document, documents, chunks, preview, busy, select, reparse, save }: {
  document?: KnowledgeDocumentData; documents: KnowledgeDocumentData[]; chunks: KnowledgeChunkData[]; preview: DocumentPreview | null; busy: boolean;
  select: (id: string) => Promise<void>; reparse: () => Promise<void>;
  save: (chunk: KnowledgeChunkData, content: string, metadata: string, enabled: boolean) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const filtered = chunks.filter((chunk) => `${chunk.content} ${JSON.stringify(chunk.metadata)}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((Math.min(page, pageCount) - 1) * pageSize, Math.min(page, pageCount) * pageSize);
  return <section className="knowledge-section chunk-workspace"><header><div><h3>切片结果</h3><p>查看用于 Embedding 和召回的 Chunk；禁用后不会参与检索。</p></div><div className="knowledge-upload-actions">
    <select value={document?.id || ""} onChange={(event) => { setPage(1); void select(event.target.value); }}><option value="" disabled>选择文档</option>{documents.map((item) => <option key={item.id} value={item.id}>{item.filename}</option>)}</select>
    <button onClick={() => void reparse()} disabled={busy || !document}>重新解析文档</button>
  </div></header>
  {!document ? <div className="knowledge-document-empty">请先选择一个文档。</div> : <div className="chunk-split-layout">
    <DocumentPreviewPanel key={document.id} document={document} preview={preview} />
    <div className="chunk-results-panel">
      <div className="chunk-toolbar"><strong>共 {filtered.length} 条</strong><label>⌕<input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索 Chunk" /></label></div>
      {chunks.length === 0 ? <div className="knowledge-document-empty">该文档暂无 Chunk。</div> : visible.length === 0 ? <div className="knowledge-document-empty">没有匹配的 Chunk。</div> : <div className="chunk-list">
        {visible.map((chunk) => <ChunkEditor key={`${chunk.id}-${chunk.updatedAt}`} chunk={chunk} busy={busy} save={save} />)}
      </div>}
      <footer className="chunk-pagination"><span>第 {Math.min(page, pageCount)} / {pageCount} 页</span><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>上一页</button><button onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={page >= pageCount}>下一页</button></footer>
    </div>
  </div>}</section>;
}

function ChunkEditor({ chunk, busy, save }: { chunk: KnowledgeChunkData; busy: boolean; save: (chunk: KnowledgeChunkData, content: string, metadata: string, enabled: boolean) => Promise<void> }) {
  const [content, setContent] = useState(chunk.content); const [metadata, setMetadata] = useState(JSON.stringify(chunk.metadata, null, 2)); const [enabled, setEnabled] = useState(chunk.enabled);
  const [editing, setEditing] = useState(false);
  async function persist() { await save(chunk, content, metadata, enabled); setEditing(false); }
  return <article id={`chunk-${chunk.id}`} className={`chunk-card ${enabled ? "" : "disabled"}`}><header><div><strong>Chunk #{chunk.chunkIndex + 1}</strong><small>{chunk.characterCount} 字符 · 约 {chunk.tokenCount} tokens</small></div><div className="chunk-card-actions"><button onClick={() => setEditing((value) => !value)}>{editing ? "取消" : "编辑"}</button><label className="chunk-switch"><input type="checkbox" checked={enabled} onChange={(event) => { const next = event.target.checked; setEnabled(next); void save(chunk, content, metadata, next); }} /><span /></label></div></header>
    {editing ? <><label>内容<textarea rows={6} value={content} onChange={(event) => setContent(event.target.value)} /></label><label>Metadata<textarea className="metadata-editor" rows={4} value={metadata} onChange={(event) => setMetadata(event.target.value)} /></label><footer><button className="primary-action" onClick={() => void persist()} disabled={busy}>保存 Chunk</button></footer></> : <><p className="chunk-content">{content}</p><dl className="chunk-metadata">{Object.entries(chunk.metadata).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></>}
  </article>;
}

function DocumentPreviewPanel({ document, preview }: { document: KnowledgeDocumentData; preview: DocumentPreview | null }) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheet = preview?.kind === "table" ? preview.sheets[Math.min(sheetIndex, Math.max(0, preview.sheets.length - 1))] : undefined;
  return <aside className="document-preview-panel"><header><h3>{document.filename}</h3><p>{formatSize(document.size)} · 上传于 {formatTime(document.createdAt)}</p></header><div className="document-preview-body">
    {!preview ? <div className="knowledge-document-empty">正在加载预览…</div> : preview.kind === "text" ? <pre>{preview.text}</pre> : sheet ? <div className="sheet-preview"><table><thead><tr><th>#</th>{sheet.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{sheet.rows.map((row, index) => <tr key={index}><th>{index + 2}</th>{sheet.columns.map((column) => <td key={column}>{String(row[column] ?? "")}</td>)}</tr>)}</tbody></table></div> : <div className="knowledge-document-empty">无可预览内容</div>}
  </div>{preview?.kind === "table" && preview.sheets.length > 0 && <footer className="sheet-tabs">{preview.sheets.map((item, index) => <button key={item.name} className={index === sheetIndex ? "active" : ""} onClick={() => setSheetIndex(index)}>{item.name}</button>)}</footer>}</aside>;
}

function ConfigPanel({ kb, columns, models, busy, save, revectorize }: {
  kb: KnowledgeBaseData; columns: string[]; models: EmbeddingModel[]; busy: boolean; save: (event: FormEvent<HTMLFormElement>) => Promise<void>; revectorize: () => Promise<void>;
}) {
  const config = kb.config;
  return <section className="knowledge-section"><header><div><h3>解析与检索配置</h3><p>Parser、Metadata Fields 与 Embedding 模型统一在此配置。</p></div>{kb.requiresReindex && <button onClick={() => void revectorize()} disabled={busy}>重新向量化</button>}</header>
    <form className="retrieval-config knowledge-config-grid" key={kb.updatedAt} onSubmit={save}>
      <label>Parser<select name="parserType" defaultValue={config.parserType}><option value="general">General</option><option value="table">Table</option><option value="qa">QA</option></select></label>
      <label>Embedding 模型<select name="embeddingModel" required defaultValue={config.embeddingModel}><option value="" disabled>选择已启用的 Embedding 模型</option>{process.env.NODE_ENV !== "production" && <option value="local-hash-embedding-v1">本地 Hash（仅开发/测试）</option>}{models.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.modelId}</option>)}</select></label>
      <label>chunk_size<input name="chunkSize" type="number" min="100" max="4000" defaultValue={config.chunkSize} /></label><label>chunk_overlap<input name="chunkOverlap" type="number" min="0" max="3999" defaultValue={config.chunkOverlap} /></label>
      <label>问题列（QA）<input name="questionColumn" defaultValue={config.questionColumn} /></label><label>答案列（QA）<input name="answerColumn" defaultValue={config.answerColumn} /></label>
      <fieldset className="metadata-fields span-two"><legend>Metadata Fields</legend>{columns.length ? columns.map((column) => <label key={column}><input type="checkbox" name="metadataFields" value={column} defaultChecked={config.metadataFields.includes(column)} /> {column}</label>) : <small>上传表格后，这里会显示可选表头。</small>}</fieldset>
      <label>top_k<input name="topK" type="number" min="1" max="50" defaultValue={config.topK} /></label><label>score_threshold<input name="scoreThreshold" type="number" min="-1" max="1" step="0.01" defaultValue={config.scoreThreshold} /></label>
      <label className="rerank-switch"><input name="rerank" type="checkbox" defaultChecked={config.rerank} /><span>启用轻量 rerank</span></label><label>rerank_model<input name="rerankModel" defaultValue={config.rerankModel} /></label>
      <button className="primary-action" disabled={busy}>保存配置</button>
    </form>
  </section>;
}

function RetrievalPanel({ config, query, setQuery, metadataFilter, setMetadataFilter, results, busy, retrieve, locate }: {
  config: RetrievalConfig; query: string; setQuery: (value: string) => void; metadataFilter: string; setMetadataFilter: (value: string) => void;
  results: RetrievalItem[]; busy: boolean; retrieve: (event: FormEvent<HTMLFormElement>) => Promise<void>; locate: (documentId: string, chunkId?: string) => Promise<void>;
}) {
  return <section className="knowledge-section"><header><div><h3>检索测试</h3><p>仅验证 Query → Embedding → Milvus Retrieval，不调用 LLM 生成答案。</p></div></header>
    <form className="retrieval-test retrieval-test-grid" onSubmit={retrieve}>
      <label className="span-two">Query<textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={3} placeholder="例如：好会计怎么删除凭证" /></label>
      <label className="span-two">Metadata Filter（JSON，多个条件默认 AND）<textarea value={metadataFilter} onChange={(event) => setMetadataFilter(event.target.value)} rows={2} placeholder={'{"产品":"好会计","模块":"凭证"}'} /></label>
      <label>TopK<input name="topK" type="number" min="1" max="50" defaultValue={config.topK} /></label><label>Score Threshold<input name="scoreThreshold" type="number" min="-1" max="1" step="0.01" defaultValue={config.scoreThreshold} /></label>
      <button className="primary-action" disabled={busy || !query.trim()}>{busy ? "检索中…" : "开始检索"}</button>
    </form>
    <div className="retrieval-results">{results.map((item) => <article key={item.chunkId}>
      <header><strong>#{item.rank} · Score {item.score.toFixed(4)}</strong><button onClick={() => void locate(item.documentId, item.chunkId)}>定位 Chunk</button></header>
      <small>来源：{item.filename} · Chunk #{item.chunkIndex + 1} · {item.chunkId}</small><p>{item.content}</p>
      <dl>{Object.entries(item.metadata).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
    </article>)}</div>
    {!busy && query && results.length === 0 && <p className="retrieval-empty">暂无符合阈值的 Chunk。</p>}
  </section>;
}

function parseMetadataJson(value: string): Metadata {
  const parsed = JSON.parse(value || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Metadata 必须是 JSON 对象");
  const entries = Object.entries(parsed);
  if (entries.some(([, item]) => !["string", "number", "boolean"].includes(typeof item))) throw new Error("Metadata 值仅支持字符串、数字或布尔值");
  return Object.fromEntries(entries) as Metadata;
}
async function requestEmpty(path: string, init: RequestInit) { const response = await apiRequest(path, init); if (!response.ok) await responseJson(response); }
function formatSize(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
