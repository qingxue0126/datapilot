import { initialWorkflow, type WorkflowDefinition } from "../../workflow/workflow-types.js";

export const PHONE_SUPPORT_AGENT_ID = "builtin.phone-support";
export const PHONE_SUPPORT_KNOWLEDGE_BASE_ID = "baec59c9-5b4d-4a10-84f4-4b896bfedcd1";

export function phoneInitialWorkflow(): WorkflowDefinition {
  const definition = initialWorkflow();
  const start = definition.nodes.find((node) => node.type === "start");
  if (start) start.data.config.prologue = "您好，欢迎致电客服中心，请问有什么可以帮您？";
  return definition;
}
