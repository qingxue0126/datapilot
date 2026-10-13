import type { RequestContext } from "../../../../shared/types/context.js";
import type { ModelTokenUsage } from "../../../../shared/types/model.js";
import type { ModelService } from "../../../model/index.js";

export const DIALOGUE_MODEL = "deepseek-v4-flash";

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
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) throw new Error(`${DIALOGUE_MODEL} is not configured`);
    return this.models.create(context, {
      name: DIALOGUE_MODEL,
      modelType: "llm",
      provider: "deepseek",
      modelId: DIALOGUE_MODEL,
      baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1",
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
  if (/^(?:再见|拜拜|没(?:有)?别的(?:问题)?了|结束(?:通话)?|就这样|不用了)[。！! ]*$/.test(utterance)) {
    return result("end", "end", current?.topic || null, [], 0.99, false);
  }
  if (/转(?:接)?人工|人工客服|找人工|真人客服/.test(utterance)) {
    return result("transfer", "end", current?.topic || null, [], 0.99, false);
  }
  if (/^(?:你好|您好|早上好|下午好|晚上好|谢谢|感谢|辛苦了)[。！! ]*$/.test(utterance)) {
    return result("chitchat", "chitchat", null, [], 0.99, false);
  }
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
  if (/^(?:我是说|不对，是|改成|更正为|刚才说错了)/.test(utterance)) {
    return result("correct", current ? "continue" : "clarify", current?.topic || null, [], current ? 0.9 : 0.35, !current);
  }
  // Slot answers and bare identifiers are deterministic continuations of the
  // service's preceding question and do not justify an LLM call.
  const lastAnswer = turns.at(-1)?.answer || "";
  if (/(?:公司名称|贵公司|哪一款产品|哪款产品|什么产品)/.test(lastAnswer) && utterance.length <= 80) {
    return result("clarify", current ? "continue" : "start", current?.topic || null, [], 0.98, false);
  }
  return undefined;
}

function safeFallback(utterance: string, turns: DialogueTurn[], topics: PriorTopic[]) {
  const current = topics.at(-1);
  const intent = inferIntent(utterance);
  const reference = utterance.match(/(?:这|那|它|刚才那个|上一个|前面那个)/)?.[0];
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
  const genericReference = /(?:那个|这个|它|这|那)/.test(utterance);
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
function isStandaloneBusiness(value: string) { return value.length >= 5 && /部门|科目|账套|凭证|订单|发票|报表|客户|供应商|库存|结账|备份|导入|导出|新增|删除|修改|查询/.test(value); }
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
