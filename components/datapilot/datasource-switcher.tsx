"use client";

import { useEffect, useRef, useState } from "react";
import type { DataSource } from "./types";

export type DatasourceSwitcherProps = {
  sources: DataSource[];
  activeSourceId?: string;
  onSelect: (source: DataSource) => void;
  onManageSources: () => void;
};

export function DatasourceSwitcher({ sources, activeSourceId, onSelect, onManageSources }: DatasourceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeSource = sources.find((source) => source.id === activeSourceId);

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div className="datasource-switcher" ref={rootRef}>
    <button
      className="source-selector"
      ref={triggerRef}
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      <span className={`source-selector-dot ${activeSource?.status === "connected" ? "connected" : "offline"}`} />
      <span className="source-selector-name">{activeSource?.name || "未选择数据源"}</span>
      <span className={`chevron-icon ${open ? "chevron-down" : "chevron-right"}`} aria-hidden="true" />
    </button>
    {open && <div className="datasource-menu" role="listbox" aria-label="选择查询数据源">
      {sources.length ? sources.map((source) => {
        const selected = source.id === activeSourceId;
        return <button
          className={`datasource-option ${selected ? "selected" : ""}`}
          type="button"
          role="option"
          aria-selected={selected}
          key={source.id}
          onClick={() => { onSelect(source); setOpen(false); }}
        >
          <span className="datasource-option-check" aria-hidden="true">{selected ? "✓" : ""}</span>
          <span className="datasource-option-copy"><strong>{source.name}</strong><small>{source.engine} · {source.database}</small></span>
          <span className={`datasource-option-status ${source.status}`} aria-label={source.status === "connected" ? "已连接" : "未连接"} />
        </button>;
      }) : <div className="datasource-menu-empty"><span>暂无可用数据源</span><button type="button" onClick={() => { setOpen(false); onManageSources(); }}>前往数据源</button></div>}
    </div>}
  </div>;
}
