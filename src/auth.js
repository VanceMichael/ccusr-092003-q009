"use strict";

const { keyHash } = require("./crypto_util");

// 从 Authorization: Bearer 头解析客户端身份；失败返回 null
function authenticate(database, request) {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  const row = database
    .prepare(
      `SELECT c.client_id, c.role, c.district_code, c.facility_id
       FROM api_keys k JOIN api_clients c ON c.client_id = k.client_id
       WHERE k.key_hash = ?`
    )
    .get(keyHash(token));
  return row ?? null;
}

function requireRole(client, roles) {
  if (!client || !roles.includes(client.role)) {
    throw Object.assign(new Error("权限不足"), { statusCode: 403 });
  }
}

module.exports = { authenticate, requireRole };
