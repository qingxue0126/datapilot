export type RowScope = {
  table: string;
  column: string;
  allowedValues: string[];
};

export type PermissionPolicy = {
  capabilities: string[];
  allowedTables: "*" | string[];
  deniedColumns: string[];
  rowScopes: RowScope[];
};
