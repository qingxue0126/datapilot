const DEFAULT_API_PORT = 3001;
const SERVER_FALLBACK = `http://localhost:${DEFAULT_API_PORT}`;

export function resolveApiBase() {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window !== "undefined") return `http://${window.location.hostname}:${DEFAULT_API_PORT}`;
  return SERVER_FALLBACK;
}

export function apiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveApiBase()}${normalizedPath}`;
}
