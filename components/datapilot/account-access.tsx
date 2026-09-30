"use client";

import Image from "next/image";
import { FormEvent, useEffect, useRef, useState } from "react";
import { apiUrl } from "./api-base";

type AccountRole = "tenant_owner" | "tenant_admin" | "finance_analyst" | "finance_viewer";
export type AuthUser = {
  id: string; username: string; email?: string; displayName: string; tenantId: string; accountSetId: string;
  role: AccountRole; isBootstrapAdmin: boolean; isRoot: boolean; canManageTenant: boolean; createdAt: string; updatedAt: string;
};
type Team = { id: string; name: string; accountSetId: string; role: AccountRole; active: boolean; memberCount: number };
type AdminTeam = { id: string; name: string; accountSetId: string; createdBy: string; createdAt: string; memberCount: number };
type AdminMember = { userId: string; tenantId: string; role: AccountRole; username: string; displayName: string; email?: string };
type AccountCenter = {
  user: AuthUser;
  teams: Team[];
  admin?: { scope: "platform" | "tenant"; teams: AdminTeam[]; members: AdminMember[]; invitations: { id: string; identifier: string; role: AccountRole; tenantId: string }[]; platform?: { tenantCount: number; userCount: number } };
};
type ApiKeyItem = { id: string; name: string; tenantId: string; enabled: boolean; createdAt: string; lastUsedAt?: string };
type CenterKind = "personal" | "admin";
type PersonalSection = "profile" | "account" | "password" | "teams" | "apiKeys";
type AdminSection = "create" | "teams" | "members" | "invite" | "roles" | "tenants" | "users" | "platform";

export function AuthScreen({ mode, setMode, submitting, error, submit }: {
  mode: "login" | "register"; setMode: (mode: "login" | "register") => void; submitting: boolean; error: string; submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const register = mode === "register";
  return <main className="auth-page">
    <section className="auth-brand"><Image src="/datapilot-logo.png" alt="DataPilot" width={34} height={34} priority /><strong>DataPilot</strong></section>
    <form className="auth-card" onSubmit={submit}>
      <div className="eyebrow">ERP FINANCE DATA AGENT</div><h1>{register ? "创建账户" : "欢迎回来"}</h1>
      <p>{register ? "注册后将创建独立的租户与默认账套。" : "登录后继续访问你的数据源与分析。"}</p>
      <label>用户名或邮箱<input name="identifier" autoComplete="username" minLength={2} maxLength={254} required autoFocus /></label>
      <label>密码<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} minLength={8} maxLength={128} required /></label>
      {register && <label>确认密码<input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      <button className="auth-submit" disabled={submitting}>{submitting ? "请稍候…" : register ? "注册并登录" : "登录"}</button>
      <button className="auth-mode" type="button" onClick={() => setMode(register ? "login" : "register")}>{register ? "已有账户？登录" : "还没有账户？注册"}</button>
    </form>
  </main>;
}

export function UserAccountMenu({ user, onLogout, onDelete, onContextChanged }: {
  user: AuthUser; onLogout: () => Promise<void>; onDelete: (confirmation: string) => Promise<void>; onContextChanged: (user: AuthUser) => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<CenterKind | "delete" | null>(null);
  const [center, setCenter] = useState<AccountCenter | null>(null);
  const [personalSection, setPersonalSection] = useState<PersonalSection>("profile");
  const [adminSection, setAdminSection] = useState<AdminSection>("create");
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [createdApiKey, setCreatedApiKey] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setMenuOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); setDialog(null); } };
    document.addEventListener("mousedown", closeOutside); document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("mousedown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, []);
  useEffect(() => { if (dialog !== "personal" || personalSection !== "apiKeys") setCreatedApiKey(""); }, [dialog, personalSection]);

  async function request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(apiUrl(path), { ...init, credentials: "include", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    const data = response.status === 204 ? undefined : await response.json();
    if (!response.ok) throw new Error(data?.error || "操作失败");
    return data as T;
  }
  async function loadCenter() {
    const [data, keys] = await Promise.all([request<AccountCenter>("/api/auth/account-center"), request<{ items: ApiKeyItem[] }>("/api/auth/api-keys")]);
    setCenter(data); setApiKeys(keys.items); return data;
  }
  async function openCenter(kind: CenterKind) {
    setMenuOpen(false); setDialog(kind); setError(""); setNotice(""); setWorking(true);
    try { await loadCenter(); } catch (caught) { setError(errorMessage(caught)); } finally { setWorking(false); }
  }
  async function action(work: () => Promise<void>, success: string) {
    setWorking(true); setError(""); setNotice("");
    try { await work(); setNotice(success); } catch (caught) { setError(errorMessage(caught)); } finally { setWorking(false); }
  }
  async function logout() { setWorking(true); try { await onLogout(); } finally { setWorking(false); } }
  async function removeAccount() {
    setWorking(true); setError("");
    try { await onDelete(confirmation); } catch (caught) { setError(errorMessage(caught)); setWorking(false); }
  }
  async function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await action(async () => { const data = await request<{ user: AuthUser }>("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ displayName: form.get("displayName") }) }); setCenter((value) => value ? { ...value, user: data.user } : value); await onContextChanged(data.user); }, "个人资料已保存");
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    await action(async () => { await request("/api/auth/password", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); formElement.reset(); }, "密码已修改，其他会话已退出");
  }
  async function switchTeam(tenantId: string) {
    await action(async () => { const data = await request<AccountCenter>("/api/auth/teams/switch", { method: "POST", body: JSON.stringify({ tenantId }) }); setCenter(data); await onContextChanged(data.user); }, "当前团队已切换");
  }
  async function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    await action(async () => { await request("/api/auth/admin/teams", { method: "POST", body: JSON.stringify({ name: form.get("name") }) }); await loadCenter(); formElement.reset(); }, "团队已创建，可在个人中心切换");
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    await action(async () => { await request<{ accepted: boolean }>("/api/auth/admin/invitations", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); await loadCenter(); formElement.reset(); }, "邀请已创建；已注册账户会立即加入团队");
  }
  async function changeRole(member: AdminMember, role: AccountRole) {
    await action(async () => { await request(`/api/auth/admin/members/${encodeURIComponent(member.userId)}`, { method: "PATCH", body: JSON.stringify({ tenantId: member.tenantId, role }) }); await loadCenter(); }, "成员角色已更新");
  }
  async function createApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    await action(async () => {
      const data = await request<{ apiKey: ApiKeyItem; key: string }>("/api/auth/api-keys", { method: "POST", body: JSON.stringify({ name: form.get("name") }) });
      setApiKeys((items) => [data.apiKey, ...items]); setCreatedApiKey(data.key); formElement.reset();
    }, "API Key 已创建，请立即复制保存");
  }
  async function toggleApiKey(item: ApiKeyItem) {
    await action(async () => {
      const data = await request<{ apiKey: ApiKeyItem }>(`/api/auth/api-keys/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !item.enabled }) });
      setApiKeys((items) => items.map((key) => key.id === item.id ? data.apiKey : key));
    }, item.enabled ? "API Key 已禁用" : "API Key 已启用");
  }
  async function revokeApiKey(item: ApiKeyItem) {
    await action(async () => { await request(`/api/auth/api-keys/${encodeURIComponent(item.id)}`, { method: "DELETE" }); setApiKeys((items) => items.filter((key) => key.id !== item.id)); }, "API Key 已撤销");
  }

  const activeTeam = center?.teams.find((team) => team.active);
  return <div className="account-entry" ref={root}>
    {menuOpen && <div className="account-menu" role="menu">
      <button role="menuitem" onClick={() => void openCenter("personal")}>个人中心</button>
      {user.canManageTenant && <button role="menuitem" onClick={() => void openCenter("admin")}>管理员中心</button>}
      <button role="menuitem" disabled={working} onClick={() => void logout()}>退出登录</button>
      <button role="menuitem" className="danger" onClick={() => { setDialog("delete"); setMenuOpen(false); setConfirmation(""); setError(""); }}>注销账户</button>
    </div>}
    <button className="profile profile-button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
      <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>{user.isRoot ? "平台管理员" : roleLabel(user.role)}</small></span><span className="more">•••</span>
    </button>
    {dialog && <div className="modal-backdrop account-dialog-backdrop" onMouseDown={() => !working && setDialog(null)}>
      <section className={`account-dialog ${dialog !== "delete" ? "account-center-dialog" : ""}`} role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2 id="account-dialog-title">{dialog === "personal" ? "个人中心" : dialog === "admin" ? "管理员中心" : "注销账户"}</h2><p>{dialog === "personal" ? "管理个人资料、账号安全与当前团队" : dialog === "admin" ? "管理团队、成员及角色权限" : "此操作会立即使当前账户和全部会话失效。"}</p></div><button aria-label="关闭" disabled={working} onClick={() => setDialog(null)}>×</button></header>
        {dialog === "delete" ? <DeletePanel confirmation={confirmation} setConfirmation={setConfirmation} error={error} working={working} cancel={() => setDialog(null)} confirm={() => void removeAccount()} />
          : <div className="account-center-layout">
            <nav aria-label={dialog === "personal" ? "个人中心导航" : "管理员中心导航"}>
              {dialog === "personal" ? <>
                <CenterNav label="个人资料" active={personalSection === "profile"} onClick={() => setPersonalSection("profile")} />
                <CenterNav label="账号信息" active={personalSection === "account"} onClick={() => setPersonalSection("account")} />
                <CenterNav label="修改密码" active={personalSection === "password"} onClick={() => setPersonalSection("password")} />
                <CenterNav label="我的团队" active={personalSection === "teams"} onClick={() => setPersonalSection("teams")} />
                <CenterNav label="API Key" active={personalSection === "apiKeys"} onClick={() => setPersonalSection("apiKeys")} />
              </> : <>
                <CenterNav label="创建团队" active={adminSection === "create"} onClick={() => setAdminSection("create")} />
                <CenterNav label="团队管理" active={adminSection === "teams"} onClick={() => setAdminSection("teams")} />
                <CenterNav label="成员管理" active={adminSection === "members"} onClick={() => setAdminSection("members")} />
                <CenterNav label="邀请成员" active={adminSection === "invite"} onClick={() => setAdminSection("invite")} />
                <CenterNav label="角色与权限" active={adminSection === "roles"} onClick={() => setAdminSection("roles")} />
                {user.isRoot && <><span className="center-nav-divider">平台管理</span><CenterNav label="所有租户" active={adminSection === "tenants"} onClick={() => setAdminSection("tenants")} /><CenterNav label="所有用户" active={adminSection === "users"} onClick={() => setAdminSection("users")} /><CenterNav label="平台级管理" active={adminSection === "platform"} onClick={() => setAdminSection("platform")} /></>}
              </>}
            </nav>
            <div className="account-center-content">
              {working && !center ? <p className="center-empty">正在加载…</p> : dialog === "personal" ? <PersonalCenter section={personalSection} center={center} activeTeam={activeTeam} updateProfile={updateProfile} changePassword={changePassword} switchTeam={switchTeam} apiKeys={apiKeys} createdApiKey={createdApiKey} createApiKey={createApiKey} toggleApiKey={toggleApiKey} revokeApiKey={revokeApiKey} working={working} /> : <AdminCenter section={adminSection} center={center} activeTeam={activeTeam} createTeam={createTeam} invite={invite} changeRole={changeRole} working={working} />}
              {notice && <div className="center-notice success" role="status">{notice}</div>}{error && <div className="center-notice error" role="alert">{error}</div>}
            </div>
          </div>}
      </section>
    </div>}
  </div>;
}

function CenterNav({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}>{label}</button>; }

function PersonalCenter({ section, center, activeTeam, updateProfile, changePassword, switchTeam, apiKeys, createdApiKey, createApiKey, toggleApiKey, revokeApiKey, working }: {
  section: PersonalSection; center: AccountCenter | null; activeTeam?: Team; updateProfile: (event: FormEvent<HTMLFormElement>) => Promise<void>; changePassword: (event: FormEvent<HTMLFormElement>) => Promise<void>; switchTeam: (id: string) => Promise<void>; apiKeys: ApiKeyItem[]; createdApiKey: string; createApiKey: (event: FormEvent<HTMLFormElement>) => Promise<void>; toggleApiKey: (item: ApiKeyItem) => Promise<void>; revokeApiKey: (item: ApiKeyItem) => Promise<void>; working: boolean;
}) {
  if (!center) return null;
  if (section === "profile") return <CenterSection title="个人资料" description="设置在 DataPilot 中显示的个人名称。"><form className="center-form" onSubmit={(event) => void updateProfile(event)}><label>显示名称<input name="displayName" defaultValue={center.user.displayName} minLength={2} maxLength={64} required /></label><button disabled={working}>保存资料</button></form></CenterSection>;
  if (section === "account") return <CenterSection title="账号信息" description="账号标识与当前权限上下文由服务端维护。"><dl className="profile-details"><div><dt>用户名</dt><dd>{center.user.username}</dd></div><div><dt>邮箱</dt><dd>{center.user.email || "未设置"}</dd></div><div><dt>角色</dt><dd>{center.user.isRoot ? "平台管理员" : roleLabel(center.user.role)}</dd></div><div><dt>当前团队</dt><dd>{activeTeam?.name || center.user.tenantId}</dd></div><div><dt>账套</dt><dd>{center.user.accountSetId}</dd></div></dl></CenterSection>;
  if (section === "password") return <CenterSection title="修改密码" description="更新后将退出除当前浏览器之外的其他会话。"><form className="center-form" onSubmit={(event) => void changePassword(event)}><label>当前密码<input name="currentPassword" type="password" autoComplete="current-password" required /></label><label>新密码<input name="newPassword" type="password" autoComplete="new-password" minLength={8} required /></label><label>确认新密码<input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required /></label><button disabled={working}>修改密码</button></form></CenterSection>;
  if (section === "apiKeys") return <CenterSection title="API Key" description="用于 RAGFlow 或外部 Agent 调用 /api/v1/*；Key 绑定当前团队，完整值只显示一次。">
    <form className="center-form compact" onSubmit={(event) => void createApiKey(event)}><label>名称<input name="name" minLength={2} maxLength={80} placeholder="例如：RAGFlow 生产环境" required /></label><button disabled={working}>创建 API Key</button></form>
    {createdApiKey && <div className="api-key-created"><strong>请立即复制，关闭后无法再次查看</strong><code>{createdApiKey}</code><button type="button" onClick={() => void navigator.clipboard.writeText(createdApiKey)}>复制</button></div>}
    <div className="api-key-list">{apiKeys.length ? apiKeys.map((item) => <article key={item.id}><div><strong>{item.name}</strong><small>{item.tenantId} · 创建于 {new Date(item.createdAt).toLocaleString()} · 最后使用 {item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : "从未"}</small></div><span className={item.enabled ? "enabled" : "disabled"}>{item.enabled ? "已启用" : "已禁用"}</span><button type="button" disabled={working} onClick={() => void toggleApiKey(item)}>{item.enabled ? "禁用" : "启用"}</button><button type="button" className="danger" disabled={working} onClick={() => void revokeApiKey(item)}>撤销</button></article>) : <p className="center-empty">当前团队还没有 API Key。</p>}</div>
  </CenterSection>;
  return <CenterSection title="我的团队" description="只能切换到你已经加入的团队，切换后业务数据会按新上下文重新加载。"><div className="team-list">{center.teams.map((team) => <article key={team.id} className={team.active ? "active" : ""}><div><strong>{team.name}</strong><small>{roleLabel(team.role)} · {team.memberCount} 位成员</small></div>{team.active ? <span>当前团队</span> : <button disabled={working} onClick={() => void switchTeam(team.id)}>切换</button>}</article>)}</div></CenterSection>;
}

function AdminCenter({ section, center, activeTeam, createTeam, invite, changeRole, working }: {
  section: AdminSection; center: AccountCenter | null; activeTeam?: Team; createTeam: (event: FormEvent<HTMLFormElement>) => Promise<void>; invite: (event: FormEvent<HTMLFormElement>) => Promise<void>; changeRole: (member: AdminMember, role: AccountRole) => Promise<void>; working: boolean;
}) {
  if (!center?.admin) return <p className="center-empty">没有管理员权限。</p>;
  const admin = center.admin;
  if (section === "create") return <CenterSection title="创建团队" description="新团队将使用独立 tenant 与账套上下文，你将成为 Owner。"><form className="center-form compact" onSubmit={(event) => void createTeam(event)}><label>团队名称<input name="name" minLength={2} maxLength={80} placeholder="例如：华东财务团队" required /></label><button disabled={working}>创建团队</button></form></CenterSection>;
  if (section === "teams" || section === "tenants") return <CenterSection title={section === "tenants" ? "所有租户" : "团队管理"} description={admin.scope === "platform" ? "平台管理员可查看全部租户。" : "Owner 与管理员仅能管理当前团队。"}><div className="admin-list">{admin.teams.map((team) => <article key={team.id}><div><strong>{team.name}</strong><small>{team.id}</small></div><span>{team.memberCount} 位成员</span></article>)}</div></CenterSection>;
  if (section === "members" || section === "users") return <CenterSection title={section === "users" ? "所有用户" : "成员管理"} description={section === "users" ? "查看平台各租户中的成员关系。" : `当前团队：${activeTeam?.name || "-"}`}><div className="admin-list member-list">{admin.members.map((member) => <article key={`${member.tenantId}-${member.userId}`}><div><strong>{member.displayName}</strong><small>{member.email || member.username}{admin.scope === "platform" ? ` · ${member.tenantId}` : ""}</small></div>{member.role === "tenant_owner" ? <span>Owner</span> : <select aria-label={`设置 ${member.displayName} 的角色`} value={member.role} disabled={working} onChange={(event) => void changeRole(member, event.target.value as AccountRole)}><option value="tenant_admin">管理员</option><option value="finance_analyst">成员（分析）</option><option value="finance_viewer">成员（只读）</option></select>}</article>)}</div></CenterSection>;
  if (section === "invite") return <CenterSection title="邀请成员" description="已注册账户会立即加入；未注册标识将在注册后自动接受邀请。"><form className="center-form compact" onSubmit={(event) => void invite(event)}><label>用户名或邮箱<input name="identifier" required /></label>{admin.scope === "platform" && <label>目标租户<select name="tenantId" defaultValue={activeTeam?.id}>{admin.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}<label>角色<select name="role" defaultValue="finance_viewer"><option value="finance_viewer">成员（只读）</option><option value="finance_analyst">成员（分析）</option><option value="tenant_admin">团队管理员</option></select></label><button disabled={working}>发送邀请</button></form></CenterSection>;
  if (section === "roles") return <CenterSection title="角色与权限" description="权限在服务端按当前 tenant 强制执行。"><div className="role-cards"><article><strong>Owner</strong><p>管理自己的团队、成员、邀请及角色。</p></article><article><strong>团队管理员</strong><p>管理当前团队，不可跨租户访问。</p></article><article><strong>普通成员</strong><p>仅使用被授予的分析与查看能力。</p></article></div></CenterSection>;
  return <CenterSection title="平台级管理" description="仅 root 平台管理员可见。"><div className="platform-stats"><article><strong>{admin.platform?.tenantCount || 0}</strong><span>租户总数</span></article><article><strong>{admin.platform?.userCount || 0}</strong><span>有效用户</span></article></div><p className="platform-note">平台操作仍受服务端 root 身份校验，不依赖前端入口可见性。</p></CenterSection>;
}

function CenterSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="center-section"><header><h3>{title}</h3><p>{description}</p></header>{children}</section>; }
function DeletePanel({ confirmation, setConfirmation, error, working, cancel, confirm }: { confirmation: string; setConfirmation: (value: string) => void; error: string; working: boolean; cancel: () => void; confirm: () => void }) { return <div className="delete-account-confirm"><p>数据源和 Mapping 不会被跨租户误删；账户将被软删除且不能再次登录。请输入 <strong>DELETE</strong> 确认。</p><input aria-label="输入 DELETE 确认注销" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="DELETE" autoFocus />{error && <div className="auth-error" role="alert">{error}</div>}<div><button onClick={cancel} disabled={working}>取消</button><button className="delete-account-button" onClick={confirm} disabled={working || confirmation !== "DELETE"}>{working ? "正在注销…" : "永久注销账户"}</button></div></div>; }
function roleLabel(role: AccountRole) { return role === "tenant_owner" ? "团队 Owner" : role === "tenant_admin" ? "租户管理员" : role === "finance_analyst" ? "财务分析师" : "财务查看者"; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }
