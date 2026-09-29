export type ConversationInputDefinition = {
  key: string;
  name: string;
  type: "string" | "number" | "boolean" | "object";
  required: boolean;
  options?: string[];
};

export function extractConversationInput(message: string, inputs: ConversationInputDefinition[], current: Record<string, unknown>) {
  const next = structuredClone(current);
  const existingQuery = String(current.query || "").trim();
  const missingBeforeMessage = inputs.filter((input) => input.key !== "query" && !hasRunInputValue(current, input.key));
  const matchedKeys = new Set<string>();
  let explicitField = false;
  let matchedOptionOnly = false;
  for (const input of inputs) {
    if (input.key === "query") continue;
    const names = [...new Set([input.key, input.name, ...(input.key === "company_name" ? ["公司", "企业名称"] : [])].filter(Boolean))];
    let matched: string | undefined;
    for (const name of names) {
      const separator = input.key === "company_name" ? "(?:是|叫|为|[:：])" : "[:：]";
      const expression = new RegExp(`(?:^|[\\n,，])\\s*(?:我(?:们)?的?)?${escapeRegExp(name)}\\s*${separator}\\s*([^\\n,，。！？?]+)`, "i");
      const value = message.match(expression)?.[1]?.trim();
      if (value) { matched = value; explicitField = true; break; }
    }
    if (!matched && input.options?.length) {
      matched = input.options.find((option) => message.includes(option));
      if (matched && message.trim() === matched) matchedOptionOnly = true;
    }
    if (matched !== undefined) {
      setObjectPath(next, input.key, input.type === "number" ? Number(matched) : input.type === "boolean" ? matched === "true" : matched);
      matchedKeys.add(input.key);
    }
  }
  if (existingQuery && missingBeforeMessage.length) {
    const companyMissing = missingBeforeMessage.find((input) => input.key === "company_name");
    if (companyMissing && !matchedKeys.has("company_name")) {
      const productOptions = inputs.find((input) => input.key === "product")?.options || [];
      const companyCandidate = productOptions.reduce((value, option) => value.replace(option, ""), message)
        .replace(/^(?:公司名称|公司|企业名称)\s*[:：是叫为]?\s*/i, "")
        .replace(/^[\s,，;；]+|[\s,，;；]+$/g, "")
        .trim();
      const supplementalOnly = missingBeforeMessage.length === 1 || matchedKeys.has("product");
      if (supplementalOnly && companyCandidate && !/[?？]/.test(companyCandidate)) setObjectPath(next, "company_name", companyCandidate);
    }
  } else if ((!explicitField && !matchedOptionOnly) || !String(next.query || "").trim()) {
    next.query = message;
  }
  return next;
}

export function missingConversationPrompt(missing: ConversationInputDefinition[]) {
  const companyMissing = missing.some((input) => input.key === "company_name");
  const productMissing = missing.some((input) => input.key === "product");
  if (companyMissing && productMissing) return "好的，方便告诉我一下公司名称吗？另外，您正在使用哪个产品：好会计、易代账还是 T+？";
  if (companyMissing) return "好的，方便告诉我一下公司名称吗？";
  if (productMissing) return "请问您正在使用哪个产品：好会计、易代账还是 T+？";
  return `请补充：${missing.map((input) => input.name || input.key).join("、")}`;
}

export function customerFacingRunError(error: string | null | undefined) {
  const message = String(error || "");
  if (/运行输入缺少字段[:：]\s*company_name\b/i.test(message)) return "好的，方便告诉我一下公司名称吗？";
  if (/运行输入缺少字段[:：]\s*product\b/i.test(message)) return "请问您正在使用哪个产品：好会计、易代账还是 T+？";
  if (/运行输入缺少字段[:：]\s*query\b/i.test(message)) return "请描述一下您遇到的问题。";
  return "抱歉，刚才处理没有成功，请稍后再试。";
}

export function hasRunInputValue(input: Record<string, unknown>, path: string) {
  const value = inputPath(input, path);
  return value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0);
}

function inputPath(input: Record<string, unknown>, path: string) {
  let current: unknown = input;
  for (const part of path.split(".")) current = current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined;
  return current;
}
function setObjectPath(target: Record<string, unknown>, path: string, value: unknown) { const parts = path.split("."); let current = target; for (const part of parts.slice(0, -1)) { if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {}; current = current[part] as Record<string, unknown>; } current[parts.at(-1)!] = value; }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
