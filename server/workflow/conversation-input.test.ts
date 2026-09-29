import assert from "node:assert/strict";
import test from "node:test";
import { customerFacingRunError, extractConversationInput, hasRunInputValue, missingConversationPrompt, type ConversationInputDefinition } from "../../components/datapilot/conversation-input.js";

const inputs: ConversationInputDefinition[] = [
  { key: "query", name: "客户问题", type: "string", required: true },
  { key: "company_name", name: "公司名称", type: "string", required: true },
  { key: "product", name: "产品", type: "string", required: true, options: ["好会计", "易代账", "T+"] },
];

function missing(value: Record<string, unknown>) {
  return inputs.filter((input) => input.required && !hasRunInputValue(value, input.key));
}

test("conversation asks for company and product together when both are missing", () => {
  const value = extractConversationInput("凭证怎么查？", inputs, {});
  assert.equal(value.query, "凭证怎么查？");
  assert.equal(missingConversationPrompt(missing(value)), "好的，方便告诉我一下公司名称吗？另外，您正在使用哪个产品：好会计、易代账还是 T+？");
});

test("conversation asks only for company when product is mentioned", () => {
  const value = extractConversationInput("好会计，凭证怎么查？", inputs, {});
  assert.equal(value.product, "好会计");
  assert.equal(value.query, "好会计，凭证怎么查？");
  assert.equal(missingConversationPrompt(missing(value)), "好的，方便告诉我一下公司名称吗？");
});

test("conversation asks only for product when company is mentioned", () => {
  const value = extractConversationInput("公司名称：企通，凭证怎么查？", inputs, {});
  assert.equal(value.company_name, "企通");
  assert.equal(missingConversationPrompt(missing(value)), "请问您正在使用哪个产品：好会计、易代账还是 T+？");
});

test("supplemental company and product preserve the original customer question", () => {
  const original = extractConversationInput("凭证怎么查？", inputs, {});
  const completed = extractConversationInput("企通，好会计", inputs, original);
  assert.equal(completed.query, "凭证怎么查？");
  assert.equal(completed.company_name, "企通");
  assert.equal(completed.product, "好会计");
  assert.deepEqual(missing(completed), []);
});

test("a plain company reply fills the sole missing field without replacing query", () => {
  const completed = extractConversationInput("企通", inputs, { query: "凭证怎么查？", product: "好会计", company_name: "" });
  assert.equal(completed.query, "凭证怎么查？");
  assert.equal(completed.company_name, "企通");
});

test("workflow validation errors are converted to customer-safe prompts", () => {
  assert.equal(customerFacingRunError("运行输入缺少字段：company_name。请在顶部“运行输入”中传入该字段。"), "好的，方便告诉我一下公司名称吗？");
  assert.equal(customerFacingRunError("运行输入缺少字段：product。"), "请问您正在使用哪个产品：好会计、易代账还是 T+？");
  assert.equal(customerFacingRunError("database connection secret"), "抱歉，刚才处理没有成功，请稍后再试。");
});
