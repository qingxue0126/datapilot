"use client";

import { useState } from "react";
import type { AnalysisSession } from "./types";

export function RecentAnalyses({ sessions, activeSessionId, onOpen, onRename, onDelete }: {
  sessions: AnalysisSession[];
  activeSessionId?: string;
  onOpen: (session: AnalysisSession) => void;
  onRename: (session: AnalysisSession, title: string) => Promise<void>;
  onDelete: (session: AnalysisSession) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");

  function beginRename(session: AnalysisSession) {
    setEditingId(session.id);
    setDraftTitle(session.title);
  }

  async function saveRename(session: AnalysisSession) {
    const title = draftTitle.trim();
    if (title && title !== session.title) await onRename(session, title);
    setEditingId("");
  }

  return <section className="recent-analyses" aria-label="最近分析">
    <div className="recent-analyses-heading"><span>最近分析</span><small>{sessions.length}</small></div>
    {sessions.length === 0 ? <p className="recent-analyses-empty">暂无分析，点击上方新建</p> : <div className="recent-analyses-list">
      {sessions.map((session) => <div
        key={session.id}
        className={`recent-analysis-item ${activeSessionId === session.id ? "active" : ""}`}
        role="button"
        tabIndex={editingId === session.id ? -1 : 0}
        aria-label={`打开分析：${session.title}`}
        onClick={() => editingId !== session.id && onOpen(session)}
        onKeyDown={(event) => {
          if (editingId !== session.id && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(session); }
        }}
      >
        {editingId === session.id ? <input
          autoFocus
          aria-label="分析标题"
          value={draftTitle}
          maxLength={80}
          onChange={(event) => setDraftTitle(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onBlur={() => void saveRename(session)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") void saveRename(session);
            if (event.key === "Escape") setEditingId("");
          }}
        /> : <span title={session.title}>{session.title}</span>}
        <div className="recent-analysis-actions">
          <button aria-label={`重命名分析：${session.title}`} title="重命名" onClick={(event) => { event.stopPropagation(); beginRename(session); }}>✎</button>
          <button aria-label={`删除分析：${session.title}`} title="删除" onClick={(event) => { event.stopPropagation(); void onDelete(session); }}>×</button>
        </div>
      </div>)}
    </div>}
  </section>;
}
