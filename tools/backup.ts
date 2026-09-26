import { DatabaseSync, backup } from "node:sqlite";
import { access } from "node:fs/promises";
const [source, target] = process.argv.slice(2);
if (!source || !target)
  throw new Error("Usage: npm run backup -- SOURCE.sqlite NEW_BACKUP.sqlite");
try {
  await access(target);
  throw new Error("Backup destination already exists");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const database = new DatabaseSync(source, { readOnly: true });
try {
  await backup(database, target);
  process.stdout.write(
    "Consistent SQLite backup created. Restore with RECOVERY_MODE=1 and independent current evidence.\n",
  );
} finally {
  database.close();
}
