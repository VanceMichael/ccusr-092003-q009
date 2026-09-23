
const { openDatabase, runMigrations } = require("../scripts/migrate");

// 服务与测试共用：打开数据文件并确保迁移到最新版本。
function openAppDatabase(databasePath) {
  const database = openDatabase(databasePath);
  runMigrations(database);
  return database;
}

module.exports = { openAppDatabase };
