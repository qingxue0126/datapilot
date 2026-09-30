import assert from "node:assert/strict";
import test from "node:test";
import { createCorsOptions, isAllowedWebOrigin } from "./cors-policy.js";

test("CORS accepts localhost, LAN and public hosts on the fixed web port", () => {
  const configured = new Set(["https://datapilot.example.com"]);
  assert.equal(isAllowedWebOrigin("http://localhost:3000", configured), true);
  assert.equal(isAllowedWebOrigin("http://192.168.1.20:3000", configured), true);
  assert.equal(isAllowedWebOrigin("http://203.0.113.8:3000", configured), true);
  assert.equal(isAllowedWebOrigin("https://datapilot.example.com", configured), true);
  assert.equal(isAllowedWebOrigin("https://untrusted.example.com", configured), false);
  assert.equal(isAllowedWebOrigin("http://localhost:3002", configured), false);
});

test("CORS keeps credential support and honors comma-separated configured origins", async () => {
  const options = createCorsOptions({ WEB_ORIGIN: "https://one.example.com, https://two.example.com" });
  assert.equal(options.credentials, true);
  const decide = (origin?: string) => new Promise<boolean>((resolve, reject) => {
    if (typeof options.origin !== "function") return reject(new Error("origin callback missing"));
    options.origin(origin, (error, allowed) => error ? reject(error) : resolve(Boolean(allowed)));
  });
  assert.equal(await decide("https://two.example.com"), true);
  assert.equal(await decide("http://10.0.0.5:3000"), true);
  assert.equal(await decide(), true);
  await assert.rejects(decide("https://blocked.example.com"), /CORS 不允许来源/);
});
