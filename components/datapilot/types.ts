import type { AgentTraceEvent } from "../../server/core/types";
import type { FinanceMetricPrompt } from "../../server/domain/erp/metrics";
import type {
  JoinPathDefinition,
  MappingValidationSummary,
  SchemaSearchResult,
  SemanticEntityMapping,
  MappingRegistryVersion,
  MappingAuditRecord,
  MappingVersionDiff,
} from "../../server/domain/erp/schema-mapping/types";

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
};

export type DetailTab = "overview" | "mapping" | "joins" | "validation" | "versions" | "raw";
