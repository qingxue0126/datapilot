import type { DialogueSemanticFrame, DialogueUnderstandingResult, PriorTopic, TopicAction } from "./dialogue-understanding.js";

export type PhoneSlots = { company_name?: string; product?: string; actual_query?: string };
export type TopicSlots = {
  product?: string;
  action?: string;
  entities: string[];
  timeExpressions: string[];
  conditions: string[];
  symptoms: string[];
  negations: string[];
  qualifiers: string[];
};
export type DialogueTopicState = {
  id: string;
  topic: string;
  originalQuery: string;
  resolvedQuery: string;
  utterances: string[];
  status: "active" | "paused" | "ended" | "corrected";
  createdTurn: number;
  lastTurn: number;
  relatedTo?: string;
  slots: TopicSlots;
};
export type DialogueState = {
  version: 2;
  turn: number;
  company_name?: string;
  product?: string;
  actual_query?: string;
  currentTopic?: string;
  topicHistory: string[];
  topics: DialogueTopicState[];
  waitingFor?: "company" | "product" | "query" | "clarification";
  prompted: { company: boolean; product: boolean; query: boolean };
  ended: boolean;
};
export type StateTransition = {
  action: TopicAction;
  previousTopic?: string;
  currentTopic?: string;
  slotUpdates: string[];
  completedSlot?: "company" | "product" | "query";
  reason: string;
};
type StateInput = Record<string, unknown>;

export class DialogueStateTracker {
  empty(): DialogueState {
    return { version: 2, turn: 0, topicHistory: [], topics: [], prompted: { company: false, product: false, query: false }, ended: false };
  }

  update(previous: DialogueState | undefined, understanding: DialogueUnderstandingResult, utterance: string, input: StateInput = {}): { state: DialogueState; transition: StateTransition } {
    const state = cloneState(previous || this.empty());
    state.turn += 1;
    state.ended = false;
    const previousTopic = state.currentTopic;
    const previousWaiting = state.waitingFor;
    const slotUpdates: string[] = [];
    let completedSlot: StateTransition["completedSlot"];

    const explicitCompany = clean(input.companyName ?? input.company_name) || companyMention(utterance);
    const explicitProduct = clean(input.product) || productCorrection(utterance) || productMention(utterance);
    if (explicitCompany && explicitCompany !== state.company_name) {
      state.company_name = explicitCompany; slotUpdates.push("company_name");
      if (previousWaiting === "company") completedSlot = "company";
    } else if (previousWaiting === "company" && isSlotAnswer(utterance)) {
      state.company_name = clean(utterance); slotUpdates.push("company_name"); completedSlot = "company";
    }
    if (explicitProduct && explicitProduct !== state.product) {
      state.product = explicitProduct; slotUpdates.push("product");
      if (previousWaiting === "product") completedSlot = "product";
    } else if (previousWaiting === "product" && isSlotAnswer(utterance)) {
      state.product = cleanProductAnswer(utterance); slotUpdates.push("product"); completedSlot = "product";
    }
    state.waitingFor = undefined;

    const slotOnly = Boolean(completedSlot) && isSlotAnswer(utterance);
    const productOnly = Boolean(explicitProduct) && !hasBusinessContent(removeProductMention(utterance));
    const nonBusiness = ["chitchat", "end"].includes(understanding.topicAction) || ["end", "transfer", "chitchat"].includes(understanding.intent);
    if (!slotOnly && !productOnly && !nonBusiness && understanding.topicAction !== "clarify" && understanding.targetTopic) {
      this.applyTopicAction(state, understanding, utterance);
    }

    if (understanding.topicAction === "end") {
      state.ended = true;
      const current = activeTopic(state);
      if (current) current.status = "ended";
    }
    if (understanding.topicAction === "clarify" || understanding.needsClarification) state.waitingFor = "clarification";
    const current = activeTopic(state);
    if (current) {
      current.lastTurn = state.turn;
      if (state.product) current.slots.product = state.product;
      state.currentTopic = current.topic;
      state.actual_query = current.resolvedQuery || current.originalQuery;
    }
    if (previousWaiting === "query" && state.currentTopic) completedSlot = "query";

    return { state, transition: { action: understanding.topicAction, previousTopic, currentTopic: state.currentTopic, slotUpdates, completedSlot, reason: transitionReason(understanding.topicAction, previousTopic, state.currentTopic, slotUpdates) } };
  }

  applyWaiting(state: DialogueState, waitingFor: DialogueState["waitingFor"]) {
    state.waitingFor = waitingFor;
    if (waitingFor === "company") state.prompted.company = true;
    if (waitingFor === "product") state.prompted.product = true;
    if (waitingFor === "query") state.prompted.query = true;
    return state;
  }

  toSlots(state: DialogueState): PhoneSlots { return { company_name: state.company_name, product: state.product, actual_query: state.actual_query }; }

  priorTopics(state: DialogueState): PriorTopic[] {
    const topics = state.topics.filter((topic) => topic.status !== "corrected").map((topic) => ({ topic: topic.topic, turn: topic.createdTurn, originalQuery: topic.originalQuery, resolvedQuery: topic.resolvedQuery }));
    const current = state.currentTopic ? topics.findIndex((topic) => sameTopic(topic.topic, state.currentTopic!)) : -1;
    if (current >= 0) topics.push(...topics.splice(current, 1));
    return topics;
  }

  private applyTopicAction(state: DialogueState, understanding: DialogueUnderstandingResult, utterance: string) {
    const target = canonicalTopic(understanding.targetTopic);
    if (!target) return;
    if (understanding.topicAction === "resume") {
      const resumed = findTopic(state, target);
      if (resumed) {
        activate(state, resumed);
        mergeTurn(resumed, utterance, target, understanding.semanticFrame, understanding.contextDependency === "independent");
      }
      return;
    }

    const current = activeTopic(state);
    if (understanding.intent === "correct" && current) {
      current.status = "corrected";
      createTopic(state, target, utterance, understanding.semanticFrame, current.relatedTo);
      return;
    }
    if (understanding.topicAction === "continue") {
      if (!current) createTopic(state, target, utterance, understanding.semanticFrame);
      else if (sameBusinessTopic(current, target, understanding.semanticFrame)) mergeTurn(current, utterance, target, understanding.semanticFrame, understanding.contextDependency === "independent");
      else {
        current.status = "paused";
        createTopic(state, target, utterance, understanding.semanticFrame, current.id);
      }
      return;
    }
    if (["start", "switch", "extend"].includes(understanding.topicAction)) {
      const exact = [...state.topics].reverse().find((item) => item.topic === target && item.status !== "corrected");
      if (exact && understanding.topicAction !== "extend") {
        activate(state, exact);
        mergeTurn(exact, utterance, target, understanding.semanticFrame, understanding.contextDependency === "independent");
      } else createTopic(state, target, utterance, understanding.semanticFrame, understanding.topicAction === "extend" ? current?.id : undefined);
    }
  }
}

export function restoreDialogueState(value: unknown): DialogueState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version === 1) return migrateV1(raw);
  if (raw.version !== 2 || !Array.isArray(raw.topics) || !Array.isArray(raw.topicHistory)) return undefined;
  const topics = raw.topics.flatMap((item, index) => restoreTopic(item, index));
  const currentTopic = clean(raw.currentTopic);
  const current = currentTopic ? [...topics].reverse().find((item) => sameTopic(item.topic, currentTopic)) : undefined;
  return {
    version: 2,
    turn: Number.isInteger(raw.turn) ? Number(raw.turn) : 0,
    company_name: clean(raw.company_name), product: clean(raw.product),
    actual_query: clean(raw.actual_query) || current?.resolvedQuery || current?.originalQuery,
    currentTopic: current?.topic || currentTopic,
    topicHistory: unique(raw.topicHistory as unknown[]), topics,
    waitingFor: isWaitingFor(raw.waitingFor) ? raw.waitingFor : undefined,
    prompted: restorePrompted(raw.prompted), ended: Boolean(raw.ended),
  };
}

export function canonicalTopic(value: unknown) {
  const text = clean(value)?.replace(/[。！!]+$/g, "").trim();
  return text ? text.slice(0, 500) : undefined;
}
export function detectAction(value: string) {
  const rules: [RegExp, string][] = [
    [/新增|新建|创建|添加|增加/, "新增"], [/删除|移除/, "删除"], [/作废/, "作废"], [/修改|更改|编辑|调整/, "修改"],
    [/查询|查找|查看|搜索|筛选/, "查询"], [/备份/, "备份"], [/恢复|还原/, "恢复"], [/导入/, "导入"], [/导出/, "导出"],
    [/生成/, "生成"], [/关账|结账/, "结账"], [/关闭|终止/, "关闭"], [/启用/, "启用"], [/停用/, "停用"], [/分配.*权限|授权/, "分配"],
  ];
  return rules.find(([pattern]) => pattern.test(value))?.[1];
}
export function detectEntity(value: string) {
  const rules: [RegExp, string][] = [
    [/会计科目|科目/, "会计科目"], [/下级部门/, "下级部门"], [/部门/, "部门"], [/客户档案|客户/, "客户档案"], [/供应商/, "供应商"],
    [/账套/, "账套"], [/凭证/, "凭证"], [/订单/, "订单"], [/发票/, "发票"], [/报表模板|模板/, "报表模板"], [/报表/, "报表"], [/存货|库存/, "存货"],
    [/操作人员|操作员|用户/, "操作人员"], [/公司/, "公司"], [/仓库/, "仓库"], [/人员|员工/, "人员"], [/编码/, "编码"], [/权限/, "权限"],
  ];
  return rules.find(([pattern]) => pattern.test(value))?.[1];
}
export function productMention(value: string) {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  const products: [string, string][] = [["好会计", "好会计"], ["易代账", "易代账"], ["u8", "U8"], ["t+", "T+"], ["t3", "T3"], ["t6", "T6"]];
  const known = products.find(([token]) => normalized.includes(token))?.[1];
  if (known) return known;
  return clean(value.match(/(?:使用|用的|产品是|换成|改成)(?:的)?[：:为]?\s*([^，。！？!?]{1,30})/)?.[1]);
}
export function hasBusinessContent(value: string) { return Boolean(detectAction(value) || detectEntity(value) || /怎么|如何|为什么|能否|是否|可以吗|报错|错误|异常|不对|失败|问题/.test(value)); }

function createTopic(state: DialogueState, target: string, utterance: string, frame: DialogueSemanticFrame, relatedTo?: string) {
  const current = activeTopic(state);
  if (current) current.status = "paused";
  const topic: DialogueTopicState = {
    id: `topic-${state.turn}-${state.topics.length + 1}`,
    topic: target,
    originalQuery: clean(utterance) || target,
    resolvedQuery: target,
    utterances: [clean(utterance) || target],
    status: "active", createdTurn: state.turn, lastTurn: state.turn, relatedTo,
    slots: frameToSlots(frame, state.product),
  };
  state.topics.push(topic); state.currentTopic = target; state.actual_query = target;
  if (!state.topicHistory.some((item) => sameTopic(item, target))) state.topicHistory.push(target);
}
function mergeTurn(topic: DialogueTopicState, utterance: string, resolved: string, frame: DialogueSemanticFrame, independent: boolean) {
  const cleaned = clean(utterance);
  if (cleaned && !topic.utterances.includes(cleaned)) topic.utterances.push(cleaned);
  topic.lastTurn += 0;
  topic.resolvedQuery = resolved;
  if (independent) topic.originalQuery = cleaned || topic.originalQuery;
  topic.topic = resolved;
  topic.slots = mergeSlots(topic.slots, frame);
}
function activate(state: DialogueState, topic: DialogueTopicState) {
  for (const item of state.topics) if (item.status === "active") item.status = "paused";
  topic.status = "active"; topic.lastTurn = state.turn; state.currentTopic = topic.topic; state.actual_query = topic.resolvedQuery;
}
function activeTopic(state: DialogueState) { return [...state.topics].reverse().find((item) => item.status === "active") || (state.currentTopic ? findTopic(state, state.currentTopic) : undefined); }
function findTopic(state: DialogueState, topic: string) { return [...state.topics].reverse().find((item) => sameTopic(item.topic, topic) && item.status !== "corrected"); }
function sameBusinessTopic(current: DialogueTopicState, target: string, frame: DialogueSemanticFrame) {
  if (sameTopic(current.topic, target)) return true;
  const currentEntity = current.slots.entities[0] || detectEntity(current.resolvedQuery);
  const nextEntity = frame.entities[0] || detectEntity(target);
  const currentAction = current.slots.action || detectAction(current.resolvedQuery);
  const nextAction = frame.action || detectAction(target);
  return Boolean(currentEntity && nextEntity && currentEntity === nextEntity && (!currentAction || !nextAction || currentAction === nextAction));
}
function frameToSlots(frame: DialogueSemanticFrame, product?: string): TopicSlots { return { product, action: frame.action || undefined, entities: unique(frame.entities), timeExpressions: unique(frame.timeExpressions), conditions: unique(frame.conditions), symptoms: unique(frame.symptoms), negations: unique(frame.negations), qualifiers: unique([...frame.timeExpressions, ...frame.conditions, ...frame.symptoms, ...frame.negations]) }; }
function mergeSlots(slots: TopicSlots, frame: DialogueSemanticFrame): TopicSlots { return { ...slots, action: frame.action || slots.action, entities: unique([...slots.entities, ...frame.entities]), timeExpressions: unique([...slots.timeExpressions, ...frame.timeExpressions]), conditions: unique([...slots.conditions, ...frame.conditions]), symptoms: unique([...slots.symptoms, ...frame.symptoms]), negations: unique([...slots.negations, ...frame.negations]), qualifiers: unique([...slots.qualifiers, ...frame.timeExpressions, ...frame.conditions, ...frame.symptoms, ...frame.negations]) }; }

function restoreTopic(value: unknown, index: number): DialogueTopicState[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = value as Record<string, unknown>; const topic = clean(raw.topic);
  if (!topic) return [];
  const slots = raw.slots && typeof raw.slots === "object" ? raw.slots as Record<string, unknown> : {};
  const array = (name: string) => Array.isArray(slots[name]) ? unique(slots[name] as unknown[]) : [];
  const status = ["active", "paused", "ended", "corrected"].includes(String(raw.status)) ? raw.status as DialogueTopicState["status"] : "paused";
  return [{ id: clean(raw.id) || `restored-${index + 1}`, topic, originalQuery: clean(raw.originalQuery) || topic, resolvedQuery: clean(raw.resolvedQuery) || topic, utterances: Array.isArray(raw.utterances) ? unique(raw.utterances) : [topic], status, createdTurn: finiteTurn(raw.createdTurn), lastTurn: finiteTurn(raw.lastTurn), relatedTo: clean(raw.relatedTo), slots: { product: clean(slots.product), action: clean(slots.action), entities: array("entities"), timeExpressions: array("timeExpressions"), conditions: array("conditions"), symptoms: array("symptoms"), negations: array("negations"), qualifiers: array("qualifiers") } }];
}
function migrateV1(raw: Record<string, unknown>): DialogueState | undefined {
  if (!Array.isArray(raw.topics)) return undefined;
  const state = new DialogueStateTracker().empty(); state.turn = finiteTurn(raw.turn); state.company_name = clean(raw.company_name); state.product = clean(raw.product); state.ended = Boolean(raw.ended); state.prompted = restorePrompted(raw.prompted); state.waitingFor = isWaitingFor(raw.waitingFor) ? raw.waitingFor : undefined;
  for (const [index, item] of raw.topics.entries()) {
    if (!item || typeof item !== "object") continue;
    const old = item as Record<string, unknown>; const topic = clean(old.topic); if (!topic) continue;
    const oldSlots = old.slots && typeof old.slots === "object" ? old.slots as Record<string, unknown> : {};
    state.topics.push({ id: `migrated-${index + 1}`, topic, originalQuery: topic, resolvedQuery: topic, utterances: [topic], status: ["active", "paused", "ended", "corrected"].includes(String(old.status)) ? old.status as DialogueTopicState["status"] : "paused", createdTurn: finiteTurn(old.createdTurn), lastTurn: finiteTurn(old.lastTurn), relatedTo: clean(old.relatedTo), slots: { product: clean(oldSlots.product), action: clean(oldSlots.action), entities: unique([oldSlots.entity]), timeExpressions: [], conditions: [], symptoms: [], negations: [], qualifiers: Array.isArray(oldSlots.qualifiers) ? unique(oldSlots.qualifiers) : [] } });
  }
  state.topicHistory = Array.isArray(raw.topicHistory) ? unique(raw.topicHistory) : state.topics.map((item) => item.topic);
  state.currentTopic = clean(raw.currentTopic); const current = state.currentTopic ? findTopic(state, state.currentTopic) : undefined; state.actual_query = current?.resolvedQuery || state.currentTopic; return state;
}
function restorePrompted(value: unknown) { const raw = value && typeof value === "object" ? value as Record<string, unknown> : {}; return { company: Boolean(raw.company), product: Boolean(raw.product), query: Boolean(raw.query) }; }
function companyMention(value: string) {
  const explicit = clean(value.match(/(?:公司(?:名称)?(?:是|叫)|我们是)[：:]?\s*([^，。！？!?]{1,50})/)?.[1]);
  if (explicit) return explicit;
  const standalone = clean(value) ?? "";
  if (/怎么|如何|为何|为什么|新增|创建|删除|修改|查询|设置|操作|报错|异常|问题/.test(standalone)) return "";
  return /^[\p{L}\d（）()·&\-]{2,50}(?:公司|集团|企业)$/u.test(standalone) ? standalone : "";
}
function productCorrection(value: string) { if (!/不是|改成|更正|换成/.test(value)) return undefined; const candidate = [...value.matchAll(/(?:而?是|改成|更正为|换成)\s*([A-Za-z0-9+\u4e00-\u9fff]{1,30})/g)].at(-1)?.[1]; return candidate ? productMention(candidate) || clean(candidate) : undefined; }
function cleanProductAnswer(value: string) { return productMention(value) || clean(value)?.replace(/^(?:我们)?用(?:的)?(?:是)?/, "").trim(); }
function removeProductMention(value: string) { return value.replace(/好会计|易代账|U8|T\+|T3|T6/gi, ""); }
function isSlotAnswer(value: string) { const text = value.trim(); return text.length > 0 && text.length <= 80 && !/[？?]/.test(text) && !/怎么|如何|为什么|能否|是否|报错|异常|问题/.test(text) && !/^(?:你好|谢谢|再见|不知道|不清楚)$/.test(text); }
function sameTopic(left: string, right: string) { return normalize(left) === normalize(right) || normalize(left).includes(normalize(right)) || normalize(right).includes(normalize(left)); }
function normalize(value: string) { return value.replace(/[？?。！!，,：:\s]/g, "").replace(/^(?:请问|麻烦|关于)/, ""); }
function isWaitingFor(value: unknown): value is DialogueState["waitingFor"] { return ["company", "product", "query", "clarification"].includes(String(value)); }
function transitionReason(action: TopicAction, previous: string | undefined, current: string | undefined, slots: string[]) { return `${action}: ${previous || "none"} -> ${current || "none"}${slots.length ? `; slots=${slots.join(",")}` : ""}`; }
function finiteTurn(value: unknown) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : 0; }
function unique(values: unknown[]): string[] { const output: string[] = []; for (const value of values) { const item = clean(value); if (item && !output.includes(item)) output.push(item); } return output; }
function clean(value: unknown) { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text ? text.slice(0, 500) : undefined; }
function cloneState(state: DialogueState): DialogueState { return structuredClone(state); }
