import type { CorsOptions } from "cors";

export function createCorsOptions(environment: Record<string, string | undefined> = process.env): CorsOptions {
  const configuredOrigins = new Set(
    String(environment.WEB_ORIGIN || "")
      .split(",")
      .map(normalizeOrigin)
      .filter(Boolean),
  );
  const webPort = String(environment.WEB_PORT || 3000);

  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin || isAllowedWebOrigin(origin, configuredOrigins, webPort)) return callback(null, true);
      callback(new Error(`CORS 不允许来源：${origin}`));
    },
  };
}

export function isAllowedWebOrigin(origin: string, configuredOrigins: ReadonlySet<string>, webPort = "3000") {
  const normalized = normalizeOrigin(origin);
  if (configuredOrigins.has(normalized)) return true;
  try {
    const url = new URL(normalized);
    return (url.protocol === "http:" || url.protocol === "https:") && url.port === webPort;
  } catch {
    return false;
  }
}

function normalizeOrigin(value: string) {
  return value.trim().replace(/\/+$/, "");
}
