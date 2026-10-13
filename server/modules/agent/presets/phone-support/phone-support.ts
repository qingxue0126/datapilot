import type { RequestContext } from "../../../../shared/types/context.js";
import type { SessionStore } from "../../../conversation/index.js";
import { ContextManager } from "../../../conversation/index.js";
import type { KnowledgeRetrievalService } from "../../../knowledge/index.js";
import type { ModelService } from "../../../model/index.js";
import type { WorkflowStore } from "../../workflow/workflow-store.js";
import { DialogueUnderstanding, type DialogueUnderstandingResult } from "./dialogue-understanding.js";

export type PhoneSupportConfig = {
  knowledgeBaseId?: string;
  modelId?: string;
  productMetadataField?: string;
  scoreThreshold?: number;
  topK?: number;
  transferMessage?: string;
};

export type PhoneSupportResult = {
  answer: string;
  sessionId: string;
  state: "collecting" | "answering" | "transferring";
  slots: { company_name?: string; product?: string; actual_query?: string };
  currentTopic?: string;
  rewrittenQuery: string;
  sources: unknown[];
  intent: string;
  dialogueUnderstanding: DialogueUnderstandingResult;
  trace: { step: string; status: "succeeded" | "failed"; durationMs: number; detail?: string }[];
};

type Input = Record<string, unknown>;

/** Code-registered phone support harness. It intentionally has no workflow definition. */
export class PhoneSupportHarness {
  private readonly contextManager: ContextManager;
  private readonly dialogueUnderstanding: DialogueUnderstanding;

  constructor(private readonly deps: { sessions: SessionStore; models: ModelService; retrieval: KnowledgeRetrievalService; workflows: WorkflowStore; contextManager?: ContextManager; dialogueUnderstanding?: DialogueUnderstanding }) {
    this.contextManager = deps.contextManager || new ContextManager();
    this.dialogueUnderstanding = deps.dialogueUnderstanding || new DialogueUnderstanding(deps.models);
  }

  async run(context: RequestContext, input: Input, signal?: AbortSignal, onToken?: (delta: string) => void, execution: { runId?: string } = {}): Promise<PhoneSupportResult> {
    const started = Date.now();
    const query = String(input.query ?? input.question ?? input.text ?? input.actual_query ?? "").trim().slice(0, 1000);
    if (!query) throw new Error("电话客服需要 query 或 question");
    // A caller-provided id is always verified by ContextManager/store. Only an
    // absent id starts a call; an invalid id must not silently create another one.
    const sessionId = String(input.sessionId ?? input.session_id ?? "").trim() || this.deps.sessions.create(context, { title: query }).id;
    const contextStarted = Date.now();
    const conversation = this.contextManager.fromSession(this.deps.sessions, context, sessionId);
    const legacyHistory = conversation.turns.length ? [] : this.deps.sessions.history(context, sessionId);
    // Keep the legacy assistant-result history as a compatibility fallback for
    // workflow adapters that expose only assistant messages from `get`.
    const history = conversation.turns.length
      ? conversation.turns
      : legacyHistory.length
        ? legacyHistory
        : normalizeInputHistory(input.__conversationHistory);
    const understanding = await this.dialogueUnderstanding.understand(context, {
      utterance: query,
      turns: history,
      priorTopics: readPriorTopics(this.deps.sessions, context, sessionId),
      signal,
    });
    const previousState = readPhoneState(this.deps.sessions, context, sessionId);
    const slots = extractSlots(input, query, history, previousState.slots);
    const currentTopic = resolveCurrentTopic(query, previousState.currentTopic || slots.actual_query);
    slots.actual_query = currentTopic;
    const rewrittenQuery = rewriteQuery(query, currentTopic, slots);
    const config = this.deps.workflows.getPresetConfig(context, "builtin.phone-support") as PhoneSupportConfig;
    const trace: PhoneSupportResult["trace"] = [
      { step: "context.prepare", status: "succeeded", durationMs: Date.now() - contextStarted, detail: `turns=${history.length}; truncated=${conversation.truncated}` },
      {
        step: "dialogue.understand",
        status: understanding.diagnostics.source === "safe_fallback" ? "failed" : "succeeded",
        durationMs: understanding.diagnostics.durationMs,
        detail: JSON.stringify({
          model: understanding.diagnostics.model,
          source: understanding.diagnostics.source,
          usage: understanding.diagnostics.usage,
          degradationReason: understanding.diagnostics.degradationReason,
          result: understanding.result,
        }),
      },
      { step: "state.extract_slots", status: "succeeded", durationMs: Date.now() - started },
    ];
    if (signal?.aborted) throw abortError();

    if (isClosingMessage(query) && history.length) {
      const answer = "\u597d\u7684\uff0c\u5982\u679c\u8fd8\u6709\u5176\u4ed6\u95ee\u9898\uff0c\u968f\u65f6\u544a\u8bc9\u6211\u3002";
      return this.persist(context, sessionId, query, answer, slots, "answering", rewrittenQuery, [], understanding.result, trace, execution.runId);
    }

    if (!slots.company_name || !slots.product) {
      const answer = !slots.company_name
        ? "\u65b9\u4fbf\u544a\u8bc9\u6211\u4e00\u4e0b\u8d35\u516c\u53f8\u7684\u540d\u79f0\u5417\uff1f"
        : "\u4e3a\u4e86\u66f4\u597d\u5730\u4e3a\u60a8\u670d\u52a1\uff0c\u8bf7\u95ee\u60a8\u73b0\u5728\u4f7f\u7528\u7684\u662f\u54ea\u4e00\u6b3e\u4ea7\u54c1\uff1f";
      return this.persist(context, sessionId, query, answer, slots, "collecting", rewrittenQuery, [], understanding.result, trace, execution.runId);
    }
    if (!config.knowledgeBaseId) {
      const answer = config.transferMessage || "当前客服知识库尚未配置，我为您转接人工客服。";
      return this.persist(context, sessionId, query, answer, slots, "transferring", rewrittenQuery, [], understanding.result, trace, execution.runId);
    }

    const retrievalStarted = Date.now();
    let retrieval;
    try {
      const field = String(config.productMetadataField || "").trim();
      retrieval = await withTimeout(this.deps.retrieval.retrieve(context, {
        knowledgeBaseId: config.knowledgeBaseId,
        query: rewrittenQuery,
        topK: config.topK ?? 5,
        scoreThreshold: config.scoreThreshold ?? 0.25,
        retrievalMode: "hybrid",
        filters: field ? { [field]: { $containsToken: slots.product } } : {},
        access: { mode: "agent", allowedKnowledgeBaseIds: [config.knowledgeBaseId] },
      }), 20_000, signal);
      trace.push({ step: "knowledge.retrieve", status: "succeeded", durationMs: Date.now() - retrievalStarted, detail: `${retrieval.items.length} hits` });
    } catch (error) {
      trace.push({ step: "knowledge.retrieve", status: "failed", durationMs: Date.now() - retrievalStarted, detail: safeError(error) });
      return this.persist(context, sessionId, query, config.transferMessage || "知识库暂时不可用，我为您转接人工客服。", slots, "transferring", rewrittenQuery, [], understanding.result, trace, execution.runId);
    }
    if (!retrieval.items.length) {
      const answer = config.transferMessage || "这个问题我暂时无法从知识库确认答案，我为您转接人工客服。";
      return this.persist(context, sessionId, query, answer, slots, "transferring", rewrittenQuery, [], understanding.result, trace, execution.runId);
    }

    const validationStarted = Date.now();
    const metadataField = String(config.productMetadataField || "").trim();
    const evidence = retrieval.items.find((item) => matchesProduct(item.metadata, metadataField, slots.product) && isRelevantEvidence(currentTopic || rewrittenQuery, item.content));
    if (!evidence) {
      trace.push({ step: "knowledge.validate", status: "failed", durationMs: Date.now() - validationStarted, detail: "No product- and topic-consistent hit" });
      const answer = config.transferMessage || "这个问题我暂时无法从知识库确认答案，我为您转接人工客服。";
      return this.persist(context, sessionId, query, answer, slots, "transferring", rewrittenQuery, [], understanding.result, trace, execution.runId);
    }
    trace.push({ step: "knowledge.validate", status: "succeeded", durationMs: Date.now() - validationStarted, detail: `evidence=${evidence.chunkId}` });

    const answerStarted = Date.now();
    const fallbackAnswer = humanizeKnowledgeAnswer(evidence.content, rewrittenQuery);
    let answer = fallbackAnswer;
    try {
      const modelContext = this.deps.workflows.executionContext(context, "builtin.phone-support", "llm");
      const content = await withTimeout(this.deps.models.text([
        { role: "system", content: [
          "你是企业软件电话热线客服，正在和客户通话。请把唯一依据改写成专业、简洁、自然的口语，不能原样朗读。",
          "只能改变措辞和语序。回答中的结论、菜单、步骤、条件、限制必须全部来自唯一依据，严禁推测、补充常识、扩展步骤或合并其他问题的答案。",
          "先直接回答，再用一到两句话说明操作。菜单路径要改成“进入……，找到……”的说法；不要使用书面报告或说明书语气。",
          "禁止说“问题描述”“解决方案”“知识库”“检索结果”“根据资料”“请按以下步骤操作”。",
          "不得补充资料中没有的信息。资料不足时只回答：这个问题我暂时无法确认，我为您转接人工客服。",
          "只输出本次通话中客服要说的话，不要输出标题、列表或分析过程。",
        ].join("\n") },
        { role: "user", content: `客户公司：${slots.company_name}\n使用产品：${slots.product}\n客户问题：${rewrittenQuery}\n唯一依据：\n${evidence.content}` },
      ], { context: modelContext, task: "answer", preferredModelId: config.modelId || "qwen3.5-flash", temperature: 0, maxTokens: 220, disableThinking: true, signal, onToken: () => undefined }), 20_000, signal);
      const generated = cleanGeneratedAnswer(content);
      answer = isGroundedRewrite(generated, evidence.content) ? generated : fallbackAnswer;
      trace.push({ step: "answer.generate", status: "succeeded", durationMs: Date.now() - answerStarted, detail: `${config.modelId || "route:answer"}; evidence=${evidence.chunkId}` });
    } catch (error) {
      trace.push({ step: "answer.generate", status: "failed", durationMs: Date.now() - answerStarted, detail: safeError(error) });
      answer = fallbackAnswer;
    }
    onToken?.(answer);
    return this.persist(context, sessionId, query, answer, slots, "answering", rewrittenQuery, retrieval.items, understanding.result, trace, execution.runId);
  }

  private persist(context: RequestContext, sessionId: string, question: string, answer: string, slots: PhoneSupportResult["slots"], state: PhoneSupportResult["state"], rewrittenQuery: string, sources: unknown[], dialogueUnderstanding: DialogueUnderstandingResult, trace: PhoneSupportResult["trace"], runId?: string) {
    const intent = dialogueUnderstanding.intent;
    this.deps.sessions.appendExchange(context, sessionId, { question, answer, result: { channel: "agent", agentId: "builtin.phone-support", runId, status: "success", question, answer, phone: { slots, state, currentTopic: slots.actual_query, rewrittenQuery, intent, dialogueUnderstanding, sources, trace } } });
    return { answer, sessionId, state, slots, currentTopic: slots.actual_query, rewrittenQuery, sources, intent, dialogueUnderstanding, trace };
  }
}

function extractSlots(input: Input, query: string, history: { question: string; answer: string }[], previous: PhoneSupportResult["slots"] = {}) {
  let company = clean(input.companyName ?? input.company_name) || previous.company_name;
  let product = clean(input.product) || previous.product;
  let actual = clean(input.actualQuery ?? input.actual_query) || previous.actual_query;
  let waitingFor: "company" | "product" | "query" | undefined;
  for (const item of history) {
    const answer = item.answer || "";
    if (waitingFor === "company" && !company) company = clean(item.question);
    else if (waitingFor === "product" && !product) product = detectProduct(item.question) || clean(item.question);
    else if (waitingFor === "query" && !actual && !isChitchat(item.question)) actual = clean(item.question);
    else if (!waitingFor && !isChitchat(item.question) && looksLikeQuestion(item.question)) actual = actual || clean(item.question);
    if (/公司名称|贵公司/.test(answer)) waitingFor = "company";
    else if (/哪一款产品|哪款产品|什么产品/.test(answer)) waitingFor = "product";
    else if (/具体遇到|有什么可以帮您|还有什么问题/.test(answer)) waitingFor = "query";
    else waitingFor = undefined;
  }
  const lastAnswer = history.at(-1)?.answer || "";
  if (/公司名称|贵公司/.test(lastAnswer)) company = company || query;
  else if (/哪一款产品|哪款产品|什么产品/.test(lastAnswer)) product = product || detectProduct(query) || clean(query);
  else if (/具体遇到|有什么可以帮您|还有什么问题/.test(lastAnswer)) actual = actual || query;
  if (!product) product = detectProduct(query);
  if (!actual && looksLikeQuestion(query) && !/^(你好|您好|谢谢|感谢|再见|拜拜)$/.test(query)) actual = query;
  return { company_name: company, product, actual_query: actual };
}
function resolveCurrentTopic(query: string, previousTopic?: string) {
  if (!previousTopic) return isBusinessQuestion(query) ? clean(query) : undefined;
  if (detectProduct(query) || isClosingMessage(query) || isContextualFollowUp(query) || !isBusinessQuestion(query)) return previousTopic;
  return clean(query) || previousTopic;
}
function rewriteQuery(query: string, currentTopic: string | undefined, slots: { product?: string }) {
  const product = slots.product ? `${slots.product} 软件` : "";
  if (!currentTopic) return [product, query].filter(Boolean).join(" ");
  const topic = normalizeTopic(currentTopic);
  const topicQuestion = asRetrievalQuestion(topic);
  if (!looksLikeQuestion(query) || detectProduct(query)) return `${product}${topicQuestion}`.trim();
  if (isDetailFollowUp(query)) return `${product}${topicQuestion}请提供详细操作步骤。`.trim();
  if (isContextualFollowUp(query)) return `${product}当前业务问题：${topic}；用户追问：${query}`.trim();
  return `${product}${query}`.trim();
}
function detectProduct(text: string) {
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  const products = [["好会计", "好会计"], ["易代账", "易代账"], ["u8", "U8"], ["t+", "T+"], ["t3", "T3"], ["t6", "T6"]] as const;
  return products.find(([token]) => normalized.includes(token))?.[1];
}
function looksLikeQuestion(text: string) { return /[？?]|怎么|如何|为什么|能不能|可以吗|怎么办|新增|新建|创建|修改|删除|查询|查看|设置|配置|导入|导出|凭证|订单|发票|账套|账簿|部门|科目|报表/.test(text); }
function isBusinessQuestion(text: string) { return looksLikeQuestion(text) && !detectProduct(text) && !isClosingMessage(text); }
function isDetailFollowUp(text: string) { return /^(?:可以)?(?:再)?(?:具体|详细)(?:怎么做|如何操作|说一下|说下|一点)?[呢吗？?。！!]*$/.test(text.trim()); }
function isContextualFollowUp(text: string) {
  const value = text.trim();
  if (isDetailFollowUp(value)) return true;
  return /^(那|然后|接着|下一步|再说|那要|那该)/.test(value) || /^(怎么办|怎么操作|如何操作|怎么做)[呢吗？?。！!]*$/.test(value);
}
function normalizeTopic(value: string) {
  return value.replace(/[？?。！!]/g, "").replace(/^(?:我)?(?:想要|需要|请问)/, "").replace(/一(?:个|下)/g, "").replace(/新增加|添加|新建|创建/g, "新增").replace(/^怎么/, "").trim();
}
function asRetrievalQuestion(topic: string) {
  if (/怎么|如何|为什么|吗$|能否|是否|可不可以/.test(topic)) return `${topic}？`;
  return `如何${topic}？`;
}
function isChitchat(text: string) { return /^(你好|您好|谢谢|谢谢你|感谢|再见|拜拜|没事了|没有了|明白了|知道了)[，。！!]?$/i.test(text.trim()); }
function normalizeInputHistory(value: unknown): { question: string; answer: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const content = String(row.content || "").trim();
    if (!content) return [];
    return [{ question: row.role === "user" ? content : "", answer: row.role === "assistant" ? content : "" }];
  }).reduce<{ question: string; answer: string }[]>((turns, item) => {
    if (item.question) turns.push({ question: item.question, answer: "" });
    else if (item.answer && turns.length) turns[turns.length - 1].answer = item.answer;
    return turns;
  }, []).filter((item) => item.question);
}
function readPhoneState(store: SessionStore, context: RequestContext, sessionId: string): { slots: PhoneSupportResult["slots"]; currentTopic?: string } {
  try {
    const messages = store.get(context, sessionId).messages;
    for (let index = messages.length - 1; index >= 0; index--) {
      const result = messages[index].result;
      const phone = result?.phone;
      if (!phone || typeof phone !== "object") continue;
      const state = phone as Record<string, unknown>;
      const rawSlots = state.slots && typeof state.slots === "object" ? state.slots as Record<string, unknown> : {};
      const slots = {
        company_name: clean(rawSlots.company_name),
        product: clean(rawSlots.product),
        actual_query: clean(rawSlots.actual_query),
      };
      return { slots, currentTopic: clean(state.currentTopic) || slots.actual_query };
    }
  } catch { /* Input-only conversations do not have persisted phone state yet. */ }
  return { slots: {} };
}
function readPriorTopics(store: SessionStore, context: RequestContext, sessionId: string) {
  try {
    return store.get(context, sessionId).messages.flatMap((message, index) => {
      if (message.role !== "assistant") return [];
      const phone = message.result?.phone as { dialogueUnderstanding?: DialogueUnderstandingResult } | undefined;
      const topic = phone?.dialogueUnderstanding?.targetTopic;
      return topic ? [{ topic, turn: Math.floor(index / 2) + 1 }] : [];
    });
  } catch { return []; }
}
function matchesProduct(metadata: unknown, field: string, product?: string) {
  if (!field || !product || !metadata || typeof metadata !== "object") return true;
  const record = metadata as Record<string, unknown>;
  if (!(field in record)) return true;
  return String(record[field] || "").split(/[\/|,，、;；\s]+/).some((token) => token.toLowerCase() === product.toLowerCase());
}
function isRelevantEvidence(topic: string, content: string) {
  const entities = ["部门", "科目", "账套", "订单", "发票", "凭证", "报表", "客户", "供应商", "存货", "仓库", "人员", "编码"];
  const requiredEntities = entities.filter((entity) => topic.includes(entity));
  if (requiredEntities.some((entity) => !content.includes(entity))) return false;
  const actions = [
    /新增|新建|创建|增加|添加/,
    /删除|移除|停用/,
    /修改|更改|编辑/,
    /备份|导出|恢复/,
    /关闭|终止/,
    /查询|查看|搜索/,
  ];
  return actions.every((action) => !action.test(topic) || action.test(content));
}
function isClosingMessage(text: string) {
  const normalized = text.replace(/[，。！？!?、,.\s]/g, "").trim();
  return new Set(["\u597d\u7684", "\u597d\u7684\u597d\u7684", "\u6ca1\u4e8b\u4e86", "\u6ca1\u6709\u4e86", "\u77e5\u9053\u4e86", "\u660e\u767d\u4e86", "\u8c22\u8c22", "\u611f\u8c22", "\u518d\u89c1", "\u62dc\u62dc"]).has(normalized);
}
function cleanGeneratedAnswer(value: string) {
  const text = String(value || "").trim();
  if (!text) return "";
  const solution = text.match(/(?:\u89e3\u51b3\u65b9\u6848|\u5904\u7406\u65b9\u6cd5)\s*[：:]\s*([\s\S]+)/);
  return (solution?.[1] || text)
    .replace(/^(?:\u56de\u7b54|\u7b54\u590d)\s*[：:]\s*/, "")
    .replace(/^根据(?:提供的)?(?:知识库|资料|检索结果)(?:内容)?[，,：:]?\s*/, "")
    .replace(/^请按以下步骤操作[：:]?\s*/, "")
    .trim();
}
function humanizeKnowledgeAnswer(value: string, query = "") {
  const problem = String(value || "").match(/(?:问题描述|问题)[：:]\s*([^\r\n]+)/)?.[1]?.trim();
  let answer = cleanGeneratedAnswer(value)
    .replace(/[\r\n]+/g, "；")
    .replace(/请按以下步骤操作[：:]?\s*/g, "")
    .replace(/录入/g, "填写")
    .replace(/重启电脑/g, "重新启动电脑")
    .trim();
  const shortPath = answer.match(/^([^，,。；-]+)-([^，,。；-]+?)进行([^，,。；]+?)(?:就可以了)?[。]?$/);
  if (shortPath) {
    const topic = conversationalTopic(problem || query);
    return `您好，${topic ? `${topic}的话，` : ""}您进入“${shortPath[1]}”，找到“${shortPath[2]}”，在那里进行${shortPath[3]}就可以了。`;
  }
  const path = answer.match(/^([^，,。；]{2,100}(?:\s*[-—→>]\s*[^，,。；]{2,50})+)[，,]\s*([\s\S]+)$/);
  if (path) {
    const menus = path[1].split(/\s*[-—→>]\s*/).filter(Boolean);
    const menuText = menus.map((menu) => `“${menu}”`).join("、");
    answer = `您先依次进入${menuText}，${path[2]}`;
  } else if (/^请/.test(answer)) {
    answer = answer.replace(/^请/, "您可以先");
  } else if (/^打开/.test(answer)) {
    answer = `您先${answer}`;
  }
  answer = answer
    .replace(/点击(增加|新增|保存|关闭|删除|确定|提交|修改|编辑)(?:按钮)?/g, "点击“$1”")
    .replace(/后保存/g, "，保存")
    .replace(/，然后保存[。；]?$/, "，保存就可以了。")
    .replace(/，保存[。；]?$/, "，保存就可以了。")
    .replace(/；+/g, "。您也可以")
    .replace(/[。；]?$/, "。");
  if (!/^(可以|不可以|不能|目前|这个问题|您)/.test(answer)) answer = `可以的。${answer}`;
  else if (/^可以的[，,]/.test(answer)) answer = answer.replace(/^可以的[，,]\s*/, "可以的。");
  return answer;
}
function conversationalTopic(value: string) {
  return String(value || "")
    .replace(/[？?。]/g, "")
    .replace(/^(?:需要|想要|请问|如何|怎么)/, "")
    .replace(/[，,].*$/, "")
    .replace(/^加科目$/, "增加会计科目")
    .replace(/怎么操作$/, "")
    .trim();
}
function isGroundedRewrite(answer: string, evidence: string) {
  if (!answer || /问题描述|解决方案|知识库|检索结果|请按以下步骤操作/.test(answer)) return false;
  const source = cleanGeneratedAnswer(evidence).replace(/\s/g, "");
  const candidate = answer.replace(/\s/g, "");
  if (candidate.length > source.length * 2 + 30) return false;
  const anchors = [...source.matchAll(/[A-Za-z0-9_+.]{2,}|[\u4e00-\u9fff]{2,8}/g)].map((item) => item[0])
    .filter((item) => !/^(请按以下|步骤操作|就可以了|进行操作)$/.test(item));
  return !anchors.length || anchors.some((item) => candidate.includes(item));
}
function clean(value: unknown) { const result = String(value || "").trim(); return result ? result.slice(0, 200) : undefined; }
async function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal) { let timer: ReturnType<typeof setTimeout> | undefined; const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`电话客服超时（${ms}ms）`)), ms); }); try { return await Promise.race([promise, timeout]); } finally { if (timer) clearTimeout(timer); if (signal?.aborted) throw abortError(); } }
function abortError() { const error = new Error("运行已中断"); error.name = "AbortError"; return error; }
function safeError(error: unknown) { return (error instanceof Error ? error.message : "未知错误").slice(0, 300); }
