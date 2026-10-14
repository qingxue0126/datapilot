import type { RequestContext } from "../../../../shared/types/context.js";
import type { SessionStore } from "../../../conversation/index.js";
import { ContextManager } from "../../../conversation/index.js";
import type { KnowledgeRetrievalService } from "../../../knowledge/index.js";
import type { ModelService } from "../../../model/index.js";
import type { WorkflowStore } from "../../workflow/workflow-store.js";
import { DialogueUnderstanding, type DialogueUnderstandingResult } from "./dialogue-understanding.js";
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
    const contextDuration = Date.now() - contextStarted;
    const understanding = await this.dialogueUnderstanding.understand(context, {
      utterance: query,
      turns: history,
      priorTopics: this.stateTracker.priorTopics(previousState),
      waitingFor: previousState.waitingFor,
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
    const rewrittenQuery = rewrite.query;
    const config = this.deps.workflows.getPresetConfig(context, "builtin.phone-support") as PhoneSupportConfig;
    const trace: PhoneSupportResult["trace"] = [
      { step: "context.prepare", status: "succeeded", durationMs: contextDuration, detail: `turns=${history.length}; truncated=${conversation.truncated}` },
      {
        step: "dialogue.understand",
        status: understanding.diagnostics.source === "safe_fallback" ? "failed" : "succeeded",
        durationMs: understanding.diagnostics.durationMs,
        detail: JSON.stringify({
          model: understanding.diagnostics.model,
          route: understanding.diagnostics.route,
          modelLatencyMs: understanding.diagnostics.modelLatencyMs,
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
    const requirements = evidenceRequirements(rewrittenQuery, tracked.state, slots.product);
    const evidenceCandidates = retrieval.items
      .map((item) => ({ item, validation: validateEvidence(item.content, item.metadata, metadataField, requirements, Boolean(metadataField)) }))
      .sort((left, right) => right.validation.score - left.validation.score);
    const selected = evidenceCandidates.find((candidate) => candidate.validation.valid);
    const evidence = selected?.item;
    if (!evidence) {
      trace.push({ step: "knowledge.validate", status: "failed", durationMs: Date.now() - validationStarted, detail: JSON.stringify({ requirements, candidates: evidenceCandidates.slice(0, 5).map((item) => ({ chunkId: item.item.chunkId, ...item.validation })) }) });
      const answer = config.transferMessage || "这个问题我暂时无法从知识库确认答案，我为您转接人工客服。";
      return this.persist(context, sessionId, query, answer, tracked.state, "transferring", rewrittenQuery, [], understanding.result, { action: "transfer", reason: "evidence_mismatch", answer }, trace, execution.runId);
    }
    trace.push({ step: "knowledge.validate", status: "succeeded", durationMs: Date.now() - validationStarted, detail: JSON.stringify({ evidence: evidence.chunkId, requirements, validation: selected?.validation }) });

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
        "证据里的每个必要步骤、前置条件、限制、警告和风险提示都必须保留，不能为了简短而省略。",
        "只输出本次通话中客服要说的话，不要输出标题、列表或分析过程。",
      ].join("\n") },
      { role: "user" as const, content: `客户公司：${slots.company_name}\n使用产品：${slots.product}\n客户问题：${rewrittenQuery}\n唯一依据：\n${evidence.content}` },
    ];
    const generateAnswer = () => withTimeout(this.deps.models.text(modelMessages, {
      context: modelContext,
      task: "answer",
      temperature: 0,
      maxTokens: 420,
      disableThinking: true,
      signal,
      onToken: () => undefined,
      onUsage: (usage, latencyMs, modelId) => { answerUsage = usage; answerModelLatencyMs = latencyMs; answerModel = modelId; },
    }), 20_000, signal);
    try {
      const content = await generateAnswer();
      const generated = cleanGeneratedAnswer(content);
      const validation = validateAnswer(generated, evidence.content, requirements);
      answer = validation.valid ? generated : fallbackAnswer;
      trace.push({ step: "answer.generate", status: "succeeded", durationMs: Date.now() - answerStarted, detail: JSON.stringify({ route: "answer", model: answerModel || "managed", modelLatencyMs: answerModelLatencyMs, usage: answerUsage, evidence: evidence.chunkId, validation, usedDeterministicFallback: !validation.valid }) });
    } catch (error) {
      trace.push({ step: "answer.generate", status: "failed", durationMs: Date.now() - answerStarted, detail: safeError(error) });
      answer = fallbackAnswer;
    }
    answer = stripOpeningGreeting(answer, slots.company_name);
    const finalValidation = validateAnswer(answer, evidence.content, requirements, true);
    if (!finalValidation.valid) {
      const transferAnswer = config.transferMessage || "现有资料不足以形成可靠且完整的答复，我为您转接人工客服。";
      trace.push({ step: "answer.validate", status: "failed", durationMs: 0, detail: JSON.stringify(finalValidation) });
      return this.persist(context, sessionId, query, transferAnswer, tracked.state, "transferring", rewrittenQuery, [], understanding.result, { action: "transfer", reason: "answer_validation_failed", answer: transferAnswer }, trace, execution.runId);
    }
    trace.push({ step: "answer.validate", status: "succeeded", durationMs: 0, detail: JSON.stringify(finalValidation) });
    onToken?.(answer);
    trace.push({ step: "answer", status: "succeeded", durationMs: Date.now() - answerStarted, detail: `grounded=${evidence.chunkId}` });
    return this.persist(context, sessionId, query, answer, tracked.state, "answering", rewrittenQuery, [evidence], understanding.result, policy, trace, execution.runId);
  }

  private persist(context: RequestContext, sessionId: string, question: string, answer: string, dialogueState: DialogueState, state: PhoneSupportResult["state"], rewrittenQuery: string, sources: unknown[], dialogueUnderstanding: DialogueUnderstandingResult, policy: DialoguePolicyDecision, trace: PhoneSupportResult["trace"], runId?: string) {
    const intent = dialogueUnderstanding.intent;
    const slots = this.stateTracker.toSlots(dialogueState);
    this.deps.sessions.appendExchange(context, sessionId, { question, answer, result: { channel: "agent", agentId: "builtin.phone-support", runId, status: "success", question, answer, phone: { slots, state, currentTopic: dialogueState.currentTopic, rewrittenQuery, intent, dialogueUnderstanding, dialogueState, policy, sources, trace } } });
    return { answer, sessionId, state, slots, currentTopic: dialogueState.currentTopic, rewrittenQuery, sources, intent, dialogueUnderstanding, dialogueState, policy, trace };
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
        state.actual_query = topic;
        state.topicHistory = [topic];
        state.topics = [{ id: "legacy-1", topic, originalQuery: topic, resolvedQuery: topic, utterances: [topic], status: "active", createdTurn: 1, lastTurn: 1, slots: { product: state.product, entities: [], timeExpressions: [], conditions: [], symptoms: [], negations: [], qualifiers: [] } }];
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
        state.actual_query = topic;
        if (!state.topicHistory.includes(topic)) state.topicHistory.push(topic);
        const qualifiers = [...turn.question.matchAll(/按([^，。！？!?]{1,20})(?:筛选|关闭|查询)/g)].map((match) => `按${match[1]}`);
        for (const item of state.topics) if (item.status === "active") item.status = "paused";
        state.topics.push({ id: `history-${index + 1}`, topic, originalQuery: turn.question, resolvedQuery: turn.question, utterances: [turn.question], status: "active", createdTurn: index + 1, lastTurn: index + 1, slots: { product: state.product, action: detectKnownAction(turn.question), entities: detectKnownEntities(turn.question).map((item) => normalizeEntity(item)).filter(Boolean) as string[], timeExpressions: extractTimes(turn.question), conditions: extractCriticalConstraints(turn.question), symptoms: extractSymptoms(turn.question), negations: extractNegations(turn.question), qualifiers } });
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
type EvidenceRequirements = { product?: string; entities: string[]; actions: string[]; symptoms: string[]; constraints: string[]; timeExpressions: string[]; negations: string[] };
type EvidenceValidation = { valid: boolean; score: number; checks: Record<string, boolean>; missing: string[] };
function evidenceRequirements(query: string, state: DialogueState, product?: string): EvidenceRequirements {
  const topic = [...state.topics].reverse().find((item) => item.status === "active") || [...state.topics].reverse().find((item) => item.topic === state.currentTopic);
  const entityValues = [...(topic?.slots.entities || []), detectKnownEntities(query)].flat().map((item) => normalizeEntity(item)).filter(Boolean) as string[];
  const actionValues = [normalizeAction(topic?.slots.action), normalizeAction(detectKnownAction(query) || query)].filter(Boolean) as string[];
  const symptoms = uniqueText([...(topic?.slots.symptoms || []), ...extractSymptoms(query)]);
  const constraints = uniqueText([...(topic?.slots.conditions || []), ...extractCriticalConstraints(query)]);
  const timeExpressions = uniqueText([...(topic?.slots.timeExpressions || []), ...extractTimes(query)]);
  const negations = uniqueText([...(topic?.slots.negations || []), ...extractNegations(query)]);
  return { product, entities: uniqueText(entityValues), actions: uniqueText(actionValues), symptoms, constraints, timeExpressions, negations };
}
function validateEvidence(content: string, metadata: unknown, metadataField: string, requirements: EvidenceRequirements, productFilterApplied: boolean): EvidenceValidation {
  const normalized = normalizeText(content);
  const product = productMatches(metadata, metadataField, requirements.product, productFilterApplied);
  const entities = requirements.entities.every((item) => entityMatches(normalized, item));
  const actions = requirements.actions.every((item) => actionMatches(normalized, item)) && !hasOppositeOnly(normalized, requirements.actions);
  const symptoms = requirements.symptoms.every((item) => symptomMatches(normalized, item));
  const materialConstraints = requirements.constraints.filter(isMaterialConstraint);
  const constraints = materialConstraints.every((item) => constraintMatches(normalized, item));
  const checks = { product, entities, actions, symptoms, constraints };
  const missing = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const score = Object.values(checks).filter(Boolean).length + (entities ? requirements.entities.length * 0.1 : 0) + (symptoms ? requirements.symptoms.length * 0.15 : 0);
  return { valid: missing.length === 0 && Boolean(requirements.entities.length || requirements.actions.length || requirements.symptoms.length), score, checks, missing };
}
function productMatches(metadata: unknown, field: string, product: string | undefined, filterApplied: boolean) {
  if (!product) return false;
  if (!field) return true;
  if (!metadata || typeof metadata !== "object" || !(field in (metadata as Record<string, unknown>))) return filterApplied;
  return String((metadata as Record<string, unknown>)[field] || "").split(/[\/|,，、;；\s]+/).some((token) => token.toLowerCase() === product.toLowerCase());
}
function detectKnownEntities(value: string) { return ["会计科目", "下级部门", "部门", "客户档案", "客户", "供应商", "账套", "公司", "凭证", "订单", "发票", "报表模板", "报表", "存货", "库存", "仓库", "操作人员", "操作员", "用户", "权限"].filter((item) => value.includes(item)); }
function normalizeEntity(value: string) {
  if (/科目/.test(value)) return "科目"; if (/部门/.test(value)) return "部门"; if (/客户/.test(value)) return "客户";
  if (/操作人员|操作员|用户/.test(value)) return "操作人员"; if (/库存|存货/.test(value)) return "存货"; if (/报表模板|模板/.test(value)) return "报表模板";
  return ["供应商", "账套", "公司", "凭证", "订单", "发票", "报表", "仓库", "权限"].find((item) => value.includes(item));
}
function detectKnownAction(value: string) { return value.match(/新增|新建|创建|添加|增加|删除|移除|作废|修改|更改|编辑|调整|查询|查找|查看|搜索|筛选|备份|恢复|还原|导入|导出|生成|关账|结账|关闭|终止|启用|停用|分配|授权/)?.[0]; }
function normalizeAction(value?: string) {
  if (!value) return undefined;
  if (/新增|新建|创建|添加|增加|建(?:一个|个|立)/.test(value)) return "新增";
  if (/删除|移除/.test(value)) return "删除"; if (/作废/.test(value)) return "作废"; if (/修改|更改|编辑|调整/.test(value)) return "修改";
  if (/查询|查找|查看|搜索|筛选/.test(value)) return "查询"; if (/备份/.test(value)) return "备份"; if (/恢复|还原/.test(value)) return "恢复";
  if (/导入/.test(value)) return "导入"; if (/导出/.test(value)) return "导出"; if (/生成/.test(value)) return "生成"; if (/关账|结账/.test(value)) return "结账";
  if (/关闭|终止/.test(value)) return "关闭"; if (/启用/.test(value)) return "启用"; if (/停用/.test(value)) return "停用"; if (/分配|授权/.test(value)) return "分配";
  return undefined;
}
function entityMatches(content: string, entity: string) {
  const groups: Record<string, RegExp> = { 科目: /科目/, 公司: /公司|账套/, 部门: /部门/, 客户: /客户/, 操作人员: /操作人员|操作员|用户/, 存货: /存货|库存/, 报表模板: /报表.*模板|模板.*报表/ };
  return (groups[entity] || new RegExp(escapeRegExp(entity))).test(content);
}
function actionMatches(content: string, action: string) {
  const groups: [RegExp, RegExp][] = [[/新增|新建|创建|添加|增加/, /新增|新建|创建|添加|增加/], [/删除|移除/, /删除|移除/], [/作废/, /作废/], [/修改|更改|编辑|调整/, /修改|更改|编辑|调整/], [/查询|查找|查看|搜索|筛选/, /查询|查找|查看|搜索|筛选/], [/备份/, /备份/], [/恢复|还原/, /恢复|还原/], [/导入/, /导入/], [/导出/, /导出/], [/生成/, /生成/], [/关账|结账/, /关账|结账/], [/关闭|终止/, /关闭|终止/], [/启用/, /启用/], [/停用/, /停用/], [/分配|授权/, /分配|授权/]];
  const group = groups.find(([request]) => request.test(action)); return group ? group[1].test(content) : content.includes(action);
}
function hasOppositeOnly(content: string, actions: string[]) { return actions.some((action) => /结账/.test(action) && !/取消|反结账/.test(action) && /取消结账|反结账/.test(content) && !/(?:^|[^取消反])结账/.test(content.replace(/取消结账|反结账/g, ""))); }
function extractSymptoms(value: string) { return value.match(/(?:报错|错误|异常|不对|失败|无法|不能|没反应|打不开|未设置)[^，。！？!?]{0,24}|\b[A-Z]?[0-9]{2,}[A-Z0-9_.-]*\b/gi) || []; }
function symptomMatches(content: string, symptom: string) {
  const codes = symptom.match(/\b[A-Z]?[0-9]{2,}[A-Z0-9_.-]*\b/gi) || [];
  if (codes.some((code) => !content.toLowerCase().includes(code.toLowerCase()))) return false;
  if (/报错|错误|未设置/.test(symptom)) return /报错|错误|未设置/.test(content);
  if (/异常|不对/.test(symptom)) return /异常|不对|错误|差异|不一致/.test(content);
  if (/失败|无法|不能|打不开|没反应/.test(symptom)) return /失败|无法|不能|打不开|没反应|不支持/.test(content);
  return true;
}
function extractCriticalConstraints(value: string) { return value.match(/(?:按行|按[^，。！？!?]{1,12}(?:筛选|查询|关闭)|只有|必须|需要先|不能|不要|没有|最新|同名|下级)[^，。！？!?]{0,20}/g) || []; }
function extractTimes(value: string) { return value.match(/今天|昨天|本月|这个月|上个月|本年|今年|去年|第\d+期|\d{4}年|\d{1,2}月|\d{1,2}[日号]/g) || []; }
function extractNegations(value: string) { return value.match(/(?:不要|不能|无法|没有|未|不对|不是|并非)[^，。！？!?]{0,20}/g) || []; }
function isMaterialConstraint(value: string) { return /按行|按.+(?:筛选|查询|关闭)|只有|必须|需要先|不能|不要|没有|最新|同名|下级/.test(value); }
function constraintMatches(content: string, constraint: string) {
  if (/按行/.test(constraint)) return /按行|行关闭|逐行/.test(content);
  if (/最新/.test(constraint)) return /最新|新版|更新/.test(content);
  if (/同名/.test(constraint)) return /同名/.test(content);
  if (/下级/.test(constraint)) return /下级|子级/.test(content);
  if (/不能|不要|没有/.test(constraint)) return /不能|不要|没有|不支持|未/.test(content);
  const anchors = significantWords(constraint); return anchors.length === 0 || anchors.some((item) => content.includes(item));
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
export function validateAnswer(answer: string, evidence: string, requirements: EvidenceRequirements, deterministic = false) {
  const candidate = normalizeText(answer);
  const source = normalizeText(solutionText(evidence));
  const missing: string[] = [];
  if (!candidate || /问题描述|解决方案|知识库|检索结果|请按以下步骤操作/.test(answer)) missing.push("invalid_format");
  if (candidate.length > source.length * 2 + 40) missing.push("over_expanded");
  const requiredFacts = criticalEvidenceFacts(source);
  const missingFacts = requiredFacts.filter((fact) => !factMatches(candidate, fact));
  if (missingFacts.length) missing.push(`missing_facts:${missingFacts.join("|")}`);
  const sourceNumbers = new Set(source.match(/\b\d+(?:\.\d+)?\b/g) || []);
  const queryNumbers = new Set([...requirements.symptoms, ...requirements.constraints].flatMap((item) => item.match(/\b\d+(?:\.\d+)?\b/g) || []));
  const inventedNumbers = (candidate.match(/\b\d+(?:\.\d+)?\b/g) || []).filter((item) => !sourceNumbers.has(item) && !queryNumbers.has(item));
  if (inventedNumbers.length) missing.push(`invented_numbers:${inventedNumbers.join("|")}`);
  const inventedBusinessFacts = businessFactTokens(candidate).filter((item) => !businessFactTokens(source).includes(item) && !requirements.entities.includes(item) && !requirements.actions.some((action) => actionMatches(item, action)));
  if (inventedBusinessFacts.length && !deterministic) missing.push(`invented_business_facts:${inventedBusinessFacts.join("|")}`);
  const claimMarkers = candidate.match(/如果|下级|上级|一级|二级|自动|转到|放心|必须|禁止|风险|否则|注意/g) || [];
  const unsupportedClaims = uniqueText(claimMarkers).filter((item) => !source.includes(item));
  if (unsupportedClaims.length) missing.push(`unsupported_claims:${unsupportedClaims.join("|")}`);
  return { valid: missing.length === 0, missing, requiredFacts, missingFacts };
}
function solutionText(value: string) {
  const text = String(value || "");
  return text.match(/(?:解决方案|处理方法)[：:]\s*([\s\S]+)/)?.[1] || text.replace(/(?:问题描述|问题)[：:][^\r\n]*(?:\r?\n|$)/, "");
}
function criticalEvidenceFacts(value: string) {
  const normalized = value.replace(/请按以下步骤操作[：:]?/g, "");
  const chunks = normalized.split(/[-—→>，,。；;\r\n]+/).map((item) => item.trim()).filter(Boolean);
  const facts: string[] = [];
  for (const chunk of chunks) {
    const codes = chunk.match(/[A-Za-z][A-Za-z0-9_+.:-]{1,}|\b\d+(?:\.\d+)?\b/g) || [];
    facts.push(...codes);
    const stripped = chunk.replace(/^(?:您|请|先|再|然后|接着|需要|可以|应当|必须)/, "").replace(/(?:就可以了|即可|进行操作|操作|按钮)$/g, "").trim();
    if (stripped.length >= 2 && stripped.length <= 24 && !/^(?:可以的|处理方法)$/.test(stripped)) facts.push(stripped);
    if (/必须|不能|禁止|注意|风险|否则|仅|只有|需先|前提|备份|确认/.test(chunk) && stripped.length > 24) facts.push(...significantWords(stripped).slice(0, 3));
  }
  return uniqueText(facts).slice(0, 24);
}
function factMatches(candidate: string, fact: string) {
  if (candidate.toLowerCase().includes(fact.toLowerCase())) return true;
  const equivalent = fact.replace(/录入/g, "填写").replace(/重启/g, "重新启动").replace(/增加/g, "新增");
  if (candidate.includes(equivalent)) return true;
  const compactCandidate = compactFact(candidate);
  const compactRequired = compactFact(equivalent);
  if (compactRequired.length >= 2 && compactCandidate.includes(compactRequired)) return true;
  const words = significantWords(fact);
  return words.length > 0 && words.every((item) => compactCandidate.includes(compactFact(item)));
}
function businessFactTokens(value: string) {
  const tokens = [
    ...(value.match(/新增|新建|创建|添加|增加|删除|移除|作废|修改|更改|编辑|调整|查询|查找|查看|搜索|筛选|备份|恢复|还原|导入|导出|生成|关账|结账|关闭|终止|启用|停用|授权/g) || []),
    ...detectKnownEntities(value).map(normalizeEntity).filter(Boolean),
  ];
  return uniqueText(tokens as string[]);
}
function significantWords(value: string) {
  const latin = value.match(/[A-Za-z][A-Za-z0-9_+.:-]{1,}/g) || [];
  const chinese = value.replace(/[A-Za-z0-9_+.:-]/g, " ").split(/[的了是在和与及、\s]+/).map((item) => item.replace(/请|您|可以|需要|进行|操作|找到|进入|点击|选择|填写|录入|然后|保存|处理/g, "").trim()).filter((item) => item.length >= 2);
  return uniqueText([...latin, ...chinese]);
}
function compactFact(value: string) { return normalizeText(value).replace(/录入/g, "填写").replace(/重启/g, "重新启动").replace(/增加/g, "新增").replace(/依次|先|再|然后|接着|后|在那里|找到|进入|点击|选择|进行|就可以了|即可|按钮/g, "").replace(/[，,。；;：:、“”"']/g, ""); }
function normalizeText(value: string) { return String(value || "").replace(/\s+/g, "").replace(/[“”"']/g, ""); }
function uniqueText(values: string[]) { return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))]; }
function clean(value: unknown) { const result = String(value || "").trim(); return result ? result.slice(0, 200) : undefined; }
async function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal) { let timer: ReturnType<typeof setTimeout> | undefined; const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`电话客服超时（${ms}ms）`)), ms); }); try { return await Promise.race([promise, timeout]); } finally { if (timer) clearTimeout(timer); if (signal?.aborted) throw abortError(); } }
function abortError() { const error = new Error("运行已中断"); error.name = "AbortError"; return error; }
function safeError(error: unknown) { return (error instanceof Error ? error.message : "未知错误").slice(0, 300); }
