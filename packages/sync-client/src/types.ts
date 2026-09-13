import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema.js";

// The desktop app and test harness use synchronous Drizzle databases backed by
// better-sqlite3-compatible drivers. The sync client targets their shared base
// type so storage details do not leak into replication logic.
type Schema = typeof schema;

export type DB = BaseSQLiteDatabase<"sync", unknown, Schema>;

export type Tx = SQLiteTransaction<"sync", unknown, Schema, ExtractTablesWithRelations<Schema>>;

export type DbExecutor = Pick<DB, "select" | "update" | "insert" | "delete" | "run" | "all" | "get">;
