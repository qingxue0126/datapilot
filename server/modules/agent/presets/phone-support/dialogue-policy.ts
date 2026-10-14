import type { DialogueUnderstandingResult } from "./dialogue-understanding.js";
import type { DialogueState, StateTransition } from "./dialogue-state-tracker.js";
import type { QueryRewriteResult } from "./query-rewriter.js";

export type DialoguePolicyAction = "ask_company" | "ask_product" | "ask_query" | "clarify" | "retrieve" | "transfer" | "end" | "respond";
export type DialoguePolicyDecision = {
  action: DialoguePolicyAction;
  reason: string;
  answer?: string;
  waitingFor?: DialogueState["waitingFor"];
};

export class DialoguePolicy {
  decide(understanding: DialogueUnderstandingResult, state: DialogueState, rewrite: QueryRewriteResult, transition: StateTransition): DialoguePolicyDecision {
    if (understanding.intent === "transfer") return { action: "transfer", reason: "explicit_transfer", answer: "好的，我现在为您转接人工客服。" };
    if (understanding.intent === "end" || understanding.topicAction === "end") return { action: "end", reason: "explicit_end", answer: "好的，如果还有其他问题，随时告诉我。" };
    if (understanding.intent === "chitchat" || understanding.topicAction === "chitchat") return { action: "respond", reason: "chitchat", answer: "请问有什么企业软件问题可以帮您？" };
    const slotCompletion = Boolean(transition.completedSlot);
    // A product-only opening is not an ambiguous business question. Record the
    // caller first, then ask what they need; never send the product name to RAG.
    if (state.product && !state.currentTopic && !state.company_name && !state.prompted.company) {
      return { action: "ask_company", reason: "company_not_recorded", answer: "方便告诉我一下贵公司的名称吗？", waitingFor: "company" };
    }
    if ((understanding.needsClarification || understanding.topicAction === "clarify") && !slotCompletion) {
      return { action: "clarify", reason: "ambiguous_or_low_confidence", answer: clarification(state), waitingFor: "clarification" };
    }
    if (!state.company_name && !state.prompted.company) {
      return { action: "ask_company", reason: "company_not_recorded", answer: "方便告诉我一下贵公司的名称吗？", waitingFor: "company" };
    }
    if (!state.product) {
      return { action: "ask_product", reason: "product_missing_and_not_inferred", answer: "为了更好地为您服务，请问您现在使用的是哪一款产品？", waitingFor: "product" };
    }
    if (!state.currentTopic) {
      return { action: "ask_query", reason: "business_question_missing", answer: "请问您具体遇到了什么问题？", waitingFor: "query" };
    }
    if (["confirm", "deny"].includes(understanding.intent) && !rewrite.shouldRetrieve) {
      return { action: "respond", reason: "acknowledgement_without_new_question", answer: understanding.intent === "confirm" ? "好的，请问还需要了解这个问题的哪一部分？" : "好的，请重新说明一下您要咨询的问题。", waitingFor: "query" };
    }
    if (!rewrite.shouldRetrieve) {
      return { action: "clarify", reason: rewrite.reason, answer: clarification(state), waitingFor: "clarification" };
    }
    return { action: "retrieve", reason: `grounded_query_ready: ${rewrite.reason}` };
  }
}

function clarification(state: DialogueState) {
  const topics = state.topicHistory.slice(-3);
  if (topics.length > 1) return `您指的是“${topics.join("”还是“")}”？请说得更具体一些。`;
  return "我还不能确定您指的是哪个问题，请补充具体的业务对象和想进行的操作。";
}
