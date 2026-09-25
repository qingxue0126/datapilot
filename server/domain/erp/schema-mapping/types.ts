import type { SchemaTable } from "../../../database.js";

export const ERP_ENTITY_NAMES = [
  "Voucher", "VoucherEntry", "Account", "Customer", "Supplier",
  "Receivable", "Payable", "Organization", "Department",
] as const;

export type ErpEntityName = typeof ERP_ENTITY_NAMES[number];
export type MappingSource = "auto" | "manual";

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
};

export type ManualEntityMapping = {
  table: string;
  fields?: Record<string, string>;
};

export type ErpSchemaMappingConfig = {
  erpType: "generic" | "yongyou" | "kingdee" | "qiqi";
  database?: string;
  mappings: Partial<Record<ErpEntityName, ManualEntityMapping>>;
};

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
