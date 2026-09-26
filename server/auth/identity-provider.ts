import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { RequestContext, Role } from "../core/types.js";
import type { AccountStore } from "./account-store.js";
import { sessionToken } from "./auth-routes.js";

export interface IdentityProvider {
  resolve(request: Request): RequestContext;
}

/** Cookie sessions are primary; a verified HS256 bearer token remains available
 * for existing service-to-service integrations when AUTH_JWT_SECRET is set. */
export class EnvironmentIdentityProvider implements IdentityProvider {
  constructor(private readonly accounts?: AccountStore) {}

  resolve(request: Request): RequestContext {
    const token = sessionToken(request);
    if (token && this.accounts) return this.accounts.authenticate(token).context;
    const secret = process.env.AUTH_JWT_SECRET?.trim();
    if (!secret) return this.accounts!.authenticate(token).context;
    const claims = verifyJwt(request, secret);
    const role = claims.role as Role;
    if (!(["tenant_admin", "finance_analyst", "finance_viewer"] as string[]).includes(role)) throw new Error("无效的用户角色");
    return {
      tenantId: safeId(claims.tenant_id, "租户"),
      accountSetId: safeId(claims.account_set_id, "账套"),
      userId: safeId(claims.sub, "用户"),
      role,
      sessionId: safeId(request.header("x-session-id")?.trim() || randomUUID(), "会话"),
    };
  }
}

type Claims = { sub: string; tenant_id: string; account_set_id: string; role: string; exp?: number };

function verifyJwt(request: Request, secret: string): Claims {
  const authorization = request.header("authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new Error("缺少登录凭证");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("登录凭证格式无效");
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = JSON.parse(base64UrlDecode(headerPart)) as { alg?: string };
  if (header.alg !== "HS256") throw new Error("不支持的登录凭证算法");
  const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
  const actual = Buffer.from(signaturePart.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("登录凭证签名无效");
  const claims = JSON.parse(base64UrlDecode(payloadPart)) as Claims;
  if (claims.exp && claims.exp * 1000 <= Date.now()) throw new Error("登录凭证已过期");
  return claims;
}

function base64UrlDecode(value: string) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function safeId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw new Error(`${label}标识无效`);
  return value;
}
