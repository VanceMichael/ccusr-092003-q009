
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

function applyMigrations(database, directory = MIGRATIONS_DIR) {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)
  );
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^\d+[\w-]*\.sql$/.test(name))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(directory, file), "utf8");
    withTransaction(database, () => {
      database.exec(sql);
      database.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(file);
    });
  }
}

function openDatabase(databasePath = process.env.DATABASE_PATH) {
  const resolved = databasePath || path.join(process.cwd(), "data", "app.sqlite3");
  fs.mkdirSync(path.dirname(path.resolve(resolved)), { recursive: true });
  const database = new DatabaseSync(resolved);
  applyMigrations(database);
  return database;
}

// node:sqlite 没有 .transaction() 助手，用 BEGIN/COMMIT 手工包裹
function withTransaction(database, work) {
  database.exec("SAVEPOINT app_tx");
  try {
    const result = work();
    database.exec("RELEASE SAVEPOINT app_tx");
    return result;
  } catch (error) {
    database.exec("ROLLBACK TO SAVEPOINT app_tx");
    database.exec("RELEASE SAVEPOINT app_tx");
    throw error;
  }
}

module.exports = { openDatabase, applyMigrations, withTransaction, MIGRATIONS_DIR };
