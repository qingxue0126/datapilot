import type { DialogueUnderstandingResult } from "./dialogue-understanding.js";
import { detectAction, detectEntity, hasBusinessContent, type DialogueState, type StateTransition } from "./dialogue-state-tracker.js";

export type QueryRewriteResult = {
  query: string;
  shouldRetrieve: boolean;
  mode: "direct" | "contextual" | "blocked";
  reason: string;
  preservedUnits: string[];
};

export class QueryRewriter {
  rewrite(utterance: string, understanding: DialogueUnderstandingResult, state: DialogueState, transition: StateTransition): QueryRewriteResult {
    const original = clean(utterance);
    if (!state.product) return blocked("missing_product");
    if (!state.currentTopic || !state.actual_query) return blocked("missing_query");
    if (["end", "transfer", "chitchat"].includes(understanding.intent) || ["end", "chitchat"].includes(understanding.topicAction)) return blocked("non_business_intent");
    if (transition.slotUpdates.includes("product") && transition.completedSlot !== "product" && !hasBusinessContent(original.replace(/好会计|易代账|U8|T\+|T3|T6|产品|使用|不是|改成|更正为|换成/gi, ""))) return blocked("product_only_update");
    if (understanding.needsClarification || understanding.contextDependency === "ambiguous" || understanding.topicAction === "clarify") return blocked("ambiguous_understanding");
    if (["confirm", "deny"].includes(understanding.intent) && !hasBusinessContent(original)) return blocked("acknowledgement_only");

    const topic = currentTopic(state);
    if (!topic) return blocked("unresolved_topic");
    const completedBusinessSlot = transition.completedSlot === "product" || transition.completedSlot === "company";

    // 首轮完整问题、后续独立问题以及补齐槽位后的原问题都不做 Query Rewriting。
    if (understanding.intent === "correct" && hasBusinessContent(original)) return direct(original, "explicit_business_correction");
    if (understanding.contextDependency === "independent" && !completedBusinessSlot) return direct(original, "independent_complete_question");
    if (completedBusinessSlot) return direct(topic.originalQuery, `resume_original_after_${transition.completedSlot}`);

    const resolved = clean(understanding.targetTopic || topic.resolvedQuery);
    if (!resolved) return blocked("missing_resolved_query");
    const units = criticalUnits(original);
    if (units.some((unit) => !containsEquivalent(resolved, unit))) return blocked("rewrite_dropped_user_constraint");
    const prior = transition.action === "resume" ? topic.resolvedQuery : transition.previousTopic || topic.relatedTo && state.topics.find((item) => item.id === topic.relatedTo)?.resolvedQuery || topic.resolvedQuery;
    if (!isSafelyGroundedInContext(original, resolved, prior, prior)) return blocked("unsafe_context_resolution");
    return { query: resolved, shouldRetrieve: true, mode: "contextual", reason: `context_only; action=${understanding.topicAction}`, preservedUnits: units };
  }
}

function currentTopic(state: DialogueState) { return [...state.topics].reverse().find((item) => item.status === "active") || [...state.topics].reverse().find((item) => item.topic === state.currentTopic && item.status !== "corrected"); }
function direct(query: string, reason: string): QueryRewriteResult { return { query, shouldRetrieve: true, mode: "direct", reason, preservedUnits: criticalUnits(query) }; }
function blocked(reason: string): QueryRewriteResult { return { query: "", shouldRetrieve: false, mode: "blocked", reason, preservedUnits: [] }; }
function isSafelyGroundedInContext(original: string, resolved: string, priorResolved: string, priorOriginal: string) {
  if (normalize(original) === normalize(resolved)) return !isContextDependent(original);
  if (!isContextDependent(original)) return true;
  const priorAnchors = businessAnchors(`${priorResolved} ${priorOriginal}`);
  const resolvedAnchors = businessAnchors(resolved);
  if (!priorAnchors.length) return false;
  return priorAnchors.some((anchor) => resolvedAnchors.includes(anchor) || normalize(resolved).includes(normalize(anchor)));
}
function businessAnchors(value: string) {
  const anchors = [detectEntity(value), detectAction(value), ...(value.match(/[A-Za-z][A-Za-z0-9+_.-]{1,}|\b\d{2,}\b/g) || [])].filter(Boolean) as string[];
  return [...new Set(anchors)];
}
function isContextDependent(value: string) { return /(?:那个|这个(?!月)|它|刚才|上一个|前面|那(?:怎么|如何)|这(?:怎么|如何))/.test(value) || /^(?:那|然后|接着|再)?(?:怎么|如何|具体|下一步|还有)/.test(value); }
function criticalUnits(value: string) {
  return [...new Set(value.match(/(?:这个月|本月|上个月|今天|昨天|今年|去年|按行|按[^，。！？!?]{1,12}|不要|不能|无法|没有|不是|报错|错误|异常|不对|失败|\b[A-Z]?[0-9]{2,}[A-Z0-9_.-]*\b)/gi) || [])];
}
function containsEquivalent(value: string, unit: string) {
  if (normalize(value).includes(normalize(unit))) return true;
  const equivalents: [RegExp, RegExp][] = [[/报错|错误/, /报错|错误/], [/异常|不对/, /异常|不对/], [/无法|不能/, /无法|不能/], [/没有|未/, /没有|未/]];
  return equivalents.some(([left, right]) => left.test(unit) && right.test(value));
}
function normalize(value: string) { return value.toLowerCase().replace(/[？?。！!，,：:\s]/g, ""); }
function clean(value: unknown) { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 1000); }
