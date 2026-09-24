import { readFileSync } from "node:fs";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { Client, type ConnectConfig } from "ssh2";

export type SchemaTable = {
  name: string;
  rows: number;
  columns: { name: string; type: string; nullable: boolean; key: string; comment: string }[];
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function mysqlConfig() {
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: required("MYSQL_USER"),
    password: required("MYSQL_PASSWORD"),
    database: required("MYSQL_DATABASE"),
  };
}

async function connect(): Promise<{ connection: Connection; tunnel?: Client }> {
  const config = mysqlConfig();
  if (process.env.SSH_ENABLED?.toLowerCase() !== "true") {
    return { connection: await mysql.createConnection({ ...config, connectTimeout: 12_000, charset: "utf8mb4" }) };
  }

  const tunnel = new Client();
  const sshConfig: ConnectConfig = {
    host: required("SSH_HOST"),
    port: Number(process.env.SSH_PORT || 22),
    username: required("SSH_USER"),
    privateKey: readFileSync(required("SSH_PRIVATE_KEY_PATH")),
    readyTimeout: 15_000,
    keepaliveInterval: 10_000,
  };
  if (process.env.SSH_PRIVATE_KEY_PASSPHRASE) sshConfig.passphrase = process.env.SSH_PRIVATE_KEY_PASSPHRASE;

  await new Promise<void>((resolve, reject) => {
    tunnel.once("ready", resolve).once("error", reject).connect(sshConfig);
  });
  try {
    const stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      tunnel.forwardOut("127.0.0.1", 0, config.host, config.port, (error, channel) => error ? reject(error) : resolve(channel));
    });
    const connection = await mysql.createConnection({ user: config.user, password: config.password, database: config.database, stream, connectTimeout: 12_000, charset: "utf8mb4" });
    return { connection, tunnel };
  } catch (error) {
    tunnel.end();
    throw error;
  }
}

export async function withDatabase<T>(operation: (connection: Connection) => Promise<T>): Promise<T> {
  const { connection, tunnel } = await connect();
  try {
    await connection.query("SET SESSION TRANSACTION READ ONLY");
    return await operation(connection);
  } finally {
    await connection.end().catch(() => undefined);
    tunnel?.end();
  }
}

export async function testDatabase() {
  const started = Date.now();
  return withDatabase(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT DATABASE() AS db, VERSION() AS version, CURRENT_USER() AS user");
    const [tables] = await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()");
    return { database: rows[0].db, version: rows[0].version, user: rows[0].user, tables: Number(tables[0].count), latencyMs: Date.now() - started };
  });
}

export async function getSchema(): Promise<SchemaTable[]> {
  return withDatabase(async (connection) => {
    const [columns] = await connection.query<RowDataPacket[]>(`
      SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_KEY, c.COLUMN_COMMENT,
             COALESCE(t.TABLE_ROWS, 0) AS TABLE_ROWS
      FROM information_schema.COLUMNS c
      JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
    `);
    const grouped = new Map<string, SchemaTable>();
    for (const row of columns) {
      if (!grouped.has(row.TABLE_NAME)) grouped.set(row.TABLE_NAME, { name: row.TABLE_NAME, rows: Number(row.TABLE_ROWS), columns: [] });
      grouped.get(row.TABLE_NAME)!.columns.push({ name: row.COLUMN_NAME, type: row.COLUMN_TYPE, nullable: row.IS_NULLABLE === "YES", key: row.COLUMN_KEY || "", comment: row.COLUMN_COMMENT || "" });
    }
    return [...grouped.values()];
  });
}

export function validateReadOnlySql(input: string) {
  const sql = input.trim().replace(/;\s*$/, "");
  if (!sql) throw new Error("SQL 不能为空");
  if (sql.includes(";")) throw new Error("每次只能执行一条 SQL");
  if (!/^(select|with|show|describe|desc|explain)\b/i.test(sql)) throw new Error("仅允许只读查询（SELECT / SHOW / DESCRIBE / EXPLAIN）");
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|replace|call|execute|load_file|outfile|dumpfile|sleep|benchmark)\b/i.test(sql)) throw new Error("SQL 包含不允许的操作");
  const maxRows = Math.min(1000, Math.max(1, Number(process.env.QUERY_MAX_ROWS || 200)));
  if (/^(select|with)\b/i.test(sql) && !/\blimit\s+\d+/i.test(sql)) return `${sql}\nLIMIT ${maxRows}`;
  return sql;
}

export async function executeReadOnly(input: string) {
  const sql = validateReadOnlySql(input);
  const started = Date.now();
  return withDatabase(async (connection) => {
    const [rows, fields] = await connection.query(sql);
    const data = Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
    return { sql, rows: data.map(normalizeRow), columns: fields?.map((field) => ({ key: field.name, label: field.name })) ?? [], rowCount: data.length, executionMs: Date.now() - started };
  });
}

function normalizeRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value instanceof Date) return [key, value.toISOString()];
    if (typeof value === "bigint") return [key, Number(value)];
    if (Buffer.isBuffer(value)) return [key, value.toString("utf8")];
    return [key, value ?? ""];
  }));
}
