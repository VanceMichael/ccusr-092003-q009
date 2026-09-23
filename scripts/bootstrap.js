"use strict";

// 本地/部署引导：登记首个规则版本与管理员客户端，打印一次性 API 密钥。
// 用法：node scripts/bootstrap.js [规则版本号]
const { openDatabase } = require("../src/db");
const { createRuleVersion, createClient } = require("../src/admin");

const database = openDatabase(process.env.DATABASE_PATH);
const versionCode = process.argv[2] || `rules-${new Date().getFullYear()}`;

let rule;
const existingRule = database.prepare("SELECT id FROM rule_versions WHERE version_code = ?").get(versionCode);
if (existingRule) {
  rule = { version_code: versionCode, id: existingRule.id, reused: true };
} else {
  rule = createRuleVersion(database, { version_code: versionCode });
}

const existingAdmin = database.prepare("SELECT client_id FROM api_clients WHERE client_id = 'admin'").get();
if (existingAdmin) {
  console.log(`规则版本 ${versionCode} 已就绪；管理员客户端已存在，密钥无法再次显示（遗失请轮换）。`);
} else {
  const admin = createClient(database, { client_id: "admin", role: "admin" });
  console.log("引导完成，请立即保存管理员密钥（仅显示一次）：");
  console.log(JSON.stringify({ rule, admin }, null, 2));
}
database.close();
