"use strict";

const { keyHash, randomApiKey } = require("./crypto_util");
const { withTransaction } = require("./db");

const ROLES = new Set(["facility", "district", "city", "research", "admin"]);

// 登记规则版本。口径参数一经发布不可就地修改：需要新口径时登记新版本
function createRuleVersion(database, body) {
  const code = body.version_code;
  if (typeof code !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(code)) {
    throw Object.assign(new Error("version_code 非法"), { statusCode: 400 });
  }
  const intField = (name, fallback, min, max) => {
    const value = body[name] === undefined ? fallback : body[name];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw Object.assign(new Error(`${name} 必须为 ${min}-${max} 的整数`), { statusCode: 400 });
    }
    return value;
  };
  const firstVisitGapDays = intField("first_visit_gap_days", 90, 1, 3650);
  const continuityWindowDays = intField("continuity_window_days", 365, 1, 3650);
  const minCellSize = intField("min_cell_size", 5, 1, 100);

  const dimensions = body.dimensions || ["age_group", "service_kind", "district_code"];
  const allowed = new Set(["age_group", "service_kind", "district_code"]);
  if (!Array.isArray(dimensions) || dimensions.some((d) => !allowed.has(d))) {
    throw Object.assign(new Error("dimensions 含非法维度"), { statusCode: 400 });
  }
  const excluded = body.excluded_quality_flags || ["invalid"];
  if (!Array.isArray(excluded) || excluded.some((f) => typeof f !== "string")) {
    throw Object.assign(new Error("excluded_quality_flags 必须为字符串数组"), { statusCode: 400 });
  }

  try {
    const result = database
      .prepare(
        `INSERT INTO rule_versions
           (version_code, first_visit_gap_days, continuity_window_days,
            excluded_quality_flags, dimensions, min_cell_size)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        code,
        firstVisitGapDays,
        continuityWindowDays,
        JSON.stringify(excluded),
        JSON.stringify(dimensions),
        minCellSize
      );
    return {
      id: Number(result.lastInsertRowid),
      version_code: code,
      first_visit_gap_days: firstVisitGapDays,
      continuity_window_days: continuityWindowDays,
      excluded_quality_flags: excluded,
      dimensions,
      min_cell_size: minCellSize,
    };
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) {
      throw Object.assign(new Error(`规则版本 ${code} 已存在，口径变更须登记新版本`), {
        statusCode: 409,
      });
    }
    throw error;
  }
}

// 登记客户端并签发 API 密钥；明文密钥仅此一次返回，库内只存摘要
function createClient(database, body) {
  const clientId = body.client_id;
  const role = body.role;
  if (typeof clientId !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(clientId)) {
    throw Object.assign(new Error("client_id 非法"), { statusCode: 400 });
  }
  if (!ROLES.has(role)) throw Object.assign(new Error("role 非法"), { statusCode: 400 });

  const districtCode = body.district_code ?? null;
  const facilityId = body.facility_id ?? null;
  if (role === "facility" && (!facilityId || !districtCode)) {
    throw Object.assign(new Error("机构凭据必须提供 facility_id 与 district_code"), {
      statusCode: 400,
    });
  }
  if (role === "district" && !districtCode) {
    throw Object.assign(new Error("区级凭据必须提供 district_code"), { statusCode: 400 });
  }

  const apiKey = randomApiKey();
  withTransaction(database, () => {
    database
      .prepare("INSERT INTO api_clients (client_id, role, district_code, facility_id) VALUES (?, ?, ?, ?)")
      .run(clientId, role, districtCode, facilityId);
    database.prepare("INSERT INTO api_keys (key_hash, client_id) VALUES (?, ?)").run(keyHash(apiKey), clientId);
  });

  return { client_id: clientId, role, district_code: districtCode, facility_id: facilityId, api_key: apiKey };
}

module.exports = { createRuleVersion, createClient };
