"use strict";

const { parseIsoOffset } = require("./time");
const { getRuleVersion, getRuleVersionByCode, computeMetrics } = require("./metrics");
const { withTransaction } = require("./db");
const { nowIso } = require("./clock");

function periodForYear(year) {
  const start = parseIsoOffset(`${year}-01-01T00:00:00+08:00`);
  const end = parseIsoOffset(`${year + 1}-01-01T00:00:00+08:00`);
  return { start, end };
}

// 将单元格列表物化为 revision_indicators 行
function materialize(database, revisionId, cells) {
  const insert = database.prepare(
    `INSERT INTO revision_indicators
       (revision_id, dimension_key, metric, value, contributing_facilities)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const cell of cells) {
    const key = JSON.stringify(cell.dimension_key);
    for (const [metric, value] of Object.entries(cell.metrics)) {
      insert.run(revisionId, key, metric, value, JSON.stringify(cell.contributing_facilities));
    }
  }
}

// 将计算结果（每单元格含四个指标的嵌套结构）扁平化为指标行
function flattenCells(cells) {
  return cells.flatMap((cell) =>
    Object.entries(cell.metrics).map(([metric, value]) => ({
      dimension_key: cell.dimension_key,
      metric,
      value,
      contributing_facilities: cell.contributing_facilities,
    }))
  );
}

// 按规则允许的维度发布：合计行 + 每个单维分组
function breakdownsForRule(rule) {
  return [[], ...rule.dimensions.map((dim) => [dim])];
}

function createPublication(database, client, params) {
  const year = Number(params.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw Object.assign(new Error("year 必须为 2000-2100 的整数"), { statusCode: 400 });
  }
  const rule = params.rule_version_code
    ? getRuleVersionByCode(database, params.rule_version_code)
    : getLatestRule(database);
  const code = params.publication_code || `COVERAGE-${year}`;
  if (database.prepare("SELECT 1 FROM publications WHERE publication_code = ?").get(code)) {
    throw Object.assign(new Error(`发布编号 ${code} 已存在，冻结发布不可覆盖`), { statusCode: 409 });
  }
  const { start, end } = periodForYear(year);
  const watermark = params.watermark || nowIso();
  if (parseIsoOffset(watermark) === null) {
    throw Object.assign(new Error("watermark 必须为带偏移量的 ISO 8601 时间"), { statusCode: 400 });
  }

  const result = withTransaction(database, () => {
    const pubResult = database
      .prepare(
        `INSERT INTO publications
           (publication_code, year, period_start, period_end, rule_version_id,
            status, watermark, created_by, notes)
         VALUES (?, ?, ?, ?, ?, 'frozen', ?, ?, ?)`
      )
      .run(
        code,
        year,
        new Date(start * 1000).toISOString(),
        new Date(end * 1000).toISOString(),
        rule.id,
        watermark,
        client.client_id,
        params.notes || ""
      );
    const publicationId = Number(pubResult.lastInsertRowid);
    const revResult = database
      .prepare(
        `INSERT INTO publication_revisions
           (publication_id, revision_no, parent_revision_id, rule_version_id,
            watermark, status, difference_summary, created_by)
         VALUES (?, 0, NULL, ?, ?, 'current', '[]', ?)`
      )
      .run(publicationId, rule.id, watermark, client.client_id);
    const revisionId = Number(revResult.lastInsertRowid);
    for (const groupBy of breakdownsForRule(rule)) {
      const cells = computeMetrics(database, {
        periodStartEpoch: start,
        periodEndEpoch: end,
        watermark,
        rule,
        groupBy,
        scope: {},
      });
      materialize(database, revisionId, cells);
    }
    return { publicationId, revisionId };
  });

  return {
    status: "frozen",
    publication_code: code,
    revision_no: 0,
    rule_version_code: rule.version_code,
    watermark,
    ...result,
  };
}

function getLatestRule(database) {
  const row = database.prepare("SELECT id FROM rule_versions ORDER BY id DESC LIMIT 1").get();
  if (!row) throw Object.assign(new Error("尚无规则版本，请管理员先登记"), { statusCode: 400 });
  return getRuleVersion(database, row.id);
}

function loadIndicators(database, revisionId) {
  return database
    .prepare("SELECT dimension_key, metric, value, contributing_facilities FROM revision_indicators WHERE revision_id = ?")
    .all(revisionId)
    .map((row) => ({
      dimension_key: JSON.parse(row.dimension_key),
      metric: row.metric,
      value: row.value,
      contributing_facilities: JSON.parse(row.contributing_facilities),
    }));
}

function diffIndicators(previous, current) {
  const index = new Map();
  for (const row of previous) index.set(`${JSON.stringify(row.dimension_key)}|${row.metric}`, row);
  const changed = [];
  const currentKeys = new Set();
  for (const row of current) {
    const key = `${JSON.stringify(row.dimension_key)}|${row.metric}`;
    currentKeys.add(key);
    const old = index.get(key);
    if (!old) {
      changed.push({ dimension_key: row.dimension_key, metric: row.metric, from: null, to: row.value, delta: row.value });
    } else if (old.value !== row.value) {
      changed.push({ dimension_key: row.dimension_key, metric: row.metric, from: old.value, to: row.value, delta: row.value - old.value });
    }
  }
  for (const row of previous) {
    const key = `${JSON.stringify(row.dimension_key)}|${row.metric}`;
    if (!currentKeys.has(key)) {
      changed.push({ dimension_key: row.dimension_key, metric: row.metric, from: row.value, to: null, delta: -row.value });
    }
  }
  changed.sort((a, b) => JSON.stringify(a.dimension_key).localeCompare(JSON.stringify(b.dimension_key)));
  return changed;
}

// 冻结后补报：不触碰原版，生成带差异说明的修订版
function createRevision(database, client, params) {
  const pub = database
    .prepare("SELECT * FROM publications WHERE publication_code = ?")
    .get(params.publication_code);
  if (!pub) throw Object.assign(new Error("发布不存在"), { statusCode: 404 });

  const parent = database
    .prepare("SELECT * FROM publication_revisions WHERE publication_id = ? AND status = 'current'")
    .get(pub.id);
  if (!parent) throw Object.assign(new Error("找不到当前修订版"), { statusCode: 400 });

  const rule = params.rule_version_code
    ? getRuleVersionByCode(database, params.rule_version_code)
    : getRuleVersion(database, parent.rule_version_id);
  const watermark = params.watermark || nowIso();
  if (watermark <= parent.watermark) {
    throw Object.assign(new Error("修订版水位必须晚于原水位，补报只能前进不能回擦"), {
      statusCode: 400,
    });
  }

  const start = parseIsoOffset(pub.period_start);
  const end = parseIsoOffset(pub.period_end);

  return withTransaction(database, () => {
    // 先在新水位下计算全部单元格（不写库），与父版冻结值逐项对比
    const newCellsByBreakdown = breakdownsForRule(rule).map((groupBy) =>
      computeMetrics(database, {
        periodStartEpoch: start,
        periodEndEpoch: end,
        watermark,
        rule,
        groupBy,
        scope: {},
      })
    );
    const allNewRows = flattenCells(newCellsByBreakdown.flat());
    const changed = diffIndicators(loadIndicators(database, parent.id), allNewRows);
    const factsAdded = database
      .prepare(
        `SELECT COUNT(*) AS n FROM service_events
         WHERE received_at > ? AND received_at <= ?
           AND occurred_at_epoch >= ? AND occurred_at_epoch < ?`
      )
      .get(parent.watermark, watermark, start, end).n;
    const summary = {
      parent_revision_no: parent.revision_no,
      parent_watermark: parent.watermark,
      new_watermark: watermark,
      rule_version_code: rule.version_code,
      facts_added_in_period: factsAdded,
      changed_cells: changed,
    };

    database
      .prepare("UPDATE publication_revisions SET status = 'superseded' WHERE id = ?")
      .run(parent.id);
    const revResult = database
      .prepare(
        `INSERT INTO publication_revisions
           (publication_id, revision_no, parent_revision_id, rule_version_id,
            watermark, status, difference_summary, created_by)
         VALUES (?, ?, ?, ?, ?, 'current', ?, ?)`
      )
      .run(
        pub.id,
        parent.revision_no + 1,
        parent.id,
        rule.id,
        watermark,
        JSON.stringify(summary),
        client.client_id
      );
    const revisionId = Number(revResult.lastInsertRowid);
    for (const cells of newCellsByBreakdown) materialize(database, revisionId, cells);

    return {
      status: "revised",
      publication_code: pub.publication_code,
      revision_no: parent.revision_no + 1,
      rule_version_code: rule.version_code,
      watermark,
      difference: summary,
    };
  });
}

function getPublication(database, code) {
  const pub = database
    .prepare(
      `SELECT p.*, rv.version_code AS rule_version_code
       FROM publications p JOIN rule_versions rv ON rv.id = p.rule_version_id
       WHERE p.publication_code = ?`
    )
    .get(code);
  if (!pub) throw Object.assign(new Error("发布不存在"), { statusCode: 404 });
  const revisions = database
    .prepare(
      `SELECT pr.id, pr.revision_no, pr.rule_version_id, rv.version_code AS rule_version_code,
              pr.watermark, pr.status, pr.difference_summary, pr.created_at
       FROM publication_revisions pr JOIN rule_versions rv ON rv.id = pr.rule_version_id
       WHERE pr.publication_id = ? ORDER BY pr.revision_no`
    )
    .all(pub.id);
  return {
    publication_code: pub.publication_code,
    year: pub.year,
    period: { start: pub.period_start, end: pub.period_end },
    status: pub.status,
    original: {
      rule_version_code: pub.rule_version_code,
      watermark: pub.watermark,
      frozen_at: pub.created_at,
    },
    revisions: revisions.map((row) => ({
      revision_no: row.revision_no,
      rule_version_code: row.rule_version_code,
      watermark: row.watermark,
      status: row.status,
      created_at: row.created_at,
      difference_summary:
        row.revision_no === 0 ? null : safeParse(row.difference_summary),
    })),
  };
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getRevisionIndicators(database, code, revisionNo = null) {
  const pub = database
    .prepare("SELECT * FROM publications WHERE publication_code = ?")
    .get(code);
  if (!pub) throw Object.assign(new Error("发布不存在"), { statusCode: 404 });
  const rev = revisionNo === null
    ? database.prepare("SELECT * FROM publication_revisions WHERE publication_id = ? ORDER BY revision_no DESC LIMIT 1").get(pub.id)
    : database.prepare("SELECT * FROM publication_revisions WHERE publication_id = ? AND revision_no = ?").get(pub.id, revisionNo);
  if (!rev) throw Object.assign(new Error("修订版不存在"), { statusCode: 404 });
  const rule = getRuleVersion(database, rev.rule_version_id);
  return {
    publication_code: pub.publication_code,
    year: pub.year,
    revision_no: rev.revision_no,
    rule_version_code: rule.version_code,
    watermark: rev.watermark,
    cells: loadIndicators(database, rev.id),
  };
}

module.exports = {
  createPublication,
  createRevision,
  getPublication,
  getRevisionIndicators,
  getLatestRule,
  periodForYear,
};
