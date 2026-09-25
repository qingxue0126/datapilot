import type { RequestContext } from "../core/types.js";
import type { DatabaseConfig } from "../database.js";

export type ToolContext = { request: RequestContext; connection: DatabaseConfig };
export interface AgentTool<I = unknown, O = unknown> { name: string; description: string; execute(input: I, context: ToolContext): Promise<O>; }

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  register(tool: AgentTool) { if (this.tools.has(tool.name)) throw new Error(`工具已注册：${tool.name}`); this.tools.set(tool.name, tool); return this; }
  list() { return [...this.tools.values()].map(({ name, description }) => ({ name, description })); }
  async call<I, O>(name: string, input: I, context: ToolContext): Promise<O> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`未知工具：${name}`);
    return tool.execute(input, context) as Promise<O>;
  }
}
