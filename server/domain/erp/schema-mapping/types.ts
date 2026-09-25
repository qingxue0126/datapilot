import type { SchemaTable } from "../../../database.js";

export const ERP_ENTITY_NAMES = [
  "Voucher", "VoucherEntry", "Account", "Customer", "Supplier",
  "Receivable", "Payable", "Organization", "Department",
] as const;

export type ErpEntityName = typeof ERP_ENTITY_NAMES[number];
export type MappingSource = "auto" | "manual";
export type JoinPathSource = "manual" | "database_fk" | "profile" | "inferred";
export type MappingVersionStatus = "draft" | "published" | "archived";
export type MappingLifecycleStatus = "unpublished" | "draft" | "published";

export type SemanticFieldMapping = {
  column: string;
  confidence: number;
  source: MappingSource;
  reason: string;
};

export type SemanticEntityMapping = {
  entity: ErpEntityName;
  table: string;
  confidence: number;
  fields: Record<string, string>;
  fieldMappings: Record<string, SemanticFieldMapping>;
  mappingSource: MappingSource;
  matchReasons: string[];
  unresolvedFields: string[];
};

export type SchemaSearchResult = {
  rawSchema: SchemaTable[];
  semanticSchema: SemanticEntityMapping[];
  mappingConfidence: number;
  mappingSource: MappingSource | "mixed";
  unresolvedFields: string[];
  erpType: string;
  joinPaths: JoinPathDefinition[];
  joinCandidates?: JoinPathDefinition[];
  mappingValidation: MappingValidationSummary;
  mappingSamples: MappingSample[];
  registryVersion?: number;
  mappingStatus?: MappingLifecycleStatus;
  publishedVersion?: number;
  draftVersion?: number;
};

export type ManualEntityMapping = {
  table: string;
  fields?: Record<string, string>;
};

export type ErpSchemaMappingConfig = {
  erpType: "generic" | "yongyou" | "kingdee" | "qiqi";
  database?: string;
  mappings: Partial<Record<ErpEntityName, ManualEntityMapping>>;
  joins?: ManualJoinDefinition[];
};

export type JoinFieldPair = {
  leftField: string;
  rightField: string;
};

export type JoinPathValidation = {
  checked: boolean;
  matchRate?: number;
  leftUniqueRate?: number;
  rightUniqueRate?: number;
  errors?: string[];
};

export type JoinPathDefinition = {
  id: string;
  leftEntity: ErpEntityName;
  rightEntity: ErpEntityName;
  leftTable: string;
  rightTable: string;
  fields: JoinFieldPair[];
  joinType: "inner" | "left";
  confidence: number;
  source: JoinPathSource;
  requiredContextFields?: string[];
  validated: boolean;
  validation?: JoinPathValidation;
};

export type ManualJoinDefinition = {
  id?: string;
  leftEntity: ErpEntityName;
  rightEntity: ErpEntityName;
  fields: JoinFieldPair[];
  joinType?: "inner" | "left";
  requiredContextFields?: string[];
};

export type MappingValidationSummary = {
  valid: boolean;
  errors: string[];
};

export type MappingSample = {
  entity: ErpEntityName;
  field: string;
  table: string;
  column: string;
  values: string[];
};

export type ErpMappingRegistry = {
  tenantId: string;
  accountSetId: string;
  datasourceId: string;
  database: string;
  erpType: string;
  entities: SemanticEntityMapping[];
  joinPaths: JoinPathDefinition[];
  joinCandidates?: JoinPathDefinition[];
  schemaFingerprint: string;
  version: number;
  updatedAt: string;
};

export type MappingRegistryVersion = {
  id: string;
  tenantId: string;
  accountSetId: string;
  datasourceId: string;
  database: string;
  erpType: string;
  version: number;
  status: MappingVersionStatus;
  entities: SemanticEntityMapping[];
  joinPaths: JoinPathDefinition[];
  joinCandidates?: JoinPathDefinition[];
  schemaFingerprint: string;
  validation: MappingValidationSummary;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  createdBy?: string;
  publishedBy?: string;
  changeSummary?: string;
  rollbackFromVersion?: number;
};

export type MappingAuditAction = "draft_saved" | "published" | "rolled_back";
export type MappingAuditRecord = {
  id: string;
  tenantId: string;
  accountSetId: string;
  datasourceId: string;
  database: string;
  erpType: string;
  version: number;
  action: MappingAuditAction;
  timestamp: string;
  userId: string;
  changeSummary?: string;
};

export type MappingVersionDiff = {
  addedMappings: string[];
  changedMappings: { field: string; before: string; after: string }[];
  removedMappings: string[];
  addedJoins: string[];
  removedJoins: string[];
};

export type EntityMappingResult = Pick<SchemaSearchResult,
  "semanticSchema" | "mappingConfidence" | "mappingSource" | "unresolvedFields" | "erpType"
>;

export type StandardFieldDefinition = {
  name: string;
  description: string;
  aliases: string[];
  commentAliases: string[];
  required: boolean;
};

export type ErpEntityDefinition = {
  entity: ErpEntityName;
  description: string;
  tableAliases: string[];
  signatureFields?: string[];
  fields: StandardFieldDefinition[];
};
