"use strict";

// 统一时钟。生产环境取系统时间；APP_CLOCK（带偏移量 ISO 8601）仅用于测试与回放，
// 以确定性地模拟“冻结后迟到/补报”。未设置或非法时回退真实时间。
const { parseIsoOffset } = require("./time");

function nowIso() {
  const override = process.env.APP_CLOCK;
  if (override && parseIsoOffset(override) !== null) {
    // 归一化为毫秒精度的 UTC 字符串，与 SQLite 存储格式一致
    return new Date(parseIsoOffset(override) * 1000).toISOString();
  }
  return new Date().toISOString();
}

module.exports = { nowIso };
