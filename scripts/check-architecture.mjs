import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = `${directory}/${entry.name}`;
  return entry.isDirectory() ? walk(file) : [file];
});
const files = ["server", "components", "app"].flatMap(walk).filter((file) => /\.tsx?$/.test(file));
const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: process.cwd(), paths: { "@/*": ["./*"] } };
const domain = (file) => file.match(/^server\/modules\/[^/]+/)?.[0];
const feature = (file) => file.match(/^components\/features\/[^/]+/)?.[0];
const edges = new Map(files.map((file) => [file, []]));
const runtime = new Map(files.map((file) => [file, []]));
const violations = [];
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    let specifier, typeOnly = false;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      typeOnly = ts.isImportDeclaration(node)
        ? !!node.importClause?.isTypeOnly || !!(node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length && node.importClause.namedBindings.elements.every((item) => item.isTypeOnly))
        : node.isTypeOnly;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal; typeOnly = true;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteral(specifier) && /^(\.|@\/)/.test(specifier.text)) {
      const resolved = ts.resolveModuleName(specifier.text, path.resolve(file), options, ts.sys).resolvedModule;
      if (!resolved && !(specifier.text.endsWith(".css") && existsSync(path.resolve(path.dirname(file), specifier.text)))) violations.push(`${file}: unresolved ${specifier.text}`);
      else if (resolved) {
        const target = path.relative(process.cwd(), resolved.resolvedFileName).replaceAll("\\", "/");
        if (edges.has(target)) { edges.get(file).push(target); if (!typeOnly) runtime.get(file).push(target); }
        if (domain(target) && domain(file) !== domain(target) && !target.endsWith("/index.ts") && !target.endsWith("/contracts.ts")) violations.push(`${file}: domain internals ${target}`);
        if (file.startsWith("server/infrastructure/") && domain(target)) violations.push(`${file}: infrastructure depends on domain ${target}`);
        if (file.startsWith("server/shared/") && !target.startsWith("server/shared/")) violations.push(`${file}: shared depends on higher layer ${target}`);
        if (file.startsWith("server/") && /^(app|components)\//.test(target)) violations.push(`${file}: server depends on browser code ${target}`);
        if (/^(app|components)\//.test(file) && target.startsWith("server/") && !typeOnly && !target.endsWith("/contracts.ts")) violations.push(`${file}: browser imports server runtime ${target}`);
        if (feature(file) && feature(target) && feature(file) !== feature(target) && !target.endsWith("/index.ts") && !target.endsWith("/contracts.ts")) violations.push(`${file}: feature internals ${target}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function cycles(graph) {
  let counter = 0;
  const index = new Map(), low = new Map(), stack = [], active = new Set(), groups = [];
  function visit(file) {
    index.set(file, counter); low.set(file, counter++); stack.push(file); active.add(file);
    for (const next of graph.get(file) || []) {
      if (!index.has(next)) { visit(next); low.set(file, Math.min(low.get(file), low.get(next))); }
      else if (active.has(next)) low.set(file, Math.min(low.get(file), index.get(next)));
    }
    if (low.get(file) === index.get(file)) {
      const group = []; let next;
      do { next = stack.pop(); active.delete(next); group.push(next); } while (next !== file);
      if (group.length > 1 || graph.get(file)?.includes(file)) groups.push(group.sort());
    }
  }
  for (const file of graph.keys()) if (!index.has(file)) visit(file);
  return groups;
}
const runtimeCycles = cycles(runtime), allCycles = cycles(edges);
const moduleEdges = {};
for (const [file, targets] of edges) for (const target of targets) {
  const from = domain(file), to = domain(target);
  if (from && to && from !== to) (moduleEdges[from] ||= new Set()).add(to);
}
const moduleGraph = new Map(Object.entries(moduleEdges).map(([key, value]) => [key, [...value]]));
const moduleCycles = cycles(moduleGraph);
const misplacedTests = ["server", "components", "scripts"].flatMap(walk).filter((file) => /\.(test|spec)\./.test(file));
violations.push(...misplacedTests.map((file) => `Test outside tests/: ${file}`));
for (const old of ["server/agent", "server/core", "server/domain", "server/tools", "server/workflow", "server/context", "server/auth", "server/llm", "server/knowledge", "components/datapilot"]) {
  if (existsSync(old)) violations.push(`Legacy directory still exists: ${old}`);
}
const result = { checkedFiles: files.length, violations: [...new Set(violations)].sort(), runtimeCycles, allCycles, moduleCycles, modules: Object.fromEntries([...moduleGraph].map(([key, value]) => [key, value.sort()])) };
mkdirSync("reports/tests/architecture", { recursive: true });
writeFileSync("reports/tests/architecture/boundaries.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.violations.length || runtimeCycles.length || allCycles.length || moduleCycles.length ? 1 : 0;
