"use strict";

const {
  getRuleVersionByCode,
  computeMetrics,
  findSuppressedCells,
} = require("./metrics");
const { getLatestRule, periodForYear } = require("./publications");
const { nowIso } = require("./clock");

function resolveScope(client) {
  if (client.role === "facility") return { facilityId: client.facility_id };
  if (client.role === "district") return { districtCode: client.district_code };
  return {}; // city / research：全市聚合，不含个体
}

// 实时聚合查询（不冻结）。group_by 只能取规则版本允许的维度，且强制限定为单维或合计
function liveQuery(database, client, query) {
  const year = Number(query.get("year"));
  if (!Number.isInteger(year)) throw Object.assign(new Error("year 必填且为整数"), { statusCode: 400 });
  const rule = query.get("rule_version_code")
    ? getRuleVersionByCode(database, query.get("rule_version_code"))
    : getLatestRule(database);

  const groupByParam = query.get("group_by");
  const groupBy = groupByParam ? groupByParam.split(",").filter(Boolean) : [];
  for (const dim of groupBy) {
    if (!rule.dimensions.includes(dim)) {
      throw Object.assign(new Error(`维度 ${dim} 不在规则允许清单内`), { statusCode: 400 });
    }
  }

  const { start, end } = periodForYear(year);
  const watermark = nowIso();
  const cells = computeMetrics(database, {
    periodStartEpoch: start,
    periodEndEpoch: end,
    watermark,
    rule,
    groupBy,
    scope: resolveScope(client),
  });

  return {
    scope: describeScope(client),
    rule_version_code: rule.version_code,
    watermark,
    provisional: true, // 实时值未经年度冻结
    cells,
  };
}

function describeScope(client) {
  if (client.role === "facility") return { level: "facility", facility_id: client.facility_id };
  if (client.role === "district") return { level: "district", district_code: client.district_code };
  return { level: "city" };
}

// 研究导出：口径与实时查询相同，但任一分组去重人数不足最小分组规模时整体拒绝，
// 拒绝信息只给被抑制的维度键，不给人数
function researchExport(database, client, query) {
  const result = liveQuery(database, client, query);
  const rule = getRuleVersionByCode(database, result.rule_version_code);
  const suppressed = findSuppressedCells(result.cells, rule.min_cell_size);
  if (suppressed.length > 0) {
    throw Object.assign(
      new Error("导出被最小分组规模规则拒绝：存在人数低于阈值的分组，请提高聚合粒度后重试"),
      {
        statusCode: 422,
        payload: {
          error: "minimum_cell_size_violation",
          min_cell_size: rule.min_cell_size,
          suppressed_dimension_keys: suppressed,
        },
      }
    );
  }
  return { ...result, export_kind: "research", min_cell_size_applied: rule.min_cell_size };
}

module.exports = { liveQuery, researchExport, resolveScope };
