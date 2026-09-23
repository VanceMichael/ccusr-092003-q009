"use strict";

const DAY = 86400;

// 水位感知的有效记录：在指定水位下，每条事实链只取接收时间最新的事实；
// 水位之后到达的更正不影响该水位的口径，保证冻结结果可复现。
function effectiveCte() {
  return `
    WITH ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(target_event_id, id)
          ORDER BY received_at DESC, id DESC
        ) AS rn
      FROM service_events
      WHERE received_at <= :watermark
        AND (:facility_id IS NULL OR facility_id = :facility_id)
        AND (:district_code IS NULL OR district_code = :district_code)
    )
    SELECT resident_ref_hash, district_code, facility_id, service_kind,
           age_group, occurred_at_epoch, quality_flag
    FROM ranked
    WHERE rn = 1 AND fact_action <> 'retraction'
  `;
}

function getRuleVersion(database, ruleVersionId) {
  const rule = database.prepare("SELECT * FROM rule_versions WHERE id = ?").get(ruleVersionId);
  if (!rule) throw Object.assign(new Error("规则版本不存在"), { statusCode: 400 });
  rule.excluded_quality_flags = JSON.parse(rule.excluded_quality_flags);
  rule.dimensions = JSON.parse(rule.dimensions);
  return rule;
}

function getRuleVersionByCode(database, code) {
  const row = database.prepare("SELECT id FROM rule_versions WHERE version_code = ?").get(code);
  if (!row) throw Object.assign(new Error(`规则版本 ${code} 不存在`), { statusCode: 404 });
  return getRuleVersion(database, row.id);
}

// 计算一个时间窗口、一组维度下的四类指标。
// options:
//   periodStartEpoch/periodEndEpoch 统计年（左闭右开）
//   watermark  ISO 字符串，只计该时刻之前到达的事实
//   rule       规则版本行
//   groupBy    分组维度子集（取自 rule.dimensions）
//   scope      {facilityId} | {districtCode} | {}
//
// 分组口径：人员级指标（去重人数、首次覆盖、连续管理）均在同一维度值内判定，
// 合计行（{}）为全市/全区口径，跨机构复诊按 resident_ref_hash 去重。
function computeMetrics(database, options) {
  const { periodStartEpoch, periodEndEpoch, watermark, rule, groupBy = [], scope = {} } = options;

  for (const dim of groupBy) {
    if (!rule.dimensions.includes(dim)) {
      throw Object.assign(new Error(`维度 ${dim} 不在规则版本 ${rule.version_code} 允许清单内`), {
        statusCode: 400,
      });
    }
  }

  const windowSec = rule.continuity_window_days * DAY;
  const gapLimit = rule.first_visit_gap_days * DAY;
  const excluded = new Set(rule.excluded_quality_flags);
  const params = {
    ":watermark": watermark,
    ":facility_id": scope.facilityId ?? null,
    ":district_code": scope.districtCode ?? null,
  };

  // 统一回溯窗口：连续管理需上年承接段，首次覆盖需首访间隔段，取两者较长者
  const lookback = periodStartEpoch - Math.max(windowSec, gapLimit);
  const rows = database
    .prepare(
      `${effectiveCte()}
       AND occurred_at_epoch >= :lookback AND occurred_at_epoch < :period_end`
    )
    .all({
      ...params,
      ":lookback": lookback,
      ":period_end": periodEndEpoch,
    });

  const cellKeyOf = (row) => {
    if (groupBy.length === 0) return "{}";
    const obj = {};
    for (const dim of groupBy) obj[dim] = row[dim];
    return JSON.stringify(obj);
  };
  const ensureCell = (cells, key) => {
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        dimension_key: JSON.parse(key),
        encounters: 0,
        facilities: new Set(),
        persons: new Set(),
        timeline: new Map(), // hash -> 合格记录时间（含回溯段）
      };
      cells.set(key, cell);
    }
    return cell;
  };

  const cells = new Map();
  for (const row of rows) {
    const key = cellKeyOf(row);
    const cell = ensureCell(cells, key);
    if (row.occurred_at_epoch >= periodStartEpoch) {
      cell.encounters += 1; // 人次：每条有效记录都计，含被排除质量标记
      cell.facilities.add(row.facility_id);
      if (!excluded.has(row.quality_flag)) cell.persons.add(row.resident_ref_hash);
    }
    if (excluded.has(row.quality_flag)) continue;
    if (!cell.timeline.has(row.resident_ref_hash)) cell.timeline.set(row.resident_ref_hash, []);
    cell.timeline.get(row.resident_ref_hash).push(row.occurred_at_epoch);
  }

  const output = [];
  for (const [key, cell] of [...cells.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (cell.encounters === 0) continue; // 只有回溯段记录、年内无服务的维度值不发布

    let firstCoverage = 0;
    let continuous = 0;
    for (const hash of cell.persons) {
      const epochs = (cell.timeline.get(hash) ?? []).sort((a, b) => a - b);
      // 年内首条合格记录
      const firstInPeriod = epochs.find((epoch) => epoch >= periodStartEpoch);
      // 其之前 gapLimit 天内无任何合格记录（含他机构）才算首次覆盖
      const recentPrior = epochs.some(
        (epoch) => epoch < firstInPeriod && firstInPeriod - epoch <= gapLimit
      );
      if (firstInPeriod !== undefined && !recentPrior) firstCoverage += 1;

      // 连续管理：年内至少 2 次合格服务，相邻间隔（含与上年末次间隔）均不超过窗口
      let inPeriodCount = 0;
      let maxGap = 0;
      for (let i = 0; i < epochs.length; i += 1) {
        if (epochs[i] >= periodStartEpoch) inPeriodCount += 1;
        if (i > 0 && epochs[i] >= periodStartEpoch) {
          const gap = epochs[i] - epochs[i - 1];
          if (gap > maxGap) maxGap = gap;
        }
      }
      if (inPeriodCount >= 2 && maxGap <= windowSec) continuous += 1;
    }

    output.push({
      dimension_key: cell.dimension_key,
      metrics: {
        encounters: cell.encounters,
        persons: cell.persons.size,
        first_coverage: firstCoverage,
        continuous_management: continuous,
      },
      contributing_facilities: [...cell.facilities].sort(),
    });
  }

  return output;
}

// 最小分组规模抑制：研究导出时任一分组的去重人数低于阈值即整体拒绝。
// 仅返回被抑制的维度键，不回传具体数值，避免借拒绝信息反查居民。
function findSuppressedCells(cells, minCellSize) {
  const suppressed = [];
  for (const cell of cells) {
    if (cell.metrics.persons > 0 && cell.metrics.persons < minCellSize) {
      suppressed.push(cell.dimension_key);
    }
  }
  return suppressed;
}

module.exports = {
  DAY,
  getRuleVersion,
  getRuleVersionByCode,
  computeMetrics,
  findSuppressedCells,
};
