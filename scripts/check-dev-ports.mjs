import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const DEV_PORTS = [3000, 3001];
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function checkDevPorts(ports = DEV_PORTS) {
  for (const port of ports) {
    if (await isPortFree(port)) continue;
    let processes = inspectPort(port);
    if (!processes.length) {
      if (await waitUntilFree(port, 10)) continue;
      processes = inspectPort(port);
    }
    const safe = processes.length > 0 && processes.every((item) => isDataPilotProcess(item, workspace));
    printConflict(port, processes, safe);
    if (!safe) throw new Error(`端口 ${port} 已被非当前 DataPilot 项目进程占用，已停止启动。`);
    for (const item of processes) terminateProcessTree(item.pid);
    if (!await waitUntilFree(port)) throw new Error(`已清理 DataPilot 遗留进程，但端口 ${port} 未及时释放。`);
    console.log(`[ports] 已释放 DataPilot 遗留端口 ${port}。`);
  }
}

export function isDataPilotProcess(info, root = workspace) {
  if (!info || info.pid === process.pid || info.pid === process.ppid) return false;
  const command = String(info.commandLine || "").replaceAll("\\", "/").toLowerCase();
  const cwd = String(info.cwd || "").replaceAll("\\", "/").toLowerCase();
  const project = path.resolve(root).replaceAll("\\", "/").toLowerCase();
  if (cwd === project || cwd.startsWith(`${project}/`)) return true;
  return command.includes(project) && /(?:vinext|server\/index\.ts|tsx|npm|node)/.test(command);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error) => resolve(error.code !== "EADDRINUSE"));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

function inspectPort(port) {
  return process.platform === "win32" ? inspectWindows(port) : inspectUnix(port);
}

function inspectWindows(port) {
  const script = [
    `$items = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    "$result = @($items | ForEach-Object {",
    "  $p = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + $_.OwningProcess) -ErrorAction SilentlyContinue",
    "  if ($p) { [PSCustomObject]@{ pid = [int]$p.ProcessId; name = $p.Name; commandLine = $p.CommandLine; cwd = '' } }",
    "}) | Sort-Object pid -Unique",
    "$result | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeProcess);
  } catch {
    return [];
  }
}

function inspectUnix(port) {
  let pids = [];
  try {
    pids = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
  } catch {
    try {
      const output = execFileSync("fuser", ["-n", "tcp", String(port)], { encoding: "utf8" });
      pids = output.trim().split(/\s+/).filter((value) => /^\d+$/.test(value));
    } catch { return []; }
  }
  return [...new Set(pids)].map((pid) => {
    try {
      const commandLine = execFileSync("sh", ["-c", `tr '\\0' ' ' < /proc/${pid}/cmdline`], { encoding: "utf8" }).trim();
      const name = execFileSync("sh", ["-c", `cat /proc/${pid}/comm`], { encoding: "utf8" }).trim();
      const cwd = execFileSync("readlink", [`/proc/${pid}/cwd`], { encoding: "utf8" }).trim();
      return normalizeProcess({ pid, name, commandLine, cwd });
    } catch { return normalizeProcess({ pid }); }
  });
}

function normalizeProcess(item) {
  return { pid: Number(item.pid), name: String(item.name || "unknown"), commandLine: String(item.commandLine || ""), cwd: String(item.cwd || "") };
}

function printConflict(port, items, safe) {
  console.error(`[ports] 端口 ${port} 已被占用。`);
  if (!items.length) console.error("[ports] 无法取得占用进程详情，为安全起见不会结束任何进程。");
  for (const item of items) {
    console.error(`[ports] PID=${item.pid} 进程=${item.name}`);
    console.error(`[ports] 命令行=${item.commandLine || "(无法读取)"}`);
  }
  if (safe) console.error("[ports] 已确认是当前 DataPilot 项目的遗留/重复进程，准备安全清理。");
}

function terminateProcessTree(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0 && !/not found|找不到/i.test(`${result.stdout}\n${result.stderr}`)) throw new Error(`无法结束 PID ${pid}：${result.stderr || result.stdout}`);
    return;
  }
  spawnSync("pkill", ["-TERM", "-P", String(pid)], { encoding: "utf8" });
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function waitUntilFree(port, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isPortFree(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  checkDevPorts().catch((error) => {
    console.error(`[ports] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
