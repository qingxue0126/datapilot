import { erpLabel } from "./datasource-status-card";
import type { DataSource } from "./types";

export type CurrentDatasourceShortcutProps = {
  source?: DataSource;
  onOpen: () => void;
};

export function CurrentDatasourceShortcut({ source, onOpen }: CurrentDatasourceShortcutProps) {
  const connected = source?.status === "connected";
  const engine = source?.engine.split(/\s+/)[0] || "";
  return <section className="current-datasource-context" aria-label="当前数据库">
    <span className="current-datasource-label">当前数据库</span>
    <button className="current-datasource-shortcut" type="button" onClick={onOpen}>
      {source ? <>
        <span className={`status-dot ${source.status}`} aria-hidden="true" />
        <span className="current-datasource-copy">
          <strong>{source.database || source.name}</strong>
          <small>{source.name} · {engine} · {erpLabel(source.insight?.erpType)}</small>
          <em>{connected ? "已连接" : "未连接"}</em>
        </span>
        <span className="chevron-icon chevron-right" aria-hidden="true" />
      </> : <>
        <span className="current-datasource-copy empty">
          <strong>未连接</strong>
          <small>未选择数据源 · 点击前往数据源</small>
        </span>
        <span className="chevron-icon chevron-right" aria-hidden="true" />
      </>}
    </button>
  </section>;
}
