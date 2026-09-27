"use client";

import { FormEvent, useEffect, useState } from "react";
import { KnowledgeBaseDetail, type KnowledgeBaseData, type KnowledgeDetailData } from "./knowledge-base-detail";
import { apiRequest, formatTime, message, responseJson } from "./knowledge-client";

export function KnowledgeBaseView() {
  const [items, setItems] = useState<KnowledgeBaseData[]>([]);
  const [detail, setDetail] = useState<KnowledgeDetailData | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => { void loadList(); }, []);

  async function loadList() {
    setLoading(true);
    try { const data = await responseJson(await apiRequest("/api/knowledge-bases")); setItems(data.items || []); }
    catch (error) { setNotice(message(error, "无法读取知识库")); }
    finally { setLoading(false); }
  }

  async function openKnowledgeBase(id: string, clearNotice = true) {
    setBusy(true); if (clearNotice) setNotice("");
    try { setDetail(await responseJson(await apiRequest(`/api/knowledge-bases/${encodeURIComponent(id)}`))); }
    catch (error) { setNotice(message(error, "无法打开知识库")); }
    finally { setBusy(false); }
  }

  async function createKnowledgeBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setNotice("");
    try {
      const form = new FormData(event.currentTarget);
      const data = await responseJson(await apiRequest("/api/knowledge-bases", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.get("name"), description: form.get("description") }),
      }));
      setShowCreate(false); await loadList(); await openKnowledgeBase(data.knowledgeBase.id);
    } catch (error) { setNotice(message(error, "新建知识库失败")); }
    finally { setBusy(false); }
  }

  if (detail) return <KnowledgeBaseDetail
    detail={detail}
    setDetail={setDetail}
    busy={busy}
    setBusy={setBusy}
    notice={notice}
    setNotice={setNotice}
    refreshList={loadList}
    back={() => { setDetail(null); setNotice(""); }}
  />;

  return <div className="module-content knowledge-page">
    <div className="module-heading">
      <div><span className="eyebrow">RAG KNOWLEDGE</span><h2>知识库</h2><p>解析业务文档，构建可检索的企业知识。</p></div>
      <button className="primary-action" onClick={() => setShowCreate(true)}>＋ 新建知识库</button>
    </div>
    {notice && <p className="knowledge-notice">{notice}</p>}
    {loading ? <div className="empty-state"><p>正在加载知识库…</p></div> : items.length === 0
      ? <div className="empty-state knowledge-empty"><span>◇</span><h3>还没有知识库</h3><p>新建后可上传 PDF、DOCX、TXT、MD、XLSX 或 CSV 文档。</p><button onClick={() => setShowCreate(true)}>新建知识库</button></div>
      : <div className="knowledge-grid">{items.map((item) => <button key={item.id} className="knowledge-card" onClick={() => void openKnowledgeBase(item.id)} disabled={busy}>
        <span className="knowledge-card-icon">◇</span><strong>{item.name}</strong><p>{item.description || "暂无描述"}</p>
        <small>{item.documentCount} 个文档 · {item.chunkCount} 个 Chunk</small><time>{formatTime(item.updatedAt)} 更新</time>
      </button>)}</div>}
    {showCreate && <div className="modal-backdrop"><form className="knowledge-create-dialog" onSubmit={createKnowledgeBase}>
      <header><div><h2>新建知识库</h2><p>创建后即可上传并处理文档。</p></div><button type="button" onClick={() => setShowCreate(false)}>×</button></header>
      <label>知识库名称<input name="name" maxLength={80} autoFocus required placeholder="例如：产品帮助与高频问题" /></label>
      <label>描述<textarea name="description" maxLength={500} rows={3} placeholder="说明知识库包含的内容" /></label>
      <footer><button type="button" onClick={() => setShowCreate(false)}>取消</button><button className="primary-action" disabled={busy}>创建</button></footer>
    </form></div>}
  </div>;
}
