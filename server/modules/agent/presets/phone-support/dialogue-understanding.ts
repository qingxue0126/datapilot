import type { RequestContext } from "../../../../shared/types/context.js";
import type { ModelTokenUsage } from "../../../../shared/types/model.js";
import type { ModelService } from "../../../model/index.js";

/** Compatibility label used by reports. The concrete model is selected by DataPilot's intent route. */
export const DIALOGUE_MODEL = "route:intent";
export const DIALOGUE_FALLBACK_MODEL = "route:intent:fallback";

export const dialogueIntents = ["consult", "create", "delete", "update", "query", "confirm", "deny", "correct", "clarify", "end", "transfer", "chitchat", "troubleshoot"] as const;
export type DialogueIntent = typeof dialogueIntents[number];
export const topicActions = ["start", "continue", "switch", "resume", "extend", "chitchat", "end", "clarify"] as const;
export type TopicAction = typeof topicActions[number];
export const contextDependencies = ["independent", "dependent", "ambiguous", "none"] as const;
export type ContextDependency = typeof contextDependencies[number];

export type ResolvedReference = { expression: string; resolvedTo: string; sourceTurn: number };
export type DialogueSemanticFrame = {
  action: string | null;
  entities: string[];
  timeExpressions: string[];
  conditions: string[];
  symptoms: string[];
  negations: string[];
};
export type DialogueUnderstandingResult = {
  intent: DialogueIntent;
  topicAction: TopicAction;
  targetTopic: string | null;
  resolvedReferences: ResolvedReference[];
  confidence: number;
  needsClarification: boolean;
  contextDependency: ContextDependency;
  semanticFrame: DialogueSemanticFrame;
};
export type DialogueUnderstandingDiagnostics = {
  source: "rule" | "structural" | "llm" | "safe_fallback";
  route: "intent";
  model?: string;
  durationMs: number;
  modelLatencyMs?: number;
  usage?: ModelTokenUsage;
  degradationReason?: string;
};
export type DialogueUnderstandingResponse = { result: DialogueUnderstandingResult; diagnostics: DialogueUnderstandingDiagnostics };
export type PriorTopic = { topic: string; turn: number; originalQuery?: string; resolvedQuery?: string };
type DialogueTurn = { question: string; answer: string };

export class DialogueUnderstanding {
  constructor(private readonly models: ModelService) {}

  async understand(context: RequestContext, input: {
    utterance: string;
    turns: DialogueTurn[];
    priorTopics?: PriorTopic[];
    waitingFor?: "company" | "product" | "query" | "clarification";
    signal?: AbortSignal;
  }): Promise<DialogueUnderstandingResponse> {
    const started = Date.now();
    const utterance = clean(input.utterance).slice(0, 1000);
    const topics = uniqueTopics(input.priorTopics || []);
    const rule = deterministicRule(utterance, input.turns, topics, input.waitingFor);
    if (rule) return { result: rule, diagnostics: { source: "rule", route: "intent", model: DIALOGUE_MODEL, durationMs: Date.now() - started } };
    const structural = structuralReference(utterance, topics);
    if (structural) return { result: structural, diagnostics: { source: "structural", route: "intent", model: DIALOGUE_MODEL, durationMs: Date.now() - started } };

    let usage: ModelTokenUsage | undefined;
    let model: string | undefined;
    let modelLatencyMs: number | undefined;
    try {
      const content = await this.models.text(prompt(utterance, input.turns, topics), {
        context,
        task: "intent",
        temperature: 0,
        maxTokens: 520,
        disableThinking: true,
        signal: input.signal,
        onToken: () => undefined,
        onUsage: (value, latency, modelId) => { usage = value; modelLatencyMs = latency; model = modelId; },
      });
      const result = enforceSafety(utterance, topics, validateResult(parseJson(content), topics, input.turns.length));
      return { result, diagnostics: { source: "llm", route: "intent", model, durationMs: Date.now() - started, modelLatencyMs, usage } };
    } catch (error) {
      return {
        result: safeFallback(utterance, input.turns, topics),
        diagnostics: { source: "safe_fallback", route: "intent", model, durationMs: Date.now() - started, modelLatencyMs, usage, degradationReason: safeError(error) },
      };
    }
  }
}

/** Resolves syntax-level references only; it contains no product or business normalization rules. */
function structuralReference(utterance: string, topics: PriorTopic[]): DialogueUnderstandingResult | undefined {
  const ordinal = utterance.match(/第([一二三四五六七八九十\d]+)个/);
  if (!ordinal) {
    const current = topics.at(-1);
    const frame = extractFrame(utterance);
    const explicitlyReferenced = topics.filter((topic) => {
      const topicFrame = extractFrame(topic.resolvedQuery || topic.topic);
      return topicFrame.entities.some((entity) => utterance.includes(entity))
        && (!frame.action || !topicFrame.action || frame.action === topicFrame.action);
    });
    if (explicitlyReferenced.length === 1 && /刚才|前面|之前|提到|说的|第/.test(utterance)) {
      const selected = explicitlyReferenced[0];
      return {
        ...baseResult(inferIntent(utterance), selected === current ? "continue" : "resume", selected.resolvedQuery || selected.topic, 0.99, false, "dependent"),
        semanticFrame: frame,
        resolvedReferences: [{ expression: utterance, resolvedTo: selected.topic, sourceTurn: selected.turn }],
      };
    }
    const genericReference = /(?:那个|这个(?!月)|它|刚才|前面|之前)/.test(utterance);
    if (genericReference && topics.length > 1 && !frame.entities.length) {
      return { ...baseResult("clarify", "clarify", null, 0.99, true, "ambiguous"), semanticFrame: frame };
    }
    if (current && frame.action && !frame.entities.length && /^(?:那|那么|这个|那个|它)?(?:再)?(?:要)?(?:怎么|如何)/.test(utterance.trim())) {
      const entity = extractFrame(current.resolvedQuery || current.topic).entities[0];
      if (entity) {
        const contextualQuestion = utterance.trim().replace(/^(?:那|那么|这个|那个|它)/, "");
        const resolved = `${entity}${contextualQuestion}${/[？?。！!]$/.test(contextualQuestion) ? "" : "？"}`;
        return {
          ...baseResult(inferIntent(utterance), "continue", resolved, 0.99, false, "dependent"),
          semanticFrame: { ...frame, entities: [entity] },
          resolvedReferences: [{ expression: utterance, resolvedTo: current.topic, sourceTurn: current.turn }],
        };
      }
    }
    if (!current || !/^(?:下一步)?(?:再)?(?:具体|详细)?(?:怎么做|如何操作|怎么操作|说一下|说说)[呢吗？?。！!]*$/.test(utterance.trim())) return undefined;
    const resolved = `${(current.resolvedQuery || current.topic).replace(/[？?。！!]+$/g, "")}，${utterance}`;
    return { ...baseResult("consult", "continue", resolved, 0.99, false, "dependent"), resolvedReferences: [{ expression: utterance, resolvedTo: current.topic, sourceTurn: current.turn }] };
  }
  const index = chineseOrdinal(ordinal[1]) - 1;
  const selected = topics[index];
  if (!selected) return baseResult("clarify", "clarify", null, 0.3, true, "ambiguous");
  const current = topics.at(-1);
  return {
    ...baseResult("consult", selected === current ? "continue" : "resume", selected.resolvedQuery || selected.topic, 0.99, false, "dependent"),
    resolvedReferences: [{ expression: ordinal[0], resolvedTo: selected.topic, sourceTurn: selected.turn }],
  };
}

function deterministicRule(utterance: string, turns: DialogueTurn[], topics: PriorTopic[], waitingFor?: string): DialogueUnderstandingResult | undefined {
  const current = topics.at(-1);
  if (/^(?:再见|拜拜|结束(?:通话)?|就这样|没(?:有)?别的(?:问题)?了)[。！! ]*$/.test(utterance)) return baseResult("end", "end", current?.topic || null, 0.99, false, "none");
  if (/^(?:不用了|算了)[，,、 ]*(?:谢谢[，,、 ]*)?(?:再见|拜拜)[。！! ]*$/.test(utterance)) return baseResult("end", "end", current?.topic || null, 0.99, false, "none");
  if (/转(?:接)?人工|人工客服|找人工|真人客服/.test(utterance)) return baseResult("transfer", "end", current?.topic || null, 0.99, false, "none");
  if (/^(?:你好|您好|早上好|下午好|晚上好|谢谢|感谢|辛苦了)[。！! ]*$/.test(utterance)) return baseResult("chitchat", "chitchat", null, 0.99, false, "none");

  // “好的/不用了”只有结合上一轮客服行为才是确定的，不能全局硬编码为结束。
  if (/^(?:好的|好|嗯|可以|不用了|算了)[。！! ]*$/.test(utterance)) {
    const lastAnswer = turns.at(-1)?.answer || "";
    const offeredMore = /(?:还有|还需要|其他).*(?:问题|帮助|了解)|随时告诉/.test(lastAnswer);
    const askingForInformation = Boolean(waitingFor) || /(?:请问|告诉我|补充|具体|哪一款|公司名称|贵公司)/.test(lastAnswer);
    if (offeredMore || (/不用了|算了/.test(utterance) && !askingForInformation)) return baseResult("end", "end", current?.topic || null, 0.98, false, "none");
    if (askingForInformation) return baseResult(/不用了|算了/.test(utterance) ? "deny" : "confirm", current ? "continue" : "clarify", current?.topic || null, current ? 0.9 : 0.4, !current, current ? "dependent" : "ambiguous");
    if (current && lastAnswer) return baseResult("end", "end", current.topic, 0.9, false, "none");
    return baseResult("confirm", current ? "continue" : "clarify", current?.topic || null, current ? 0.88 : 0.35, !current, current ? "dependent" : "ambiguous");
  }

  // A direct answer to a requested slot is state handling, not business semantic normalization.
  if ((waitingFor === "company" || waitingFor === "product") && isLikelySlotValue(utterance)) return baseResult("clarify", current ? "continue" : "start", current?.topic || null, 0.98, false, current ? "dependent" : "none");
  if (isExplicitCompanyName(utterance)) return baseResult("clarify", current ? "continue" : "start", current?.topic || null, 0.98, false, current ? "dependent" : "none");
  return undefined;
}

function isExplicitCompanyName(value: string) {
  const text = value.trim();
  if (/怎么|如何|为何|为什么|新增|创建|删除|修改|查询|设置|操作|报错|异常|问题/.test(text)) return false;
  return /^[\p{L}\d（）()·&\-]{2,50}(?:公司|集团|企业)$/u.test(text);
}

function prompt(utterance: string, turns: DialogueTurn[], topics: PriorTopic[]) {
  const context = turns.slice(-8).map((turn, index) => `T${turns.length - Math.min(8, turns.length) + index + 1} 用户:${truncate(turn.question, 350)}\n客服:${truncate(turn.answer, 350)}`).join("\n") || "无";
  const topicList = topics.map((item, index) => `${index + 1}. ${truncate(item.topic, 180)}；原始问题=${truncate(item.originalQuery || "", 220)}；上下文补全=${truncate(item.resolvedQuery || "", 220)}；turn=${item.turn}`).join("\n") || "无";
  return [
    { role: "system" as const, content: [
      "你只负责企业软件电话客服的对话理解，不回答业务问题，也不维护会话状态。",
      `intent 只能是: ${dialogueIntents.join(", ")}`,
      `topicAction 只能是: ${topicActions.join(", ")}`,
      `contextDependency 只能是: ${contextDependencies.join(", ")}`,
      "independent=单独看当前话语就能完整检索；dependent=存在指代、省略、追问或补充，必须借助历史；ambiguous=无法安全消解；none=非业务输入。",
      "targetTopic 必须是可独立理解的完整业务问题。independent 时尽量逐字保留当前用户原话；dependent 时只补齐历史中明确存在的对象/动作，绝不改写用户原意。",
      "必须保留时间、范围、条件、业务实体、操作、异常现象、错误码和否定信息。禁止把‘这个月的报表不对’改成泛化的‘如何处理报表数据异常’。",
      "独立新问题用 start/switch；当前话题追问用 continue；回到更早话题用 resume；关联但不同的子问题用 extend。多候选、矛盾或信息不足必须 clarify 且 needsClarification=true。",
      "用户说‘第一个/第二个’时，严格按上方已出现话题的编号选择；编号存在时这是可安全消解的 resume/continue，不得标为歧义，编号不存在才澄清。",
      "semanticFrame.action 是原话中的核心业务操作，没有则为 null；其余字段均为字符串数组，只抽取用户明确表达的内容，不推断。",
      "resolvedReferences 只能指向已出现话题；元素为 expression,resolvedTo,sourceTurn。",
      "只输出 JSON，字段必须且只能为 intent,topicAction,targetTopic,resolvedReferences,confidence,needsClarification,contextDependency,semanticFrame。",
    ].join("\n") },
    { role: "user" as const, content: `历史:\n${context}\n\n已出现话题:\n${topicList}\n\n当前用户原话:\n${utterance}` },
  ];
}

function validateResult(value: unknown, topics: PriorTopic[], turnCount: number): DialogueUnderstandingResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid structured output");
  const row = value as Record<string, unknown>;
  const expected = ["confidence", "contextDependency", "intent", "needsClarification", "resolvedReferences", "semanticFrame", "targetTopic", "topicAction"];
  if (Object.keys(row).sort().join(",") !== expected.join(",")) throw new Error("unexpected structured output fields");
  if (!dialogueIntents.includes(row.intent as DialogueIntent)) throw new Error("invalid intent");
  if (!topicActions.includes(row.topicAction as TopicAction)) throw new Error("invalid topicAction");
  if (!contextDependencies.includes(row.contextDependency as ContextDependency)) throw new Error("invalid contextDependency");
  if (typeof row.confidence !== "number" || row.confidence < 0 || row.confidence > 1) throw new Error("invalid confidence");
  if (typeof row.needsClarification !== "boolean") throw new Error("invalid needsClarification");
  const targetTopic = row.targetTopic === null ? null : clean(row.targetTopic).slice(0, 500);
  if (row.targetTopic !== null && !targetTopic) throw new Error("invalid targetTopic");
  if (!Array.isArray(row.resolvedReferences)) throw new Error("invalid resolvedReferences");
  const references = row.resolvedReferences.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid reference");
    const reference = item as Record<string, unknown>;
    const expression = clean(reference.expression); const resolvedTo = clean(reference.resolvedTo); const sourceTurn = Number(reference.sourceTurn);
    if (!expression || !resolvedTo || !Number.isInteger(sourceTurn) || sourceTurn < 1 || sourceTurn > turnCount) throw new Error("invalid reference fields");
    if (!topics.some((topic) => sameTopic(topic.topic, resolvedTo))) throw new Error("ungrounded reference");
    return { expression, resolvedTo, sourceTurn };
  });
  const semanticFrame = validateFrame(row.semanticFrame);
  return { intent: row.intent as DialogueIntent, topicAction: row.topicAction as TopicAction, targetTopic, resolvedReferences: references, confidence: row.confidence, needsClarification: row.needsClarification, contextDependency: row.contextDependency as ContextDependency, semanticFrame };
}

function validateFrame(value: unknown): DialogueSemanticFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid semanticFrame");
  const row = value as Record<string, unknown>;
  const action = row.action === null || row.action === undefined ? null : clean(row.action).slice(0, 80);
  if (row.action !== null && row.action !== undefined && !action) throw new Error("invalid semanticFrame.action");
  const array = (name: string) => {
    if (row[name] === undefined) return [];
    if (!Array.isArray(row[name])) throw new Error(`invalid semanticFrame.${name}`);
    return [...new Set(row[name].map((item) => clean(item).slice(0, 120)).filter(Boolean))];
  };
  return { action, entities: array("entities"), timeExpressions: array("timeExpressions"), conditions: array("conditions"), symptoms: array("symptoms"), negations: array("negations") };
}

function enforceSafety(utterance: string, topics: PriorTopic[], result: DialogueUnderstandingResult): DialogueUnderstandingResult {
  if (result.contextDependency === "ambiguous" || result.needsClarification || result.confidence < 0.55) return { ...result, topicAction: "clarify" as const, targetTopic: null, resolvedReferences: [], needsClarification: true, contextDependency: "ambiguous" as const };
  if (["resume", "continue"].includes(result.topicAction) && result.contextDependency === "dependent" && !topics.length) return { ...result, topicAction: "clarify" as const, targetTopic: null, resolvedReferences: [], needsClarification: true, contextDependency: "ambiguous" as const };
  if (result.contextDependency === "independent" && result.targetTopic && losesCriticalInformation(utterance, result.targetTopic)) return { ...result, topicAction: "clarify" as const, targetTopic: null, resolvedReferences: [], needsClarification: true, contextDependency: "ambiguous" as const };
  const explicitFrame = extractFrame(utterance);
  const current = topics.at(-1);
  if (current && /^(?:如果|要是|假如|已经)/.test(utterance) && result.contextDependency === "dependent") {
    return {
      ...result,
      intent: inferIntent(utterance),
      topicAction: "continue",
      targetTopic: `${(current.resolvedQuery || current.topic).replace(/[？?。！!]+$/g, "")}，${utterance}`,
      contextDependency: "dependent",
      semanticFrame: mergeFrame(result.semanticFrame, explicitFrame),
    };
  }
  if (/(?:先到这里|先不说|先放一边).*(?:接着|然后|再)(?:问|咨询)/.test(utterance) && explicitFrame.entities.length) {
    const nextQuestion = utterance.match(/(?:接着|然后|再)(?:问|咨询)?[：:]?\s*(.+)$/)?.[1] || utterance;
    return {
      ...result,
      intent: inferIntent(nextQuestion),
      topicAction: "switch",
      targetTopic: nextQuestion,
      resolvedReferences: [],
      contextDependency: "independent",
      semanticFrame: extractFrame(nextQuestion),
    };
  }
  const hasReference = /(?:那个|这个(?!月)|它|刚才|上一个|前面|第[一二三四五六七八九十\d]+个|那(?:怎么|如何)|这(?:怎么|如何))/.test(utterance);
  const hasDependencyCue = hasReference || /^(?:如果|要是|假如|已经|还要|新增后|删除后|修改后|查询后|操作后)|(?:后|以后)(?:怎么|如何)/.test(utterance);
  if (result.contextDependency === "dependent" && result.intent !== "correct" && explicitFrame.entities.length && !hasDependencyCue) {
    return {
      ...result,
      topicAction: topics.length ? "switch" : "start",
      targetTopic: utterance,
      resolvedReferences: [],
      contextDependency: "independent",
      semanticFrame: mergeFrame(result.semanticFrame, explicitFrame),
    };
  }
  const explicitIntent = inferIntent(utterance);
  const explicitBusiness = isSelfContainedBusiness(utterance, extractFrame(utterance));
  if ((result.intent === "end" || result.topicAction === "end") && explicitBusiness) {
    return { ...result, intent: explicitIntent, topicAction: topics.length ? "switch" : "start", targetTopic: result.targetTopic || utterance, contextDependency: "independent", needsClarification: false };
  }
  if (!["correct", "clarify", "confirm", "deny", "end", "transfer", "chitchat"].includes(result.intent) && /新增|新建|创建|添加|删除|移除|修改|更改|编辑|调整|查询|查找|查看|搜索|筛选|分配|授权/.test(utterance)) return { ...result, intent: explicitIntent };
  return result;
}

function mergeFrame(left: DialogueSemanticFrame, right: DialogueSemanticFrame): DialogueSemanticFrame {
  return {
    action: right.action || left.action,
    entities: unique([...left.entities, ...right.entities]),
    timeExpressions: unique([...left.timeExpressions, ...right.timeExpressions]),
    conditions: unique([...left.conditions, ...right.conditions]),
    symptoms: unique([...left.symptoms, ...right.symptoms]),
    negations: unique([...left.negations, ...right.negations]),
  };
}

function safeFallback(utterance: string, turns: DialogueTurn[], topics: PriorTopic[]): DialogueUnderstandingResult {
  const current = topics.at(-1);
  const frame = extractFrame(utterance);
  const reference = /(?:那个|这个(?!月)|它|刚才|上一个|前面|那(?:怎么|如何)|这(?:怎么|如何))/.test(utterance);
  const ellipsis = /^(?:那|然后|接着|这个|那个)?(?:再)?(?:怎么|如何|具体|下一步|还有|能否|可以).{0,12}[？?。！!]*$/.test(utterance) && !frame.entities.length && !frame.action;
  if (reference || ellipsis) return { ...baseResult("clarify", "clarify", null, 0.2, true, "ambiguous"), semanticFrame: frame };
  if (isSelfContainedBusiness(utterance, frame)) return { ...baseResult(inferIntent(utterance), turns.length && current ? "switch" : "start", utterance, 0.62, false, "independent"), semanticFrame: frame };
  return { ...baseResult("clarify", "clarify", null, 0.2, true, "ambiguous"), semanticFrame: frame };
}

function baseResult(intent: DialogueIntent, topicAction: TopicAction, targetTopic: string | null, confidence: number, needsClarification: boolean, contextDependency: ContextDependency): DialogueUnderstandingResult {
  return { intent, topicAction, targetTopic, resolvedReferences: [], confidence, needsClarification, contextDependency, semanticFrame: emptyFrame() };
}
function emptyFrame(): DialogueSemanticFrame { return { action: null, entities: [], timeExpressions: [], conditions: [], symptoms: [], negations: [] }; }
function extractFrame(value: string): DialogueSemanticFrame {
  const actions = value.match(/新增|新建|创建|添加|删除|移除|作废|修改|更改|编辑|调整|查询|查找|查看|搜索|筛选|备份|恢复|还原|导入|导出|生成|关账|结账|关闭|启用|停用|分配|授权/g) || [];
  const entities = value.match(/报表模板|客户档案|操作人员|下级部门|会计科目|账套|公司|部门|科目|客户|供应商|凭证|订单|发票|报表|库存|存货|仓库|操作员|用户|权限|模板/g) || [];
  const timeExpressions = value.match(/(?:今天|昨天|本月|这个月|上个月|本年|今年|去年|第\d+期|\d{4}年|\d{1,2}月|\d{1,2}[日号])/g) || [];
  const conditions = value.match(/(?:如果|当|只有|需要|必须|按|在|没有)[^，。！？!?]{1,30}/g) || [];
  const symptoms = value.match(/(?:报错|错误|异常|不对|失败|无法|不能|没反应|打不开|未设置)[^，。！？!?]{0,30}|\b[A-Z]?[0-9]{2,}[A-Z0-9_-]*\b/gi) || [];
  const negations = value.match(/(?:不要|不能|无法|没有|未|不对|不是|并非)[^，。！？!?]{0,20}/g) || [];
  return { action: actions[0] || null, entities: unique(entities), timeExpressions: unique(timeExpressions), conditions: unique(conditions), symptoms: unique(symptoms), negations: unique(negations) };
}
function inferIntent(value: string): DialogueIntent {
  if (/故障|报错|错误|异常|不对|失败|无法|不能|没反应|打不开/.test(value)) return "troubleshoot";
  const actions = [...value.matchAll(/新增|新建|创建|添加|删除|移除|修改|更改|编辑|调整|查询|查找|查看|搜索|筛选|分配|授权/g)].map((item) => item[0]);
  const action = actions.at(-1) || "";
  if (/删除|移除/.test(action)) return "delete";
  if (/新增|新建|创建|添加/.test(action)) return "create";
  if (/修改|更改|编辑|调整/.test(action)) return "update";
  if (/查询|查找|查看|搜索|筛选/.test(action)) return "query";
  return "consult";
}
function isSelfContainedBusiness(value: string, frame: DialogueSemanticFrame) { return value.length >= 4 && Boolean(frame.entities.length || frame.symptoms.length || /怎么|如何|为什么|能否|是否|可以吗|报错|异常|问题/.test(value)); }
function isLikelySlotValue(value: string) { return value.length <= 80 && !/[？?]/.test(value) && !/怎么|如何|为什么|报错|异常|问题/.test(value); }
function losesCriticalInformation(source: string, target: string) { return criticalUnits(source).some((unit) => !target.toLowerCase().includes(unit.toLowerCase())); }
function criticalUnits(value: string) { return unique([...(value.match(/(?:这个月|本月|上个月|今天|昨天|今年|去年|按行|按[^，。！？!?]{1,12}|不要|不能|无法|没有|不是|报错|异常|不对|失败|\b[A-Z]?[0-9]{2,}[A-Z0-9_-]*\b)/gi) || [])]); }
function unique(values: string[]) { return [...new Set(values.map((item) => clean(item)).filter(Boolean))]; }
function uniqueTopics(topics: PriorTopic[]) { const seen = new Set<string>(); return topics.filter((item) => { const key = item.topic.trim(); if (!key || seen.has(key)) return false; seen.add(key); return true; }); }
function sameTopic(left: string, right: string) { return left === right || left.includes(right) || right.includes(left); }
function chineseOrdinal(value: string) { if (/^\d+$/.test(value)) return Number(value); const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }; if (value === "十") return 10; if (value.startsWith("十")) return 10 + (digits[value[1]] || 0); if (value.endsWith("十")) return (digits[value[0]] || 0) * 10; return digits[value] || 0; }
function parseJson(value: string) { return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as unknown; }
function truncate(value: string, length: number) { return value.length > length ? `${value.slice(0, length)}…` : value; }
function clean(value: unknown) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function safeError(error: unknown) { return (error instanceof Error ? error.message : "未知错误").replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi, "<redacted>").slice(0, 500); }
