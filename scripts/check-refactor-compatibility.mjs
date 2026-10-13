import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
export function contracts(root) {
  const routes = {}, schemas = [];
  for (const file of walk(path.join(root, "server")).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["get", "post", "put", "patch", "delete"].includes(node.expression.name.text) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith("/api/")) {
        const key = `${node.expression.name.text.toUpperCase()} ${node.arguments[0].text}`;
        const handler = node.arguments.slice(1).map((argument) => printer.printNode(ts.EmitHint.Unspecified, argument, source)).join("\n");
        routes[key] = hash(handler);
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX/i.test(node.text)) schemas.push(hash(node.text.replace(/\s+/g, " ").trim()));
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const protectedFiles = ["db/schema.ts", "drizzle/0000_freezing_norrin_radd.sql", "drizzle/0001_premium_the_stranger.sql", "vite.config.ts", "next.config.ts", "worker/index.ts", "build/sites-vite-plugin.ts", ".openai/hosting.json"];
  const files = Object.fromEntries(protectedFiles.map((file) => { try { return [file, hash(readFileSync(path.join(root, file)))]; } catch { return [file, null]; } }));
  return { routes: Object.fromEntries(Object.entries(routes).sort()), schemas: schemas.sort(), files };
}

if (process.argv.includes("--capture-baseline")) {
  const result = contracts("tmp/refactor-baseline");
  // Hosting/build files were not part of the movable source snapshot; capture their untouched originals.
  const current = contracts(".");
  for (const file of Object.keys(result.files)) if (result.files[file] === null) result.files[file] = current.files[file];
  mkdirSync("tests/unit/architecture/fixtures", { recursive: true });
  writeFileSync("tests/unit/architecture/fixtures/refactor-contracts.json", JSON.stringify(result, null, 2) + "\n");
} else {
  const expected = JSON.parse(readFileSync("tests/unit/architecture/fixtures/refactor-contracts.json", "utf8"));
  const actual = contracts(".");
  const differences = [];
  for (const route of new Set([...Object.keys(expected.routes), ...Object.keys(actual.routes)])) if (expected.routes[route] !== actual.routes[route]) differences.push(`Route handler changed: ${route}`);
  if (JSON.stringify(expected.schemas) !== JSON.stringify(actual.schemas)) differences.push("Database DDL changed");
  for (const file of Object.keys(expected.files)) if (expected.files[file] !== actual.files[file]) differences.push(`Protected build/schema file changed: ${file}`);
  const result = { routeCount: Object.keys(actual.routes).length, schemaStatements: actual.schemas.length, protectedFiles: Object.keys(actual.files).length, differences };
  mkdirSync("reports/tests/architecture", { recursive: true });
  writeFileSync("reports/tests/architecture/compatibility.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = differences.length ? 1 : 0;
}
