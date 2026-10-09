"use client";

import Image from "next/image";
import { FormEvent, useEffect, useRef, useState } from "react";
import { apiUrl } from "./api-base";

type AccountRole = "tenant_owner" | "tenant_admin" | "finance_analyst" | "finance_viewer";
export type AuthUser = {
  id: string; username: string; email?: string; displayName: string; tenantId: string; accountSetId: string;
  phone?: string; unit?: string; remark?: string; avatar?: string;
  role: AccountRole; isBootstrapAdmin: boolean; isRoot: boolean; canManageTenant: boolean; createdAt: string; updatedAt: string;
};
type Team = { id: string; name: string; accountSetId: string; role: AccountRole; active: boolean; memberCount: number };
type AdminTeam = { id: string; name: string; accountSetId: string; createdBy: string; createdAt: string; memberCount: number; administrators: string[] };
type AdminMember = { userId: string; tenantId: string; role: AccountRole; username: string; displayName: string; email?: string; phone?: string; status: "active" | "deleted"; createdAt: string };
type IncomingInvitation = { id: string; tenantId: string; tenantName: string; role: AccountRole; invitedBy: string; createdAt: string };
type AccountCenter = {
  user: AuthUser;
  teams: Team[];
  invitations: IncomingInvitation[];
  admin?: { scope: "platform" | "tenant"; teams: AdminTeam[]; members: AdminMember[]; invitations: { id: string; identifier: string; role: AccountRole; tenantId: string }[]; platform?: { tenantCount: number; userCount: number } };
};
type CenterKind = "personal" | "admin";
type AdminSection = "organizations" | "users";

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
  const [adminSection, setAdminSection] = useState<AdminSection>("organizations");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setMenuOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); setPasswordOpen(false); setDialog(null); } };
    document.addEventListener("mousedown", closeOutside); document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("mousedown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, []);
  async function request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(apiUrl(path), { ...init, credentials: "include", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    const data = response.status === 204 ? undefined : await response.json();
    if (!response.ok) throw new Error(data?.error || "操作失败");
    return data as T;
  }
  async function loadCenter() {
    const data = await request<AccountCenter>("/api/auth/account-center");
    setCenter(data); return data;
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
    await action(async () => { const data = await request<{ user: AuthUser }>("/api/auth/profile", { method: "PATCH", body: JSON.stringify(Object.fromEntries(form)) }); setCenter((value) => value ? { ...value, user: data.user } : value); await onContextChanged(data.user); }, "个人资料已保存");
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    await action(async () => { await request("/api/auth/password", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); formElement.reset(); setPasswordOpen(false); }, "密码已修改，其他会话已退出");
  }
  async function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    await action(async () => { await request("/api/auth/admin/teams", { method: "POST", body: JSON.stringify({ name: form.get("name") }) }); await loadCenter(); formElement.reset(); }, "团队已创建，可在个人中心切换");
  }
  async function switchTeam(tenantId: string) {
    if (!tenantId || tenantId === activeTeam?.id) return;
    await action(async () => {
      const data = await request<AccountCenter>("/api/auth/teams/switch", { method: "POST", body: JSON.stringify({ tenantId }) });
      setCenter(data);
      await onContextChanged(data.user);
    }, "团队已切换");
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    await action(async () => { await request<{ accepted: boolean }>("/api/auth/admin/invitations", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); await loadCenter(); formElement.reset(); }, "邀请已发送，等待用户确认");
  }
  async function respondInvitation(invitation: IncomingInvitation, accept: boolean) {
    await action(async () => { const data = await request<AccountCenter>(`/api/auth/invitations/${encodeURIComponent(invitation.id)}/${accept ? "accept" : "reject"}`, { method: "POST" }); setCenter(data); if (accept) await onContextChanged(data.user); }, accept ? "已加入组织" : "已拒绝邀请");
  }
  async function changeRole(member: AdminMember, role: AccountRole) {
    await action(async () => { await request(`/api/auth/admin/members/${encodeURIComponent(member.userId)}`, { method: "PATCH", body: JSON.stringify({ tenantId: member.tenantId, role }) }); await loadCenter(); }, "成员角色已更新");
  }
  const activeTeam = center?.teams.find((team) => team.active);
  return <div className="account-entry" ref={root}>
    {menuOpen && <div className="account-menu" role="menu">
      <button role="menuitem" onClick={() => void openCenter("personal")}>个人中心</button>
      <button role="menuitem" onClick={() => void openCenter("admin")}>管理员中心</button>
      <button role="menuitem" disabled={working} onClick={() => void logout()}>退出登录</button>
      <button role="menuitem" className="danger" onClick={() => { setDialog("delete"); setMenuOpen(false); setConfirmation(""); setError(""); }}>注销账户</button>
    </div>}
    <button className="profile profile-button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
      <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>{user.isRoot ? "平台管理员" : roleLabel(user.role)}</small></span><span className="more">•••</span>
    </button>
    {dialog && <div className={`modal-backdrop account-dialog-backdrop ${dialog === "personal" ? "personal-center-backdrop" : ""}`} onMouseDown={() => !working && setDialog(null)}>
      <section className={`account-dialog ${dialog === "personal" ? "personal-center-dialog" : dialog === "admin" ? "account-center-dialog" : ""}`} role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2 id="account-dialog-title">{dialog === "personal" ? "个人信息" : dialog === "admin" ? "管理员中心" : "注销账户"}</h2>{dialog !== "personal" && <p>{dialog === "admin" ? "管理团队、成员及角色权限" : "此操作会立即使当前账户和全部会话失效。"}</p>}</div><button aria-label={dialog === "personal" ? "返回" : "关闭"} disabled={working} onClick={() => setDialog(null)}>{dialog === "personal" ? "←" : "×"}</button></header>
        {dialog === "delete" ? <DeletePanel confirmation={confirmation} setConfirmation={setConfirmation} error={error} working={working} cancel={() => setDialog(null)} confirm={() => void removeAccount()} />
          : dialog === "personal" ? <div className="personal-center-content">
            {working && !center ? <p className="center-empty">正在加载…</p> : center && <PersonalProfile center={center} updateProfile={updateProfile} openPassword={() => { setError(""); setNotice(""); setPasswordOpen(true); }} working={working} />}
            {notice && <div className="center-notice success" role="status">{notice}</div>}{error && <div className="center-notice error" role="alert">{error}</div>}
          </div> : <div className="account-center-layout">
            <nav aria-label="管理员中心导航">
              {center?.admin ? <>
                <CenterNav label="组织" active={adminSection === "organizations"} onClick={() => setAdminSection("organizations")} />
                <CenterNav label="用户" active={adminSection === "users"} onClick={() => setAdminSection("users")} />
              </> : <CenterNav label={`组织邀请${center?.invitations.length ? ` (${center.invitations.length})` : ""}`} active onClick={() => undefined} />}
            </nav>
            <div className="account-center-content">
              {working && !center ? <p className="center-empty">正在加载…</p> : <AdminCenter section={adminSection} center={center} activeTeam={activeTeam} switchTeam={switchTeam} createTeam={createTeam} invite={invite} changeRole={changeRole} respondInvitation={respondInvitation} working={working} />}
              {notice && <div className="center-notice success" role="status">{notice}</div>}{error && <div className="center-notice error" role="alert">{error}</div>}
            </div>
          </div>}
      </section>
    </div>}
    {passwordOpen && <div className="modal-backdrop password-dialog-backdrop" onMouseDown={() => !working && setPasswordOpen(false)}><section className="password-change-dialog" role="dialog" aria-modal="true" aria-labelledby="password-dialog-title" onMouseDown={(event) => event.stopPropagation()}><header><h2 id="password-dialog-title">更改密码</h2><button aria-label="关闭" disabled={working} onClick={() => setPasswordOpen(false)}>×</button></header><form onSubmit={(event) => void changePassword(event)}><label><span><b>*</b> 旧密码</span><input name="currentPassword" type="password" autoComplete="current-password" placeholder="请输入旧密码" required /></label><label><span><b>*</b> 新密码</span><input name="newPassword" type="password" autoComplete="new-password" minLength={8} placeholder="请输入，密码需包含字母、数字，长度8-20" required /></label><label><span><b>*</b> 确认新密码</span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} placeholder="请再次输入新密码" required /></label>{error && <div className="center-notice error" role="alert">{error}</div>}<footer><button type="button" onClick={() => setPasswordOpen(false)}>取消</button><button className="primary-action" disabled={working}>{working ? "提交中…" : "确定"}</button></footer></form></section></div>}
  </div>;
}

function CenterNav({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}>{label}</button>; }

function PersonalProfile({ center, updateProfile, openPassword, working }: { center: AccountCenter; updateProfile: (event: FormEvent<HTMLFormElement>) => Promise<void>; openPassword: () => void; working: boolean }) {
  return <form className="personal-profile-form" onSubmit={(event) => void updateProfile(event)}><AvatarField user={center.user} /><div className="personal-fields"><input type="hidden" name="displayName" value={center.user.displayName} /><label>用户名<input value={center.user.username} disabled /></label><label>密码<div className="password-summary"><input value="***" disabled /><button type="button" onClick={openPassword}>修改密码</button></div></label><label>单位<input name="unit" defaultValue={center.user.unit || ""} maxLength={100} placeholder="--" /></label><label>电话<input name="phone" defaultValue={center.user.phone || ""} maxLength={25} placeholder="--" /></label><label>邮箱<input name="email" type="email" defaultValue={center.user.email || ""} maxLength={254} placeholder="--" /></label><label>备注<textarea name="remark" defaultValue={center.user.remark || ""} maxLength={300} placeholder="--" /></label><button disabled={working}>{working ? "保存中…" : "保存资料"}</button></div></form>;
}

function AvatarField({ user }: { user: AuthUser }) {
  const [avatar, setAvatar] = useState(user.avatar || "");
  function selectAvatar(file?: File) {
    if (!file) return;
    if (file.size > 1_000_000) return;
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result || ""));
    reader.readAsDataURL(file);
  }
  return <label className="avatar-upload"><span className="avatar-preview" style={avatar ? { backgroundImage: `url(${avatar})` } : undefined}>{avatar ? "" : user.displayName.slice(0, 1).toUpperCase()}</span><span>点击上传图片</span><input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => selectAvatar(event.target.files?.[0])} /><input type="hidden" name="avatar" value={avatar} /></label>;
}

function AdminCenter({ section, center, activeTeam, switchTeam, createTeam, invite, changeRole, respondInvitation, working }: {
  section: AdminSection; center: AccountCenter | null; activeTeam?: Team; switchTeam: (id: string) => Promise<void>; createTeam: (event: FormEvent<HTMLFormElement>) => Promise<void>; invite: (event: FormEvent<HTMLFormElement>) => Promise<void>; changeRole: (member: AdminMember, role: AccountRole) => Promise<void>; respondInvitation: (invitation: IncomingInvitation, accept: boolean) => Promise<void>; working: boolean;
}) {
  const [query, setQuery] = useState("");
  if (!center) return null;
  if (!center.admin) return <CenterSection title="组织邀请" description="你没有组织管理权限；管理员发给你的邀请会显示在这里。"><div className="invitation-list">{center.invitations.length ? center.invitations.map((invitation) => <article key={invitation.id}><div><strong>{invitation.tenantName}</strong><small>{invitation.invitedBy} 邀请你以“{roleLabel(invitation.role)}”身份加入 · {new Date(invitation.createdAt).toLocaleString()}</small></div><div><button className="secondary" disabled={working} onClick={() => void respondInvitation(invitation, false)}>拒绝</button><button disabled={working} onClick={() => void respondInvitation(invitation, true)}>接受邀请</button></div></article>) : <p className="center-empty">暂无待处理邀请。</p>}</div></CenterSection>;
  const admin = center.admin;
  const incomingInvitations = center.invitations.length > 0 && <CenterSection title="待处理邀请" description="你收到的组织邀请需要先确认，确认后即可加入对应组织。"><div className="invitation-list">{center.invitations.map((invitation) => <article key={invitation.id}><div><strong>{invitation.tenantName}</strong><small>{invitation.invitedBy} 邀请你以“{roleLabel(invitation.role)}”身份加入 · {new Date(invitation.createdAt).toLocaleString()}</small></div><div><button className="secondary" disabled={working} onClick={() => void respondInvitation(invitation, false)}>拒绝</button><button disabled={working} onClick={() => void respondInvitation(invitation, true)}>接受邀请</button></div></article>)}</div></CenterSection>;
  if (section === "organizations") {
    const teams = admin.teams.filter((team) => team.name.toLowerCase().includes(query.toLowerCase()));
    return <>{incomingInvitations}<CenterSection title="组织管理" description="管理组织信息和成员归属。"><div className="admin-toolbar"><input aria-label="搜索组织" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索组织" /><form onSubmit={(event) => void createTeam(event)}><input name="name" minLength={2} maxLength={80} placeholder="组织名称" required /><button disabled={working}>＋ 新增组织</button></form></div><div className="management-table organization-table"><div className="table-row table-head"><span>组织名称</span><span>组织管理员</span><span>成员数</span><span>创建时间</span><span>操作</span></div>{teams.map((team) => <div className="table-row" key={team.id}><strong>{team.name}</strong><span>{team.administrators.join("、") || "--"}</span><span>{team.memberCount}</span><span>{new Date(team.createdAt).toLocaleString()}</span><span className="table-actions"><button type="button" disabled title="后续支持重命名">编辑</button></span></div>)}</div></CenterSection></>;
  }
  const members = admin.members.filter((member) => `${member.displayName} ${member.username} ${member.email || ""}`.toLowerCase().includes(query.toLowerCase()));
  return <>{incomingInvitations}<CenterSection title="用户管理" description={`管理组织用户、角色与邀请。当前组织：${activeTeam?.name || "-"}`}><div className="admin-toolbar user-toolbar"><label className="team-switcher"><span>当前团队</span><select aria-label="切换团队" value={activeTeam?.id || ""} disabled={working} onChange={(event) => void switchTeam(event.target.value)}>{center.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><input aria-label="用户名或邮箱搜索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="用户名/邮箱搜索" /><form className="invite-inline-form" onSubmit={(event) => void invite(event)}><input name="identifier" placeholder="用户名或邮箱" required />{admin.scope === "platform" && <select name="tenantId" defaultValue={activeTeam?.id}>{admin.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select>}<select name="role" defaultValue="finance_viewer"><option value="finance_viewer">普通成员</option><option value="finance_analyst">分析成员</option><option value="tenant_admin">组织管理员</option></select><button disabled={working}>邀请用户</button></form></div>{admin.invitations.length > 0 && <div className="pending-invitations"><strong>待确认邀请</strong>{admin.invitations.map((item) => <span key={item.id}>{item.identifier} · {roleLabel(item.role)}</span>)}</div>}<div className="management-table user-table"><div className="table-row table-head"><span>用户名</span><span>角色</span><span>手机号</span><span>状态</span><span>创建时间</span><span>操作</span></div>{members.map((member) => <div className="table-row" key={`${member.tenantId}-${member.userId}`}><span className="user-cell"><span className="mini-avatar">{member.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{member.displayName}</strong><small>{member.email || member.username}</small></span></span><span>{member.role === "tenant_owner" ? "Owner" : <select aria-label={`设置 ${member.displayName} 的角色`} value={member.role} disabled={working} onChange={(event) => void changeRole(member, event.target.value as AccountRole)}><option value="tenant_admin">组织管理员</option><option value="finance_analyst">分析成员</option><option value="finance_viewer">普通成员</option></select>}</span><span>{member.phone || "--"}</span><span className={`status-pill ${member.status}`}>{member.status === "active" ? "启用" : "停用"}</span><span>{new Date(member.createdAt).toLocaleString()}</span><span className="table-actions"><button type="button" disabled={member.role === "tenant_owner"}>编辑</button></span></div>)}</div></CenterSection></>;
}

function CenterSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="center-section"><header><h3>{title}</h3><p>{description}</p></header>{children}</section>; }
function DeletePanel({ confirmation, setConfirmation, error, working, cancel, confirm }: { confirmation: string; setConfirmation: (value: string) => void; error: string; working: boolean; cancel: () => void; confirm: () => void }) { return <div className="delete-account-confirm"><p>数据源和 Mapping 不会被跨租户误删；账户将被软删除且不能再次登录。请输入 <strong>DELETE</strong> 确认。</p><input aria-label="输入 DELETE 确认注销" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="DELETE" autoFocus />{error && <div className="auth-error" role="alert">{error}</div>}<div><button onClick={cancel} disabled={working}>取消</button><button className="delete-account-button" onClick={confirm} disabled={working || confirmation !== "DELETE"}>{working ? "正在注销…" : "永久注销账户"}</button></div></div>; }
function roleLabel(role: AccountRole) { return role === "tenant_owner" ? "团队 Owner" : role === "tenant_admin" ? "租户管理员" : role === "finance_analyst" ? "财务分析师" : "财务查看者"; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }
