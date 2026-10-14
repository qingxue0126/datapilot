import type { DialogueUnderstandingResult } from "./dialogue-understanding.js";
import { canonicalTopic, detectAction, detectEntity, hasBusinessContent, type DialogueState, type StateTransition } from "./dialogue-state-tracker.js";

export type QueryRewriteResult = { query: string; shouldRetrieve: boolean; reason: string };

export class QueryRewriter {
  rewrite(utterance: string, understanding: DialogueUnderstandingResult, state: DialogueState, transition: StateTransition): QueryRewriteResult {
    if (!state.product) return blocked("missing_product");
    if (!state.currentTopic) return blocked("missing_topic");
    if (understanding.topicAction === "end" || understanding.topicAction === "chitchat" || ["end", "transfer", "chitchat"].includes(understanding.intent)) return blocked("non_business_intent");
    const slotCompletion = transition.completedSlot === "product" || transition.completedSlot === "company";
    if ((understanding.needsClarification || understanding.topicAction === "clarify") && !slotCompletion) return blocked("ambiguous_understanding");
    if (["confirm", "deny"].includes(understanding.intent) && !hasBusinessContent(utterance)) return blocked("acknowledgement_only");

    const topic = canonicalTopic(state.currentTopic);
    if (!topic) return blocked("unresolved_topic");
    const action = detectAction(topic) || detectAction(utterance);
    const entity = detectEntity(topic) || detectEntity(utterance);
    let question = retrievalQuestion(topic, action, entity);
    const topicState = [...state.topics].reverse().find((item) => item.topic === state.currentTopic && item.status !== "corrected");
    const persistedQualifiers = topicState?.slots.qualifiers || [];

    if (isDetailRequest(utterance)) question += "请提供详细操作步骤。";
    else if (understanding.topicAction === "continue" && hasUsefulQualifier(utterance)) question += `补充条件：${cleanQualifier(utterance)}。`;
    else if (understanding.topicAction === "extend" && hasUsefulQualifier(utterance) && !question.includes(cleanQualifier(utterance))) question += `关联信息：${cleanQualifier(utterance)}。`;
    else if (persistedQualifiers.length) question += `补充条件：${persistedQualifiers.join("、")}。`;

    return { query: `${state.product}软件${question}`, shouldRetrieve: true, reason: `${understanding.topicAction}; topic=${topic}; product=explicit_or_collected` };
  }
}

function retrievalQuestion(topic: string, action?: string, entity?: string) {
  if (/发票.*生成凭证/.test(topic)) return "发票如何自动生成凭证？";
  if (topic === "结账") return "怎么结账？";
  if (action && entity) return `如何${action}${entity}？`;
  if (/^(?:为什么|能否|是否|可不可以)/.test(topic)) return `${topic}？`;
  return `如何${topic}？`;
}
function hasUsefulQualifier(value: string) { return /如果|同名|按.+筛选|下级|条件|范围|日期|制单人|注意|权限/.test(value) && !isDetailRequest(value); }
function cleanQualifier(value: string) { return value.replace(/^(?:那|然后|接着|同时)?(?:还要|再)?/, "").replace(/[？?。！!]+$/g, "").trim(); }
function isDetailRequest(value: string) { return /^(?:可以)?(?:再)?(?:具体|详细)(?:怎么做|如何操作|说一下|说下|一点)?[呢吗？?。！!]*$/.test(value.trim()) || /^下一步(?:具体)?(?:怎么做|怎么操作|如何操作)/.test(value.trim()) || /(?:(?:具体|详细)(?:怎么|如何)|怎么(?:再)?具体)(?:操作|做)/.test(value); }
function blocked(reason: string): QueryRewriteResult { return { query: "", shouldRetrieve: false, reason }; }
