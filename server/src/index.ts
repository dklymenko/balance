import "dotenv/config";
import { db, sqlite } from "./db/index.js";
import { createApp } from "./app.js";
import { startBackupSchedule } from "./lib/backup.js";
import { runMigrations } from "./db/migrate.js";

// The database is migration-managed: bundled migrations run on every boot
// (no-op when up to date). A legacy pre-cents database is refused with
// pointers to the archive migration path -- see runMigrations.
runMigrations(db);

const PORT = Number(process.env.PORT ?? 3001);
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const app = createApp(db);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running on http://127.0.0.1:${PORT}`);
  startBackupSchedule(sqlite);
});
