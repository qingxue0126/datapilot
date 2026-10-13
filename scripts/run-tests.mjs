import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const suites = args.filter((arg) => !arg.startsWith("--"));
const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = join(directory, entry.name);
  return entry.isDirectory() ? walk(file) : [file];
});
const files = suites.flatMap((suite) => walk(`tests/${suite}`)).filter((file) => /\.test\.(ts|mjs)$/.test(file))
  .filter((file) => !args.includes("--exclude-rendered") || !file.endsWith("rendered-html.test.mjs")).sort();
if (!files.length) throw new Error("No test files found");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
