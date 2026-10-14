import type { RequestContext } from "../../../../shared/types/context.js";
import type { SessionStore } from "../../../conversation/index.js";
import { ContextManager } from "../../../conversation/index.js";
import type { KnowledgeRetrievalService } from "../../../knowledge/index.js";
import type { ModelService } from "../../../model/index.js";
import type { WorkflowStore } from "../../workflow/workflow-store.js";
import { DIALOGUE_FALLBACK_MODEL, DIALOGUE_MODEL, DialogueUnderstanding, type DialogueUnderstandingResult } from "./dialogue-understanding.js";
import { DialoguePolicy, type DialoguePolicyDecision } from "./dialogue-policy.js";
import { canonicalTopic, DialogueStateTracker, hasBusinessContent, productMention, restoreDialogueState, type DialogueState, type PhoneSlots } from "./dialogue-state-tracker.js";
import { QueryRewriter } from "./query-rewriter.js";

export type PhoneSupportConfig = {
  knowledgeBaseId?: string;
  productMetadataField?: string;
  scoreThreshold?: number;
  topK?: number;
  transferMessage?: string;
};

export type PhoneSupportResult = {
  answer: string;
  sessionId: string;
  state: "collecting" | "answering" | "transferring";
  slots: PhoneSlots;
  currentTopic?: string;
  rewrittenQuery: string;
  sources: unknown[];
  intent: string;
  dialogueUnderstanding: DialogueUnderstandingResult;
  dialogueState: DialogueState;
  policy: DialoguePolicyDecision;
  trace: { step: string; status: "succeeded" | "failed"; durationMs: number; detail?: string }[];
};

type Input = Record<string, unknown>;

/** Code-registered phone support harness. It intentionally has no workflow definition. */
export class PhoneSupportHarness {
  private readonly contextManager: ContextManager;
  private readonly dialogueUnderstanding: DialogueUnderstanding;
  private readonly stateTracker = new DialogueStateTracker();
  private readonly queryRewriter = new QueryRewriter();
  private readonly dialoguePolicy = new DialoguePolicy();

  constructor(private readonly deps: { sessions: SessionStore; models: ModelService; retrieval: KnowledgeRetrievalService; workflows: WorkflowStore; contextManager?: ContextManager; dialogueUnderstanding?: DialogueUnderstanding }) {
    this.contextManager = deps.contextManager || new ContextManager();
    this.dialogueUnderstanding = deps.dialogueUnderstanding || new DialogueUnderstanding(deps.models);
  }

  async run(context: RequestContext, input: Input, signal?: AbortSignal, onToken?: (delta: string) => void, execution: { runId?: string } = {}): Promise<PhoneSupportResult> {
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
    const previousState = readDialogueState(this.deps.sessions, context, sessionId) || bootstrapDialogueState(history);
    const understanding = await this.dialogueUnderstanding.understand(context, {
      utterance: query,
      turns: history,
      priorTopics: this.stateTracker.priorTopics(previousState),
      signal,
    });
    const stateStarted = Date.now();
    const tracked = this.stateTracker.update(previousState, understanding.result, query, input);
    const stateDuration = Date.now() - stateStarted;
    const rewriteStarted = Date.now();
    const rewrite = this.queryRewriter.rewrite(query, understanding.result, tracked.state, tracked.transition);
    const rewriteDuration = Date.now() - rewriteStarted;
    const policyStarted = Date.now();
    const policy = this.dialoguePolicy.decide(understanding.result, tracked.state, rewrite, tracked.transition);
    if (policy.waitingFor) this.stateTracker.applyWaiting(tracked.state, policy.waitingFor);
    const policyDuration = Date.now() - policyStarted;
    const slots = this.stateTracker.toSlots(tracked.state);
    const currentTopic = tracked.state.currentTopic;
    const rewrittenQuery = rewrite.query;
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
      { step: "dialogue.state", status: "succeeded", durationMs: stateDuration, detail: JSON.stringify({ transition: tracked.transition, state: tracked.state }) },
      { step: "dialogue.rewrite", status: "succeeded", durationMs: rewriteDuration, detail: JSON.stringify(rewrite) },
      { step: "dialogue.policy", status: "succeeded", durationMs: policyDuration, detail: JSON.stringify(policy) },
    ];
    if (signal?.aborted) throw abortError();
    if (policy.action !== "retrieve") {
      const answer = policy.answer || "请补充具体问题。";
      trace.push({ step: "answer", status: "succeeded", durationMs: 0, detail: `policy=${policy.action}; no_retrieval` });
      return this.persist(context, sessionId, query, answer, tracked.state, policy.action === "transfer" ? "transferring" : "collecting", rewrittenQuery, [], understanding.result, policy, trace, execution.runId);
    }
    if (!config.knowledgeBaseId) {
      const answer = config.transferMessage || "当前客服知识库尚未配置，我为您转接人工客服。";
      const transferPolicy = { action: "transfer", reason: "knowledge_base_not_configured", answer } as const;
      trace.push({ step: "answer", status: "succeeded", durationMs: 0, detail: transferPolicy.reason });
      return this.persist(context, sessionId, query, answer, tracked.state, "transferring", rewrittenQuery, [], understanding.result, transferPolicy, trace, execution.runId);
    }

    const retrievalStarted = Date.now();
    let retrieval;
    try {
      const field = String(config.productMetadataField || "").trim();
      retrieval = await withTimeout(this.deps.retrieval.retrieve(context, {
        knowledgeBaseId: config.knowledgeBaseId,
        query: rewrittenQuery,
        // Keep enough product-filtered candidates for the evidence validator
        // to distinguish closely related operations such as 结账 and 取消结账.
        topK: Math.max(config.topK ?? 5, 10),
        scoreThreshold: config.scoreThreshold ?? 0.25,
        retrievalMode: "hybrid",
        // The vector candidate set can place a related reverse-operation ahead
        // of the exact hotline question (for example, “取消结账” before
        // “怎么结账”).  The knowledge base's local keyword reranker keeps the
        // final evidence aligned with the rewritten, product-specific question.
        rerank: true,
        filters: field ? { [field]: { $containsToken: slots.product! } } : {},
        access: { mode: "agent", allowedKnowledgeBaseIds: [config.knowledgeBaseId] },
      }), 20_000, signal);
      trace.push({ step: "knowledge.retrieve", status: "succeeded", durationMs: Date.now() - retrievalStarted, detail: JSON.stringify({ query: rewrittenQuery, hits: retrieval.items.length }) });
    } catch (error) {
      trace.push({ step: "knowledge.retrieve", status: "failed", durationMs: Date.now() - retrievalStarted, detail: safeError(error) });
      const answer = config.transferMessage || "知识库暂时不可用，我为您转接人工客服。";
      return this.persist(context, sessionId, query, answer, tracked.state, "transferring", rewrittenQuery, [], understanding.result, { action: "transfer", reason: "retrieval_failed", answer }, trace, execution.runId);
    }
    if (!retrieval.items.length) {
      const answer = config.transferMessage || "这个问题我暂时无法从知识库确认答案，我为您转接人工客服。";
      return this.persist(context, sessionId, query, answer, tracked.state, "transferring", rewrittenQuery, [], understanding.result, { action: "transfer", reason: "no_retrieval_hits", answer }, trace, execution.runId);
    }

    const validationStarted = Date.now();
    const metadataField = String(config.productMetadataField || "").trim();
    const evidence = retrieval.items.find((item) => matchesProduct(item.metadata, metadataField, slots.product) && isRelevantEvidence(currentTopic || rewrittenQuery, item.content));
    if (!evidence) {
      trace.push({ step: "knowledge.validate", status: "failed", durationMs: Date.now() - validationStarted, detail: "No product- and topic-consistent hit" });
      const answer = config.transferMessage || "这个问题我暂时无法从知识库确认答案，我为您转接人工客服。";
      return this.persist(context, sessionId, query, answer, tracked.state, "transferring", rewrittenQuery, [], understanding.result, { action: "transfer", reason: "evidence_mismatch", answer }, trace, execution.runId);
    }
    trace.push({ step: "knowledge.validate", status: "succeeded", durationMs: Date.now() - validationStarted, detail: `evidence=${evidence.chunkId}` });

    const answerStarted = Date.now();
    const fallbackAnswer = humanizeKnowledgeAnswer(evidence.content, rewrittenQuery);
    let answer = fallbackAnswer;
    let answerUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    let answerModel = "";
    let answerModelLatencyMs = 0;
    const modelContext = this.deps.workflows.executionContext(context, "builtin.phone-support", "llm");
    const modelMessages = [
      { role: "system" as const, content: [
        "你是企业软件电话热线客服，正在和客户通话。请把唯一依据改写成专业、简洁、自然的口语，不能原样朗读。",
        "只能改变措辞和语序。回答中的结论、菜单、步骤、条件、限制必须全部来自唯一依据，严禁推测、补充常识、扩展步骤或合并其他问题的答案。",
        "先直接回答，再用一到两句话说明操作。菜单路径要改成“进入……，找到……”的说法；不要使用书面报告或说明书语气。",
        "本次通话的开场白已完成首次问候。当前及后续回复都不要使用“您好”“你好”或其他寒暄作为开头，也不要在客户公司名称后补寒暄。",
        "禁止说“问题描述”“解决方案”“知识库”“检索结果”“根据资料”“请按以下步骤操作”。",
        "不得补充资料中没有的信息。资料不足时只回答：这个问题我暂时无法确认，我为您转接人工客服。",
        "只输出本次通话中客服要说的话，不要输出标题、列表或分析过程。",
      ].join("\n") },
      { role: "user" as const, content: `客户公司：${slots.company_name}\n使用产品：${slots.product}\n客户问题：${rewrittenQuery}\n唯一依据：\n${evidence.content}` },
    ];
    const generateAnswer = (preferredModelId?: string) => withTimeout(this.deps.models.text(modelMessages, {
      context: modelContext,
      task: "answer",
      preferredModelId,
      temperature: 0,
      maxTokens: 220,
      disableThinking: true,
      signal,
      onToken: () => undefined,
      onUsage: (usage, latencyMs, modelId) => { answerUsage = usage; answerModelLatencyMs = latencyMs; answerModel = modelId; },
    }), 20_000, signal);
    let primaryModelId: string | undefined;
    try {
      primaryModelId = this.resolveAnswerModelId(modelContext, DIALOGUE_MODEL);
      const content = await generateAnswer(primaryModelId);
      const generated = cleanGeneratedAnswer(content);
      answer = isGroundedRewrite(generated, evidence.content) ? generated : fallbackAnswer;
      trace.push({ step: "answer.generate", status: "succeeded", durationMs: Date.now() - answerStarted, detail: JSON.stringify({ model: answerModel || primaryModelId || "route:answer", modelLatencyMs: answerModelLatencyMs, usage: answerUsage, evidence: evidence.chunkId }) });
    } catch (primaryError) {
      try {
        const fallbackModelId = this.resolveAnswerModelId(modelContext, DIALOGUE_FALLBACK_MODEL);
        if (!fallbackModelId || fallbackModelId === primaryModelId || signal?.aborted) throw primaryError;
        const content = await generateAnswer(fallbackModelId);
        const generated = cleanGeneratedAnswer(content);
        answer = isGroundedRewrite(generated, evidence.content) ? generated : fallbackAnswer;
        trace.push({ step: "answer.generate", status: "succeeded", durationMs: Date.now() - answerStarted, detail: JSON.stringify({ model: answerModel || fallbackModelId, fallback: true, modelLatencyMs: answerModelLatencyMs, usage: answerUsage, evidence: evidence.chunkId }) });
      } catch (fallbackError) {
        trace.push({ step: "answer.generate", status: "failed", durationMs: Date.now() - answerStarted, detail: `primary=${safeError(primaryError)}; fallback=${safeError(fallbackError)}` });
        answer = fallbackAnswer;
      }
    }
    answer = stripOpeningGreeting(answer, slots.company_name);
    onToken?.(answer);
    trace.push({ step: "answer", status: "succeeded", durationMs: Date.now() - answerStarted, detail: `grounded=${evidence.chunkId}` });
    return this.persist(context, sessionId, query, answer, tracked.state, "answering", rewrittenQuery, retrieval.items, understanding.result, policy, trace, execution.runId);
  }

  private persist(context: RequestContext, sessionId: string, question: string, answer: string, dialogueState: DialogueState, state: PhoneSupportResult["state"], rewrittenQuery: string, sources: unknown[], dialogueUnderstanding: DialogueUnderstandingResult, policy: DialoguePolicyDecision, trace: PhoneSupportResult["trace"], runId?: string) {
    const intent = dialogueUnderstanding.intent;
    const slots = this.stateTracker.toSlots(dialogueState);
    this.deps.sessions.appendExchange(context, sessionId, { question, answer, result: { channel: "agent", agentId: "builtin.phone-support", runId, status: "success", question, answer, phone: { slots, state, currentTopic: dialogueState.currentTopic, rewrittenQuery, intent, dialogueUnderstanding, dialogueState, policy, sources, trace } } });
    return { answer, sessionId, state, slots, currentTopic: dialogueState.currentTopic, rewrittenQuery, sources, intent, dialogueUnderstanding, dialogueState, policy, trace };
  }

  private resolveAnswerModelId(context: RequestContext, model: typeof DIALOGUE_MODEL | typeof DIALOGUE_FALLBACK_MODEL) {
    if (typeof this.deps.models.list !== "function") return undefined;
    const existing = this.deps.models.list(context).find((item) => item.enabled && item.modelId === model);
    if (existing) return existing.id;
    const isDeepSeek = model === DIALOGUE_MODEL;
    const apiKey = (isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.DASHSCOPE_API_KEY)?.trim();
    if (!apiKey) throw new Error(`${model} is not configured`);
    return this.deps.models.create(context, {
      name: model,
      modelType: "llm",
      provider: isDeepSeek ? "deepseek" : "qwen",
      modelId: model,
      baseUrl: isDeepSeek
        ? process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1"
        : process.env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1",
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
function readDialogueState(store: SessionStore, context: RequestContext, sessionId: string): DialogueState | undefined {
  try {
    const messages = store.get(context, sessionId).messages;
    for (let index = messages.length - 1; index >= 0; index--) {
      const phone = messages[index].result?.phone;
      if (!phone || typeof phone !== "object") continue;
      const raw = phone as Record<string, unknown>;
      const restored = restoreDialogueState(raw.dialogueState);
      if (restored) return restored;
      const slots = raw.slots && typeof raw.slots === "object" ? raw.slots as Record<string, unknown> : {};
      const topic = canonicalTopic(raw.currentTopic || slots.actual_query);
      const state = new DialogueStateTracker().empty();
      state.company_name = clean(slots.company_name);
      state.product = clean(slots.product);
      if (topic) {
        state.currentTopic = topic;
        state.topicHistory = [topic];
        state.topics = [{ topic, status: "active", createdTurn: 1, lastTurn: 1, slots: { product: state.product, qualifiers: [] } }];
      }
      return state;
    }
  } catch { /* A newly created session has no phone state. */ }
  return undefined;
}
function bootstrapDialogueState(history: { question: string; answer: string }[]): DialogueState {
  const state = new DialogueStateTracker().empty();
  let waitingFor: DialogueState["waitingFor"];
  for (let index = 0; index < history.length; index++) {
    const turn = history[index];
    state.turn = index + 1;
    if (waitingFor === "company" && !hasBusinessContent(turn.question)) state.company_name = clean(turn.question);
    else if (waitingFor === "product" && !hasBusinessContent(turn.question)) state.product = productMention(turn.question) || clean(turn.question);
    else {
      const topic = canonicalTopic(turn.question);
      if (topic && hasBusinessContent(turn.question)) {
        state.currentTopic = topic;
        if (!state.topicHistory.includes(topic)) state.topicHistory.push(topic);
        const qualifiers = [...turn.question.matchAll(/按([^，。！？!?]{1,20})(?:筛选|关闭|查询)/g)].map((match) => `按${match[1]}`);
        state.topics.push({ topic, status: "active", createdTurn: index + 1, lastTurn: index + 1, slots: { product: state.product, qualifiers } });
      }
    }
    if (/公司名称|贵公司/.test(turn.answer)) { waitingFor = "company"; state.prompted.company = true; }
    else if (/哪一款产品|哪款产品|什么产品/.test(turn.answer)) { waitingFor = "product"; state.prompted.product = true; }
    else if (/具体遇到|有什么可以帮您|还有什么问题/.test(turn.answer)) { waitingFor = "query"; state.prompted.query = true; }
    else waitingFor = undefined;
  }
  state.waitingFor = waitingFor;
  return state;
}
function matchesProduct(metadata: unknown, field: string, product?: string) {
  if (!field || !product || !metadata || typeof metadata !== "object") return true;
  const record = metadata as Record<string, unknown>;
  if (!(field in record)) return true;
  return String(record[field] || "").split(/[\/|,，、;；\s]+/).some((token) => token.toLowerCase() === product.toLowerCase());
}
function isRelevantEvidence(topic: string, content: string) {
  if (/最新.*报表模板/.test(topic) && !(/最新/.test(content) && /报表模板/.test(content))) return false;
  if (/结账/.test(topic) && !/取消|反结账/.test(topic) && /取消结账|反结账/.test(content)) return false;
  const entities = ["部门", "科目", "账套", "订单", "发票", "凭证", "报表", "客户", "供应商", "存货", "库存", "仓库", "操作人员", "人员", "编码"];
  const requiredEntities = entities.filter((entity) => topic.includes(entity));
  if (requiredEntities.some((entity) => !content.includes(entity))) return false;
  const actions = [
    /新增|新建|创建|增加|添加/,
    /删除|移除|停用/,
    /修改|更改|编辑/,
    /备份|导出|恢复/,
    /生成/,
    /关账|结账/,
    /关闭|终止/,
    /查询|查看|搜索/,
  ];
  if (!actions.every((action) => !action.test(topic) || action.test(content))) return false;
  if (requiredEntities.length) return true;
  const compact = topic.replace(/如何|怎么|为什么|能否|是否|可以|软件|系统|问题|操作|处理|功能|请提供|详细|步骤|[？?。！!，,：:\s]/g, "");
  const latinAnchors = compact.match(/[A-Za-z0-9_+.]{2,}/g) || [];
  const chinese = compact.replace(/[A-Za-z0-9_+.]/g, "");
  const chineseAnchors = Array.from({ length: Math.max(0, chinese.length - 1) }, (_item, index) => chinese.slice(index, index + 2));
  const anchors = [...latinAnchors, ...chineseAnchors].filter((item) => item.length >= 2);
  return anchors.length > 0 && anchors.some((anchor) => content.toLowerCase().includes(anchor.toLowerCase()));
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
    return `${topic ? `${topic}的话，` : ""}您进入“${shortPath[1]}”，找到“${shortPath[2]}”，在那里进行${shortPath[3]}就可以了。`;
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
function stripOpeningGreeting(value: string, companyName?: string) {
  let answer = String(value || "").trim();
  const company = companyName?.trim();
  if (company) answer = answer.replace(new RegExp(`^${escapeRegExp(company)}\\s*(?:您好|你好)[，,、：:！!。\\s]*`), "");
  return answer.replace(/^(?:您好|你好|哈喽|早上好|下午好|晚上好)[，,、：:！!。\s]*/, "");
}
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
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
