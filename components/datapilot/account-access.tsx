"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Image from "next/image";

export type AuthUser = {
  id: string;
  username: string;
  email?: string;
  displayName: string;
  tenantId: string;
  accountSetId: string;
  role: "tenant_admin" | "finance_analyst" | "finance_viewer";
  isBootstrapAdmin: boolean;
  createdAt: string;
  updatedAt: string;
};

export function AuthScreen({ mode, setMode, submitting, error, submit }: {
  mode: "login" | "register";
  setMode: (mode: "login" | "register") => void;
  submitting: boolean;
  error: string;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const register = mode === "register";
  return <main className="auth-page">
    <section className="auth-brand"><Image src="/datapilot-logo.png" alt="DataPilot" width={34} height={34} priority /><strong>DataPilot</strong></section>
    <form className="auth-card" onSubmit={submit}>
      <div className="eyebrow">ERP FINANCE DATA AGENT</div>
      <h1>{register ? "创建账户" : "欢迎回来"}</h1>
      <p>{register ? "注册后将创建独立的租户与默认账套。" : "登录后继续访问你的数据源与分析。"}</p>
      <label>用户名或邮箱<input name="identifier" autoComplete="username" minLength={2} maxLength={254} required autoFocus /></label>
      <label>密码<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} minLength={8} maxLength={128} required /></label>
      {register && <label>确认密码<input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      <button className="auth-submit" disabled={submitting}>{submitting ? "请稍候…" : register ? "注册并登录" : "登录"}</button>
      <button className="auth-mode" type="button" onClick={() => setMode(register ? "login" : "register")}>
        {register ? "已有账户？登录" : "还没有账户？注册"}
      </button>
    </form>
  </main>;
}

export function UserAccountMenu({ user, onLogout, onDelete }: { user: AuthUser; onLogout: () => Promise<void>; onDelete: (confirmation: string) => Promise<void> }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<"profile" | "delete" | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setMenuOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); setDialog(null); } };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("mousedown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, []);

  async function logout() { setWorking(true); try { await onLogout(); } finally { setWorking(false); } }
  async function removeAccount() {
    setWorking(true); setError("");
    try { await onDelete(confirmation); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "注销账户失败"); setWorking(false); }
  }

  return <div className="account-entry" ref={root}>
    {menuOpen && <div className="account-menu" role="menu">
      <button role="menuitem" onClick={() => { setDialog("profile"); setMenuOpen(false); }}>个人信息</button>
      <button role="menuitem" disabled={working} onClick={() => void logout()}>退出登录</button>
      <button role="menuitem" className="danger" onClick={() => { setDialog("delete"); setMenuOpen(false); setConfirmation(""); setError(""); }}>注销账户</button>
    </div>}
    <button className="profile profile-button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
      <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
      <span><strong>{user.displayName}</strong><small>{roleLabel(user.role)}</small></span>
      <span className="more">•••</span>
    </button>
    {dialog && <div className="modal-backdrop account-dialog-backdrop" onMouseDown={() => !working && setDialog(null)}>
      <section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2 id="account-dialog-title">{dialog === "profile" ? "个人信息" : "注销账户"}</h2><p>{dialog === "profile" ? "当前账户与权限上下文" : "此操作会立即使当前账户和全部会话失效。"}</p></div><button aria-label="关闭" disabled={working} onClick={() => setDialog(null)}>×</button></header>
        {dialog === "profile" ? <dl className="profile-details">
          <div><dt>用户名</dt><dd>{user.username}</dd></div>
          <div><dt>邮箱</dt><dd>{user.email || "未设置"}</dd></div>
          <div><dt>角色</dt><dd>{roleLabel(user.role)}</dd></div>
          <div><dt>租户</dt><dd>{user.tenantId}</dd></div>
          <div><dt>账套</dt><dd>{user.accountSetId}</dd></div>
        </dl> : <div className="delete-account-confirm">
          <p>数据源和 Mapping 不会被跨租户误删；账户将被软删除且不能再次登录。请输入 <strong>DELETE</strong> 确认。</p>
          <input aria-label="输入 DELETE 确认注销" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="DELETE" autoFocus />
          {error && <div className="auth-error" role="alert">{error}</div>}
          <div><button onClick={() => setDialog(null)} disabled={working}>取消</button><button className="delete-account-button" onClick={() => void removeAccount()} disabled={working || confirmation !== "DELETE"}>{working ? "正在注销…" : "永久注销账户"}</button></div>
        </div>}
      </section>
    </div>}
  </div>;
}

function roleLabel(role: AuthUser["role"]) {
  return role === "tenant_admin" ? "租户管理员" : role === "finance_analyst" ? "财务分析师" : "财务查看者";
}
