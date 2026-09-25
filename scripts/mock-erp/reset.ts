import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { generateData } from "./generate-data.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const database = "datapilot_mock";
if (database !== "datapilot_mock") throw new Error("Safety check failed: reset may only target datapilot_mock");

const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "123456",
  multipleStatements: true,
  charset: "utf8mb4",
});

try {
  await connection.query("DROP DATABASE IF EXISTS `datapilot_mock`");
  await connection.query(await readFile(resolve(scriptDirectory, "schema.sql"), "utf8"));
  await connection.query(await readFile(resolve(scriptDirectory, "seed.sql"), "utf8"));
  await connection.query("USE `datapilot_mock`");
  await connection.beginTransaction();
  try { await generateData(connection); await connection.commit(); }
  catch (error) { await connection.rollback(); throw error; }
  const [rows] = await connection.query(`SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`, [database]);
  console.log(JSON.stringify({ ok: true, database, tables: rows }, null, 2));
} finally {
  await connection.end();
}
