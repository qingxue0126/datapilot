export type DatabaseConfig = {
  name: string;
  engine: "mysql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssh?: {
    enabled: boolean;
    host: string;
    port: number;
    user: string;
    privateKey: string;
    passphrase?: string;
  };
};

export type SchemaTable = {
  name: string;
  rows: number;
  columns: { name: string; type: string; nullable: boolean; key: string; comment: string }[];
};

