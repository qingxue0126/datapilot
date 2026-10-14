import type { DialogueUnderstandingResult, PriorTopic, TopicAction } from "./dialogue-understanding.js";

export type PhoneSlots = { company_name?: string; product?: string; actual_query?: string };

export type TopicSlots = {
  product?: string;
  action?: string;
  entity?: string;
  qualifiers: string[];
};

export type DialogueTopicState = {
  topic: string;
  status: "active" | "paused" | "ended" | "corrected";
  createdTurn: number;
  lastTurn: number;
  relatedTo?: string;
  slots: TopicSlots;
};

export type DialogueState = {
  version: 1;
  turn: number;
  company_name?: string;
  product?: string;
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
    return { version: 1, turn: 0, topicHistory: [], topics: [], prompted: { company: false, product: false, query: false }, ended: false };
  }

  update(previous: DialogueState | undefined, understanding: DialogueUnderstandingResult, utterance: string, input: StateInput = {}): { state: DialogueState; transition: StateTransition } {
    const state = cloneState(previous || this.empty());
    state.turn += 1;
    state.ended = false;
    const previousTopic = state.currentTopic;
    const slotUpdates: string[] = [];
    let completedSlot: StateTransition["completedSlot"];
    const waitingFor = state.waitingFor;

    const explicitCompany = clean(input.companyName ?? input.company_name) || companyMention(utterance);
    const correctedProduct = productCorrection(utterance);
    const explicitProduct = clean(input.product) || correctedProduct || productMention(utterance);
    if (explicitCompany && explicitCompany !== state.company_name) {
      state.company_name = explicitCompany;
      slotUpdates.push("company_name");
      completedSlot = waitingFor === "company" ? "company" : completedSlot;
    } else if (waitingFor === "company" && isSlotAnswer(utterance)) {
      state.company_name = clean(utterance);
      slotUpdates.push("company_name");
      completedSlot = "company";
    }
    if (explicitProduct && explicitProduct !== state.product) {
      state.product = explicitProduct;
      slotUpdates.push("product");
      completedSlot = waitingFor === "product" ? "product" : completedSlot;
      for (const topic of state.topics) if (topic.status === "active") topic.slots.product = explicitProduct;
    } else if (waitingFor === "product" && isSlotAnswer(utterance)) {
      state.product = cleanProductAnswer(utterance);
      slotUpdates.push("product");
      completedSlot = "product";
    }
    state.waitingFor = undefined;

    const productOnly = Boolean(explicitProduct) && !hasBusinessContent(removeProductMention(utterance));
    const slotOnly = Boolean(completedSlot) && isSlotAnswer(utterance);
    if (!productOnly && !slotOnly && understanding.topicAction !== "chitchat" && understanding.topicAction !== "end" && understanding.topicAction !== "clarify") {
      const corrected = understanding.intent === "correct" ? correctionTopic(utterance) : undefined;
      const candidate = canonicalTopic(corrected || understanding.targetTopic || inferTopic(utterance));
      this.applyTopicAction(state, understanding.topicAction, candidate, utterance);
    } else if (completedSlot === "product" && state.currentTopic) {
      const topic = findTopic(state, state.currentTopic);
      if (topic && state.product) topic.slots.product = state.product;
    }

    if (understanding.topicAction === "end") {
      state.ended = true;
      const current = state.currentTopic && findTopic(state, state.currentTopic);
      if (current) current.status = "ended";
    }
    if (understanding.topicAction === "clarify" || understanding.needsClarification) state.waitingFor = "clarification";
    const current = state.currentTopic && findTopic(state, state.currentTopic);
    if (current) {
      current.lastTurn = state.turn;
      if (state.product) current.slots.product = state.product;
    }
    if (waitingFor === "query" && state.currentTopic) completedSlot = "query";

    return {
      state,
      transition: {
        action: understanding.topicAction,
        previousTopic,
        currentTopic: state.currentTopic,
        slotUpdates,
        completedSlot,
        reason: transitionReason(understanding.topicAction, previousTopic, state.currentTopic, slotUpdates),
      },
    };
  }

  applyWaiting(state: DialogueState, waitingFor: DialogueState["waitingFor"]) {
    state.waitingFor = waitingFor;
    if (waitingFor === "company") state.prompted.company = true;
    if (waitingFor === "product") state.prompted.product = true;
    if (waitingFor === "query") state.prompted.query = true;
    return state;
  }

  toSlots(state: DialogueState): PhoneSlots {
    return { company_name: state.company_name, product: state.product, actual_query: state.currentTopic };
  }

  priorTopics(state: DialogueState): PriorTopic[] {
    const topics = state.topics
      .filter((topic) => topic.status !== "corrected")
      .map((topic) => ({ topic: topic.topic, turn: topic.createdTurn }));
    const current = state.currentTopic ? topics.findIndex((topic) => sameTopic(topic.topic, state.currentTopic!)) : -1;
    if (current >= 0) topics.push(...topics.splice(current, 1));
    return topics;
  }

  private applyTopicAction(state: DialogueState, action: TopicAction, candidate: string | undefined, utterance: string) {
    if (action === "resume") {
      const resumed = candidate && findTopic(state, candidate);
      if (resumed) activate(state, resumed);
      return;
    }
    if (action === "continue") {
      const current = state.currentTopic && findTopic(state, state.currentTopic);
      if (!current && candidate) createTopic(state, candidate);
      else if (current) {
        const explicit = canonicalTopic(inferTopic(utterance));
        const ellipsisAction = detectAction(utterance);
        const currentEntity = detectEntity(current.topic);
        if (!explicit && ellipsisAction && currentEntity && ellipsisAction !== topicActionPart(current.topic)) {
          current.status = "corrected";
          createTopic(state, `${ellipsisAction}${currentEntity}`, current.relatedTo);
        } else if (explicit && isSameEntity(current.topic, explicit) && topicActionPart(explicit) !== topicActionPart(current.topic)) {
          current.status = "corrected";
          createTopic(state, explicit, current.relatedTo);
        } else if (candidate && !sameTopic(candidate, current.topic) && hasExplicitBusinessEntity(utterance)) {
          current.status = "corrected";
          createTopic(state, candidate, current.relatedTo);
        } else addQualifier(current, utterance);
      }
      return;
    }
    if (action === "start" || action === "switch" || action === "extend") {
      if (!candidate) return;
      // A switch needs an exact prior topic.  Fuzzy containment is useful when
      // resolving an explicit resume, but it would conflate a broad follow-up
      // such as “报表模板” with the narrower “获取最新报表模板”.
      const existing = [...state.topics].reverse().find((item) => item.topic === candidate && item.status !== "corrected");
      if (existing && action !== "extend") activate(state, existing);
      else createTopic(state, candidate, action === "extend" ? state.currentTopic : undefined);
    }
  }
}

export function restoreDialogueState(value: unknown): DialogueState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<DialogueState>;
  if (raw.version !== 1 || !Array.isArray(raw.topics) || !Array.isArray(raw.topicHistory)) return undefined;
  return cloneState({
    version: 1,
    turn: Number.isInteger(raw.turn) ? Number(raw.turn) : 0,
    company_name: clean(raw.company_name),
    product: clean(raw.product),
    currentTopic: clean(raw.currentTopic),
    topicHistory: raw.topicHistory.map(clean).filter(Boolean) as string[],
    topics: raw.topics.flatMap((item) => validTopic(item) ? [item] : []),
    waitingFor: ["company", "product", "query", "clarification"].includes(String(raw.waitingFor)) ? raw.waitingFor : undefined,
    prompted: { company: Boolean(raw.prompted?.company), product: Boolean(raw.prompted?.product), query: Boolean(raw.prompted?.query) },
    ended: Boolean(raw.ended),
  });
}

export function canonicalTopic(value: unknown) {
  let text = clean(value)?.replace(/[？?。！!]+$/g, "").replace(/^(?:我(?:是)?(?:想|要|需要|说)|请问|麻烦|能不能|可以|关于)/, "").trim();
  if (!text) return undefined;
  text = text.replace(/^我的意思是/, "").replace(/^(?:那|然后|接着|同时)?(?:还要|再)?/, "").trim();
  if (/发票/.test(text) && /(?:自动)?生成凭证/.test(text)) return "发票生成凭证";
  if (/新(?:的)?电脑/.test(text) && /报表模板/.test(text)) return "报表模板";
  if (/关账|结账/.test(text)) return "结账";
  const action = detectAction(text);
  const entity = detectEntity(text);
  if (action && entity) return `${action}${entity}`;
  if (/部门权限|分配权限/.test(text)) return "分配部门权限";
  if (entity && /权限/.test(text)) return `${entity}权限`;
  return text
    .replace(/^(?:怎么|如何)/, "")
    .replace(/(?:怎么|如何)(?:操作|处理|做)?$/, "")
    .replace(/一(?:个|下)/g, "")
    .replace(/新增加|添加|新建|创建/g, "新增")
    .trim() || undefined;
}

export function detectAction(value: string) {
  const rules: [RegExp, string][] = [
    [/新增|新建|创建|添加|增加/, "新增"], [/删除|移除/, "删除"], [/作废/, "作废"], [/修改|更改|编辑|调整/, "修改"],
    [/查询|查找|查看|搜索|筛选/, "查询"], [/备份/, "备份"], [/恢复|还原/, "恢复"], [/导入/, "导入"], [/导出/, "导出"],
    [/生成/, "生成"], [/关账|结账/, "结账"], [/关闭|终止/, "关闭"], [/分配.*权限|授权/, "分配"],
  ];
  return rules.find(([pattern]) => pattern.test(value))?.[1];
}

export function detectEntity(value: string) {
  const rules: [RegExp, string][] = [
    [/会计科目|科目/, "会计科目"], [/下级部门/, "下级部门"], [/部门/, "部门"], [/客户档案|客户/, "客户档案"], [/供应商/, "供应商"],
    [/账套/, "账套"], [/凭证/, "凭证"], [/订单/, "订单"], [/发票/, "发票"], [/报表/, "报表"], [/存货|库存/, "存货"],
    [/操作人员|操作员|用户/, "操作人员"], [/公司/, "账套"], [/仓库/, "仓库"], [/人员|员工/, "人员"], [/编码/, "编码"], [/权限/, "部门权限"],
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

export function hasBusinessContent(value: string) {
  return Boolean(detectAction(value) || detectEntity(value) || /怎么|如何|为什么|能否|是否|可以吗|报错|异常|问题/.test(value));
}

function createTopic(state: DialogueState, topic: string, relatedTo?: string) {
  const current = state.currentTopic && findTopic(state, state.currentTopic);
  if (current && current.status === "active") current.status = "paused";
  const parts = topicParts(topic);
  const created: DialogueTopicState = {
    topic,
    status: "active",
    createdTurn: state.turn,
    lastTurn: state.turn,
    relatedTo,
    slots: { product: state.product, action: parts.action, entity: parts.entity, qualifiers: [] },
  };
  state.topics.push(created);
  state.currentTopic = topic;
  if (!state.topicHistory.some((item) => sameTopic(item, topic))) state.topicHistory.push(topic);
}

function activate(state: DialogueState, topic: DialogueTopicState) {
  for (const item of state.topics) if (item.status === "active") item.status = "paused";
  topic.status = "active";
  topic.lastTurn = state.turn;
  state.currentTopic = topic.topic;
}

function addQualifier(topic: DialogueTopicState, utterance: string) {
  if (!/如果|同名|按.+筛选|下级|权限|条件|范围|日期|制单人|注意/.test(utterance)) return;
  const qualifier = clean(utterance)?.replace(/[？?。！!]+$/g, "");
  if (qualifier && !topic.slots.qualifiers.includes(qualifier)) topic.slots.qualifiers.push(qualifier);
}

function inferTopic(value: string) {
  const action = detectAction(value);
  const entity = detectEntity(value);
  if (action && entity) return `${action}${entity}`;
  return hasBusinessContent(value) && entity ? entity : undefined;
}

function correctionTopic(value: string) {
  const direct = value.match(/(?:我是说|改成|更正为|不对[，,]?是|不是[^，,。]*[，,]\s*是)([^，,。！？!?]+)/)?.[1];
  if (direct) return direct;
  const segments = value.split(/[，,。]/).filter((item) => !/^不是/.test(item.trim()));
  return segments.map(inferTopic).find(Boolean);
}

function productCorrection(value: string) {
  if (!/不是|改成|更正|换成/.test(value)) return undefined;
  if (!/(?:产品|使用|好会计|易代账|U8|T\+|T3|T6)/i.test(value)) return undefined;
  const candidates = [...value.matchAll(/(?:而?是|改成|更正为|换成)\s*([A-Za-z0-9+\u4e00-\u9fff]{1,30})/g)].map((match) => match[1]);
  const corrected = candidates.at(-1);
  if (!corrected) return undefined;
  return productMention(corrected) || (/(?:产品|使用)/.test(value) ? clean(corrected) : undefined);
}

function companyMention(value: string) { return clean(value.match(/(?:公司(?:名称)?(?:是|叫)|我们是)[：:]?\s*([^，。！？!?]{1,50})/)?.[1]); }
function cleanProductAnswer(value: string) { return productMention(value) || clean(value)?.replace(/^(?:我们)?用(?:的)?(?:是)?/, "").trim(); }
function removeProductMention(value: string) { return value.replace(/好会计|易代账|U8|T\+|T3|T6/gi, ""); }
function isSlotAnswer(value: string) {
  const text = value.trim();
  // A company name such as “测试公司” is a valid answer to the company prompt,
  // even though the word 公司 can also appear in a business question.
  const companyName = /^[\u4e00-\u9fffA-Za-z0-9 _-]{2,80}公司$/.test(text) && !detectAction(text) && !/怎么|如何|是否|可以/.test(text);
  return text.length <= 80 && (companyName || !hasBusinessContent(text)) && !/^(?:你好|谢谢|再见|不知道|不清楚)/.test(text);
}
function hasExplicitBusinessEntity(value: string) { return Boolean(detectEntity(value)); }
function topicParts(topic: string) { return { action: detectAction(topic), entity: detectEntity(topic) }; }
function topicActionPart(topic: string) { return detectAction(topic); }
function isSameEntity(left: string, right: string) { const a = detectEntity(left); const b = detectEntity(right); return Boolean(a && b && a === b); }
function sameTopic(left: string, right: string) { return left === right || left.includes(right) || right.includes(left); }
function findTopic(state: DialogueState, topic: string) { return [...state.topics].reverse().find((item) => sameTopic(item.topic, topic) && item.status !== "corrected"); }
function validTopic(value: unknown): value is DialogueTopicState { return Boolean(value && typeof value === "object" && clean((value as DialogueTopicState).topic)); }
function transitionReason(action: TopicAction, previous: string | undefined, current: string | undefined, slots: string[]) { return `${action}: ${previous || "none"} -> ${current || "none"}${slots.length ? `; slots=${slots.join(",")}` : ""}`; }
function clean(value: unknown) { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text ? text.slice(0, 200) : undefined; }
function cloneState(state: DialogueState): DialogueState { return structuredClone(state); }
