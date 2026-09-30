import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateUUID } from "../../components/datapilot/generate-uuid.js";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const studio = readFileSync(new URL("../../components/datapilot/agent-studio.tsx", import.meta.url), "utf8");

test("generateUUID falls back to UUID v4 when crypto.randomUUID is unavailable", () => {
  let next = 0;
  const cryptoWithoutRandomUUID = {
    getRandomValues(bytes: Uint8Array) {
      bytes.forEach((_, index) => { bytes[index] = next++ & 0xff; });
      return bytes;
    },
  };
  const id = generateUUID(cryptoWithoutRandomUUID);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("generateUUID remains usable when Web Crypto random primitives are unavailable", () => {
  const ids = new Set(Array.from({ length: 32 }, () => generateUUID({})));
  assert.equal(ids.size, 32);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("smart Q&A and agent conversations generate message ids through the HTTP-safe helper", () => {
  assert.match(page, /pending-\$\{generateUUID\(\)\}/);
  assert.match(page, /agent-user-\$\{generateUUID\(\)\}/);
  assert.match(page, /streamApi\(/);
  assert.match(studio, /const userMessage: ChatMessage = \{ id: generateUUID\(\)/);
  assert.match(studio, /streamApi\(/);
  assert.doesNotMatch(`${page}\n${studio}`, /(?:window\.)?crypto\.randomUUID/);
});
