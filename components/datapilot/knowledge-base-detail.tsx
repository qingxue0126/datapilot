"use client";

import { FormEvent, RefObject, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, formatTime, message, responseJson } from "./knowledge-client";
import { ConfirmDialog } from "./confirm-dialog";
import { generateUUID } from "./generate-uuid";

export type ParserType = "general" | "table" | "qa";
export type Metadata = Record<string, string | number | boolean>;
export type ColumnAttributes = { content: boolean; embedding: boolean; metadata: boolean };
export type RetrievalConfig = {
  language: "zh-CN" | "en";
  parserType: ParserType; chunkStrategy: "fixed" | "paragraph" | "heading" | "table-row" | "qa-pair"; chunkSize: number; chunkOverlap: number; questionColumn: string; answerColumn: string;
  metadataFields: string[]; columnMode: "auto" | "manual"; columnRoles: Record<string, ColumnAttributes>; embeddingModel: string;
  indexType: "HNSW"; metricType: "COSINE" | "IP" | "L2"; hnswM: number; hnswEfConstruction: number;
  topK: number; scoreThreshold: number; rerank: boolean; rerankModel: string;
};
export type KnowledgeBaseData = {
  id: string; name: string; description: string; documentCount: number; chunkCount: number; requiresReindex: boolean;
  permission: "private" | "tenant" | "team"; isOwner: boolean; config: RetrievalConfig; createdAt: string; updatedAt: string;
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
type ManagedModel = { id: string; name: string; modelId: string; modelType: string; enabled: boolean };
type MetadataFacet = { field: string; types: string[]; values: (string | number | boolean)[] };
type MetadataFilterRow = { id: string; field: string; value: string };
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
  const [models, setModels] = useState<ManagedModel[]>([]);
  const [query, setQuery] = useState("");
  const [metadataFacets, setMetadataFacets] = useState<MetadataFacet[]>([]);
  const [metadataFilters, setMetadataFilters] = useState<MetadataFilterRow[]>([]);
  const [retrievalMode, setRetrievalMode] = useState<"vector" | "hybrid">("vector");
  const [rerankEnabled, setRerankEnabled] = useState(false);
  const [results, setResults] = useState<RetrievalItem[]>([]);
  const [pendingDelete, setPendingDelete] = useState<{ type: "knowledge-base" } | { type: "document"; document: KnowledgeDocumentData } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedDocument = detail.documents.find((item) => item.id === selectedDocumentId);
  const columns = useMemo(() => [...new Set(detail.documents.flatMap((document) => document.columns))], [detail.documents]);

  useEffect(() => {
    void Promise.all([
      apiRequest("/api/models").then(responseJson),
      apiRequest(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}/metadata-schema`).then(responseJson),
    ]).then(([modelData, metadataData]) => {
      setModels((modelData.items || []).filter((item: ManagedModel) => item.enabled));
      setMetadataFacets(metadataData.items || []);
    }).catch(() => { setModels([]); setMetadataFacets([]); });
  }, [detail.knowledgeBase.id]);

  async function refresh(clearNotice = false) {
    if (clearNotice) setNotice("");
    setDetail(await responseJson(await apiRequest(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}`)));
  }

  async function uploadDocument(file?: File) {
    if (!file) return;
    setBusy(true); setNotice("正在解析、分块、Embedding 并写入向量库…");
    try {
      const isTable = /\.(xlsx|csv)$/i.test(file.name);
      const configuredParser = detail.knowledgeBase.config.parserType;
      const parserType = isTable ? (configuredParser === "general" ? "table" : configuredParser) : "general";
      const body = new FormData(); body.append("file", file); body.append("parserType", parserType);
      body.append("chunkStrategy", detail.knowledgeBase.config.chunkStrategy);
      body.append("questionColumn", detail.knowledgeBase.config.questionColumn); body.append("answerColumn", detail.knowledgeBase.config.answerColumn);
      body.append("metadataFields", JSON.stringify(detail.knowledgeBase.config.metadataFields));
      body.append("columnMode", detail.knowledgeBase.config.columnMode);
      body.append("columnRoles", JSON.stringify(detail.knowledgeBase.config.columnRoles || {}));
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
    setBusy(true);
    try {
      await requestEmpty(`/api/documents/${encodeURIComponent(document.id)}`, { method: "DELETE" });
      if (selectedDocumentId === document.id) { setSelectedDocumentId(""); setChunks([]); setPreview(null); }
      await refresh(); await refreshList(); setNotice("文档已删除");
    } catch (error) { setNotice(message(error, "删除文档失败")); }
    finally { setBusy(false); }
  }

  async function deleteKnowledgeBase() {
    setBusy(true);
    try { await requestEmpty(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}`, { method: "DELETE" }); setDetail(null); await refreshList(); }
    catch (error) { setNotice(message(error, "删除知识库失败")); }
    finally { setBusy(false); }
  }

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const columnMode = String(form.get("columnMode") || "auto");
    const columnRoles = columnMode === "manual" ? Object.fromEntries(columns.map((column) => [column, {
      content: form.has(`columnContent:${column}`),
      embedding: form.has(`columnEmbedding:${column}`),
      metadata: form.has(`columnMetadata:${column}`),
    }])) : {};
    const metadataFields = columnMode === "manual" ? Object.entries(columnRoles).filter(([, attributes]) => attributes.metadata).map(([column]) => column) : [];
    const chunkSizeValue = form.get("chunkSize");
    const chunkOverlapValue = form.get("chunkOverlap");
    const config = {
      language: String(form.get("language")) as RetrievalConfig["language"],
      parserType: String(form.get("parserType")), chunkStrategy: String(form.get("chunkStrategy")),
      chunkSize: chunkSizeValue === null ? detail.knowledgeBase.config.chunkSize : Number(chunkSizeValue),
      chunkOverlap: chunkOverlapValue === null ? detail.knowledgeBase.config.chunkOverlap : Number(chunkOverlapValue),
      questionColumn: form.get("questionColumn") === null ? detail.knowledgeBase.config.questionColumn : String(form.get("questionColumn")),
      answerColumn: form.get("answerColumn") === null ? detail.knowledgeBase.config.answerColumn : String(form.get("answerColumn")),
      metadataFields, columnMode, columnRoles, embeddingModel: String(form.get("embeddingModel")),
      indexType: String(form.get("indexType")), metricType: String(form.get("metricType")),
      hnswM: Number(form.get("hnswM")), hnswEfConstruction: Number(form.get("hnswEfConstruction")),
      topK: detail.knowledgeBase.config.topK, scoreThreshold: detail.knowledgeBase.config.scoreThreshold,
      rerank: detail.knowledgeBase.config.rerank, rerankModel: detail.knowledgeBase.config.rerankModel,
    };
    setBusy(true);
    try {
      const previous = detail.knowledgeBase.config;
      const data = await responseJson(await apiRequest(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: String(form.get("name") || kb.name), description: String(form.get("description") || ""), permission: String(form.get("permission") || "private"), config }),
      }));
      await refresh();
      const vectorChanged = previous.embeddingModel !== config.embeddingModel || previous.metricType !== config.metricType
        || previous.hnswM !== config.hnswM || previous.hnswEfConstruction !== config.hnswEfConstruction;
      setNotice(data.knowledgeBase.requiresReindex && vectorChanged ? "向量或索引配置已变更，请重新向量化以重建索引。" : "知识库配置已保存");
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
          parserType: config.parserType, chunkStrategy: config.chunkStrategy, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap,
          questionColumn: config.questionColumn, answerColumn: config.answerColumn, metadataFields: config.metadataFields,
          columnMode: config.columnMode, columnRoles: config.columnRoles,
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
      const filter = Object.fromEntries(metadataFilters.filter((item) => item.field && item.value !== "").map((item) => {
        const facet = metadataFacets.find((candidate) => candidate.field === item.field);
        const type = facet?.types[0];
        const value: string | number | boolean = type === "number" ? Number(item.value) : type === "boolean" ? item.value === "true" : item.value;
        return [item.field, value];
      }));
      const data = await responseJson(await apiRequest(`/api/knowledge-bases/${encodeURIComponent(detail.knowledgeBase.id)}/retrieve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          query, metadataFilter: filter, topK: Number(form.get("topK")), scoreThreshold: Number(form.get("scoreThreshold")),
          retrievalMode, vectorWeight: Number(form.get("vectorWeight") || 0.7), candidateCount: Number(form.get("candidateCount") || 15),
          rerank: rerankEnabled, rerankModel: String(form.get("rerankModel") || ""), rerankTopK: Number(form.get("rerankTopK") || form.get("topK")),
        }),
      }));
      setResults(data.items || []);
    } catch (error) { setNotice(message(error, "检索失败")); }
    finally { setBusy(false); }
  }

  const kb = detail.knowledgeBase;
  if (tab === "chunks") return <div className="module-content knowledge-page chunk-page">
    <button className="knowledge-back chunk-page-back" onClick={() => setTab("documents")}>← 返回</button>
    {notice && <p className="knowledge-notice">{notice}</p>}
    {kb.requiresReindex && <div className="knowledge-reindex-warning"><span>向量或索引配置已变更，现有向量索引需要重建。</span><button onClick={() => void revectorize()} disabled={busy}>重新向量化</button></div>}
    <ChunksPanel key={selectedDocumentId || "empty"} document={selectedDocument} documents={detail.documents} chunks={chunks} preview={preview} busy={busy} select={openChunks} reparse={reparseDocument} save={saveChunk} />
  </div>;
  return <div className="module-content knowledge-page">
    <button className="knowledge-back" onClick={back}>← 返回知识库</button>
    <div className="module-heading knowledge-detail-heading"><div><span className="eyebrow">KNOWLEDGE BASE</span><h2>{kb.name}</h2><p>{kb.description || "管理文档、Chunk、解析配置与检索测试。"}</p></div><div>
      <button className="danger-action" onClick={() => setPendingDelete({ type: "knowledge-base" })} disabled={busy}>删除知识库</button>
    </div></div>
    {notice && <p className="knowledge-notice">{notice}</p>}
    {kb.requiresReindex && <div className="knowledge-reindex-warning"><span>向量或索引配置已变更，现有向量索引需要重建。</span><button onClick={() => void revectorize()} disabled={busy}>重新向量化</button></div>}
    <nav className="knowledge-tabs" aria-label="知识库详情">
      {([['documents', '文件列表'], ['chunks', '分块结果'], ['config', '配置'], ['retrieval', '检索测试']] as [Tab, string][]).map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => openTab(value)}>{label}</button>)}
    </nav>
    {tab === "documents" && <DocumentsPanel documents={detail.documents} metadataFields={kb.config.columnMode === "auto" ? columns : kb.config.metadataFields} busy={busy} fileInput={fileInput} upload={uploadDocument} openChunks={openChunks} remove={(document) => setPendingDelete({ type: "document", document })} />}
    {tab === "config" && <ConfigPanel kb={kb} columns={columns} models={models.filter((model) => model.modelType === "embedding")} busy={busy} save={saveConfig} revectorize={revectorize} />}
    {tab === "retrieval" && <RetrievalPanel config={kb.config} query={query} setQuery={setQuery} metadataFacets={metadataFacets} metadataFilters={metadataFilters} setMetadataFilters={setMetadataFilters} retrievalMode={retrievalMode} setRetrievalMode={setRetrievalMode} rerankEnabled={rerankEnabled} setRerankEnabled={setRerankEnabled} rerankModels={models.filter((model) => model.modelType === "rerank")} results={results} busy={busy} retrieve={retrieve} locate={openChunks} />}
    {pendingDelete && <ConfirmDialog
      title={pendingDelete.type === "knowledge-base" ? "删除知识库" : "删除文件"}
      message={pendingDelete.type === "knowledge-base" ? `确认删除知识库“${kb.name}”及其全部文档？` : `确认删除文件“${pendingDelete.document.filename}”及其全部 Chunk？`}
      busy={busy}
      close={() => setPendingDelete(null)}
      confirm={async () => { const target = pendingDelete; setPendingDelete(null); if (target.type === "knowledge-base") await deleteKnowledgeBase(); else await deleteDocument(target.document); }}
    />}
  </div>;
}

function DocumentsPanel({ documents, metadataFields, busy, fileInput, upload, openChunks, remove }: {
  documents: KnowledgeDocumentData[]; metadataFields: string[]; busy: boolean; fileInput: RefObject<HTMLInputElement | null>;
  upload: (file?: File) => Promise<void>; openChunks: (id: string) => Promise<void>; remove: (document: KnowledgeDocumentData) => void;
}) {
  return <section className="knowledge-section"><header><div><h3>文件列表</h3><p>文件 → Parser → Chunk → Metadata → Embedding → Milvus</p></div><div className="knowledge-upload-actions">
    <input ref={fileInput} type="file" hidden accept=".pdf,.docx,.txt,.md,.xlsx,.csv" onChange={(event) => void upload(event.target.files?.[0])} />
    <button className="primary-action" onClick={() => fileInput.current?.click()} disabled={busy}>＋ 新增文件</button>
  </div></header>
  {documents.length === 0 ? <div className="knowledge-document-empty">暂无文档。XLSX / CSV 默认推荐使用 Table Parser。</div> : <div className="knowledge-document-table">
    <div className="knowledge-document-head"><span>文件名</span><span>类型</span><span>大小</span><span>上传时间</span><span>元数据</span><span>解析</span><span>分块数</span><span>操作</span></div>
    {documents.map((document) => <div className="knowledge-document-row" key={document.id}>
      <button className="document-name" title={document.filename} onClick={() => void openChunks(document.id)}>{document.filename}</button><span>{document.fileType}</span><span>{formatSize(document.size)}</span>
      <time>{formatTime(document.createdAt)}</time><span className="document-metadata" title={metadataFields.join("、")}>{metadataFields.length ? metadataFields.join("、") : "—"}</span>
      <span className={`document-status ${document.status}`} title={document.error || statusLabels[document.status]}>{document.parserType}</span><strong>{document.chunkCount}</strong>
      <button className="document-delete" onClick={() => remove(document)} disabled={busy}>删除</button>
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
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const pageSize = 50;
  const filtered = chunks.filter((chunk) => (!enabledOnly || chunk.enabled) && `${chunk.content} ${JSON.stringify(chunk.metadata)}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((Math.min(page, pageCount) - 1) * pageSize, Math.min(page, pageCount) * pageSize);
  const currentPageSelected = visible.length > 0 && visible.every((chunk) => selectedIds.has(chunk.id));
  function toggleCurrentPage(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const chunk of visible) {
        if (checked) next.add(chunk.id); else next.delete(chunk.id);
      }
      return next;
    });
  }
  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }
  return <section className="knowledge-section chunk-workspace"><header><div><h3>切片结果</h3><p>查看用于 Embedding 和召回的 Chunk；禁用后不会参与检索。</p></div><div className="knowledge-upload-actions">
    <select value={document?.id || ""} onChange={(event) => { setPage(1); void select(event.target.value); }}><option value="" disabled>选择文档</option>{documents.map((item) => <option key={item.id} value={item.id}>{item.filename}</option>)}</select>
    <button onClick={() => void reparse()} disabled={busy || !document}>重新解析文档</button>
  </div></header>
  {!document ? <div className="knowledge-document-empty">请先选择一个文档。</div> : <div className="chunk-split-layout">
    <DocumentPreviewPanel key={document.id} document={document} preview={preview} />
    <div className="chunk-results-panel">
      <div className="chunk-toolbar"><div className="chunk-view-modes"><button className="active">全文</button><button disabled title="当前解析器未生成摘要切片">摘要</button></div><div className="chunk-toolbar-actions"><button className={enabledOnly ? "active" : ""} onClick={() => { setEnabledOnly((value) => !value); setPage(1); }} title="仅显示已启用的 Chunk">▽</button><label>⌕<input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索" /></label><button disabled title="新增 Chunk 接口暂未开放">＋</button></div><label className="chunk-select-page"><input type="checkbox" checked={currentPageSelected} onChange={(event) => toggleCurrentPage(event.target.checked)} />选择当前页</label></div>
      {chunks.length === 0 ? <div className="knowledge-document-empty">该文档暂无 Chunk。</div> : visible.length === 0 ? <div className="knowledge-document-empty">没有匹配的 Chunk。</div> : <div className="chunk-list">
        {visible.map((chunk) => <ChunkEditor key={`${chunk.id}-${chunk.updatedAt}`} chunk={chunk} selected={selectedIds.has(chunk.id)} toggleSelected={(checked) => toggleOne(chunk.id, checked)} busy={busy} save={save} />)}
      </div>}
      <footer className="chunk-pagination"><span>总共 {filtered.length} 条</span><button aria-label="上一页" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>‹</button>{Array.from({ length: Math.min(pageCount, 5) }, (_, index) => index + 1).map((number) => <button key={number} className={number === Math.min(page, pageCount) ? "active" : ""} onClick={() => setPage(number)}>{number}</button>)}<button aria-label="下一页" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={page >= pageCount}>›</button><small>{pageSize}条/页</small></footer>
    </div>
  </div>}</section>;
}

function ChunkEditor({ chunk, selected, toggleSelected, busy, save }: { chunk: KnowledgeChunkData; selected: boolean; toggleSelected: (checked: boolean) => void; busy: boolean; save: (chunk: KnowledgeChunkData, content: string, metadata: string, enabled: boolean) => Promise<void> }) {
  const [content, setContent] = useState(chunk.content); const [metadata, setMetadata] = useState(JSON.stringify(chunk.metadata, null, 2)); const [enabled, setEnabled] = useState(chunk.enabled);
  const [editing, setEditing] = useState(false);
  async function persist() { await save(chunk, content, metadata, enabled); setEditing(false); }
  return <article id={`chunk-${chunk.id}`} className={`chunk-card ${enabled ? "" : "disabled"}`}><span className="chunk-type-badge">Text</span><header><label className="chunk-row-selector"><input type="checkbox" checked={selected} onChange={(event) => toggleSelected(event.target.checked)} /></label><div><strong>Chunk #{chunk.chunkIndex + 1}</strong><small>{chunk.characterCount} 字符 · 约 {chunk.tokenCount} tokens</small></div><div className="chunk-card-actions"><button onClick={() => setEditing((value) => !value)}>{editing ? "取消" : "编辑"}</button><label className="chunk-switch"><input type="checkbox" checked={enabled} onChange={(event) => { const next = event.target.checked; setEnabled(next); void save(chunk, content, metadata, next); }} /><span /></label></div></header>
    {editing ? <><label>内容<textarea rows={6} value={content} onChange={(event) => setContent(event.target.value)} /></label><label>Metadata<textarea className="metadata-editor" rows={4} value={metadata} onChange={(event) => setMetadata(event.target.value)} /></label><footer><button className="primary-action" onClick={() => void persist()} disabled={busy}>保存 Chunk</button></footer></> : <><p className="chunk-content">{content}</p><dl className="chunk-metadata">{Object.entries(chunk.metadata).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></>}
  </article>;
}

function DocumentPreviewPanel({ document, preview }: { document: KnowledgeDocumentData; preview: DocumentPreview | null }) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheet = preview?.kind === "table" ? preview.sheets[Math.min(sheetIndex, Math.max(0, preview.sheets.length - 1))] : undefined;
  return <aside className="document-preview-panel"><header><div><h3>{document.filename}</h3><p>{formatSize(document.size)} · 上传于 {formatTime(document.createdAt)}</p></div><div className="preview-modes"><button className="active">▧ 预览</button><button disabled>Artifact</button></div></header><div className="document-preview-body">
    {!preview ? <div className="knowledge-document-empty">正在加载预览…</div> : preview.kind === "text" ? <pre>{preview.text}</pre> : sheet ? <div className="sheet-preview"><table><thead><tr><th>#</th>{sheet.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{sheet.rows.map((row, index) => <tr key={index}><th>{index + 2}</th>{sheet.columns.map((column) => <td key={column}>{String(row[column] ?? "")}</td>)}</tr>)}</tbody></table></div> : <div className="knowledge-document-empty">无可预览内容</div>}
  </div>{preview?.kind === "table" && preview.sheets.length > 0 && <footer className="sheet-tabs">{preview.sheets.map((item, index) => <button key={item.name} className={index === sheetIndex ? "active" : ""} onClick={() => setSheetIndex(index)}>{item.name}</button>)}</footer>}</aside>;
}

function normalizeColumnAttributes(value: unknown, metadataFallback = false): ColumnAttributes {
  if (value === "index") return { content: true, embedding: true, metadata: metadataFallback };
  if (value === "metadata") return { content: false, embedding: false, metadata: true };
  if (value === "both") return { content: true, embedding: true, metadata: true };
  if (value === "ignore") return { content: false, embedding: false, metadata: false };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const attributes = value as Partial<ColumnAttributes>;
    return { content: attributes.content === true, embedding: attributes.embedding === true, metadata: attributes.metadata === true || metadataFallback };
  }
  return { content: true, embedding: true, metadata: metadataFallback };
}

function inferColumnAttributes(column: string): ColumnAttributes {
  const normalized = column.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (/^(id|uuid|序号|行号|编号|主键)$/.test(normalized) || /^(?:[a-z\u4e00-\u9fff][a-z0-9\u4e00-\u9fff]*)id$/.test(normalized) || /(?:^|业务|记录)(?:id|编号)$/.test(normalized)) return { content: false, embedding: false, metadata: false };
  if (/(product|module|category|classification|questiontype|problemtype|产品|模块|分类|类别|类型)/.test(normalized)) return { content: false, embedding: false, metadata: true };
  if (/(question|answer|description|content|text|title|问题|答案|描述|内容|正文|标题)/.test(normalized)) return { content: true, embedding: true, metadata: false };
  return { content: true, embedding: true, metadata: true };
}

function ColumnAttributeRow({ column, initial, disabled }: { column: string; initial: ColumnAttributes; disabled: boolean }) {
  const [attributes, setAttributes] = useState(initial);
  const set = (key: keyof ColumnAttributes, value: boolean) => setAttributes((current) => ({ ...current, [key]: value }));
  const ignored = !attributes.content && !attributes.embedding && !attributes.metadata;
  return <div className="column-role-row"><strong>{column}</strong>
    <label><input type="checkbox" name={`columnContent:${column}`} checked={attributes.content} disabled={disabled} onChange={(event) => set("content", event.target.checked)} /><span>Content</span></label>
    <label><input type="checkbox" name={`columnEmbedding:${column}`} checked={attributes.embedding} disabled={disabled} onChange={(event) => set("embedding", event.target.checked)} /><span>Embedding</span></label>
    <label><input type="checkbox" name={`columnMetadata:${column}`} checked={attributes.metadata} disabled={disabled} onChange={(event) => set("metadata", event.target.checked)} /><span>Metadata</span></label>
    <span className={ignored ? "column-ignore active" : "column-ignore"}>{ignored ? "Ignore" : "Enabled"}</span>
  </div>;
}

function ConfigPanel({ kb, columns, models, busy, save, revectorize }: {
  kb: KnowledgeBaseData; columns: string[]; models: ManagedModel[]; busy: boolean; save: (event: FormEvent<HTMLFormElement>) => Promise<void>; revectorize: () => Promise<void>;
}) {
  const config = kb.config;
  const [columnMode, setColumnMode] = useState(config.columnMode || (Object.keys(config.columnRoles || {}).length ? "manual" : "auto"));
  const [parserType, setParserType] = useState<ParserType>(config.parserType);
  const [chunkStrategy, setChunkStrategy] = useState(config.chunkStrategy);
  function selectParser(next: ParserType) {
    setParserType(next);
    setChunkStrategy(next === "table" ? "table-row" : next === "qa" ? "qa-pair" : ["fixed", "paragraph", "heading"].includes(chunkStrategy) ? chunkStrategy : "fixed");
  }
  return <form className="knowledge-settings" key={kb.updatedAt} onSubmit={save}>
    <section className="knowledge-settings-block"><header><h3>基本信息</h3><p>管理知识库名称、语言、描述与团队可见范围。</p></header><div className="knowledge-settings-fields">
      <label><span><b>*</b> 名称</span><input name="name" required maxLength={80} defaultValue={kb.name} /></label>
      <label><span>语言</span><select name="language" defaultValue={config.language}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
      <label><span>描述</span><textarea name="description" rows={3} maxLength={500} defaultValue={kb.description} placeholder="请输入知识库描述" /></label>
      <label><span>共享范围</span><select name="permission" defaultValue={kb.permission}><option value="private">仅自己</option><option value="tenant">组织内</option></select></label>
    </div></section>

    <section className="knowledge-settings-block"><header><h3>解析</h3><p>选择文档解析器。Table 和 QA 会自动识别工作表表头与业务行。</p></header><div className="knowledge-settings-fields">
      <label><span>Parser Type</span><select name="parserType" value={parserType} onChange={(event) => selectParser(event.target.value as ParserType)}><option value="general">General</option><option value="table">Table</option><option value="qa">QA</option></select></label>
      {parserType === "qa" && <div className="knowledge-setting-pair"><label><span>问题列</span><input name="questionColumn" defaultValue={config.questionColumn} /></label><label><span>答案列</span><input name="answerColumn" defaultValue={config.answerColumn} /></label></div>}
      {(parserType === "table" || parserType === "qa") && <p className="knowledge-setting-note">上传 XLSX / CSV 后自动读取 Sheet、表头和行；字段属性在下方“元数据”区设置。</p>}
    </div></section>

    <section className="knowledge-settings-block"><header><h3>分块</h3><p>General 可按固定长度或段落分块；Table 和 QA 默认按一行业务记录分块。</p></header><div className="knowledge-settings-fields">
      <label><span>Chunk Strategy</span><select name="chunkStrategy" value={chunkStrategy} onChange={(event) => setChunkStrategy(event.target.value as RetrievalConfig["chunkStrategy"])}>
        {parserType === "general" ? <><option value="fixed">Fixed</option><option value="paragraph">Paragraph</option><option value="heading" disabled>Heading（预留）</option></> : parserType === "table" ? <option value="table-row">Table Row</option> : <option value="qa-pair">QA Pair</option>}
      </select></label>
      {parserType === "general" && (chunkStrategy === "fixed" || chunkStrategy === "paragraph") && <div className="knowledge-setting-pair"><label><span>Chunk Size</span><input name="chunkSize" type="number" min="100" max="4000" defaultValue={config.chunkSize} /></label>{chunkStrategy === "fixed" && <label><span>Chunk Overlap</span><input name="chunkOverlap" type="number" min="0" max="3999" defaultValue={config.chunkOverlap} /></label>}</div>}
      {(parserType === "table" || parserType === "qa") && <p className="knowledge-setting-note">{parserType === "table" ? "每行业务数据生成一个 Chunk，不使用 Chunk Size / Overlap。" : "每组问题和答案生成一个 Chunk，不使用 Chunk Size / Overlap。"}</p>}
    </div></section>

    <section className="knowledge-settings-block"><header><h3>元数据</h3><p>为每个表格字段独立配置 Content、Embedding 和 Metadata 属性。</p></header><div className="knowledge-settings-fields">
      <fieldset className="column-role-settings standalone"><legend>Column Mode / Field Attributes</legend><div className="column-mode"><label><input type="radio" name="columnMode" value="auto" checked={columnMode === "auto"} onChange={() => setColumnMode("auto")} /> Auto</label><label><input type="radio" name="columnMode" value="manual" checked={columnMode === "manual"} onChange={() => setColumnMode("manual")} /> Manual</label></div>
        <p className="column-mode-description">{columnMode === "auto" ? "Auto 按表头语义推断：问题/答案类字段用于正文和向量，产品/模块类字段用于过滤，ID 类字段默认忽略。" : "Content 决定最终返回正文；Embedding 决定向量化文本；Metadata 用于 filters。三项全关闭即为 Ignore。已有文档需要重新解析。"}</p>
        {columns.length ? <div className="column-role-list"><div className="column-role-header"><span>Field</span><span>Content</span><span>Embedding</span><span>Metadata</span><span>Status</span></div>{columns.map((column) => {
          const attributes = columnMode === "auto" ? inferColumnAttributes(column) : normalizeColumnAttributes(config.columnRoles?.[column], config.metadataFields.includes(column));
          return <ColumnAttributeRow key={`${columnMode}-${column}`} column={column} initial={attributes} disabled={columnMode === "auto"} />;
        })}</div> : <small>上传 XLSX / CSV 后，这里会显示表头字段。</small>}
      </fieldset>
    </div></section>

    <section className="knowledge-settings-block"><header><div><h3>嵌入</h3><p>仅显示模型管理中已启用的 Embedding 模型；向量维度由模型响应自动确定。</p></div>{kb.requiresReindex && <button type="button" onClick={() => void revectorize()} disabled={busy}>重新向量化</button>}</header><div className="knowledge-settings-fields">
      <label><span><b>*</b> Embedding Model</span><select name="embeddingModel" required defaultValue={config.embeddingModel}><option value="" disabled>选择已启用的 Embedding 模型</option>{process.env.NODE_ENV !== "production" && <option value="local-hash-embedding-v1">本地 Hash（仅开发/测试）</option>}{models.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.modelId}</option>)}</select></label>
      <label><span>向量维度</span><input value="自动（由 Embedding 模型决定）" readOnly aria-readonly="true" /></label>
    </div></section>

    <section className="knowledge-settings-block"><header><h3>索引</h3><p>配置当前知识库的 Milvus 向量索引；变更后需要重新向量化并重建索引。</p></header><div className="knowledge-settings-fields">
      <label><span>Index Type</span><select name="indexType" defaultValue={config.indexType}><option value="HNSW">HNSW</option></select></label>
      <label><span>Metric Type</span><select name="metricType" defaultValue={config.metricType}><option value="COSINE">COSINE</option><option value="IP">IP</option><option value="L2">L2</option></select></label>
      <details className="knowledge-index-advanced"><summary>高级参数</summary><div className="knowledge-setting-pair"><label><span>M</span><input name="hnswM" type="number" min="4" max="64" defaultValue={config.hnswM} /></label><label><span>efConstruction</span><input name="hnswEfConstruction" type="number" min="8" max="512" defaultValue={config.hnswEfConstruction} /></label></div></details>
    </div></section>
    <footer className="knowledge-settings-actions"><button className="primary-action" disabled={busy}>{busy ? "保存中…" : "保存配置"}</button></footer>
  </form>;
}

function RetrievalPanel({ config, query, setQuery, metadataFacets, metadataFilters, setMetadataFilters, retrievalMode, setRetrievalMode, rerankEnabled, setRerankEnabled, rerankModels, results, busy, retrieve, locate }: {
  config: RetrievalConfig; query: string; setQuery: (value: string) => void; metadataFacets: MetadataFacet[]; metadataFilters: MetadataFilterRow[]; setMetadataFilters: (value: MetadataFilterRow[]) => void;
  retrievalMode: "vector" | "hybrid"; setRetrievalMode: (value: "vector" | "hybrid") => void; rerankEnabled: boolean; setRerankEnabled: (value: boolean) => void; rerankModels: ManagedModel[];
  results: RetrievalItem[]; busy: boolean; retrieve: (event: FormEvent<HTMLFormElement>) => Promise<void>; locate: (documentId: string, chunkId?: string) => Promise<void>;
}) {
  const [vectorWeight, setVectorWeight] = useState(0.7);
  const [candidateCount, setCandidateCount] = useState(Math.max(config.topK * 3, 15));
  const [rerankTopK, setRerankTopK] = useState(config.topK);
  const updateFilter = (id: string, patch: Partial<MetadataFilterRow>) => setMetadataFilters(metadataFilters.map((item) => item.id === id ? { ...item, ...patch } : item));
  return <section className="knowledge-section retrieval-workbench"><header><div><h3>检索测试</h3><p>元数据过滤 → 向量/混合检索 → 可选重排 → TopK，不调用 LLM 生成答案。</p></div></header>
    <div className="retrieval-workbench-grid">
      <form className="retrieval-settings" onSubmit={retrieve}>
        <h4>测试设置</h4>
        <label>Query<textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={4} placeholder="例如：好会计怎么删除凭证" /></label>
        <fieldset><legend>检索方式</legend><div className="retrieval-segmented"><button type="button" className={retrievalMode === "vector" ? "active" : ""} onClick={() => setRetrievalMode("vector")}>向量检索</button><button type="button" className={retrievalMode === "hybrid" ? "active" : ""} onClick={() => setRetrievalMode("hybrid")}>混合检索</button></div></fieldset>
        {retrievalMode === "hybrid" && <label>向量相似度权重 <span className="retrieval-value">向量 {vectorWeight.toFixed(2)} / 关键词 {(1 - vectorWeight).toFixed(2)}</span><input name="vectorWeight" type="range" min="0" max="1" step="0.05" value={vectorWeight} onChange={(event) => setVectorWeight(Number(event.target.value))} /></label>}
        <div className="retrieval-pair"><label>相似度阈值<input name="scoreThreshold" type="number" min="-1" max="1" step="0.01" defaultValue={config.scoreThreshold} /></label><label>TopK<input name="topK" type="number" min="1" max="50" defaultValue={config.topK} /></label></div>
        <fieldset className="metadata-filter-builder"><legend>元数据过滤 <small>多个条件按 AND</small></legend>
          {metadataFilters.map((filter) => { const facet = metadataFacets.find((item) => item.field === filter.field); return <div className="metadata-filter-row" key={filter.id}>
            <select value={filter.field} onChange={(event) => updateFilter(filter.id, { field: event.target.value, value: "" })}><option value="">选择字段</option>{metadataFacets.map((item) => <option key={item.field} value={item.field}>{item.field}</option>)}</select>
            <select value={filter.value} disabled={!filter.field} onChange={(event) => updateFilter(filter.id, { value: event.target.value })}><option value="">选择值</option>{facet?.values.map((value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select>
            <button type="button" aria-label="删除过滤条件" onClick={() => setMetadataFilters(metadataFilters.filter((item) => item.id !== filter.id))}>×</button>
          </div>; })}
          <button type="button" className="add-filter" disabled={!metadataFacets.length} onClick={() => setMetadataFilters([...metadataFilters, { id: generateUUID(), field: "", value: "" }])}>＋ 添加过滤条件</button>
        </fieldset>
        <label className="retrieval-toggle"><input type="checkbox" checked={rerankEnabled} onChange={(event) => setRerankEnabled(event.target.checked)} /><span>启用重排</span></label>
        {rerankEnabled && <div className="rerank-settings"><label>Rerank 模型<select name="rerankModel" required defaultValue=""><option value="" disabled>选择已启用的重排模型</option>{rerankModels.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.modelId}</option>)}</select></label>
          <label>重排候选数 <span className="retrieval-value">{candidateCount}</span><input name="candidateCount" type="range" min={rerankTopK} max="200" step="1" value={candidateCount} onChange={(event) => setCandidateCount(Number(event.target.value))} /></label>
          <label>重排 TopK <span className="retrieval-value">{rerankTopK}</span><input name="rerankTopK" type="range" min="1" max={Math.min(candidateCount, 50)} step="1" value={rerankTopK} onChange={(event) => setRerankTopK(Number(event.target.value))} /></label>
          {!rerankModels.length && <p className="retrieval-hint">请先在模型管理中新增并启用 Rerank 模型。</p>}
        </div>}
        <button className="primary-action retrieval-run" disabled={busy || !query.trim() || (rerankEnabled && !rerankModels.length)}>{busy ? "检索中…" : "运行检索"}</button>
      </form>
      <div className="retrieval-result-pane"><header><h4>测试结果 <span>共 {results.length} 条</span></h4></header>
        <div className="retrieval-results">{results.map((item) => <article key={item.chunkId}>
          <header><strong>#{item.rank} · Score {item.score.toFixed(4)}</strong><button onClick={() => void locate(item.documentId, item.chunkId)}>定位 Chunk</button></header>
          <small>来源：{item.filename} · Chunk #{item.chunkIndex + 1} · {item.chunkId}</small><p>{item.content}</p>
          <dl>{Object.entries(item.metadata).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
        </article>)}</div>
        {!busy && results.length === 0 && <div className="retrieval-empty-state"><span>◇</span><p>{query ? "暂无符合条件的 Chunk" : "尚未运行测试，结果会显示在这里"}</p></div>}
      </div>
    </div>
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
