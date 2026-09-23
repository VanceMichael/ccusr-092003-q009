
const crypto = require("node:crypto");

// 领域逻辑：所有函数接收一个已迁移的 DatabaseSync 实例，不直接接触 HTTP。

const DEFAULT_RULE_DEFINITIONS = {
  age_groups: ["child", "adult", "senior"],
  service_kinds: ["screening", "guidance", "intervention"],
  quality_marks: ["normal", "deficient"],
  late_threshold_days: 30,
  continuous_management: { min_events: 2, max_gap_days: 180 },
  export_min_cell_size: 10,
};

const TOKEN_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

class HttpError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseOccurredAt(value) {
  if (typeof value !== "string" || !ISO_OFFSET_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_occurred_at", { expected: "ISO 8601 with offset" });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "invalid_occurred_at", { expected: "ISO 8601 with offset" });
  }
  return { utc: date.toISOString(), wallYear: Number(value.slice(0, 4)) };
}

// ---------- 规则版本 ----------

function listRuleVersions(db) {
  return db.prepare(
    `SELECT version, status, definitions_json, note, created_at, activated_at
       FROM rule_versions ORDER BY created_at DESC`
  ).all().map((row) => ({
    version: row.version,
    status: row.status,
    definitions: JSON.parse(row.definitions_json),
    note: row.note,
    created_at: row.created_at,
    activated_at: row.activated_at,
  }));
}

function getActiveRule(db) {
  const row = db.prepare("SELECT * FROM rule_versions WHERE status = 'active' LIMIT 1").get();
  if (!row) throw new HttpError(409, "no_active_rule_version");
  return { version: row.version, definitions: JSON.parse(row.definitions_json) };
}

function validateDefinitions(definitions) {
  if (!definitions || typeof definitions !== "object") {
    throw new HttpError(400, "invalid_definitions");
  }
  for (const key of ["age_groups", "service_kinds", "quality_marks"]) {
    if (!Array.isArray(definitions[key]) || definitions[key].length === 0) {
      throw new HttpError(400, "invalid_definitions", { field: key, expected: "non-empty array" });
    }
  }
  const cm = definitions.continuous_management;
  if (!cm || !Number.isInteger(cm.min_events) || cm.min_events < 2 ||
      !Number.isFinite(cm.max_gap_days) || cm.max_gap_days <= 0) {
    throw new HttpError(400, "invalid_definitions", { field: "continuous_management" });
  }
  if (!Number.isInteger(definitions.export_min_cell_size) || definitions.export_min_cell_size < 1) {
    throw new HttpError(400, "invalid_definitions", { field: "export_min_cell_size" });
  }
  if (!Number.isInteger(definitions.late_threshold_days) || definitions.late_threshold_days < 0) {
    throw new HttpError(400, "invalid_definitions", { field: "late_threshold_days" });
  }
}

function createRuleVersion(db, { version, definitions, note }) {
  if (!version || typeof version !== "string") {
    throw new HttpError(400, "invalid_version");
  }
  validateDefinitions(definitions);
  try {
    db.prepare(
      `INSERT INTO rule_versions(version, definitions_json, note) VALUES (?, ?, ?)`
    ).run(version, JSON.stringify(definitions), note || "");
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw new HttpError(409, "rule_version_exists", { version });
    }
    throw error;
  }
  return { version, status: "deactivated" };
}

function activateRuleVersion(db, version) {
  const row = db.prepare("SELECT version FROM rule_versions WHERE version = ?").get(version);
  if (!row) throw new HttpError(404, "rule_version_not_found", { version });
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE rule_versions SET status = 'deactivated' WHERE status = 'active'").run();
    db.prepare(
      `UPDATE rule_versions SET status = 'active',
         activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE version = ?`
    ).run(version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ---------- 鉴权 ----------

function authenticate(db, apiKey) {
  if (!apiKey) throw new HttpError(401, "missing_api_key");
  const client = db.prepare("SELECT * FROM api_clients WHERE api_key = ?").get(apiKey);
  if (!client) throw new HttpError(401, "invalid_api_key");
  return client;
}

function requireRole(client, ...roles) {
  if (!roles.includes(client.role)) {
    throw new HttpError(403, "forbidden_role", { required: roles, actual: client.role });
  }
}

// 区级用户只能访问本区；市级不限制。
function assertDistrictScope(client, districtCode) {
  if (client.role === "district" && client.district_code !== districtCode) {
    throw new HttpError(403, "cross_district_denied", { requested_district: districtCode });
  }
  if (client.role === "ingest" && client.district_code !== districtCode) {
    throw new HttpError(403, "cross_district_denied", { requested_district: districtCode });
  }
}

// ---------- 上报（仅追加，幂等） ----------

function validateEventPayload(payload, definitions) {
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "invalid_payload");
  }
  const errors = [];
  const token = payload.resident_token;
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    errors.push({ field: "resident_token", issue: "must be sha256:<64 hex chars> irreducible token" });
  }
  const requireEnum = (field, allowed) => {
    if (!allowed.includes(payload[field])) {
      errors.push({ field, issue: `must be one of ${allowed.join(", ")}` });
    }
  };
  requireEnum("service_kind", definitions.service_kinds);
  requireEnum("age_group", definitions.age_groups);
  const qualityMark = payload.quality_mark === undefined ? "normal" : payload.quality_mark;
  if (!definitions.quality_marks.includes(qualityMark)) {
    errors.push({ field: "quality_mark", issue: `must be one of ${definitions.quality_marks.join(", ")}` });
  }
  if (!Number.isInteger(payload.source_sequence) || payload.source_sequence < 0) {
    errors.push({ field: "source_sequence", issue: "must be a non-negative integer" });
  }
  const { utc, wallYear } = (() => {
    try {
      return parseOccurredAt(payload.occurred_at);
    } catch (error) {
      errors.push({ field: "occurred_at", issue: "invalid ISO 8601 with offset" });
      return { utc: null, wallYear: null };
    }
  })();
  if (payload.corrects_event_id !== undefined &&
      (typeof payload.corrects_event_id !== "string" || payload.corrects_event_id.length === 0)) {
    errors.push({ field: "corrects_event_id", issue: "must be a non-empty string when provided" });
  }
  if (errors.length > 0) throw new HttpError(400, "validation_failed", { errors });
  return {
    resident_token: token,
    service_kind: payload.service_kind,
    age_group: payload.age_group,
    occurred_at: utc,
    occurred_year: wallYear,
    quality_mark: qualityMark,
    source_sequence: payload.source_sequence,
    corrects_event_id: payload.corrects_event_id || null,
    correction_reason: typeof payload.correction_reason === "string" ? payload.correction_reason : null,
  };
}

function ingestEvent(db, client, payload, options = {}) {
  requireRole(client, "ingest");
  const { version, definitions } = getActiveRule(db);
  const event = validateEventPayload(payload, definitions);
  const receivedAt = options.receivedAt || nowIso();

  // 幂等：机构内同一序列号只接受一次（迟到重传不产生新行）。
  const existing = db.prepare(
    "SELECT event_id FROM events WHERE org_code = ? AND source_sequence = ?"
  ).get(client.org_code, event.source_sequence);
  if (existing) {
    return { status: "duplicate", event_id: existing.event_id, rule_version: version };
  }

  if (event.corrects_event_id) {
    const target = db.prepare(
      "SELECT event_id, org_code FROM events WHERE event_id = ?"
    ).get(event.corrects_event_id);
    if (!target) {
      throw new HttpError(404, "correction_target_not_found", {
        corrects_event_id: event.corrects_event_id,
      });
    }
    if (target.org_code !== client.org_code) {
      // 机构只能更正本机构原始上报，不能借更正触碰他机构记录。
      throw new HttpError(403, "cannot_correct_other_org_event");
    }
  }

  const eventId = crypto.randomUUID();
  // 注意：只 INSERT；被更正行保留原状，通过 corrects_event_id 形成事实链。
  db.prepare(
    `INSERT INTO events(
       event_id, org_code, resident_token, district_code, service_kind, age_group,
       occurred_at, occurred_year, quality_mark, source_sequence,
       corrects_event_id, correction_reason, raw_json, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId, client.org_code, event.resident_token, client.district_code,
    event.service_kind, event.age_group, event.occurred_at, event.occurred_year,
    event.quality_mark, event.source_sequence,
    event.corrects_event_id, event.correction_reason,
    JSON.stringify({ ...payload, _ingest_rule_version: version }),
    receivedAt
  );

  const lagDays = (Date.now() - Date.parse(event.occurred_at)) / 86400000;
  return {
    status: "accepted",
    event_id: eventId,
    correction: event.corrects_event_id
      ? { corrects_event_id: event.corrects_event_id, reason: event.correction_reason }
      : null,
    late: lagDays > definitions.late_threshold_days,
    rule_version: version,
  };
}

function listEvents(db, client, { period, orgCode }) {
  let sql = `SELECT event_id, org_code, district_code, resident_token, service_kind,
                    age_group, occurred_at, occurred_year, quality_mark, source_sequence,
                    corrects_event_id, correction_reason, received_at
               FROM events WHERE 1=1`;
  const params = [];
  if (client.role === "ingest") {
    sql += " AND org_code = ?";
    params.push(client.org_code);
  } else if (client.role === "district") {
    sql += " AND district_code = ?";
    params.push(client.district_code);
  }
  if (orgCode) {
    if (client.role === "ingest" && orgCode !== client.org_code) {
      throw new HttpError(403, "cross_org_denied", { org_code: orgCode });
    }
    if (client.role === "district") {
      const org = db.prepare("SELECT district_code FROM organizations WHERE org_code = ?").get(orgCode);
      if (!org || org.district_code !== client.district_code) {
        throw new HttpError(403, "cross_district_denied", { org_code: orgCode });
      }
    }
    sql += " AND org_code = ?";
    params.push(orgCode);
  }
  if (period) {
    sql += " AND occurred_year = ?";
    params.push(Number(period));
  }
  sql += " ORDER BY occurred_at, received_at";
  return db.prepare(sql).all(...params).map(markSuperseded(db));
}

function markSuperseded(db) {
  const corrected = new Set(
    db.prepare("SELECT corrects_event_id FROM events WHERE corrects_event_id IS NOT NULL")
      .all().map((row) => row.corrects_event_id)
  );
  return (row) => ({ ...row, superseded: corrected.has(row.event_id) });
}

// ---------- 指标计算 ----------

// 取截至某水位的全部事件，并应用“更正后有效”视图：
// 被任一（截至水位已收到的）更正行指向的原始行不参与统计，但永不删除。
function loadActiveEvents(db, asOf, district) {
  const rows = db.prepare(
    `SELECT * FROM events
      WHERE received_at <= ?${district ? " AND district_code = ?" : ""}`
  ).all(...(district ? [asOf, district] : [asOf]));
  const superseded = new Set(
    rows.filter((r) => r.corrects_event_id).map((r) => r.corrects_event_id)
  );
  return rows.filter((r) => !superseded.has(r.event_id));
}

function latestWatermark(db) {
  const row = db.prepare("SELECT MAX(received_at) AS w FROM events").get();
  return row.w;
}

function computeMetrics(db, { period, district, ageGroup, serviceKind, qualityMark, asOf, definitions }) {
  const active = loadActiveEvents(db, asOf, district);
  const cm = definitions.continuous_management;

  const matchesDims = (row) =>
    (!ageGroup || row.age_group === ageGroup) &&
    (!serviceKind || row.service_kind === serviceKind) &&
    (!qualityMark || row.quality_mark === qualityMark);

  const cells = new Map();
  const keyOf = (row) => `${row.age_group}|${row.service_kind}|${row.quality_mark}`;
  const ensureCell = (key) => {
    if (!cells.has(key)) {
      const [age_group, service_kind, quality_mark] = key.split("|");
      cells.set(key, {
        age_group, service_kind, quality_mark,
        encounters: 0,
        _residents: new Set(),
      });
    }
    return cells.get(key);
  };

  // 连续管理分组（年龄×质量，跨服务类型）：一名居民在同一年度内
  // 至少 min_events 次服务，且相邻两次间隔不超过 max_gap_days。
  const continuity = new Map();
  const continuityKeyOf = (row) => `${row.age_group}|${row.quality_mark}`;
  const ensureContinuity = (key) => {
    if (!continuity.has(key)) {
      const [age_group, quality_mark] = key.split("|");
      continuity.set(key, { age_group, quality_mark, _chains: new Map() });
    }
    return continuity.get(key);
  };

  // 首次覆盖：居民在有效事件中的最早一次（全市/本区口径，全部年度）。
  const firstEvent = new Map();
  for (const row of active) {
    const prev = firstEvent.get(row.resident_token);
    if (!prev || row.occurred_at < prev.occurred_at ||
        (row.occurred_at === prev.occurred_at && row.received_at < prev.received_at)) {
      firstEvent.set(row.resident_token, row);
    }
  }
  const firstCoverage = new Map(); // key -> Set(resident)
  for (const [resident, row] of firstEvent) {
    if (row.occurred_year !== period || !matchesDims(row)) continue;
    const key = keyOf(row);
    if (!firstCoverage.has(key)) firstCoverage.set(key, new Set());
    firstCoverage.get(key).add(resident);
  }

  for (const row of active) {
    if (row.occurred_year !== period) continue;

    if (matchesDims(row)) {
      const cell = ensureCell(keyOf(row));
      cell.encounters += 1;
      cell._residents.add(row.resident_token);
    }

    // 连续性链不受单一服务类型过滤影响：连续管理本就跨筛查/指导/干预。
    if ((!ageGroup || row.age_group === ageGroup) &&
        (!qualityMark || row.quality_mark === qualityMark)) {
      const group = ensureContinuity(continuityKeyOf(row));
      if (!group._chains.has(row.resident_token)) group._chains.set(row.resident_token, []);
      group._chains.get(row.resident_token).push(Date.parse(row.occurred_at));
    }
  }

  const serviceCells = [];
  for (const [key, cell] of cells) {
    serviceCells.push({
      age_group: cell.age_group,
      service_kind: cell.service_kind,
      quality_mark: cell.quality_mark,
      metrics: {
        encounters: cell.encounters,
        unique_residents: cell._residents.size,
        first_coverage: firstCoverage.get(key)?.size || 0,
      },
    });
  }
  serviceCells.sort((a, b) =>
    (a.age_group + a.service_kind + a.quality_mark).localeCompare(
      b.age_group + b.service_kind + b.quality_mark));

  const continuityCells = [];
  for (const [key, group] of continuity) {
    let continuous = 0;
    for (const timestamps of group._chains.values()) {
      timestamps.sort((a, b) => a - b);
      if (timestamps.length < cm.min_events) continue;
      let chained = true;
      for (let i = 1; i < timestamps.length; i += 1) {
        const gapDays = (timestamps[i] - timestamps[i - 1]) / 86400000;
        if (gapDays > cm.max_gap_days) { chained = false; break; }
      }
      if (chained) continuous += 1;
    }
    continuityCells.push({
      age_group: group.age_group,
      quality_mark: group.quality_mark,
      continuous_management: continuous,
    });
  }
  continuityCells.sort((a, b) =>
    (a.age_group + a.quality_mark).localeCompare(b.age_group + b.quality_mark));

  return { serviceCells, continuityCells };
}

function liveMetrics(db, client, query) {
  requireRole(client, "city", "district");
  const period = Number(query.period);
  if (!Number.isInteger(period) || period < 2000) {
    throw new HttpError(400, "invalid_period", { expected: "4-digit year" });
  }
  const district = query.district || (client.role === "district" ? client.district_code : null);
  if (query.district) assertDistrictScope(client, query.district);
  const { version, definitions } = getActiveRule(db);
  const asOf = latestWatermark(db);
  if (!asOf) {
    return { period, scope: { type: district ? "district" : "city", code: district || "" },
      rule_version: version, as_of_received_at: null,
      service_cells: [], continuity_cells: [] };
  }
  const { serviceCells, continuityCells } = computeMetrics(db, {
    period, district,
    ageGroup: query.age_group || null,
    serviceKind: query.service_kind || null,
    qualityMark: query.quality_mark || null,
    asOf, definitions,
  });
  return {
    period,
    scope: { type: district ? "district" : "city", code: district || "" },
    rule_version: version,
    as_of_received_at: asOf,
    service_cells: serviceCells,
    continuity_cells: continuityCells,
  };
}

// ---------- 发布冻结与修订 ----------

function buildManifest(db, asOf) {
  const orgs = db.prepare(
    `SELECT o.org_code, o.name, o.district_code,
            COUNT(e.event_id) AS event_count,
            MAX(e.source_sequence) AS last_source_sequence,
            MAX(e.received_at) AS last_received_at
       FROM organizations o
       LEFT JOIN events e ON e.org_code = o.org_code AND e.received_at <= ?
      GROUP BY o.org_code
      ORDER BY o.org_code`
  ).all(asOf);
  return orgs.map((o) => ({
    org_code: o.org_code,
    name: o.name,
    district_code: o.district_code,
    event_count: o.event_count,
    last_source_sequence: o.last_source_sequence,
    last_received_at: o.last_received_at,
  }));
}

function districtsWithData(db, asOf) {
  return db.prepare(
    "SELECT DISTINCT district_code FROM events WHERE received_at <= ? ORDER BY district_code"
  ).all(asOf).map((r) => r.district_code);
}

function freezeMetrics(db, period, definitions, asOf) {
  const frozen = [];
  const pushScope = (scopeType, scopeCode, district) => {
    const { serviceCells, continuityCells } = computeMetrics(db, { period, district, asOf, definitions });
    for (const cell of serviceCells) {
      for (const metric of ["encounters", "unique_residents", "first_coverage"]) {
        frozen.push({
          scope_type: scopeType, scope_code: scopeCode,
          age_group: cell.age_group, service_kind: cell.service_kind,
          quality_mark: cell.quality_mark, metric, value: cell.metrics[metric],
        });
      }
    }
    // 连续管理跨服务类型，service_kind 以 "*" 占位。
    for (const cell of continuityCells) {
      frozen.push({
        scope_type: scopeType, scope_code: scopeCode,
        age_group: cell.age_group, service_kind: "*",
        quality_mark: cell.quality_mark, metric: "continuous_management",
        value: cell.continuous_management,
      });
    }
  };
  pushScope("city", "", null);
  for (const district of districtsWithData(db, asOf)) {
    pushScope("district", district, district);
  }
  return frozen;
}

function createPublication(db, client, { period, note }) {
  requireRole(client, "city");
  period = Number(period);
  if (!Number.isInteger(period) || period < 2000) {
    throw new HttpError(400, "invalid_period");
  }
  const asOf = latestWatermark(db);
  if (!asOf) throw new HttpError(409, "no_data_to_publish");

  const prior = db.prepare(
    "SELECT * FROM publications WHERE period = ? ORDER BY created_at DESC LIMIT 1"
  ).get(period);

  const { version, definitions } = getActiveRule(db);
  const publicationId = crypto.randomUUID();
  const edition = prior ? "revision" : "original";
  const manifest = buildManifest(db, asOf);
  const metrics = freezeMetrics(db, period, definitions, asOf);

  let revisionDiff = null;
  if (prior) {
    revisionDiff = buildRevisionDiff(db, prior, { asOf, manifest, metrics });
  }

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO publications(
         publication_id, period, edition, supersedes_publication_id,
         rule_version, definitions_json, as_of_received_at, manifest_json,
         revision_diff_json, created_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      publicationId, period, edition, prior ? prior.publication_id : null,
      version, JSON.stringify(definitions), asOf, JSON.stringify(manifest),
      revisionDiff ? JSON.stringify(revisionDiff) : null, client.api_key, note || ""
    );
    const insertMetric = db.prepare(
      `INSERT INTO publication_metrics(
         publication_id, scope_type, scope_code, age_group, service_kind,
         quality_mark, metric, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const m of metrics) {
      insertMetric.run(publicationId, m.scope_type, m.scope_code, m.age_group,
        m.service_kind, m.quality_mark, m.metric, m.value);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getPublication(db, client, publicationId);
}

function metricKey(m) {
  return [m.scope_type, m.scope_code, m.age_group, m.service_kind, m.quality_mark, m.metric].join("|");
}

function buildRevisionDiff(db, prior, current) {
  const previousMetrics = db.prepare(
    "SELECT * FROM publication_metrics WHERE publication_id = ?"
  ).all(prior.publication_id);
  const oldByKey = new Map(previousMetrics.map((m) => [metricKey(m), m.value]));
  const newByKey = new Map(current.metrics.map((m) => [metricKey(m), m.value]));

  const changed = [];
  const added = [];
  for (const [key, value] of newByKey) {
    const parts = key.split("|");
    const entry = {
      scope_type: parts[0], scope_code: parts[1], age_group: parts[2],
      service_kind: parts[3], quality_mark: parts[4], metric: parts[5],
    };
    if (!oldByKey.has(key)) {
      added.push({ ...entry, value });
    } else if (oldByKey.get(key) !== value) {
      changed.push({ ...entry, from: oldByKey.get(key), to: value });
    }
  }
  const removed = [];
  for (const [key, value] of oldByKey) {
    if (!newByKey.has(key)) {
      const parts = key.split("|");
      removed.push({
        scope_type: parts[0], scope_code: parts[1], age_group: parts[2],
        service_kind: parts[3], quality_mark: parts[4], metric: parts[5], value,
      });
    }
  }

  const oldManifest = new Map(JSON.parse(prior.manifest_json).map((o) => [o.org_code, o]));
  const orgWatermarks = current.manifest.map((o) => ({
    org_code: o.org_code,
    previous_last_source_sequence: oldManifest.get(o.org_code)?.last_source_sequence ?? null,
    current_last_source_sequence: o.last_source_sequence,
    new_events: o.event_count - (oldManifest.get(o.org_code)?.event_count || 0),
  }));

  // 补报与更正数量：水位之间进入的新事实（原行保持不动，这里只做差异说明）。
  const lateRows = db.prepare(
    `SELECT
       SUM(CASE WHEN received_at > ? THEN 1 ELSE 0 END) AS late_events,
       SUM(CASE WHEN received_at > ? AND corrects_event_id IS NOT NULL THEN 1 ELSE 0 END) AS corrections
     FROM events WHERE received_at <= ?`
  ).get(prior.as_of_received_at, prior.as_of_received_at, current.asOf);

  return {
    supersedes_publication_id: prior.publication_id,
    previous_edition_rule_version: prior.rule_version,
    previous_as_of_received_at: prior.as_of_received_at,
    current_as_of_received_at: current.asOf,
    metrics_changed: changed,
    metrics_added: added,
    metrics_removed: removed,
    late_events_since_freeze: lateRows.late_events || 0,
    corrections_since_freeze: lateRows.corrections || 0,
    org_watermarks: orgWatermarks,
  };
}

function listPublications(db, client, period) {
  requireRole(client, "city", "district");
  let sql = "SELECT * FROM publications";
  const params = [];
  if (period) {
    sql += " WHERE period = ?";
    params.push(Number(period));
  }
  sql += " ORDER BY period DESC, created_at DESC";
  return db.prepare(sql).all(...params).map(shapePublicationHeader);
}

function shapePublicationHeader(row) {
  return {
    publication_id: row.publication_id,
    period: row.period,
    edition: row.edition,
    supersedes_publication_id: row.supersedes_publication_id,
    rule_version: row.rule_version,
    as_of_received_at: row.as_of_received_at,
    created_at: row.created_at,
    created_by: row.created_by,
    note: row.note,
  };
}

function getPublication(db, client, publicationId) {
  requireRole(client, "city", "district");
  const row = db.prepare("SELECT * FROM publications WHERE publication_id = ?").get(publicationId);
  if (!row) throw new HttpError(404, "publication_not_found");
  let metrics = db.prepare(
    "SELECT * FROM publication_metrics WHERE publication_id = ? ORDER BY scope_type, scope_code, age_group, service_kind, quality_mark, metric"
  ).all(publicationId);
  if (client.role === "district") {
    // 区级可看全市汇总与本区数字，其他区的分组不予返回。
    metrics = metrics.filter((m) => m.scope_type === "city" || m.scope_code === client.district_code);
  }
  const grouped = new Map();
  for (const m of metrics) {
    const key = [m.scope_type, m.scope_code, m.age_group, m.service_kind, m.quality_mark].join("|");
    if (!grouped.has(key)) {
      grouped.set(key, {
        scope: { type: m.scope_type, code: m.scope_code },
        age_group: m.age_group, service_kind: m.service_kind, quality_mark: m.quality_mark,
        metrics: {},
      });
    }
    grouped.get(key).metrics[m.metric] = m.value;
  }
  let manifest = JSON.parse(row.manifest_json);
  let revisionDiff = row.revision_diff_json ? JSON.parse(row.revision_diff_json) : null;
  if (client.role === "district") {
    // 他区机构水位与他区分组差异同样不返回。
    manifest = manifest.filter((o) => o.district_code === client.district_code);
    if (revisionDiff) {
      const visibleChange = (d) => d.scope_type === "city" || d.scope_code === client.district_code;
      revisionDiff = {
        ...revisionDiff,
        metrics_changed: revisionDiff.metrics_changed.filter(visibleChange),
        metrics_added: revisionDiff.metrics_added.filter(visibleChange),
        metrics_removed: revisionDiff.metrics_removed.filter(visibleChange),
        org_watermarks: revisionDiff.org_watermarks.filter((o) => {
          const org = db.prepare("SELECT district_code FROM organizations WHERE org_code = ?")
            .get(o.org_code);
          return org && org.district_code === client.district_code;
        }),
      };
    }
  }
  return {
    ...shapePublicationHeader(row),
    definitions_frozen: JSON.parse(row.definitions_json),
    manifest,
    revision_diff: revisionDiff,
    cells: [...grouped.values()],
  };
}

// ---------- 研究导出（最小分组规模保护） ----------

function researchExport(db, client, body) {
  requireRole(client, "city", "district");
  const period = Number(body.period);
  if (!Number.isInteger(period) || period < 2000) throw new HttpError(400, "invalid_period");
  const requestedDims = Array.isArray(body.dimensions) ? body.dimensions : ["age_group"];
  const allowedDims = ["district_code", "age_group", "service_kind", "quality_mark"];
  const dims = [...new Set(requestedDims)];
  for (const dim of dims) {
    if (!allowedDims.includes(dim)) {
      throw new HttpError(400, "invalid_dimension", { allowed: allowedDims });
    }
  }

  const district = client.role === "city" ? (body.district || null) : client.district_code;
  if (body.district) assertDistrictScope(client, body.district);

  const { version, definitions } = getActiveRule(db);
  const asOf = latestWatermark(db);
  const groups = new Map();
  if (asOf) {
    const active = loadActiveEvents(db, asOf, district)
      .filter((r) => r.occurred_year === period);
    for (const row of active) {
      const keyParts = dims.map((d) => (d === "district_code" ? row.district_code : row[d]));
      const key = keyParts.join("|");
      if (!groups.has(key)) groups.set(key, { encounters: 0, residents: new Set() });
      const group = groups.get(key);
      group.encounters += 1;
      group.residents.add(row.resident_token);
    }
  }

  const minCellSize = definitions.export_min_cell_size;
  const smallCells = [];
  const rows = [];
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const values = key ? key.split("|") : [];
    const descriptor = Object.fromEntries(dims.map((d, i) => [d, values[i]]));
    if (group.residents.size < minCellSize) {
      smallCells.push(descriptor);
    } else {
      rows.push({ ...descriptor, encounters: group.encounters, unique_residents: group.residents.size });
    }
  }

  const filterRecord = { period, dimensions: dims, district: district || null };
  if (smallCells.length > 0) {
    // 小格维度描述只进内部审计，不随拒绝响应返回：
    // “某个小格存在”本身就会泄露 ≥1 名居民在该维度上的存在。
    db.prepare(
      `INSERT INTO export_audit(client_role, scope_code, period, filter_json, result, small_cells_json, row_count)
       VALUES (?, ?, ?, ?, 'rejected_small_cells', ?, 0)`
    ).run(client.role, district || "__city__", period, JSON.stringify(filterRecord),
      JSON.stringify(smallCells));
    throw new HttpError(409, "export_rejected_small_cells", {
      min_cell_size: minCellSize,
      small_cell_count: smallCells.length,
      remedy: "coarsen dimensions or widen the period/scope, then retry",
    });
  }

  db.prepare(
    `INSERT INTO export_audit(client_role, scope_code, period, filter_json, result, small_cells_json, row_count)
     VALUES (?, ?, ?, ?, 'released', NULL, ?)`
  ).run(client.role, district || "__city__", period, JSON.stringify(filterRecord), rows.length);

  return {
    period,
    scope: { type: district ? "district" : "city", code: district || "" },
    rule_version: version,
    as_of_received_at: asOf,
    min_cell_size: minCellSize,
    dimensions: dims,
    rows,
  };
}

module.exports = {
  DEFAULT_RULE_DEFINITIONS,
  HttpError,
  parseOccurredAt,
  authenticate,
  requireRole,
  assertDistrictScope,
  listRuleVersions,
  createRuleVersion,
  activateRuleVersion,
  ingestEvent,
  listEvents,
  liveMetrics,
  createPublication,
  listPublications,
  getPublication,
  researchExport,
};
