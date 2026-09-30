import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { RequestContext } from "../core/types.js";

export type ApiKeyAuditEntry = {
  requestId: string; method: string; path: string; userId: string; tenantId: string; accountSetId: string;
  role: string; status: number; durationMs: number; ip?: string;
};

export function createApiKeyGuard(
  identity: (request: Request) => RequestContext,
  options: { limit?: number; now?: () => number; log?: (entry: ApiKeyAuditEntry) => void } = {},
) {
  const limiter = new ApiKeyRateLimiter(options.limit ?? configuredLimit(), 60_000, options.now);
  return (request: Request, response: Response, next: NextFunction) => {
    let context: RequestContext;
    try { context = identity(request); }
    catch { return next(); }
    if (!context.sessionId.startsWith("api-key:")) return next();

    const requestId = randomUUID();
    const started = Date.now();
    const decision = limiter.consume(context.sessionId);
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("X-RateLimit-Limit", String(decision.limit));
    response.setHeader("X-RateLimit-Remaining", String(decision.remaining));
    const writeAudit = () => (options.log || defaultAudit)({
      requestId, method: request.method, path: request.path, userId: context.userId, tenantId: context.tenantId,
      accountSetId: context.accountSetId, role: context.role, status: response.statusCode,
      durationMs: Date.now() - started, ip: request.ip,
    });
    response.once("finish", writeAudit);
    if (!decision.allowed) {
      response.setHeader("Retry-After", String(decision.retryAfterSeconds));
      return response.status(429).json({ error: "API Key 请求过于频繁，请稍后重试", requestId });
    }
    return next();
  };
}

export class ApiKeyRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000, private readonly now = () => Date.now()) {}
  consume(key: string) {
    const current = this.now();
    let window = this.windows.get(key);
    if (!window || current - window.startedAt >= this.windowMs) {
      window = { startedAt: current, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return {
      allowed: window.count <= this.limit, limit: this.limit, remaining: Math.max(0, this.limit - window.count),
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + this.windowMs - current) / 1000)),
    };
  }
}

function configuredLimit() {
  const value = Number(process.env.API_KEY_RATE_LIMIT_PER_MINUTE || process.env.API_KEY_QUERY_RATE_LIMIT_PER_MINUTE || 60);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 60;
}
function defaultAudit(entry: ApiKeyAuditEntry) { console.info(JSON.stringify({ event: "api_key_request", ...entry })); }
