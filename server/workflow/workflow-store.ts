import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RequestContext } from "../core/types.js";
import { initialWorkflow, type AgentRecord, type WorkflowDefinition, type WorkflowNodeRun, type WorkflowNodeRunStatus, type WorkflowRecord, type WorkflowRun, type WorkflowRunStatus, type WorkflowStatus } from "./workflow-types.js";

type Row = Record<string, unknown>;

export class WorkflowStoreError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export class WorkflowStore {
  private readonly database: DatabaseSync;

  constructor(path = process.env.WORKFLOW_DB_PATH || resolve(".data", "workflows.sqlite")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  listAgents(context: RequestContext): AgentRecord[] {
    return (this.database.prepare(`${agentSelect} WHERE tenant_id=? AND account_set_id=? AND user_id=? ORDER BY updated_at DESC`)
      .all(context.tenantId, context.accountSetId, context.userId) as Row[]).map(agentFromRow);
  }

  getAgent(context: RequestContext, id: string): AgentRecord {
    return agentFromRow(this.agentRow(context, id));
  }

  createAgent(context: RequestContext, input: { name: string; description?: string }): { agent: AgentRecord; workflow: WorkflowRecord } {
    const id = randomUUID();
    const workflowId = randomUUID();
    const now = new Date().toISOString();
    const name = cleanName(input.name);
    this.database.prepare("INSERT INTO agents (id,tenant_id,account_set_id,user_id,name,description,status,current_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, context.tenantId, context.accountSetId, context.userId, name, String(input.description || "").trim().slice(0, 500), "draft", 1, now, now);
    this.database.prepare("INSERT INTO workflows (id,agent_id,definition_json,version,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(workflowId, id, JSON.stringify(initialWorkflow()), 1, now, now);
    this.saveVersion(id, 1, initialWorkflow(), "draft", now);
    return { agent: this.getAgent(context, id), workflow: this.getWorkflow(context, id) };
  }

  updateAgent(context: RequestContext, id: string, input: { name?: string; description?: string; status?: WorkflowStatus }): AgentRecord {
    const current = this.getAgent(context, id);
    const name = input.name === undefined ? current.name : cleanName(input.name);
    const description = input.description === undefined ? current.description : String(input.description).trim().slice(0, 500);
    const status = input.status === undefined ? current.status : validateStatus(input.status);
    this.database.prepare("UPDATE agents SET name=?,description=?,status=?,updated_at=? WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?")
      .run(name, description, status, new Date().toISOString(), id, context.tenantId, context.accountSetId, context.userId);
    return this.getAgent(context, id);
  }

  copyAgent(context: RequestContext, id: string): { agent: AgentRecord; workflow: WorkflowRecord } {
    const source = this.getAgent(context, id);
    const workflow = this.getWorkflow(context, id);
    const created = this.createAgent(context, { name: `${source.name} 副本`, description: source.description });
    return { agent: created.agent, workflow: this.saveWorkflow(context, created.agent.id, workflow.definition) };
  }

  deleteAgent(context: RequestContext, id: string) {
    this.agentRow(context, id);
    this.database.prepare("DELETE FROM agents WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?")
      .run(id, context.tenantId, context.accountSetId, context.userId);
  }

  getWorkflow(context: RequestContext, agentId: string): WorkflowRecord {
    this.agentRow(context, agentId);
    const row = this.database.prepare("SELECT * FROM workflows WHERE agent_id=?").get(agentId) as Row | undefined;
    if (!row) throw new WorkflowStoreError("工作流不存在", 404);
    return workflowFromRow(row);
  }

  saveWorkflow(context: RequestContext, agentId: string, definition: WorkflowDefinition): WorkflowRecord {
    const agent = this.getAgent(context, agentId);
    const workflow = this.getWorkflow(context, agentId);
    const version = workflow.version + 1;
    const now = new Date().toISOString();
    this.database.prepare("UPDATE workflows SET definition_json=?,version=?,updated_at=? WHERE agent_id=?")
      .run(JSON.stringify(definition), version, now, agentId);
    this.database.prepare("UPDATE agents SET current_version=?,status='draft',updated_at=? WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?")
      .run(version, now, agentId, context.tenantId, context.accountSetId, context.userId);
    this.saveVersion(agentId, version, definition, agent.status, now);
    return this.getWorkflow(context, agentId);
  }

  publish(context: RequestContext, agentId: string, enabled = true): AgentRecord {
    const agent = this.getAgent(context, agentId);
    const workflow = this.getWorkflow(context, agentId);
    const status: WorkflowStatus = enabled ? "published" : "disabled";
    const now = new Date().toISOString();
    this.database.prepare("UPDATE agents SET status=?,updated_at=? WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?")
      .run(status, now, agentId, context.tenantId, context.accountSetId, context.userId);
    this.saveVersion(agentId, workflow.version, workflow.definition, status, now, true);
    return { ...agent, status, updatedAt: now };
  }

  createRun(context: RequestContext, agentId: string, version: number, input: unknown): WorkflowRun {
    this.agentRow(context, agentId);
    const id = randomUUID(); const now = new Date().toISOString();
    this.database.prepare("INSERT INTO workflow_runs (id,agent_id,tenant_id,account_set_id,user_id,workflow_version,status,input_json,output_json,error,duration_ms,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, agentId, context.tenantId, context.accountSetId, context.userId, version, "running", json(input), null, null, 0, now, null);
    return this.getRun(context, id);
  }

  addNodeRun(context: RequestContext, runId: string, input: Omit<WorkflowNodeRun, "id" | "runId">): WorkflowNodeRun {
    this.runRow(context, runId);
    const id = randomUUID();
    this.database.prepare("INSERT INTO workflow_node_runs (id,run_id,node_id,node_type,status,input_json,output_json,error,duration_ms,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, runId, input.nodeId, input.nodeType, input.status, json(input.input), input.output === undefined ? null : json(input.output), input.error, input.durationMs, input.startedAt, input.finishedAt);
    return { ...input, id, runId };
  }

  finishNodeRun(context: RequestContext, runId: string, id: string, input: { status: WorkflowNodeRunStatus; input: unknown; output: unknown; error: string | null; durationMs: number; finishedAt: string }): WorkflowNodeRun {
    this.runRow(context, runId);
    const result = this.database.prepare("UPDATE workflow_node_runs SET status=?,input_json=?,output_json=?,error=?,duration_ms=?,finished_at=? WHERE id=? AND run_id=?")
      .run(input.status, json(input.input), input.output === undefined ? null : json(input.output), input.error, input.durationMs, input.finishedAt, id, runId);
    if (!result.changes) throw new WorkflowStoreError("节点运行记录不存在", 404);
    const row = this.database.prepare("SELECT * FROM workflow_node_runs WHERE id=? AND run_id=?").get(id, runId) as Row;
    return nodeRunFromRow(row);
  }

  finishRun(context: RequestContext, runId: string, status: WorkflowRunStatus, output: unknown, error: string | null, durationMs: number): WorkflowRun {
    this.runRow(context, runId);
    this.database.prepare("UPDATE workflow_runs SET status=?,output_json=?,error=?,duration_ms=?,finished_at=? WHERE id=?")
      .run(status, output === undefined ? null : json(output), error, durationMs, new Date().toISOString(), runId);
    return this.getRun(context, runId);
  }

  getRun(context: RequestContext, id: string): WorkflowRun {
    const row = this.runRow(context, id);
    const nodeRows = this.database.prepare("SELECT * FROM workflow_node_runs WHERE run_id=? ORDER BY rowid ASC").all(id) as Row[];
    return runFromRow(row, nodeRows.map(nodeRunFromRow));
  }

  listRuns(context: RequestContext, agentId: string): WorkflowRun[] {
    this.agentRow(context, agentId);
    return (this.database.prepare("SELECT * FROM workflow_runs WHERE agent_id=? AND tenant_id=? AND account_set_id=? AND user_id=? ORDER BY started_at DESC LIMIT 30")
      .all(agentId, context.tenantId, context.accountSetId, context.userId) as Row[]).map((row) => runFromRow(row, []));
  }

  private agentRow(context: RequestContext, id: string): Row {
    const row = this.database.prepare(`${agentSelect} WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?`)
      .get(id, context.tenantId, context.accountSetId, context.userId) as Row | undefined;
    if (!row) throw new WorkflowStoreError("智能体不存在或无权访问", 404);
    return row;
  }

  private runRow(context: RequestContext, id: string): Row {
    const row = this.database.prepare("SELECT * FROM workflow_runs WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?")
      .get(id, context.tenantId, context.accountSetId, context.userId) as Row | undefined;
    if (!row) throw new WorkflowStoreError("运行记录不存在或无权访问", 404);
    return row;
  }

  private saveVersion(agentId: string, version: number, definition: WorkflowDefinition, status: WorkflowStatus, now: string, replace = false) {
    const command = replace ? "INSERT OR REPLACE" : "INSERT";
    this.database.prepare(`${command} INTO workflow_versions (id,agent_id,version,definition_json,status,created_at) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), agentId, version, JSON.stringify(definition), status, now);
  }

  private migrate() {
    this.database.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, account_set_id TEXT NOT NULL, user_id TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', current_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(tenant_id,account_set_id,user_id);
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, definition_json TEXT NOT NULL, version INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version INTEGER NOT NULL, definition_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(agent_id,version), FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tenant_id TEXT NOT NULL, account_set_id TEXT NOT NULL, user_id TEXT NOT NULL,
      workflow_version INTEGER NOT NULL, status TEXT NOT NULL, input_json TEXT, output_json TEXT, error TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, finished_at TEXT, FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_owner ON workflow_runs(tenant_id,account_set_id,user_id,agent_id);
    CREATE TABLE IF NOT EXISTS workflow_node_runs (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, node_type TEXT NOT NULL, status TEXT NOT NULL,
      input_json TEXT, output_json TEXT, error TEXT, duration_ms INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT,
      FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );`);
  }
}

const agentSelect = "SELECT * FROM agents";
function cleanName(value: unknown) { const name = String(value || "").trim(); if (!name) throw new WorkflowStoreError("请输入智能体名称"); return name.slice(0, 100); }
function validateStatus(value: unknown): WorkflowStatus { if (!['draft', 'published', 'disabled'].includes(String(value))) throw new WorkflowStoreError("无效的智能体状态"); return value as WorkflowStatus; }
function json(value: unknown) { return JSON.stringify(value ?? null); }
function parse(value: unknown) { if (value === null || value === undefined || value === "") return null; try { return JSON.parse(String(value)); } catch { return null; } }
function agentFromRow(row: Row): AgentRecord { return { id: String(row.id), name: String(row.name), description: String(row.description || ""), status: validateStatus(row.status), currentVersion: Number(row.current_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function workflowFromRow(row: Row): WorkflowRecord { return { id: String(row.id), agentId: String(row.agent_id), definition: parse(row.definition_json) as WorkflowDefinition, version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function nodeRunFromRow(row: Row): WorkflowNodeRun { return { id: String(row.id), runId: String(row.run_id), nodeId: String(row.node_id), nodeType: String(row.node_type) as WorkflowNodeRun["nodeType"], status: String(row.status) as WorkflowNodeRunStatus, input: parse(row.input_json), output: parse(row.output_json), error: row.error == null ? null : String(row.error), durationMs: Number(row.duration_ms), startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at) }; }
function runFromRow(row: Row, nodeRuns: WorkflowNodeRun[]): WorkflowRun { return { id: String(row.id), agentId: String(row.agent_id), workflowVersion: Number(row.workflow_version), status: String(row.status) as WorkflowRunStatus, input: parse(row.input_json), output: parse(row.output_json), error: row.error == null ? null : String(row.error), durationMs: Number(row.duration_ms), startedAt: String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at), nodeRuns }; }
