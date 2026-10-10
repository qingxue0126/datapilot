"use client";

import Image from "next/image";
import { FormEvent, useEffect, useRef, useState } from "react";
import { apiUrl } from "./api-base";

type AccountRole = "tenant_owner" | "tenant_admin" | "finance_viewer";
export type AuthUser = {
  id: string; username: string; email?: string; displayName: string; tenantId: string; accountSetId: string;
  phone?: string; unit?: string; remark?: string; avatar?: string;
  role: AccountRole; isBootstrapAdmin: boolean; isRoot: boolean; isPlatformAdmin: boolean; canManageTenant: boolean; createdAt: string; updatedAt: string;
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
type CenterKind = "personal" | "admin" | "platform";
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
  const [invitationOpen, setInvitationOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setMenuOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); setPasswordOpen(false); setDialog(null); } };
    document.addEventListener("mousedown", closeOutside); document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("mousedown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, []);
  useEffect(() => {
    let disposed = false;
    const refreshInvitations = async () => {
      try {
        const data = await request<AccountCenter>("/api/auth/account-center");
        if (!disposed) setCenter(data);
      } catch { /* 页面级会话负责处理失效登录 */ }
    };
    void refreshInvitations();
    const timer = window.setInterval(() => void refreshInvitations(), 30_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [user.id]);
  async function request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(apiUrl(path), { ...init, credentials: "include", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    const data = response.status === 204 ? undefined : await response.json();
    if (!response.ok) throw new Error(data?.error || "操作失败");
    return data as T;
  }
  async function loadCenter(scope: "platform" | "tenant" = "tenant") {
    const data = await request<AccountCenter>(`/api/auth/account-center?scope=${scope}`);
    setCenter(data); return data;
  }
  async function openCenter(kind: CenterKind) {
    setMenuOpen(false); setDialog(kind); setError(""); setNotice(""); setWorking(true);
    try { await loadCenter(kind === "platform" ? "platform" : "tenant"); } catch (caught) { setError(errorMessage(caught)); } finally { setWorking(false); }
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
  async function createMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    await action(async () => { await request("/api/auth/admin/members", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); await loadCenter(); formElement.reset(); }, "用户已创建");
  }
  async function updateTeam(teamId: string, name: string) {
    await action(async () => { await request(`/api/auth/admin/teams/${encodeURIComponent(teamId)}`, { method: "PATCH", body: JSON.stringify({ name }) }); await loadCenter(); }, "组织已更新");
  }
  async function deleteTeam(teamId: string) {
    await action(async () => { await request(`/api/auth/admin/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" }); await loadCenter(); }, "组织已删除");
  }
  async function respondInvitation(invitation: IncomingInvitation, accept: boolean) {
    await action(async () => { const data = await request<AccountCenter>(`/api/auth/invitations/${encodeURIComponent(invitation.id)}/${accept ? "accept" : "reject"}`, { method: "POST" }); setCenter(data); if (accept) await onContextChanged(data.user); }, accept ? "已加入组织" : "已拒绝邀请");
  }
  async function respondSidebarInvitation(accept: boolean) {
    const invitation = center?.invitations[0];
    if (!invitation) return;
    await respondInvitation(invitation, accept);
    if (accept || center?.invitations.length === 1) setInvitationOpen(false);
  }
  async function changeRole(member: AdminMember, role: AccountRole) {
    await action(async () => { await request(`/api/auth/admin/members/${encodeURIComponent(member.userId)}`, { method: "PATCH", body: JSON.stringify({ tenantId: member.tenantId, role }) }); await loadCenter(); }, "成员角色已更新");
  }
  async function updateMember(member: AdminMember, input: { phone: string; email: string; role: AccountRole }) {
    await action(async () => { await request(`/api/auth/admin/members/${encodeURIComponent(member.userId)}/profile`, { method: "PATCH", body: JSON.stringify({ ...input, tenantId: member.tenantId }) }); await loadCenter(); }, "用户信息已更新");
  }
  async function removeMember(member: AdminMember) {
    await action(async () => { await request(`/api/auth/admin/members/${encodeURIComponent(member.userId)}`, { method: "DELETE", body: JSON.stringify({ tenantId: member.tenantId }) }); await loadCenter(); }, "用户已移除");
  }
  async function resetMemberPassword(member: AdminMember, newPassword: string, confirmPassword: string) {
    await action(async () => { await request(`/api/auth/admin/members/${encodeURIComponent(member.userId)}/reset-password`, { method: "POST", body: JSON.stringify({ tenantId: member.tenantId, newPassword, confirmPassword }) }); }, "密码已重置");
  }
  const activeTeam = center?.teams.find((team) => team.active);
  const pendingInvitation = center?.invitations[0];
  return <div className="account-entry" ref={root}>
    {menuOpen && <div className="account-menu" role="menu">
      <button role="menuitem" onClick={() => void openCenter("personal")}>个人中心</button>
      {user.isPlatformAdmin && <button role="menuitem" onClick={() => void openCenter("platform")}>平台管理中心</button>}
      <button role="menuitem" onClick={() => void openCenter("admin")}>{user.canManageTenant ? "组织管理中心" : "组织信息"}</button>
      <button role="menuitem" disabled={working} onClick={() => void logout()}>退出登录</button>
      <button role="menuitem" className="danger" onClick={() => { setDialog("delete"); setMenuOpen(false); setConfirmation(""); setError(""); }}>注销账户</button>
    </div>}
    <button className="profile profile-button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
      <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>{user.isRoot ? "平台管理员" : roleLabel(user.role)}</small></span><span className="more">•••</span>
    </button>
    {center && center.invitations.length > 0 && <button type="button" className="sidebar-invitation-alert" onClick={() => { setInvitationOpen(true); setMenuOpen(false); }}><span className="sidebar-invitation-dot">!</span><span><strong>待处理团队邀请</strong><small>{center.invitations.length > 1 ? `${center.invitations.length} 条邀请` : "点击查看邀请"}</small></span></button>}
    {invitationOpen && pendingInvitation && <div className="modal-backdrop invitation-popup-backdrop" onMouseDown={() => !working && setInvitationOpen(false)}><section className="invitation-popup" role="dialog" aria-modal="true" aria-labelledby="invitation-popup-title" onMouseDown={(event) => event.stopPropagation()}><header><h2 id="invitation-popup-title">团队邀请</h2><button type="button" aria-label="关闭" disabled={working} onClick={() => setInvitationOpen(false)}>×</button></header><p><strong>{pendingInvitation.invitedBy}</strong> 邀请你加入组织「{pendingInvitation.tenantName}」，以“{roleLabel(pendingInvitation.role)}”身份加入。</p><footer><button type="button" className="secondary" disabled={working} onClick={() => void respondSidebarInvitation(false)}>取消</button><button type="button" className="primary-action" disabled={working} onClick={() => void respondSidebarInvitation(true)}>加入</button></footer></section></div>}
    {dialog && <div className={`modal-backdrop account-dialog-backdrop ${dialog === "personal" ? "personal-center-backdrop" : ""}`} onMouseDown={() => !working && setDialog(null)}>
      <section className={`account-dialog ${dialog === "personal" ? "personal-center-dialog" : dialog === "admin" || dialog === "platform" ? "account-center-dialog" : ""}`} role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2 id="account-dialog-title">{dialog === "personal" ? "个人信息" : dialog === "platform" ? "平台管理中心" : dialog === "admin" ? "组织管理中心" : "注销账户"}</h2>{dialog !== "personal" && <p>{dialog === "platform" ? "管理全平台组织、用户与平台配置" : dialog === "admin" ? "管理本组织成员与业务资源" : "此操作会立即使当前账户和全部会话失效。"}</p>}</div><button aria-label={dialog === "personal" ? "返回" : "关闭"} disabled={working} onClick={() => setDialog(null)}>{dialog === "personal" ? "←" : "×"}</button></header>
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
              {working && !center ? <p className="center-empty">正在加载…</p> : <AdminCenter section={adminSection} center={center} activeTeam={activeTeam} switchTeam={switchTeam} createTeam={createTeam} updateTeam={updateTeam} deleteTeam={deleteTeam} invite={invite} createMember={createMember} changeRole={changeRole} updateMember={updateMember} removeMember={removeMember} resetMemberPassword={resetMemberPassword} respondInvitation={respondInvitation} working={working} />}
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

function OrganizationManagement({ admin, canDelete, incomingInvitations, query, setQuery, createTeam, updateTeam, deleteTeam, working }: { admin: NonNullable<AccountCenter["admin"]>; canDelete: boolean; incomingInvitations: React.ReactNode; query: string; setQuery: (value: string) => void; createTeam: (event: FormEvent<HTMLFormElement>) => Promise<void>; updateTeam: (teamId: string, name: string) => Promise<void>; deleteTeam: (teamId: string) => Promise<void>; working: boolean }) {
  const [editing, setEditing] = useState<AdminTeam | null>(null);
  const [deleting, setDeleting] = useState<AdminTeam | null>(null);
  const teams = admin.teams.filter((team) => team.name.toLowerCase().includes(query.toLowerCase()));
  return <>{incomingInvitations}<CenterSection title="组织管理" description="管理组织信息和成员归属。"><div className="admin-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索组织" /><form onSubmit={(event) => void createTeam(event)}><input name="name" placeholder="组织名称" required /><button disabled={working}>＋ 新增组织</button></form></div><div className="management-table organization-table"><div className="table-row table-head"><span>组织名称</span><span>组织管理员</span><span>成员数</span><span>创建时间</span><span>操作</span></div>{teams.map((team) => <div className="table-row" key={team.id}><strong>{team.name}</strong><span>{team.administrators.join("、") || "--"}</span><span>{team.memberCount}</span><span>{new Date(team.createdAt).toLocaleString()}</span><span className="table-actions organization-actions"><button type="button" onClick={() => setEditing(team)}>编辑</button><button type="button" className="delete-action" disabled={!canDelete} title={!canDelete ? "只有组织管理员可以删除" : "删除组织"} onClick={() => setDeleting(team)}>删除</button></span></div>)}</div>{editing && <div className="user-action-backdrop" onMouseDown={() => setEditing(null)}><section className="user-action-dialog" onMouseDown={(event) => event.stopPropagation()}><header><h3>编辑组织</h3><button type="button" onClick={() => setEditing(null)}>×</button></header><form className="user-action-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void updateTeam(editing.id, String(form.get("name") || "")).then(() => setEditing(null)); }}><label><span><b>*</b> 组织名称</span><input name="name" defaultValue={editing.name} required /></label><label><span>组织描述</span><textarea placeholder="请输入" maxLength={100} /></label><footer className="user-action-dialog-footer"><button type="button" className="secondary" onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={working}>确定</button></footer></form></section></div>}{deleting && <div className="user-action-backdrop" onMouseDown={() => setDeleting(null)}><section className="delete-confirm-dialog" onMouseDown={(event) => event.stopPropagation()}><header><h3>提示</h3><button type="button" onClick={() => setDeleting(null)}>×</button></header><p><span className="warning-icon">!</span>该组织删除后不可恢复，是否确认删除？</p><footer className="user-action-dialog-footer"><button type="button" className="secondary" onClick={() => setDeleting(null)}>取消</button><button type="button" className="danger-confirm" disabled={working} onClick={() => void deleteTeam(deleting.id).then(() => setDeleting(null))}>确定</button></footer></section></div>}</CenterSection></>;
}

function AdminCenter({ section, center, activeTeam, switchTeam, createTeam, updateTeam, deleteTeam, invite, createMember, changeRole, updateMember, removeMember, resetMemberPassword, respondInvitation, working }: {
  section: AdminSection; center: AccountCenter | null; activeTeam?: Team; switchTeam: (id: string) => Promise<void>; createTeam: (event: FormEvent<HTMLFormElement>) => Promise<void>; updateTeam: (teamId: string, name: string) => Promise<void>; deleteTeam: (teamId: string) => Promise<void>; invite: (event: FormEvent<HTMLFormElement>) => Promise<void>; createMember: (event: FormEvent<HTMLFormElement>) => Promise<void>; changeRole: (member: AdminMember, role: AccountRole) => Promise<void>; updateMember: (member: AdminMember, input: { phone: string; email: string; role: AccountRole }) => Promise<void>; removeMember: (member: AdminMember) => Promise<void>; resetMemberPassword: (member: AdminMember, newPassword: string, confirmPassword: string) => Promise<void>; respondInvitation: (invitation: IncomingInvitation, accept: boolean) => Promise<void>; working: boolean;
}) {
  const [query, setQuery] = useState("");
  const [userModal, setUserModal] = useState<"create" | "invite" | null>(null);
  const [orgEditState, setOrgEdit] = useState<AdminTeam | null>(null);
  const orgEdit = orgEditState as AdminTeam;
  if (!center) return null;
  if (!center.admin) return <ReadOnlyOrganization center={center} />;
  if (!center.admin) return <CenterSection title="组织邀请" description="你没有组织管理权限；管理员发给你的邀请会显示在这里。"><div className="invitation-list">{center.invitations.length ? center.invitations.map((invitation) => <article key={invitation.id}><div><strong>{invitation.tenantName}</strong><small>{invitation.invitedBy} 邀请你以“{roleLabel(invitation.role)}”身份加入 · {new Date(invitation.createdAt).toLocaleString()}</small></div><div><button className="secondary" disabled={working} onClick={() => void respondInvitation(invitation, false)}>拒绝</button><button disabled={working} onClick={() => void respondInvitation(invitation, true)}>接受邀请</button></div></article>) : <p className="center-empty">暂无待处理邀请。</p>}</div></CenterSection>;
  const admin = center.admin;
  const incomingInvitations = center.invitations.length > 0 && <CenterSection title="待处理邀请" description="你收到的组织邀请需要先确认，确认后即可加入对应组织。"><div className="invitation-list">{center.invitations.map((invitation) => <article key={invitation.id}><div><strong>{invitation.tenantName}</strong><small>{invitation.invitedBy} 邀请你以“{roleLabel(invitation.role)}”身份加入 · {new Date(invitation.createdAt).toLocaleString()}</small></div><div><button className="secondary" disabled={working} onClick={() => void respondInvitation(invitation, false)}>拒绝</button><button disabled={working} onClick={() => void respondInvitation(invitation, true)}>接受邀请</button></div></article>)}</div></CenterSection>;
  if (section === "organizations") return <OrganizationManagement admin={admin} canDelete={center.user.role === "tenant_owner" || center.user.role === "tenant_admin"} incomingInvitations={incomingInvitations} query={query} setQuery={setQuery} createTeam={createTeam} updateTeam={updateTeam} deleteTeam={deleteTeam} working={working} />;
  if (section === "users") return <UserManagement admin={admin} activeTeam={activeTeam} query={query} setQuery={setQuery} switchTeam={switchTeam} createMember={createMember} invite={invite} changeRole={changeRole} updateMember={updateMember} removeMember={removeMember} resetMemberPassword={resetMemberPassword} incomingInvitations={incomingInvitations} working={working} />;
  if (false) {
    const teams = admin.teams.filter((team) => team.name.toLowerCase().includes(query.toLowerCase()));
    return <>{incomingInvitations}<CenterSection title="组织管理" description="管理组织信息和成员归属。"><div className="admin-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索组织" /><form onSubmit={(event) => void createTeam(event)}><input name="name" minLength={2} maxLength={80} placeholder="组织名称" required /><button disabled={working}>＋ 新增组织</button></form></div><div className="management-table organization-table"><div className="table-row table-head"><span>组织名称</span><span>组织管理员</span><span>成员数</span><span>创建时间</span><span>操作</span></div>{teams.map((team) => <div className="table-row" key={team.id}><strong>{team.name}</strong><span>{team.administrators.join("、") || "--"}</span><span>{team.memberCount}</span><span>{new Date(team.createdAt).toLocaleString()}</span><span className="table-actions"><button type="button" onClick={() => setOrgEdit(team)}>编辑</button></span></div>)}</div>{orgEdit && <div className="user-action-backdrop" onMouseDown={() => setOrgEdit(null)}><section className="user-action-dialog" onMouseDown={(event) => event.stopPropagation()}><header><h3>编辑组织</h3><button type="button" onClick={() => setOrgEdit(null)}>×</button></header><form className="user-action-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void updateTeam(orgEdit.id, String(form.get("name") || "")).then(() => setOrgEdit(null)); }}><label><span>组织图标</span><div className="org-icon-upload">点击上传图片</div></label><label><span><b>*</b> 组织名称</span><input name="name" defaultValue={orgEdit.name} required /></label><label><span>组织描述</span><textarea name="description" placeholder="请输入" maxLength={100} /></label><footer className="user-action-dialog-footer"><button type="button" className="secondary" onClick={() => setOrgEdit(null)}>取消</button><button type="submit" disabled={working}>确定</button></footer></form></section></div>}</CenterSection></>;
    return <>{incomingInvitations}<CenterSection title="组织管理" description="管理组织信息和成员归属。"><div className="admin-toolbar"><input aria-label="搜索组织" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索组织" /><form onSubmit={(event) => void createTeam(event)}><input name="name" minLength={2} maxLength={80} placeholder="组织名称" required /><button disabled={working}>＋ 新增组织</button></form></div><div className="management-table organization-table"><div className="table-row table-head"><span>组织名称</span><span>组织管理员</span><span>成员数</span><span>创建时间</span><span>操作</span></div>{teams.map((team) => <div className="table-row" key={team.id}><strong>{team.name}</strong><span>{team.administrators.join("、") || "--"}</span><span>{team.memberCount}</span><span>{new Date(team.createdAt).toLocaleString()}</span><span className="table-actions"><button type="button" disabled title="后续支持重命名">编辑</button></span></div>)}</div></CenterSection></>;
  }
  const members = admin.members.filter((member) => `${member.displayName} ${member.username} ${member.email || ""}`.toLowerCase().includes(query.toLowerCase()));
  if (section === "users") return <>{incomingInvitations}<CenterSection title="用户管理" description={`管理组织用户、角色与邀请。当前组织：${activeTeam?.name || "-"}`}><div className="admin-toolbar user-toolbar"><label className="team-switcher"><span>当前团队</span><select value={activeTeam?.id || ""} disabled={working} onChange={(event) => void switchTeam(event.target.value)}>{center.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><input className="user-search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="用户名或邮箱搜索" /><div className="user-action-buttons"><button type="button" className="secondary" onClick={() => setUserModal("create")}>＋ 新增用户</button><button type="button" onClick={() => setUserModal("invite")}>邀请用户</button></div></div><div className="management-table user-table"><div className="table-row table-head"><span>用户名</span><span>角色</span><span>手机号</span><span>状态</span><span>创建时间</span><span>操作</span></div>{members.map((member) => <div className="table-row" key={member.userId}><span className="user-cell"><span className="mini-avatar">{member.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{member.displayName}</strong><small>{member.email || member.username}</small></span></span><span>{member.role === "tenant_owner" ? "Owner" : <select value={member.role} disabled={working} onChange={(event) => void changeRole(member, event.target.value as AccountRole)}><option value="tenant_admin">组织管理员</option><option value="finance_analyst">分析成员</option><option value="finance_viewer">普通成员</option></select>}</span><span>{member.phone || "--"}</span><span className={`status-pill ${member.status}`}>{member.status === "active" ? "启用" : "停用"}</span><span>{new Date(member.createdAt).toLocaleString()}</span><span className="table-actions"><button type="button">编辑</button></span></div>)}</div></CenterSection>{userModal && <div className="user-action-backdrop" onMouseDown={() => setUserModal(null)}><section className="user-action-dialog" onMouseDown={(event) => event.stopPropagation()}><header><h3>{userModal === "create" ? "新增用户" : "邀请用户"}</h3><button type="button" onClick={() => setUserModal(null)}>×</button></header><form className="user-action-form" onSubmit={(event) => { if (userModal === "create") void createMember(event).then(() => setUserModal(null)); else void invite(event).then(() => setUserModal(null)); }}><label><span><b>*</b> {userModal === "create" ? "用户名" : "选择用户"}</span>{userModal === "create" ? <input name="username" required placeholder="请输入用户名" /> : <select name="identifier" defaultValue="" required><option value="" disabled>请搜索选择</option>{admin.members.map((member) => <option key={member.userId} value={member.username}>{member.displayName}（{member.username}）</option>)}</select>}</label>{userModal === "create" && <><label><span><b>*</b> 密码</span><input name="password" type="password" required placeholder="请输入密码" /></label><label><span><b>*</b> 手机号</span><input name="phone" required placeholder="请输入手机号" /></label><label><span>电子邮箱</span><input name="email" type="email" placeholder="请输入" /></label></>}<input type="hidden" name="role" value="finance_viewer" /><footer className="user-action-dialog-footer"><button type="button" className="secondary" onClick={() => setUserModal(null)}>取消</button><button type="submit" disabled={working}>确定</button></footer></form></section></div>}</>;
  return <>{incomingInvitations}<CenterSection title="用户管理" description={`管理组织用户、角色与邀请。当前组织：${activeTeam?.name || "-"}`}><div className="admin-toolbar user-toolbar"><label className="team-switcher"><span>当前团队</span><select aria-label="切换团队" value={activeTeam?.id || ""} disabled={working} onChange={(event) => void switchTeam(event.target.value)}>{center.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><input aria-label="用户名或邮箱搜索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="用户名/邮箱搜索" /><form className="invite-inline-form" onSubmit={(event) => void invite(event)}><input name="identifier" placeholder="用户名或邮箱" required />{admin.scope === "platform" && <select name="tenantId" defaultValue={activeTeam?.id}>{admin.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select>}<select name="role" defaultValue="finance_viewer"><option value="finance_viewer">普通成员</option><option value="finance_analyst">分析成员</option><option value="tenant_admin">组织管理员</option></select><button disabled={working}>邀请用户</button></form></div>{admin.invitations.length > 0 && <div className="pending-invitations"><strong>待确认邀请</strong>{admin.invitations.map((item) => <span key={item.id}>{item.identifier} · {roleLabel(item.role)}</span>)}</div>}<div className="management-table user-table"><div className="table-row table-head"><span>用户名</span><span>角色</span><span>手机号</span><span>状态</span><span>创建时间</span><span>操作</span></div>{members.map((member) => <div className="table-row" key={`${member.tenantId}-${member.userId}`}><span className="user-cell"><span className="mini-avatar">{member.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{member.displayName}</strong><small>{member.email || member.username}</small></span></span><span>{member.role === "tenant_owner" ? "Owner" : <select aria-label={`设置 ${member.displayName} 的角色`} value={member.role} disabled={working} onChange={(event) => void changeRole(member, event.target.value as AccountRole)}><option value="tenant_admin">组织管理员</option><option value="finance_analyst">分析成员</option><option value="finance_viewer">普通成员</option></select>}</span><span>{member.phone || "--"}</span><span className={`status-pill ${member.status}`}>{member.status === "active" ? "启用" : "停用"}</span><span>{new Date(member.createdAt).toLocaleString()}</span><span className="table-actions"><button type="button" disabled={member.role === "tenant_owner"}>编辑</button></span></div>)}</div></CenterSection></>;
}

function UserManagement({ admin, activeTeam, query, setQuery, switchTeam, createMember, invite, changeRole, updateMember, removeMember, resetMemberPassword, incomingInvitations, working }: {
  admin: NonNullable<AccountCenter["admin"]>; activeTeam?: Team; query: string; setQuery: (value: string) => void; switchTeam: (id: string) => Promise<void>; createMember: (event: FormEvent<HTMLFormElement>) => Promise<void>; invite: (event: FormEvent<HTMLFormElement>) => Promise<void>; changeRole: (member: AdminMember, role: AccountRole) => Promise<void>; updateMember: (member: AdminMember, input: { phone: string; email: string; role: AccountRole }) => Promise<void>; removeMember: (member: AdminMember) => Promise<void>; resetMemberPassword: (member: AdminMember, newPassword: string, confirmPassword: string) => Promise<void>; incomingInvitations: React.ReactNode; working: boolean;
}) {
  const [editing, setEditing] = useState<AdminMember | null>(null);
  const [removing, setRemoving] = useState<AdminMember | null>(null);
  const [resetting, setResetting] = useState<AdminMember | null>(null);
  const [modal, setModal] = useState<"create" | "invite" | null>(null);
  const members = admin.members.filter((member) => `${member.displayName} ${member.username} ${member.email || ""}`.toLowerCase().includes(query.toLowerCase()));
  const canManage = admin.scope === "platform" || activeTeam?.role === "tenant_admin";
  return <>{incomingInvitations}<CenterSection title="用户管理" description={`管理组织用户、角色与邀请。当前组织：${activeTeam?.name || "-"}`}>
    <div className="admin-toolbar user-toolbar"><label className="team-switcher"><span>当前团队</span><select value={activeTeam?.id || ""} disabled={working} onChange={(event) => void switchTeam(event.target.value)}>{admin.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><input className="user-search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="用户名或邮箱搜索" /><div className="user-action-buttons"><button type="button" className="secondary" onClick={() => setModal("create")}>＋ 新增用户</button><button type="button" onClick={() => setModal("invite")}>邀请用户</button></div></div>
    <div className="management-table user-table"><div className="table-row table-head"><span>用户名</span><span>角色</span><span>手机号</span><span>状态</span><span>创建时间</span><span>操作</span></div>{members.map((member) => <div className="table-row" key={`${member.tenantId}-${member.userId}`}><span className="user-cell"><span className="mini-avatar">{member.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{member.displayName}</strong><small>{member.email || member.username}</small></span></span><span>{member.role === "tenant_owner" ? "Owner" : <select aria-label={`设置 ${member.displayName} 的角色`} value={member.role} disabled={working} onChange={(event) => void changeRole(member, event.target.value as AccountRole)}><option value="tenant_admin">组织管理员</option><option value="finance_analyst">分析成员</option><option value="finance_viewer">普通成员</option></select>}</span><span>{member.phone || "--"}</span><span className={`status-pill ${member.status}`}>{member.status === "active" ? "启用" : "停用"}</span><span>{new Date(member.createdAt).toLocaleString()}</span><span className="table-actions member-actions"><button type="button" disabled={!canManage || member.role === "tenant_owner"} title={!canManage ? "只有组织管理员可以操作" : undefined} onClick={() => setEditing(member)}>编辑</button><button type="button" disabled={!canManage || member.role === "tenant_owner"} title={!canManage ? "只有组织管理员可以操作" : undefined} onClick={() => setRemoving(member)}>移除</button><button type="button" disabled={!canManage || member.role === "tenant_owner"} title={!canManage ? "只有组织管理员可以操作" : undefined} onClick={() => setResetting(member)}>重置密码</button></span></div>)}</div>
  </CenterSection>
  {modal && <div className="user-action-backdrop" onMouseDown={() => setModal(null)}><section className="user-action-dialog" onMouseDown={(event) => event.stopPropagation()}><header><h3>{modal === "create" ? "新增用户" : "邀请用户"}</h3><button type="button" onClick={() => setModal(null)}>×</button></header><form className="user-action-form" onSubmit={(event) => { const submit = modal === "create" ? createMember : invite; void submit(event).then(() => setModal(null)); }}><label><span><b>*</b> {modal === "create" ? "用户名" : "用户名或邮箱"}</span><input name={modal === "create" ? "username" : "identifier"} required /></label>{modal === "create" ? <><label><span><b>*</b> 密码</span><input name="password" type="password" minLength={8} required /></label><label><span><b>*</b> 手机号</span><input name="phone" required /></label><label><span>电子邮箱</span><input name="email" type="email" /></label><input type="hidden" name="role" value="finance_viewer" /></> : <><input type="hidden" name="tenantId" value={activeTeam?.id || ""} /><input type="hidden" name="role" value="finance_viewer" /></>}<footer className="user-action-dialog-footer"><button type="button" className="secondary" onClick={() => setModal(null)}>取消</button><button type="submit" disabled={working}>确定</button></footer></form></section></div>}
  {editing && <div className="user-action-backdrop" onMouseDown={() => setEditing(null)}><section className="user-action-dialog" onMouseDown={(event) => event.stopPropagation()}><header><h3>编辑用户</h3><button type="button" onClick={() => setEditing(null)}>×</button></header><form className="user-action-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void updateMember(editing, { phone: String(form.get("phone") || ""), email: String(form.get("email") || ""), role: String(form.get("role")) as AccountRole }).then(() => setEditing(null)); }}><label><span><b>*</b> 用户名</span><input value={editing.username} disabled /></label><label><span>密码</span><input value="******" disabled /></label><label><span><b>*</b> 手机号</span><input name="phone" defaultValue={editing.phone || ""} required /></label><label><span>电子邮箱</span><input name="email" type="email" defaultValue={editing.email || ""} placeholder="暂无邮箱" /></label><label><span>分配角色</span><select name="role" defaultValue={editing.role}><option value="finance_viewer">普通成员</option><option value="finance_analyst">分析成员</option><option value="tenant_admin">组织管理员</option></select></label><footer className="user-action-dialog-footer"><button type="button" className="secondary" onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={working}>确定</button></footer></form></section></div>}
  {removing && <div className="user-action-backdrop" onMouseDown={() => setRemoving(null)}><section className="delete-confirm-dialog" onMouseDown={(event) => event.stopPropagation()}><header><h3>提示</h3><button type="button" onClick={() => setRemoving(null)}>×</button></header><p><span className="warning-icon">!</span>该账户将从组织内移除，是否确认？</p><footer className="user-action-dialog-footer"><button type="button" className="secondary" onClick={() => setRemoving(null)}>取消</button><button type="button" className="danger-confirm" disabled={working} onClick={() => void removeMember(removing).then(() => setRemoving(null))}>确定</button></footer></section></div>}
  {resetting && <div className="user-action-backdrop" onMouseDown={() => setResetting(null)}><section className="user-action-dialog" onMouseDown={(event) => event.stopPropagation()}><header><h3>更改密码</h3><button type="button" onClick={() => setResetting(null)}>×</button></header><form className="user-action-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void resetMemberPassword(resetting, String(form.get("newPassword") || ""), String(form.get("confirmPassword") || "")).then(() => setResetting(null)); }}><label><span>新密码</span><input name="newPassword" type="password" minLength={8} maxLength={20} placeholder="请输入，密码需包含字母、数字，长度8-20" required /></label><label><span>确认新密码</span><input name="confirmPassword" type="password" minLength={8} maxLength={20} placeholder="请再次输入新密码" required /></label><footer className="user-action-dialog-footer"><button type="button" className="secondary" onClick={() => setResetting(null)}>取消</button><button type="submit" disabled={working}>确定</button></footer></form></section></div>}
  </>;
}

function ReadOnlyOrganization({ center }: { center: AccountCenter }) {
  const activeTeam = center.teams.find((team) => team.active) || center.teams[0];
  return <CenterSection title={"\u7EC4\u7EC7\u4FE1\u606F"} description={"\u5F53\u524D\u8D26\u6237\u6240\u5C5E\u7684\u7EC4\u7EC7\u4E0E\u89D2\u8272"}>
    <div className="team-list">
      {activeTeam && <article className="active"><div><strong>{activeTeam.name}</strong><small>{"\u5F53\u524D\u7EC4\u7EC7\u00B7\u6210\u5458\u6570\uFF1A"}{activeTeam.memberCount}</small></div><span>{roleLabel(activeTeam.role)}</span></article>}
      {center.teams.filter((team) => !team.active).map((team) => <article key={team.id}><div><strong>{team.name}</strong><small>{"\u6210\u5458\u6570\uFF1A"}{team.memberCount}</small></div><span>{roleLabel(team.role)}</span></article>)}
    </div>
    {center.invitations.length > 0 && <p className="center-notice success">{"\u4F60\u6709"} {center.invitations.length} {"\u6761\u5F85\u5904\u7406\u7684\u7EC4\u7EC7\u9080\u8BF7\u3002"}</p>}
  </CenterSection>;
}

function CenterSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="center-section"><header><h3>{title}</h3><p>{description}</p></header>{children}</section>; }
function DeletePanel({ confirmation, setConfirmation, error, working, cancel, confirm }: { confirmation: string; setConfirmation: (value: string) => void; error: string; working: boolean; cancel: () => void; confirm: () => void }) { return <div className="delete-account-confirm"><p>数据源和 Mapping 不会被跨租户误删；账户将被软删除且不能再次登录。请输入 <strong>DELETE</strong> 确认。</p><input aria-label="输入 DELETE 确认注销" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="DELETE" autoFocus />{error && <div className="auth-error" role="alert">{error}</div>}<div><button onClick={cancel} disabled={working}>取消</button><button className="delete-account-button" onClick={confirm} disabled={working || confirmation !== "DELETE"}>{working ? "正在注销…" : "永久注销账户"}</button></div></div>; }
function roleLabel(role: AccountRole) { return role === "tenant_owner" ? "团队 Owner" : role === "tenant_admin" ? "租户管理员" : "普通成员"; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }
