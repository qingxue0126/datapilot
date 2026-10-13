/** Public domain API; do not import domain internals from other modules. */
export { loadConnections, saveConnections } from "./connection-store.js";
export type { StoredConnection } from "./connection-store.js";
export { createDatasourceAccess, installDatasourceRoutes } from "./datasource-routes.js";
export { assertSqlUsesValidatedJoinPaths } from "./schema-mapping/join-policy.js";
export { MappingRegistryStore } from "./schema-mapping/mapping-registry.js";
export { MappingReviewService } from "./schema-mapping/mapping-review-service.js";
export type { MappingDraftInput } from "./schema-mapping/mapping-review-service.js";
export type { JoinPathDefinition, SchemaSearchResult, SemanticEntityMapping } from "./schema-mapping/types.js";
export { SchemaSearchTool } from "./schema-search-tool.js";
