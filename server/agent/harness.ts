import type { PermissionService } from "../auth/permission-service.js";
import type { SessionStore } from "../context/session-store.js";
import type { StructuredModelClient } from "../llm/model-service.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

/** Agent runtime dependencies. New models, tools and session stores can be swapped independently. */
export type AgentHarness = {
  model: StructuredModelClient;
  tools: ToolRegistry;
  sessions: SessionStore;
  permissions: PermissionService;
};
