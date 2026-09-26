import assert from "node:assert/strict";
import test from "node:test";
import { defaultModelId, modelCatalog, resolveModelId } from "./model-catalog.js";

test("model catalog exposes an allowed default and rejects unknown model ids", () => {
  const models = modelCatalog();
  assert.ok(models.length > 0);
  assert.ok(models.some((model) => model.id === defaultModelId()));
  assert.equal(resolveModelId(models[0].id), models[0].id);
  assert.throws(() => resolveModelId("untrusted-model"), /所选模型不可用/);
});
