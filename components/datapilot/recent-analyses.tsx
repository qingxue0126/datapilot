"use client";

import { useMemo, useState } from "react";
import type { AnalysisSession } from "./types";

type Props = {
  sessions: AnalysisSession[];
  activeSessionId?: string;
  onOpen: (session: AnalysisSession) => void;
  onPin: (session: AnalysisSession, pinned: boolean) => Promise<void>;
  onRename: (session: AnalysisSession, title: string) => Promise<void>;
  onDelete: (session: AnalysisSession) => Promise<void>;
};

export function RecentAnalyses({ sessions, activeSessionId, onOpen, onPin, onRename, onDelete }: Props) {
  const [editingId, setEditingId] = useState("");
  const [menuId, setMenuId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [recentExpanded, setRecentExpanded] = useState(true);
  const sorted = useMemo(() => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [sessions]);
  const pinned = sorted.filter((session) => session.pinned);
  const recent = sorted.filter((session) => !session.pinned);

  function beginRename(session: AnalysisSession) {
    setMenuId("");
    setEditingId(session.id);
    setDraftTitle(session.title);
  }

  async function saveRename(session: AnalysisSession) {
    const title = draftTitle.trim();
    if (title && title !== session.title) await onRename(session, title);
    setEditingId("");
  }

  function group(label: string, items: AnalysisSession[], expanded: boolean, toggle: () => void) {
    return <section className="analysis-group" aria-label={`${label}会话`}>
      <button className="recent-analyses-heading" type="button" aria-expanded={expanded} onClick={toggle}>
        <span>{label}<i className={`chevron-icon ${expanded ? "chevron-down" : "chevron-right"}`} aria-hidden="true" /></span>
      </button>
      {expanded && (items.length === 0
        ? <p className="recent-analyses-empty">暂无会话，点击上方新建</p>
        : <div className="recent-analyses-list">{items.map(renderSession)}</div>)}
    </section>;
  }

  function renderSession(session: AnalysisSession) {
    return <div
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
        <button aria-label={`会话菜单：${session.title}`} aria-expanded={menuId === session.id} title="会话菜单" onClick={(event) => { event.stopPropagation(); setMenuId((current) => current === session.id ? "" : session.id); }}>•••</button>
        {menuId === session.id && <div className="session-menu" role="menu" onClick={(event) => event.stopPropagation()}>
          <button role="menuitem" onClick={() => { setMenuId(""); void onPin(session, !session.pinned); }}>{session.pinned ? "取消置顶" : "置顶"}</button>
          <button role="menuitem" onClick={() => beginRename(session)}>重命名</button>
          <button className="danger" role="menuitem" onClick={() => { setMenuId(""); void onDelete(session); }}>删除</button>
        </div>}
      </div>
    </div>;
  }

  return <div className="recent-analyses">
    {pinned.length > 0 && group("置顶", pinned, pinnedExpanded, () => setPinnedExpanded((value) => !value))}
    {group("最近", recent, recentExpanded, () => setRecentExpanded((value) => !value))}
  </div>;
}
