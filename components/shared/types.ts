import type { JoinPathDefinition, MappingAuditRecord, MappingRegistryVersion, MappingValidationSummary, MappingVersionDiff, SchemaSearchResult, SemanticEntityMapping } from "../../server/modules/datasource/contracts.js";
import type { FinanceMetricPrompt } from "../../server/modules/text2sql/contracts.js";
import type { AgentTraceEvent } from "../../server/shared/types/trace.js";

export type { AgentTraceEvent, JoinPathDefinition, MappingAuditRecord, MappingRegistryVersion, MappingVersionDiff, SchemaSearchResult, SemanticEntityMapping };

export type DatasourceInsight = Pick<SchemaSearchResult,
  "erpType" | "semanticSchema" | "mappingConfidence" | "unresolvedFields" | "joinPaths" | "mappingValidation" | "mappingStatus" | "publishedVersion" | "draftVersion"
>;

export type DataSource = {
  id: string;
  connectionId: string;
  name: string;
  engine: string;
  host: string;
  database: string;
  tables: number;
  status: "connected" | "offline";
  sshEnabled: boolean;
  insight?: DatasourceInsight;
};

export type SchemaMappingResponse = SchemaSearchResult & {
  datasource: {
    connectionId: string;
    name: string;
    engine: string;
    host: string;
    port: number;
    database: string;
    sshEnabled: boolean;
    version: string;
    tables: number;
  };
  review: {
    publishedVersion?: MappingRegistryVersion;
    draftVersion?: MappingRegistryVersion;
    capabilities: string[];
  };
};

export type MappingDraftPayload = {
  erpType: string;
  entities: SemanticEntityMapping[];
  joinPaths: JoinPathDefinition[];
  changeSummary?: string;
};

export type MappingVersionsResponse = { items: MappingRegistryVersion[]; audits: MappingAuditRecord[] };
export type MappingVersionResponse = { version: MappingRegistryVersion; diff: MappingVersionDiff };

export type QueryExplanation = {
  metrics: FinanceMetricPrompt[];
  semanticEntities: string[];
  mappingsUsed: SemanticEntityMapping[];
  joinPathsUsed: JoinPathDefinition[];
  mappingValidation: MappingValidationSummary;
  registryVersion?: number;
  mappingStatus?: "unpublished" | "draft" | "published";
  publishedVersion?: number;
};

export type QueryResult = {
  question: string;
  summary: string;
  sql: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number>[];
  chart?: { label: string; value: number }[];
  executionMs: number;
  rowCount: number;
  requiresConfirmation?: boolean;
  operation?: string;
  explanation?: QueryExplanation;
  agent?: { runId: string; attempts: number; trace: AgentTraceEvent[] };
  model?: string;
  sessionId?: string;
  session?: AnalysisSession;
  persistedMessages?: AnalysisMessage[];
};

export type AnalysisSession = {
  id: string;
  title: string;
  pinned: boolean;
  datasourceId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type AnalysisMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  result?: QueryResult | { channel?: string; agentId?: string; runId?: string; durationMs?: number; status?: string; question?: string; [key: string]: unknown };
  createdAt: string;
};

export type AnalysisSessionDetail = { session: AnalysisSession; messages: AnalysisMessage[] };

export type DetailTab = "overview" | "mapping" | "joins" | "validation" | "versions" | "raw";
