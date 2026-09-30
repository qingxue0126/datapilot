import assert from "node:assert/strict";
import test from "node:test";
import { isDataPilotProcess } from "./check-dev-ports.mjs";

test("only processes tied to the current DataPilot workspace are safe to clean", () => {
  const root = process.platform === "win32" ? "D:\\work\\data-agent-app" : "/work/data-agent-app";
  const command = process.platform === "win32"
    ? "node D:\\work\\data-agent-app\\node_modules\\vinext\\dist\\cli.js dev"
    : "node /work/data-agent-app/node_modules/vinext/dist/cli.js dev";
  assert.equal(isDataPilotProcess({ pid: 99991, name: "node", commandLine: command, cwd: "" }, root), true);
  assert.equal(isDataPilotProcess({ pid: 99992, name: "other", commandLine: "other-server --port 3000", cwd: "" }, root), false);
});
