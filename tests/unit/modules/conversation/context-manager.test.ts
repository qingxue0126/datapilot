import assert from "node:assert/strict";
import test from "node:test";
import { ContextManager } from "../../../../server/modules/conversation/context-manager.js";

function messages(...pairs: [string, string][]) {
  return pairs.flatMap(([question, answer], index) => [
    { id: `u${index}`, sessionId: "s", role: "user" as const, content: question, createdAt: `2026-01-01T00:00:0${index}.000Z` },
    { id: `a${index}`, sessionId: "s", role: "assistant" as const, content: answer, createdAt: `2026-01-01T00:00:0${index}.000Z` },
  ]);
}

test("context manager retains complete recent exchanges in chronological order", () => {
  const context = new ContextManager({ historyWindow: 2, maxCharacters: 100 }).organize(messages(["first", "one"], ["second", "two"], ["third", "three"]));
  assert.deepEqual(context.turns.map((turn) => turn.question), ["second", "third"]);
  assert.equal(context.truncated, true);
  assert.equal(context.droppedTurns, 1);
});

test("context manager truncates whole oldest turns rather than mixing questions and answers", () => {
  const context = new ContextManager({ historyWindow: 3, maxCharacters: 12 }).organize(messages(["1111", "aaaa"], ["2222", "bbbb"], ["3333", "cccc"]));
  assert.deepEqual(context.turns.map((turn) => turn.question), ["3333"]);
  assert.equal(context.truncated, true);
});

test("context manager enforces its character limit for one oversized exchange", () => {
  const context = new ContextManager({ maxCharacters: 6 }).organize(messages(["123456", "abcdef"]));
  assert.ok(context.turns[0].question.length + context.turns[0].answer.length <= 6);
  assert.equal(context.truncated, true);
});
