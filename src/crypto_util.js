"use strict";

const crypto = require("node:crypto");

// 平台侧再做一次带胡椒的 HMAC：即使机构提交的引用发生泄露，库内摘要也无法跨平台比对
function residentDigest(token, pepper = process.env.RESIDENT_PEPPER || "development-pepper") {
  return crypto.createHmac("sha256", pepper).update(String(token)).digest("hex");
}

function keyHash(apiKey) {
  return crypto.createHash("sha256").update(String(apiKey)).digest("hex");
}

function randomApiKey() {
  return `sk_${crypto.randomBytes(24).toString("hex")}`;
}

module.exports = { residentDigest, keyHash, randomApiKey };
