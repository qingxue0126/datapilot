import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import bcrypt from "bcryptjs";
import type { RequestContext, Role } from "../core/types.js";

export type Account = {
  id: string; username: string; email?: string; displayName: string; passwordHash: string;
  phone?: string; unit?: string; remark?: string; avatar?: string;
  /** Retained for backward-compatible account files; memberships are authoritative. */
  tenantId: string; accountSetId: string; role: Role; activeTenantId?: string;
  status: "active" | "deleted"; createdAt: string; updatedAt: string; deletedAt?: string;
};
export type Tenant = { id: string; name: string; accountSetId: string; createdBy: string; createdAt: string };
export type TenantMembership = { userId: string; tenantId: string; accountSetId: string; role: Role; joinedAt: string };
type TeamInvitation = { id: string; tenantId: string; identifier: string; role: Role; invitedBy: string; status: "pending" | "accepted" | "rejected"; createdAt: string; resolvedAt?: string };
type AuthSession = { id: string; tokenHash: string; userId: string; expiresAt: string; createdAt: string };
type StoredApiKey = { id: string; name: string; keyHash: string; userId: string; tenantId: string; accountSetId: string; enabled: boolean; createdAt: string; lastUsedAt?: string };
type StoredAuth = { accounts: Account[]; sessions: AuthSession[]; tenants: Tenant[]; memberships: TenantMembership[]; invitations: TeamInvitation[]; apiKeys: StoredApiKey[] };
export type PublicApiKey = Pick<StoredApiKey, "id" | "name" | "tenantId" | "enabled" | "createdAt" | "lastUsedAt">;

export type PublicAccount = {
  id: string; username: string; email?: string; displayName: string; tenantId: string; accountSetId: string; role: Role;
  phone?: string; unit?: string; remark?: string; avatar?: string;
  isBootstrapAdmin: boolean; isRoot: boolean; canManageTenant: boolean; createdAt: string; updatedAt: string;
};
export type TeamSummary = { id: string; name: string; accountSetId: string; role: Role; active: boolean; memberCount: number };

const defaultPath = resolve(process.cwd(), ".data", "accounts.json");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_ROLES: Role[] = ["tenant_owner", "tenant_admin"];

export class AccountStore {
  private state: StoredAuth;

  constructor(private readonly path = defaultPath, private readonly now = () => new Date()) {
    this.state = this.load();
    this.migrateLegacyState();
    this.pruneSessions();
  }

  async register(identifierInput: string, password: string, confirmPassword: string) {
    const identifier = normalizeIdentifier(identifierInput);
    validatePassword(password, confirmPassword);
    if (this.state.accounts.some((account) => account.status === "active" && matchesIdentifier(account, identifier))) throw new AuthError("用户名或邮箱已被注册", 409);
    const passwordHash = await bcrypt.hash(password, 12);
    if (this.state.accounts.some((account) => account.status === "active" && matchesIdentifier(account, identifier))) throw new AuthError("用户名或邮箱已被注册", 409);
    const timestamp = this.now().toISOString();
    const userId = randomUUID();
    const isEmail = identifier.includes("@");
    const bootstrapAccount = this.state.accounts.length === 0;
    const tenantId = bootstrapAccount ? (process.env.DEFAULT_TENANT_ID || "demo-tenant") : `tenant-${randomUUID()}`;
    const accountSetId = bootstrapAccount ? (process.env.DEFAULT_ACCOUNT_SET_ID || "default-account-set") : `account-set-${randomUUID()}`;
    const role: Role = bootstrapAccount ? "tenant_admin" : "tenant_owner";
    const account: Account = {
      id: userId, username: identifier, email: isEmail ? identifier : undefined,
      displayName: isEmail ? identifier.split("@")[0] : identifier, passwordHash,
      tenantId, accountSetId, role, activeTenantId: tenantId, status: "active", createdAt: timestamp, updatedAt: timestamp,
    };
    this.state.accounts.push(account);
    this.state.tenants.push({ id: tenantId, name: bootstrapAccount ? "默认团队" : `${account.displayName}的团队`, accountSetId, createdBy: userId, createdAt: timestamp });
    this.state.memberships.push({ userId, tenantId, accountSetId, role, joinedAt: timestamp });
    const token = this.issueSession(account.id);
    this.persist();
    return { user: this.toPublicAccount(account), token };
  }

  async login(identifierInput: string, password: string) {
    const identifier = normalizeIdentifier(identifierInput);
    const account = this.state.accounts.find((item) => item.status === "active" && matchesIdentifier(item, identifier));
    if (!account || !(await bcrypt.compare(password, account.passwordHash))) throw new AuthError("用户名、邮箱或密码错误", 401);
    const token = this.issueSession(account.id);
    this.persist();
    return { user: this.toPublicAccount(account), token };
  }

  authenticate(token?: string): { user: PublicAccount; context: RequestContext } {
    const account = this.authenticatedAccount(token);
    const session = this.sessionForToken(token)!;
    const membership = this.activeMembership(account);
    return { user: this.toPublicAccount(account), context: { userId: account.id, tenantId: membership.tenantId, accountSetId: membership.accountSetId, role: membership.role, sessionId: session.id } };
  }

  authenticateApiKey(key?: string): RequestContext {
    if (!key || !/^dp_[A-Za-z0-9_-]{32,}$/.test(key)) throw new AuthError("API Key 无效", 401);
    const record = this.state.apiKeys.find((item) => item.keyHash === hashToken(key));
    if (!record || !record.enabled) throw new AuthError("API Key 无效或已禁用", 401);
    const account = this.state.accounts.find((item) => item.id === record.userId && item.status === "active");
    const membership = account && this.state.memberships.find((item) => item.userId === account.id && item.tenantId === record.tenantId && item.accountSetId === record.accountSetId);
    if (!account || !membership) throw new AuthError("API Key 所属账户或团队已失效", 401);
    record.lastUsedAt = this.now().toISOString();
    this.persist();
    return { userId: account.id, tenantId: membership.tenantId, accountSetId: membership.accountSetId, role: membership.role, sessionId: `api-key:${record.id}` };
  }

  createApiKey(token: string | undefined, nameInput: unknown) {
    const account = this.authenticatedAccount(token);
    const membership = this.activeMembership(account);
    const name = String(nameInput || "").trim();
    if (name.length < 2 || name.length > 80) throw new AuthError("API Key 名称长度需为 2–80 个字符", 400);
    const key = `dp_${randomBytes(32).toString("base64url")}`;
    const record: StoredApiKey = { id: randomUUID(), name, keyHash: hashToken(key), userId: account.id, tenantId: membership.tenantId, accountSetId: membership.accountSetId, enabled: true, createdAt: this.now().toISOString() };
    this.state.apiKeys.push(record);
    this.persist();
    return { apiKey: this.publicApiKey(record), key };
  }

  listApiKeys(token: string | undefined) {
    const account = this.authenticatedAccount(token);
    const tenantId = this.activeMembership(account).tenantId;
    return this.state.apiKeys.filter((item) => item.userId === account.id && item.tenantId === tenantId).map((item) => this.publicApiKey(item));
  }

  setApiKeyEnabled(token: string | undefined, id: string, enabled: boolean) {
    const record = this.ownedApiKey(token, id);
    record.enabled = enabled;
    this.persist();
    return this.publicApiKey(record);
  }

  revokeApiKey(token: string | undefined, id: string) {
    const record = this.ownedApiKey(token, id);
    this.state.apiKeys = this.state.apiKeys.filter((item) => item.id !== record.id);
    this.persist();
  }

  accountCenter(token?: string) {
    const account = this.authenticatedAccount(token);
    const user = this.toPublicAccount(account);
    return { user, teams: this.teamsFor(account), invitations: this.incomingInvitations(account), admin: user.canManageTenant ? this.adminSnapshot(account) : undefined };
  }

  updateProfile(token: string | undefined, input: { displayName?: unknown; email?: unknown; phone?: unknown; unit?: unknown; remark?: unknown; avatar?: unknown }) {
    const account = this.authenticatedAccount(token);
    const displayName = String(input.displayName || "").trim();
    if (displayName.length < 2 || displayName.length > 64) throw new AuthError("显示名称长度需为 2–64 个字符", 400);
    const email = String(input.email || "").trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("请输入有效邮箱", 400);
    if (email && this.state.accounts.some((item) => item.id !== account.id && item.status === "active" && item.email?.toLowerCase() === email)) throw new AuthError("邮箱已被其他账户使用", 409);
    const phone = String(input.phone || "").trim();
    if (phone && !/^[+\d][\d\s-]{5,24}$/.test(phone)) throw new AuthError("请输入有效手机号", 400);
    const unit = String(input.unit || "").trim();
    const remark = String(input.remark || "").trim();
    if (unit.length > 100 || remark.length > 300) throw new AuthError("单位或备注内容过长", 400);
    const avatar = String(input.avatar || "").trim();
    if (avatar && (!/^data:image\/(?:png|jpeg|webp);base64,/.test(avatar) || avatar.length > 1_500_000)) throw new AuthError("头像格式无效或超过 1MB", 400);
    account.displayName = displayName;
    account.email = email || undefined;
    account.phone = phone || undefined;
    account.unit = unit || undefined;
    account.remark = remark || undefined;
    account.avatar = avatar || account.avatar;
    account.updatedAt = this.now().toISOString();
    this.persist();
    return this.toPublicAccount(account);
  }

  async changePassword(token: string | undefined, currentPassword: unknown, newPassword: unknown, confirmation: unknown) {
    const account = this.authenticatedAccount(token);
    if (!(await bcrypt.compare(String(currentPassword || ""), account.passwordHash))) throw new AuthError("当前密码错误", 400);
    const next = String(newPassword || "");
    validatePassword(next, String(confirmation || ""));
    account.passwordHash = await bcrypt.hash(next, 12);
    account.updatedAt = this.now().toISOString();
    this.state.sessions = this.state.sessions.filter((session) => session.userId !== account.id || session.tokenHash === hashToken(token || ""));
    this.persist();
  }

  switchTeam(token: string | undefined, tenantIdInput: unknown) {
    const account = this.authenticatedAccount(token);
    const tenantId = String(tenantIdInput || "").trim();
    const membership = this.state.memberships.find((item) => item.userId === account.id && item.tenantId === tenantId);
    if (!membership) throw new AuthError("只能切换到自己已加入的团队", 403);
    account.activeTenantId = membership.tenantId;
    account.tenantId = membership.tenantId;
    account.accountSetId = membership.accountSetId;
    account.role = membership.role;
    account.updatedAt = this.now().toISOString();
    this.persist();
    return this.accountCenter(token);
  }

  createTeam(token: string | undefined, nameInput: unknown) {
    const account = this.requireManager(token);
    const name = String(nameInput || "").trim();
    if (name.length < 2 || name.length > 80) throw new AuthError("团队名称长度需为 2–80 个字符", 400);
    const timestamp = this.now().toISOString();
    const tenant: Tenant = { id: `tenant-${randomUUID()}`, name, accountSetId: `account-set-${randomUUID()}`, createdBy: account.id, createdAt: timestamp };
    this.state.tenants.push(tenant);
    this.state.memberships.push({ userId: account.id, tenantId: tenant.id, accountSetId: tenant.accountSetId, role: "tenant_owner", joinedAt: timestamp });
    this.persist();
    return tenant;
  }

  inviteMember(token: string | undefined, input: { identifier?: unknown; role?: unknown; tenantId?: unknown }) {
    const manager = this.requireManager(token);
    const identifier = normalizeIdentifier(String(input.identifier || ""));
    const role = memberRole(input.role);
    const tenantId = this.managedTenantId(manager, input.tenantId);
    const duplicate = this.state.invitations.some((item) => item.tenantId === tenantId && item.identifier === identifier && item.status === "pending");
    if (duplicate) throw new AuthError("该成员已有待处理邀请", 409);
    const invitation: TeamInvitation = { id: randomUUID(), tenantId, identifier, role, invitedBy: manager.id, status: "pending", createdAt: this.now().toISOString() };
    this.state.invitations.push(invitation);
    this.persist();
    return { invitation, accepted: false };
  }

  respondToInvitation(token: string | undefined, invitationIdInput: unknown, accept: boolean) {
    const account = this.authenticatedAccount(token);
    const invitationId = String(invitationIdInput || "").trim();
    const invitation = this.state.invitations.find((item) => item.id === invitationId && item.status === "pending" && matchesIdentifier(account, item.identifier));
    if (!invitation) throw new AuthError("邀请不存在、已处理或不属于当前账户", 404);
    if (accept) this.acceptInvitation(invitation, account);
    else invitation.status = "rejected";
    invitation.resolvedAt = this.now().toISOString();
    this.persist();
    return this.accountCenter(token);
  }

  updateMemberRole(token: string | undefined, userIdInput: unknown, input: { role?: unknown; tenantId?: unknown }) {
    const manager = this.requireManager(token);
    const tenantId = this.managedTenantId(manager, input.tenantId);
    const userId = String(userIdInput || "").trim();
    const membership = this.state.memberships.find((item) => item.tenantId === tenantId && item.userId === userId);
    if (!membership) throw new AuthError("成员不存在或不属于可管理团队", 404);
    if (membership.role === "tenant_owner" && !this.isRoot(manager)) throw new AuthError("团队 Owner 角色只能由平台管理员调整", 403);
    membership.role = memberRole(input.role);
    const account = this.state.accounts.find((item) => item.id === userId);
    if (account?.activeTenantId === tenantId) { account.role = membership.role; account.updatedAt = this.now().toISOString(); }
    this.persist();
    return membership;
  }

  logout(token?: string) {
    if (!token) return;
    const tokenHash = hashToken(token);
    this.state.sessions = this.state.sessions.filter((item) => item.tokenHash !== tokenHash);
    this.persist();
  }

  deleteAccount(token?: string) {
    const account = this.authenticatedAccount(token);
    const timestamp = this.now().toISOString();
    account.status = "deleted"; account.deletedAt = timestamp; account.updatedAt = timestamp;
    this.state.sessions = this.state.sessions.filter((item) => item.userId !== account.id);
    this.state.apiKeys = this.state.apiKeys.filter((item) => item.userId !== account.id);
    this.persist();
  }

  private authenticatedAccount(token?: string) {
    if (!token) throw new AuthError("请先登录", 401);
    this.pruneSessions();
    const session = this.sessionForToken(token);
    const account = session && this.state.accounts.find((item) => item.id === session.userId && item.status === "active");
    if (!session || !account) throw new AuthError("登录状态已失效，请重新登录", 401);
    return account;
  }
  private ownedApiKey(token: string | undefined, id: string) {
    const account = this.authenticatedAccount(token);
    const tenantId = this.activeMembership(account).tenantId;
    const record = this.state.apiKeys.find((item) => item.id === id && item.userId === account.id && item.tenantId === tenantId);
    if (!record) throw new AuthError("API Key 不存在", 404);
    return record;
  }
  private publicApiKey(record: StoredApiKey): PublicApiKey {
    return {
      id: record.id, name: record.name, tenantId: record.tenantId,
      enabled: record.enabled, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt,
    };
  }
  private sessionForToken(token?: string) { return token ? this.state.sessions.find((item) => item.tokenHash === hashToken(token)) : undefined; }
  private requireManager(token?: string) {
    const account = this.authenticatedAccount(token);
    if (!this.isRoot(account) && !ADMIN_ROLES.includes(this.activeMembership(account).role)) throw new AuthError("仅团队管理员可执行此操作", 403);
    return account;
  }
  private managedTenantId(account: Account, requested: unknown) {
    const active = this.activeMembership(account).tenantId;
    const tenantId = String(requested || active).trim();
    if (!this.isRoot(account) && tenantId !== active) throw new AuthError("无权管理其他团队", 403);
    if (!this.state.tenants.some((tenant) => tenant.id === tenantId)) throw new AuthError("团队不存在", 404);
    return tenantId;
  }
  private activeMembership(account: Account) {
    const memberships = this.state.memberships.filter((item) => item.userId === account.id);
    const membership = memberships.find((item) => item.tenantId === account.activeTenantId) || memberships[0];
    if (!membership) throw new AuthError("账户未加入任何团队", 403);
    if (account.activeTenantId !== membership.tenantId) account.activeTenantId = membership.tenantId;
    return membership;
  }
  private teamsFor(account: Account): TeamSummary[] {
    const activeTenantId = this.activeMembership(account).tenantId;
    return this.state.memberships.filter((item) => item.userId === account.id).map((membership) => {
      const tenant = this.state.tenants.find((item) => item.id === membership.tenantId);
      return { id: membership.tenantId, name: tenant?.name || membership.tenantId, accountSetId: membership.accountSetId, role: membership.role, active: membership.tenantId === activeTenantId, memberCount: this.state.memberships.filter((item) => item.tenantId === membership.tenantId).length };
    });
  }
  private incomingInvitations(account: Account) {
    return this.state.invitations.filter((item) => item.status === "pending" && matchesIdentifier(account, item.identifier)).map((item) => {
      const tenant = this.state.tenants.find((entry) => entry.id === item.tenantId);
      const inviter = this.state.accounts.find((entry) => entry.id === item.invitedBy);
      return { id: item.id, tenantId: item.tenantId, tenantName: tenant?.name || item.tenantId, role: item.role, invitedBy: inviter?.displayName || inviter?.username || item.invitedBy, createdAt: item.createdAt };
    });
  }
  private adminSnapshot(account: Account) {
    const activeTenantId = this.activeMembership(account).tenantId;
    const tenantIds = this.isRoot(account) ? this.state.tenants.map((tenant) => tenant.id) : [activeTenantId];
    return {
      scope: this.isRoot(account) ? "platform" as const : "tenant" as const,
      teams: this.state.tenants.filter((tenant) => tenantIds.includes(tenant.id)).map((tenant) => ({ ...tenant, memberCount: this.state.memberships.filter((item) => item.tenantId === tenant.id).length, administrators: this.state.memberships.filter((item) => item.tenantId === tenant.id && ADMIN_ROLES.includes(item.role)).map((item) => this.state.accounts.find((account) => account.id === item.userId)?.displayName).filter(Boolean) })),
      members: this.state.memberships.filter((item) => tenantIds.includes(item.tenantId)).map((membership) => {
        const member = this.state.accounts.find((item) => item.id === membership.userId);
        return { ...membership, username: member?.username || "已删除账户", displayName: member?.displayName || "已删除账户", email: member?.email, phone: member?.phone, status: member?.status || "deleted", createdAt: member?.createdAt || membership.joinedAt };
      }),
      invitations: this.state.invitations.filter((item) => tenantIds.includes(item.tenantId) && item.status === "pending"),
      platform: this.isRoot(account) ? { tenantCount: this.state.tenants.length, userCount: this.state.accounts.filter((item) => item.status === "active").length } : undefined,
    };
  }
  private toPublicAccount(account: Account): PublicAccount {
    const membership = this.activeMembership(account);
    const isRoot = this.isRoot(account);
    return { id: account.id, username: account.username, email: account.email, displayName: account.displayName, phone: account.phone, unit: account.unit, remark: account.remark, avatar: account.avatar, tenantId: membership.tenantId, accountSetId: membership.accountSetId, role: membership.role, isBootstrapAdmin: isRoot, isRoot, canManageTenant: isRoot || ADMIN_ROLES.includes(membership.role), createdAt: account.createdAt, updatedAt: account.updatedAt };
  }
  private isRoot(account: Account) {
    const first = [...this.state.accounts].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
    const membership = this.state.memberships.find((item) => item.userId === account.id && item.tenantId === (process.env.DEFAULT_TENANT_ID || "demo-tenant"));
    return first?.id === account.id && membership?.role === "tenant_admin" && membership.accountSetId === (process.env.DEFAULT_ACCOUNT_SET_ID || "default-account-set");
  }
  private acceptInvitation(invitation: TeamInvitation, account: Account) {
    const tenant = this.state.tenants.find((item) => item.id === invitation.tenantId);
    if (!tenant) return;
    if (!this.state.memberships.some((item) => item.userId === account.id && item.tenantId === tenant.id)) this.state.memberships.push({ userId: account.id, tenantId: tenant.id, accountSetId: tenant.accountSetId, role: invitation.role, joinedAt: this.now().toISOString() });
    invitation.status = "accepted";
  }
  private issueSession(userId: string) {
    const token = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    this.state.sessions.push({ id: randomUUID(), tokenHash: hashToken(token), userId, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + SESSION_TTL_MS).toISOString() });
    return token;
  }
  private pruneSessions() { const now = this.now().getTime(); this.state.sessions = this.state.sessions.filter((item) => new Date(item.expiresAt).getTime() > now); }
  private load(): StoredAuth {
    if (!existsSync(this.path)) return { accounts: [], sessions: [], tenants: [], memberships: [], invitations: [], apiKeys: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredAuth>;
      return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [], sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [], tenants: Array.isArray(parsed.tenants) ? parsed.tenants : [], memberships: Array.isArray(parsed.memberships) ? parsed.memberships : [], invitations: Array.isArray(parsed.invitations) ? parsed.invitations : [], apiKeys: Array.isArray(parsed.apiKeys) ? parsed.apiKeys : [] };
    } catch { throw new Error("账户存储损坏，无法安全启动认证服务"); }
  }
  private migrateLegacyState() {
    let changed = false;
    for (const account of this.state.accounts) {
      if (!account.activeTenantId) { account.activeTenantId = account.tenantId; changed = true; }
      if (!this.state.tenants.some((tenant) => tenant.id === account.tenantId)) { this.state.tenants.push({ id: account.tenantId, name: account.tenantId === (process.env.DEFAULT_TENANT_ID || "demo-tenant") ? "默认团队" : `${account.displayName}的团队`, accountSetId: account.accountSetId, createdBy: account.id, createdAt: account.createdAt }); changed = true; }
      if (!this.state.memberships.some((membership) => membership.userId === account.id && membership.tenantId === account.tenantId)) { this.state.memberships.push({ userId: account.id, tenantId: account.tenantId, accountSetId: account.accountSetId, role: account.role, joinedAt: account.createdAt }); changed = true; }
    }
    if (changed) this.persist();
  }
  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export class AuthError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function normalizeIdentifier(value: string) {
  const identifier = String(value || "").trim().toLowerCase();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
  const validUsername = /^[\p{L}\p{N}_.-]{2,64}$/u.test(identifier);
  if (!(identifier.includes("@") ? validEmail && identifier.length <= 254 : validUsername)) throw new AuthError("请输入有效的用户名或邮箱", 400);
  return identifier;
}
function validatePassword(password: string, confirmation: string) {
  if (password !== confirmation) throw new AuthError("两次输入的密码不一致", 400);
  if (password.length < 8 || password.length > 128) throw new AuthError("密码长度需为 8–128 个字符", 400);
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new AuthError("密码必须同时包含字母和数字", 400);
}
function memberRole(value: unknown): Role {
  const role = String(value || "finance_viewer") as Role;
  if (!["tenant_admin", "finance_analyst", "finance_viewer"].includes(role)) throw new AuthError("成员角色无效", 400);
  return role;
}
function matchesIdentifier(account: Account, identifier: string) { return account.username.toLowerCase() === identifier || account.email?.toLowerCase() === identifier; }
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
