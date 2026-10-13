export type AgentTraceEvent = {
  step: string;
  status: "started" | "succeeded" | "failed";
  detail?: string;
  durationMs?: number;
};

