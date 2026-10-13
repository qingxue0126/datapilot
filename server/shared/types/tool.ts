import type { DatabaseConfig } from "./database.js";
import type { RequestContext } from "./context.js";

export type ToolContext = { request: RequestContext; datasourceId: string; connection: DatabaseConfig };
export interface AgentTool<I = unknown, O = unknown> { name: string; description: string; execute(input: I, context: ToolContext): Promise<O>; }

