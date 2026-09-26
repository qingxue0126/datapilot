export type HistoryStorage = Pick<Storage, "getItem" | "setItem">;
export type HistoryOwner = { id: string; isBootstrapAdmin?: boolean };

const LEGACY_HISTORY_KEYS = ["datapilot-history", "datapilot-history:local-admin"];

export function loadQueryHistory<T extends { id?: string }>(storage: HistoryStorage, user: HistoryOwner): T[] {
  const userKey = `datapilot-history:${user.id}`;
  const current = parseHistory<T>(storage.getItem(userKey)) || [];
  if (!user.isBootstrapAdmin) return current;

  const markerKey = `datapilot-history:migrated:${user.id}`;
  if (storage.getItem(markerKey)) return current;

  const legacyValues = LEGACY_HISTORY_KEYS.map((key) => storage.getItem(key)).filter((value): value is string => value !== null);
  if (legacyValues.some((value) => parseHistory<T>(value) === null)) return current;

  const legacy = legacyValues.flatMap((value) => parseHistory<T>(value) || []);
  const merged = deduplicate([...current, ...legacy]).slice(0, 50);
  storage.setItem(userKey, JSON.stringify(merged));
  storage.setItem(markerKey, JSON.stringify({ version: 1, migratedAt: new Date().toISOString(), sources: LEGACY_HISTORY_KEYS }));
  return merged;
}

function parseHistory<T>(value: string | null): T[] | null {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : null;
  } catch { return null; }
}

function deduplicate<T extends { id?: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.id || JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
