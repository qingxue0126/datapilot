import type { PermissionService } from "../auth/permission-service.js";
import type { SessionStore } from "../context/session-store.js";
import type { ModelProvider } from "../llm/model-provider.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

/** Agent runtime dependencies. New models, tools and session stores can be swapped independently. */
export type AgentHarness = {
  model: ModelProvider;
  tools: ToolRegistry;
  sessions: SessionStore;
  permissions: PermissionService;
};
