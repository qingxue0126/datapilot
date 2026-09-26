import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import bcrypt from "bcryptjs";
import type { RequestContext, Role } from "../core/types.js";

export type Account = {
  id: string;
  username: string;
  email?: string;
  displayName: string;
  passwordHash: string;
  tenantId: string;
  accountSetId: string;
  role: Role;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

type AuthSession = {
  id: string;
  tokenHash: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
};

type StoredAuth = { accounts: Account[]; sessions: AuthSession[] };
export type PublicAccount = Omit<Account, "passwordHash" | "status" | "deletedAt"> & { isBootstrapAdmin: boolean };

const defaultPath = resolve(process.cwd(), ".data", "accounts.json");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class AccountStore {
  private state: StoredAuth;

  constructor(private readonly path = defaultPath, private readonly now = () => new Date()) {
    this.state = this.load();
    this.pruneSessions();
  }

  async register(identifierInput: string, password: string, confirmPassword: string) {
    const identifier = normalizeIdentifier(identifierInput);
    validatePassword(password, confirmPassword);
    if (this.state.accounts.some((account) => account.status === "active" && matchesIdentifier(account, identifier))) {
      throw new AuthError("用户名或邮箱已被注册", 409);
    }
    const passwordHash = await bcrypt.hash(password, 12);
    if (this.state.accounts.some((account) => account.status === "active" && matchesIdentifier(account, identifier))) {
      throw new AuthError("用户名或邮箱已被注册", 409);
    }
    const timestamp = this.now().toISOString();
    const userId = randomUUID();
    const isEmail = identifier.includes("@");
    const bootstrapAccount = this.state.accounts.length === 0;
    const account: Account = {
      id: userId,
      username: identifier,
      email: isEmail ? identifier : undefined,
      displayName: isEmail ? identifier.split("@")[0] : identifier,
      passwordHash,
      tenantId: bootstrapAccount ? (process.env.DEFAULT_TENANT_ID || "demo-tenant") : `tenant-${randomUUID()}`,
      accountSetId: bootstrapAccount ? (process.env.DEFAULT_ACCOUNT_SET_ID || "default-account-set") : `account-set-${randomUUID()}`,
      role: "tenant_admin",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.accounts.push(account);
    const token = this.issueSession(account.id);
    this.persist();
    return { user: publicAccount(account, this.state.accounts), token };
  }

  async login(identifierInput: string, password: string) {
    const identifier = normalizeIdentifier(identifierInput);
    const account = this.state.accounts.find((item) => item.status === "active" && matchesIdentifier(item, identifier));
    if (!account || !(await bcrypt.compare(password, account.passwordHash))) {
      throw new AuthError("用户名、邮箱或密码错误", 401);
    }
    const token = this.issueSession(account.id);
    this.persist();
    return { user: publicAccount(account, this.state.accounts), token };
  }

  authenticate(token?: string): { user: PublicAccount; context: RequestContext } {
    if (!token) throw new AuthError("请先登录", 401);
    this.pruneSessions();
    const session = this.state.sessions.find((item) => item.tokenHash === hashToken(token));
    const account = session && this.state.accounts.find((item) => item.id === session.userId && item.status === "active");
    if (!session || !account) throw new AuthError("登录状态已失效，请重新登录", 401);
    return {
      user: publicAccount(account, this.state.accounts),
      context: {
        userId: account.id,
        tenantId: account.tenantId,
        accountSetId: account.accountSetId,
        role: account.role,
        sessionId: session.id,
      },
    };
  }

  logout(token?: string) {
    if (!token) return;
    const tokenHash = hashToken(token);
    this.state.sessions = this.state.sessions.filter((item) => item.tokenHash !== tokenHash);
    this.persist();
  }

  deleteAccount(token?: string) {
    const authenticated = this.authenticate(token);
    const account = this.state.accounts.find((item) => item.id === authenticated.user.id)!;
    const timestamp = this.now().toISOString();
    account.status = "deleted";
    account.deletedAt = timestamp;
    account.updatedAt = timestamp;
    this.state.sessions = this.state.sessions.filter((item) => item.userId !== account.id);
    this.persist();
  }

  private issueSession(userId: string) {
    const token = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    this.state.sessions.push({
      id: randomUUID(),
      tokenHash: hashToken(token),
      userId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + SESSION_TTL_MS).toISOString(),
    });
    return token;
  }

  private pruneSessions() {
    const now = this.now().getTime();
    this.state.sessions = this.state.sessions.filter((item) => new Date(item.expiresAt).getTime() > now);
  }

  private load(): StoredAuth {
    if (!existsSync(this.path)) return { accounts: [], sessions: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoredAuth;
      return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [], sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    } catch {
      throw new Error("账户存储损坏，无法安全启动认证服务");
    }
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export class AuthError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function normalizeIdentifier(value: string) {
  const identifier = String(value || "").trim().toLowerCase();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
  const validUsername = /^[\p{L}\p{N}_.-]{2,64}$/u.test(identifier);
  if (!(identifier.includes("@") ? validEmail && identifier.length <= 254 : validUsername)) {
    throw new AuthError("请输入有效的用户名或邮箱", 400);
  }
  return identifier;
}

function validatePassword(password: string, confirmation: string) {
  if (password !== confirmation) throw new AuthError("两次输入的密码不一致", 400);
  if (password.length < 8 || password.length > 128) throw new AuthError("密码长度需为 8–128 个字符", 400);
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new AuthError("密码必须同时包含字母和数字", 400);
}

function matchesIdentifier(account: Account, identifier: string) {
  return account.username.toLowerCase() === identifier || account.email?.toLowerCase() === identifier;
}
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function publicAccount(account: Account, accounts: Account[]): PublicAccount {
  const firstAccount = [...accounts].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
  return {
    id: account.id,
    username: account.username,
    email: account.email,
    displayName: account.displayName,
    tenantId: account.tenantId,
    accountSetId: account.accountSetId,
    role: account.role,
    isBootstrapAdmin: firstAccount?.id === account.id
      && account.role === "tenant_admin"
      && account.tenantId === (process.env.DEFAULT_TENANT_ID || "demo-tenant")
      && account.accountSetId === (process.env.DEFAULT_ACCOUNT_SET_ID || "default-account-set"),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
