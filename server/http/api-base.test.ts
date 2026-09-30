import assert from "node:assert/strict";
import test from "node:test";
import { apiUrl, resolveApiBase } from "../../components/datapilot/api-base.js";

test("API base prefers configuration and trims trailing slashes", () => {
  const previous = process.env.NEXT_PUBLIC_API_BASE_URL;
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example.com/";
  try {
    assert.equal(resolveApiBase(), "https://api.example.com");
    assert.equal(apiUrl("api/health"), "https://api.example.com/api/health");
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = previous;
  }
});

test("API base follows the browser hostname when no environment override exists", () => {
  const previous = process.env.NEXT_PUBLIC_API_BASE_URL;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  delete process.env.NEXT_PUBLIC_API_BASE_URL;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hostname: "192.168.1.88" } } });
  try {
    assert.equal(resolveApiBase(), "http://192.168.1.88:3001");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (previous !== undefined) process.env.NEXT_PUBLIC_API_BASE_URL = previous;
  }
});
