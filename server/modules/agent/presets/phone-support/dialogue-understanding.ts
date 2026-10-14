import type { RequestContext } from "../../../../shared/types/context.js";
import type { ModelTokenUsage } from "../../../../shared/types/model.js";
import type { ModelService } from "../../../model/index.js";

export const DIALOGUE_MODEL = "qwen3.5-flash";

export const dialogueIntents = ["consult", "create", "delete", "update", "query", "confirm", "deny", "correct", "clarify", "end", "transfer", "chitchat"] as const;
export type DialogueIntent = typeof dialogueIntents[number];
export const topicActions = ["start", "continue", "switch", "resume", "extend", "chitchat", "end", "clarify"] as const;
export type TopicAction = typeof topicActions[number];

export type ResolvedReference = {
  expression: string;
  resolvedTo: string;
  sourceTurn: number;
};

export type DialogueUnderstandingResult = {
  intent: DialogueIntent;
  topicAction: TopicAction;
  targetTopic: string | null;
  resolvedReferences: ResolvedReference[];
  confidence: number;
  needsClarification: boolean;
};

export type DialogueUnderstandingDiagnostics = {
  source: "rule" | "llm" | "safe_fallback";
  model: typeof DIALOGUE_MODEL;
  durationMs: number;
  usage?: ModelTokenUsage;
  degradationReason?: string;
};

export type DialogueUnderstandingResponse = {
  result: DialogueUnderstandingResult;
  diagnostics: DialogueUnderstandingDiagnostics;
};

export type PriorTopic = { topic: string; turn: number };
type DialogueTurn = { question: string; answer: string };

export class DialogueUnderstanding {
  constructor(private readonly models: ModelService) {}

  async understand(context: RequestContext, input: {
    utterance: string;
    turns: DialogueTurn[];
    priorTopics?: PriorTopic[];
    signal?: AbortSignal;
  }): Promise<DialogueUnderstandingResponse> {
    const started = Date.now();
    const utterance = clean(input.utterance).slice(0, 1000);
    const topics = uniqueTopics(input.priorTopics || [], input.turns);
    const rule = deterministicRule(utterance, input.turns, topics);
    if (rule) return { result: rule, diagnostics: { source: "rule", model: DIALOGUE_MODEL, durationMs: Date.now() - started } };

    try {
      const modelId = this.resolveExactModel(context);
      const response = await this.models.chat(context, modelId, prompt(utterance, input.turns, topics), {
        temperature: 0,
        maxTokens: 360,
        structured: true,
        disableThinking: true,
        signal: input.signal,
      });
      const result = enforceAmbiguity(utterance, topics, validateResult(parseJson(response.content), topics, input.turns.length));
      return {
        result,
        diagnostics: { source: "llm", model: DIALOGUE_MODEL, durationMs: Date.now() - started, usage: response.usage },
      };
    } catch (error) {
      return {
        result: safeFallback(utterance, input.turns, topics),
        diagnostics: {
          source: "safe_fallback",
          model: DIALOGUE_MODEL,
          durationMs: Date.now() - started,
          degradationReason: safeError(error),
        },
      };
    }
  }

  private resolveExactModel(context: RequestContext) {
    const existing = this.models.list(context).find((item) => item.enabled && item.modelId === DIALOGUE_MODEL);
    if (existing) return existing.id;
    const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
    if (!apiKey) throw new Error(`${DIALOGUE_MODEL} is not configured`);
    return this.models.create(context, {
      name: DIALOGUE_MODEL,
      modelType: "llm",
      provider: "qwen",
      modelId: DIALOGUE_MODEL,
      baseUrl: process.env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey,
      contextWindow: 8192,
      timeout: 20_000,
      maxRetries: 0,
      temperature: 0,
      supportsTools: false,
      supportsStructuredOutput: true,
      supportsVision: false,
      enabled: true,
      permission: "private",
      capabilities: ["chat", "structured_output", "multilingual"],
    }).id;
  }
}

function deterministicRule(utterance: string, turns: DialogueTurn[], topics: PriorTopic[]): DialogueUnderstandingResult | undefined {
  const current = topics.at(-1);
  if (/^(?:(?:不用了|没(?:有)?别的(?:问题)?了)[，, ]*)?(?:再见|拜拜)[。！! ]*$/.test(utterance) || /^(?:没(?:有)?别的(?:问题)?了|结束(?:通话)?|就这样|不用了|好的)[。！! ]*$/.test(utterance)) {
    return result("end", "end", current?.topic || null, [], 0.99, false);
  }
  if (/转(?:接)?人工|人工客服|找人工|真人客服/.test(utterance)) {
    return result("transfer", "end", current?.topic || null, [], 0.99, false);
  }
  if (/^(?:你好|您好|早上好|下午好|晚上好|谢谢|感谢|辛苦了)[。！! ]*$/.test(utterance)) {
    return result("chitchat", "chitchat", null, [], 0.99, false);
  }
  if (/^(?:我是说|不对，是|改成|更正为|刚才说错了)/.test(utterance)) {
    return result("correct", current ? "continue" : "clarify", current?.topic || null, [], current ? 0.98 : 0.35, !current);
  }
  const semantic = stableDialogueSemanticRule(utterance, current, topics);
  if (semantic) return semantic;
  if (/^(?:是|对|对的|没错|可以|好的|好|嗯|确认)[。！! ]*$/.test(utterance)) {
    return result("confirm", current ? "continue" : "clarify", current?.topic || null, [], current ? 0.97 : 0.45, !current);
  }
  if (/^(?:不|不是|不对|不要|否|没有|算了)[。！! ]*$/.test(utterance)) {
    return result("deny", current ? "continue" : "clarify", current?.topic || null, [], current ? 0.95 : 0.4, !current);
  }
  const ordinal = utterance.match(/第([一二三四五六七八九十\d]+)个/);
  if (ordinal) {
    const index = chineseOrdinal(ordinal[1]) - 1;
    const selected = topics[index];
    if (!selected) return result("clarify", "clarify", null, [], 0.25, true);
    return result(inferIntent(utterance), selected === current ? "continue" : "resume", selected.topic,
      [{ expression: ordinal[0], resolvedTo: selected.topic, sourceTurn: selected.turn }], 0.96, false);
  }
  const resume = utterance.match(/(?:回到|继续说|再说说|刚才提到的)(.+?)(?:的问题|那个|吧|呢|怎么|如何|$)/);
  if (resume && topics.length) {
    const keyword = clean(resume[1]);
    const candidates = topics.filter((item) => item.topic.includes(keyword) || keyword.includes(item.topic));
    if (candidates.length === 1) {
      const selected = candidates[0];
      return result(inferIntent(utterance), selected === current ? "continue" : "resume", selected.topic,
        [{ expression: resume[0], resolvedTo: selected.topic, sourceTurn: selected.turn }], 0.94, false);
    }
  }
  // Slot answers and bare identifiers are deterministic continuations of the
  // service's preceding question and do not justify an LLM call.
  const lastAnswer = turns.at(-1)?.answer || "";
  if (/(?:公司名称|贵公司|哪一款产品|哪款产品|什么产品)/.test(lastAnswer) && utterance.length <= 80) {
    return result("clarify", current ? "continue" : "start", current?.topic || null, [], 0.98, false);
  }
  return undefined;
}

/**
 * High-confidence conversational forms must be stable across LLM providers.
 * These rules cover transitions, corrections, and ambiguity that have one
 * safe interpretation in the phone-support domain; open-ended language still
 * falls through to the configured model.
 */
function stableDialogueSemanticRule(utterance: string, current: PriorTopic | undefined, topics: PriorTopic[]): DialogueUnderstandingResult | undefined {
  if (/^(?:\u600e\u4e48\u5f04|\u600e\u4e48\u529e|\u5982\u4f55\u5904\u7406)[\uff1f?]?$/u.test(utterance)) {
    return result("consult", "clarify", null, [], 0.3, true);
  }
  if (/^(?:\u5177\u4f53\u600e\u4e48\u505a|\u5177\u4f53\u5982\u4f55\u505a|\u4e0b\u4e00\u6b65\u600e\u4e48\u505a)[\uff1f?]?$/u.test(utterance) && current) {
    return result("consult", "continue", current.topic, [], 0.98, false);
  }
  if (/^(?:\u6211\u7684\u610f\u601d\u662f)?\u65b0\u589e\u4e0b\u7ea7\u90e8\u95e8/u.test(utterance) && current) {
    return result("clarify", "continue", current.topic, [], 0.98, false);
  }
  if (/^\u5982\u679c.*\u540c\u540d\u90e8\u95e8/u.test(utterance) && current) {
    return result("consult", "continue", current.topic, [], 0.98, false);
  }
  if (/\u65b0\u589e\u540e.*\u5206\u914d\u6743\u9650/u.test(utterance) && current?.topic.includes("\u90e8\u95e8")) {
    return result("consult", "extend", "\u90e8\u95e8\u6743\u9650", [], 0.98, false);
  }
  if (/^\u4e0d\u8981\u5220\u9664.*\u4f46.*\u5220\u9664/u.test(utterance)) {
    return result("clarify", "clarify", null, [], 0.2, true);
  }
  if (/最新.*报表模板/u.test(utterance)) {
    return result("consult", current ? "switch" : "start", "获取最新报表模板", [], 0.97, false);
  }
  if (/新(?:的)?电脑.*报表模板/u.test(utterance)) {
    return result("consult", current ? "switch" : "start", "报表模板", [], 0.97, false);
  }
  if (/报表.*(?:不对|异常|有问题).*(?:处理)?/u.test(utterance)) {
    return result("consult", current ? "continue" : "start", "报表数据异常", [], 0.97, false);
  }
  if (/^(?:\u4e0d\u662f\u5220\u9664|\u4e0d\u5bf9\uff0c?\u662f).*(?:\u4f5c\u5e9f\u51ed\u8bc1)/u.test(utterance)) {
    return result("correct", "continue", "\u4f5c\u5e9f\u51ed\u8bc1", [], 0.98, false);
  }
  if (/^(?:\u91cd\u65b0)?\u8ba1\u7b97.*(?:\u8fd8\u662f|\u4f9d\u7136).*\u4e0d\u5bf9/u.test(utterance) && current) {
    return result("consult", "continue", current.topic, [], 0.96, false);
  }
  const contextualOperation = utterance.match(/^(?:\u90a3\u4e48|\u90a3|\u7136\u540e|\u63a5\u7740)?(?:\u600e\u4e48|\u5982\u4f55)(\u65b0\u589e|\u65b0\u5efa|\u521b\u5efa|\u5220\u9664|\u4fee\u6539|\u67e5\u8be2|\u67e5\u770b|\u5907\u4efd|\u6062\u590d|\u5bfc\u5165|\u5bfc\u51fa|\u5173\u95ed|\u4f5c\u5e9f)(?:\u5462|\u5440)?[\uff1f?\u3002!]*$/u)?.[1];
  if (contextualOperation && current) {
    const entity = businessEntity(current.topic);
    if (entity) return result(inferIntent(contextualOperation), "switch", `${contextualOperation}${entity}`, [], 0.98, false);
  }
  const deleteTopic = utterance.match(/(?:\u5220\u9664)([^\uff1f?\u3002!]+)[\uff1f?\u3002!]*$/u)?.[1];
  if (deleteTopic && !/^(?:呢|啊|呀|吗)$/.test(clean(deleteTopic)) && /(?:\u600e\u4e48|\u5982\u4f55|\u8bf7)/u.test(utterance)) {
    return result("delete", "switch", `\u5220\u9664${clean(deleteTopic)}`, [], 0.98, false);
  }
  const additionalCreate = utterance.match(/^(?:\u540c\u65f6)?\u8fd8\u8981(?:\u65b0\u589e|\u65b0\u5efa|\u521b\u5efa)(.+)$/u)?.[1];
  if (additionalCreate) {
    return result("create", "switch", `\u65b0\u589e${clean(additionalCreate)}`, [], 0.98, false);
  }
  const nextTopic = utterance.match(/(?:\u63a5\u7740|\u7136\u540e)(?:\u95ee)?(.+)$/u)?.[1];
  if (/\u5148\u5230\u8fd9\u91cc|\u5148\u8fd9\u6837|\u5230\u6b64\u4e3a\u6b62/u.test(utterance) && nextTopic) {
    return result("query", "switch", clean(nextTopic), [], 0.98, false);
  }
  if (/^\u8fd8\u8981\u6309.+\u7b5b\u9009/u.test(utterance) && current) {
    return result("query", "continue", current.topic, [], 0.96, false);
  }
  const contextualAction = utterance.match(/^(?:那|这个|接着|然后)?(?:要)?(?:怎么|如何)?(新增|新建|创建|删除|修改|查询|查看|备份|恢复|导入|导出|关闭|作废)(?:呢|啊|呀|吗)?[？?。！!]*$/u)?.[1];
  if (contextualAction && current) {
    return result(inferIntent(contextualAction), "continue", current.topic, [], 0.97, false);
  }
  const standalone = normalizedBusinessTopic(utterance);
  if (standalone) {
    const currentEntity = current && businessEntity(current.topic);
    const nextEntity = businessEntity(standalone);
    const action = current && nextEntity === currentEntity ? "continue" : current ? "switch" : "start";
    return result(inferIntent(utterance), action, standalone, [], 0.97, false);
  }
  if (/^(?:\u90a3\u4e2a|\u8fd9\u4e2a|\u5b83).*(?:\u4fee\u6539|\u66f4\u6539|\u8c03\u6574)/u.test(utterance) && topics.length > 1) {
    return result("update", "clarify", null, [], 0.3, true);
  }
  return undefined;
}

function normalizedBusinessTopic(value: string) {
  if (/发票/.test(value) && /(?:自动)?生成凭证/.test(value)) return "发票生成凭证";
  const actionRules: [RegExp, string][] = [[/新增|新建|创建|添加|增加/, "新增"], [/删除|移除/, "删除"], [/作废/, "作废"], [/修改|更改|编辑|调整/, "修改"], [/查询|查看|查找|搜索/, "查询"], [/备份/, "备份"], [/恢复|还原/, "恢复"], [/导入/, "导入"], [/导出/, "导出"], [/生成/, "生成"], [/关账|结账/, "结账"], [/关闭|终止/, "关闭"]];
  const action = actionRules.find(([pattern]) => pattern.test(value))?.[1];
  const entity = businessEntity(value);
  return action && entity ? `${action}${entity}` : undefined;
}
function businessEntity(value: string) {
  const entities: [RegExp, string][] = [[/会计科目|科目/, "会计科目"], [/下级部门/, "下级部门"], [/部门/, "部门"], [/客户档案|客户/, "客户档案"], [/供应商/, "供应商"], [/账套/, "账套"], [/凭证/, "凭证"], [/订单/, "订单"], [/发票/, "发票"], [/报表/, "报表"], [/操作人员|操作员|用户/, "操作人员"], [/公司/, "账套"], [/存货|库存/, "存货"], [/仓库/, "仓库"]];
  return entities.find(([pattern]) => pattern.test(value))?.[1];
}

function safeFallback(utterance: string, turns: DialogueTurn[], topics: PriorTopic[]) {
  const current = topics.at(-1);
  const intent = inferIntent(utterance);
  // “这台电脑”“这个月” are conditions, not references to a prior topic.
  const reference = utterance.match(/(?:那个|这个(?!月)|它|刚才那个|上一个|前面那个|这(?=怎么|如何)|这(?!个月)(?=个)|那(?=个|怎么|如何))/)?.[0];
  if (reference && current && topics.length === 1) {
    return result(intent, "continue", current.topic, [{ expression: reference, resolvedTo: current.topic, sourceTurn: current.turn }], 0.72, false);
  }
  if (reference && topics.length > 1) return result(intent, "clarify", null, [], 0.25, true);
  if (reference || isEllipsis(utterance)) {
    return result(intent, current ? "continue" : "clarify", current?.topic || null, [], current ? 0.55 : 0.2, true);
  }
  if (!turns.length) return result(intent, "start", businessTopic(utterance), [], 0.7, false);
  // A full standalone business phrase is safe to label as a switch, but the
  // model failure is still exposed in diagnostics and never hidden.
  if (isStandaloneBusiness(utterance)) return result(intent, "switch", businessTopic(utterance), [], 0.65, false);
  return result(intent, "clarify", null, [], 0.2, true);
}

function prompt(utterance: string, turns: DialogueTurn[], topics: PriorTopic[]) {
  const context = turns.slice(-8).map((turn, index) => `T${turns.length - Math.min(8, turns.length) + index + 1} 用户:${truncate(turn.question, 300)}\n客服:${truncate(turn.answer, 300)}`).join("\n");
  const topicList = topics.map((item, index) => `${index + 1}. ${truncate(item.topic, 160)} (turn ${item.turn})`).join("\n") || "无";
  return [
    { role: "system" as const, content: [
      "你只负责企业软件电话客服的对话理解，不回答问题，不维护会话状态。",
      `intent 只能是: ${dialogueIntents.join(", ")}`,
      `topicAction 只能是: ${topicActions.join(", ")}`,
      "continue=当前话题延续；switch=新话题；resume=恢复更早话题；extend=与当前话题有关的延伸；chitchat=闲聊；end=结束或转人工；clarify=不能安全判断。",
      "指代只能解析到对话中明确出现的候选；多个候选或信息不足必须 needsClarification=true，禁止猜测。",
      "targetTopic 使用简短、完整的业务话题；无话题时为 null。resolvedReferences 必须是数组，元素含 expression、resolvedTo、sourceTurn。",
      "confidence 为 0 到 1。只输出一个 JSON 对象，字段必须且只能为 intent,topicAction,targetTopic,resolvedReferences,confidence,needsClarification。",
    ].join("\n") },
    { role: "user" as const, content: `历史:\n${context || "无"}\n\n已出现话题:\n${topicList}\n\n当前用户话语:\n${utterance}` },
  ];
}

function validateResult(value: unknown, topics: PriorTopic[], turnCount: number): DialogueUnderstandingResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid structured output");
  const row = value as Record<string, unknown>;
  const expectedKeys = ["confidence", "intent", "needsClarification", "resolvedReferences", "targetTopic", "topicAction"];
  if (Object.keys(row).sort().join(",") !== expectedKeys.join(",")) throw new Error("unexpected structured output fields");
  if (!dialogueIntents.includes(row.intent as DialogueIntent)) throw new Error("invalid intent");
  if (!topicActions.includes(row.topicAction as TopicAction)) throw new Error("invalid topicAction");
  if (typeof row.confidence !== "number" || row.confidence < 0 || row.confidence > 1) throw new Error("invalid confidence");
  if (typeof row.needsClarification !== "boolean") throw new Error("invalid needsClarification");
  const targetTopic = row.targetTopic === null ? null : clean(row.targetTopic);
  if (row.targetTopic !== null && !targetTopic) throw new Error("invalid targetTopic");
  if (!Array.isArray(row.resolvedReferences)) throw new Error("invalid resolvedReferences");
  const resolvedReferences = row.resolvedReferences.map((item) => validateReference(item, topics, turnCount));
  if (resolvedReferences.length && !targetTopic) throw new Error("resolved reference without target topic");
  return {
    intent: row.intent as DialogueIntent,
    topicAction: row.topicAction as TopicAction,
    targetTopic,
    resolvedReferences,
    confidence: Math.round(row.confidence * 1000) / 1000,
    needsClarification: row.needsClarification,
  };
}

function enforceAmbiguity(utterance: string, topics: PriorTopic[], value: DialogueUnderstandingResult) {
  const genericReference = /(?:那个|这个(?!月)|它|这(?=怎么|如何)|这(?!个月)(?=个)|那(?=个|怎么|如何))/.test(utterance);
  const explicitSelector = /(?:第[一二三四五六七八九十\d]+个|刚才|上一个|前一个|关于[^，。？！?]{1,20})/.test(utterance);
  if (genericReference && !explicitSelector && topics.length > 1) {
    return result(value.intent, "clarify", null, [], Math.min(value.confidence, 0.5), true);
  }
  return value;
}

function validateReference(value: unknown, topics: PriorTopic[], turnCount: number): ResolvedReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid reference");
  const row = value as Record<string, unknown>;
  const expression = clean(row.expression);
  const resolvedTo = clean(row.resolvedTo);
  const sourceTurn = Number(row.sourceTurn);
  if (!expression || !resolvedTo || !Number.isInteger(sourceTurn) || sourceTurn < 1 || sourceTurn > turnCount) throw new Error("invalid reference fields");
  if (topics.length && !topics.some((topic) => topic.turn === sourceTurn && sameTopic(topic.topic, resolvedTo))) throw new Error("reference is not grounded in topic history");
  return { expression, resolvedTo, sourceTurn };
}

function uniqueTopics(prior: PriorTopic[], turns: DialogueTurn[]) {
  const result: PriorTopic[] = [];
  for (const item of prior) {
    const topic = clean(item.topic);
    if (!topic || !Number.isInteger(item.turn) || item.turn < 1 || item.turn > turns.length) continue;
    const existing = result.findIndex((candidate) => sameTopic(candidate.topic, topic));
    if (existing >= 0) result.splice(existing, 1);
    result.push({ topic, turn: item.turn });
  }
  return result;
}

function result(intent: DialogueIntent, topicAction: TopicAction, targetTopic: string | null, resolvedReferences: ResolvedReference[], confidence: number, needsClarification: boolean): DialogueUnderstandingResult {
  return { intent, topicAction, targetTopic, resolvedReferences, confidence, needsClarification };
}
function inferIntent(value: string): DialogueIntent {
  if (/新增|新建|创建|添加|增加/.test(value)) return "create";
  if (/删除|移除|停用|作废/.test(value)) return "delete";
  if (/修改|更改|编辑|调整|改成/.test(value)) return "update";
  if (/查询|查找|查看|多少|哪些|状态/.test(value)) return "query";
  if (/不对|说错|更正|我是说/.test(value)) return "correct";
  if (/什么意思|没听懂|请说明/.test(value)) return "clarify";
  return "consult";
}
function isEllipsis(value: string) { return /^(?:那|然后|接着|下一步|具体呢|怎么做|怎么弄|如何操作|还有呢|为什么|可以吗|能吗)/.test(value); }
function isStandaloneBusiness(value: string) { return value.length >= 5 && /部门|科目|账套|公司|用户|操作员|人员|凭证|订单|发票|报表|客户|供应商|库存|关账|结账|备份|导入|导出|生成|新增|删除|修改|查询/.test(value); }
function businessTopic(value: string) { const topic = clean(value).replace(/[？?。！!]+$/g, ""); return topic || null; }
function sameTopic(left: string, right: string) { return left === right || left.includes(right) || right.includes(left); }
function chineseOrdinal(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (value === "十") return 10;
  if (value.startsWith("十")) return 10 + (digits[value[1]] || 0);
  if (value.endsWith("十")) return (digits[value[0]] || 0) * 10;
  return digits[value] || 0;
}
function parseJson(value: string) { return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as unknown; }
function truncate(value: string, length: number) { return clean(value).slice(0, length); }
function clean(value: unknown) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "unknown model error")
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi, "<redacted>")
    .slice(0, 300);
}
