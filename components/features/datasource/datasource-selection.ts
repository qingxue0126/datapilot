type SelectableDatasource = { id: string; status: "connected" | "offline" };

export function fallbackDatasourceId(sources: SelectableDatasource[], activeSourceId?: string) {
  if (activeSourceId && sources.some((source) => source.id === activeSourceId)) return activeSourceId;
  return sources.find((source) => source.status === "connected")?.id || "";
}
