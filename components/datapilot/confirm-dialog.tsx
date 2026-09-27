"use client";

export function ConfirmDialog({ title, message, busy = false, close, confirm }: {
  title: string; message: string; busy?: boolean; close: () => void; confirm: () => void | Promise<void>;
}) {
  return <div className="modal-backdrop knowledge-confirm-backdrop" onMouseDown={() => !busy && close()}>
    <section className="knowledge-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="central-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="central-confirm-title">{title}</h2><p>此操作无法撤销</p></div><button aria-label="关闭" onClick={close} disabled={busy}>×</button></header>
      <p>{message}</p><footer><button onClick={close} disabled={busy}>取消</button><button className="danger-confirm" onClick={() => void confirm()} disabled={busy}>{busy ? "处理中…" : "确认删除"}</button></footer>
    </section>
  </div>;
}
