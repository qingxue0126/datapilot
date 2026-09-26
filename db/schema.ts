import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  accountSetId: text("account_set_id").notNull(),
  userId: text("user_id").notNull(),
  title: text("title").notNull().default("新分析"),
  titleManuallyEdited: integer("title_manually_edited", { mode: "boolean" }).notNull().default(false),
  datasourceId: text("datasource_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("sessions_owner_updated_idx").on(table.tenantId, table.accountSetId, table.userId, table.updatedAt),
]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  resultJson: text("result_json"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("messages_session_created_idx").on(table.sessionId, table.createdAt),
]);
