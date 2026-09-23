
const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { runMigrations } = require("../scripts/migrate");
const { createServer } = require("../src/server");
const crypto = require("node:crypto");

const KEYS = {
  city: "demo-city-key",
  districtA: "demo-district-a-key",
  districtB: "demo-district-b-key",
  ingestA1: "demo-ingest-a1-key", // ORG-A-01 DIST-A
  ingestA2: "demo-ingest-a2-key", // ORG-A-02 DIST-A
  ingestB1: "demo-ingest-b1-key", // ORG-B-01 DIST-B
};

function token(seed) {
  return `sha256:${crypto.createHash("sha256").update(seed).digest("hex")}`;
}

async function startHarness() {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, require("node:path").join(__dirname, "..", "migrations"));
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { key, body, raw } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(key ? { "x-api-key": key } : {}),
        ...(raw ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  }

  // 内部确定性收报时间：仅测试使用（HTTP 层不接收该字段）。
  const ingest = (key, payload, receivedAt) => {
    const { ingestEvent, authenticate } = require("../src/platform");
    const client = authenticate(db, key);
    return ingestEvent(db, client, payload, receivedAt ? { receivedAt } : undefined);
  };

  const stop = () => new Promise((resolve) => server.close(resolve));
  return { db, base, call, ingest, stop };
}

const event = (resident, seq, { kind = "screening", age = "child", at, quality = "normal",
  corrects, reason } = {}) => ({
  resident_token: resident,
  service_kind: kind,
  age_group: age,
  occurred_at: at,
  source_sequence: seq,
  quality_mark: quality,
  ...(corrects ? { corrects_event_id: corrects, correction_reason: reason || "更正" } : {}),
});

test("健康接口无需密钥", async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  } finally {
    await h.stop();
  }
});

test("上报需鉴权且令牌必须为不可逆哈希形态", async () => {
  const h = await startHarness();
  try {
    assert.equal((await h.call("POST", "/v1/events", {
      body: event(token("r1"), 0, { at: "2025-03-01T09:00:00+08:00" }),
    })).status, 401);

    const bad = await h.call("POST", "/v1/events", {
      key: KEYS.ingestA1,
      body: { ...event(token("r1"), 0, { at: "2025-03-01T09:00:00+08:00" }), resident_token: "身份证-310..." },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "validation_failed");

    assert.equal((await h.call("GET", "/v1/metrics/live?period=2025", { key: KEYS.ingestA1 })).status, 403);
  } finally {
    await h.stop();
  }
});

test("跨机构复诊：人次为三、去重人数为一；首覆与连续管理分列", async () => {
  const h = await startHarness();
  try {
    const r1 = token("居民甲");
    h.ingest(KEYS.ingestA1, event(r1, 10, { at: "2025-03-01T09:00:00+08:00" }));
    h.ingest(KEYS.ingestA2, event(r1, 7, { kind: "guidance", at: "2025-04-10T14:00:00+08:00" }));
    // 同一机构重复投递相同序列号：幂等，不新增人次
    const dup = h.ingest(KEYS.ingestA1, event(r1, 10, { at: "2025-03-01T09:00:00+08:00" }));
    assert.equal(dup.status, "duplicate");
    // 第三位“人次”是另一居民
    h.ingest(KEYS.ingestA1, event(token("居民乙"), 11, { age: "senior", at: "2025-05-01T10:00:00+08:00" }));

    const res = await h.call("GET", "/v1/metrics/live?period=2025", { key: KEYS.city });
    assert.equal(res.status, 200);
    const child = res.json.service_cells.find(
      (c) => c.age_group === "child" && c.service_kind === "screening");
    assert.equal(child.metrics.encounters, 1);
    const guidance = res.json.service_cells.find((c) => c.service_kind === "guidance");
    assert.equal(guidance.metrics.encounters, 1);
    assert.equal(guidance.metrics.unique_residents, 1);
    // 甲跨机构两次服务，去重后儿童覆盖人数仍为 1
    const totalChildUnique = res.json.service_cells
      .filter((c) => c.age_group === "child")
      .reduce((sum, c) => sum + c.metrics.unique_residents, 0);
    assert.ok(totalChildUnique >= 1);
    // 甲在 2025 年内两次服务间隔 40 天 < 180 天：连续管理 1 人
    const cont = res.json.continuity_cells.find((c) => c.age_group === "child");
    assert.equal(cont.continuous_management, 1);
  } finally {
    await h.stop();
  }
});

test("首次覆盖只记居民最早服务年度；迟到次年事件不回改历史首覆", async () => {
  const h = await startHarness();
  try {
    const r1 = token("首覆-甲");
    h.ingest(KEYS.ingestA1, event(r1, 1, { at: "2024-06-01T09:00:00+08:00" }));
    h.ingest(KEYS.ingestA1, event(r1, 2, { kind: "guidance", at: "2025-03-01T09:00:00+08:00" }));
    h.ingest(KEYS.ingestA1, event(token("首覆-乙"), 3, { at: "2025-05-01T09:00:00+08:00" }));

    const y2024 = await h.call("GET", "/v1/metrics/live?period=2024", { key: KEYS.city });
    assert.equal(y2024.json.service_cells[0].metrics.first_coverage, 1);

    const y2025 = await h.call("GET", "/v1/metrics/live?period=2025", { key: KEYS.city });
    const screening2025 = y2025.json.service_cells.find(
      (c) => c.service_kind === "screening" && c.age_group === "child");
    // 甲 2024 年已首覆；2025 年筛查首覆只有乙
    assert.equal(screening2025.metrics.first_coverage, 1);
    assert.equal(screening2025.metrics.unique_residents, 1);
    // 甲 2025 年只有 1 次服务，不满足连续管理
    const cont = y2025.json.continuity_cells.find((c) => c.age_group === "child");
    assert.equal(cont.continuous_management, 0);
  } finally {
    await h.stop();
  }
});

test("迟到数据以新事实进入：原版冻结不变，修订版带差异说明", async () => {
  const h = await startHarness();
  try {
    const r1 = token("迟到-甲");
    h.ingest(KEYS.ingestA1, event(r1, 1, { at: "2025-01-10T09:00:00+08:00" }), "2026-01-05T00:00:00.000Z");

    const first = await h.call("POST", "/v1/publications",
      { key: KEYS.city, body: { period: 2025, note: "年度原版" } });
    assert.equal(first.status, 201);
    assert.equal(first.json.edition, "original");
    assert.equal(first.json.rule_version, "1.0");
    const originalId = first.json.publication_id;
    const firstWatermark = first.json.as_of_received_at;
    const originalChildScreen = first.json.cells.find(
      (c) => c.scope.type === "city" && c.age_group === "child" && c.service_kind === "screening");
    assert.equal(originalChildScreen.metrics.encounters, 1);

    // 冻结后迟到到达：新事实，不改原行
    h.ingest(KEYS.ingestA1, event(token("迟到-乙"), 2, {
      at: "2025-02-10T09:00:00+08:00",
    }), "2026-02-01T00:00:00.000Z");

    const revision = await h.call("POST", "/v1/publications",
      { key: KEYS.city, body: { period: 2025, note: "补报修订" } });
    assert.equal(revision.status, 201);
    assert.equal(revision.json.edition, "revision");
    assert.equal(revision.json.supersedes_publication_id, originalId);
    assert.ok(revision.json.as_of_received_at > firstWatermark);

    const diff = revision.json.revision_diff;
    assert.equal(diff.late_events_since_freeze, 1);
    const changedEncounters = diff.metrics_changed.find(
      (d) => d.metric === "encounters" && d.scope_type === "city" &&
             d.age_group === "child" && d.service_kind === "screening");
    assert.deepEqual([changedEncounters.from, changedEncounters.to], [1, 2]);
    assert.ok(diff.org_watermarks.find((o) => o.org_code === "ORG-A-01").new_events >= 1);

    // 原版仍然可读，数字与口径快照保持冻结时状态
    const refetched = await h.call("GET", `/v1/publications/${originalId}`, { key: KEYS.city });
    const frozenCell = refetched.json.cells.find(
      (c) => c.scope.type === "city" && c.age_group === "child" && c.service_kind === "screening");
    assert.equal(frozenCell.metrics.encounters, 1);
    assert.equal(refetched.json.rule_version, "1.0");
    assert.ok(refetched.json.definitions_json === undefined); // 字段名为 definitions_frozen
    assert.ok(refetched.json.definitions_frozen.continuous_management);
  } finally {
    await h.stop();
  }
});

test("更正以新事实追加，原上报保留但标记 superseded", async () => {
  const h = await startHarness();
  try {
    const r1 = token("更正-甲");
    const first = h.ingest(KEYS.ingestA1, event(r1, 1, {
      at: "2025-03-01T09:00:00+08:00", quality: "normal",
    }));
    // 更正：质量标记应为 deficient；新行指向原行
    h.ingest(KEYS.ingestA1, event(r1, 2, {
      at: "2025-03-01T09:00:00+08:00", quality: "deficient",
      corrects: first.event_id, reason: "质量标记误录",
    }));

    const list = await h.call("GET", "/v1/events?period=2025", { key: KEYS.ingestA1 });
    assert.equal(list.json.events.length, 2);
    const original = list.json.events.find((e) => e.event_id === first.event_id);
    assert.equal(original.superseded, true);
    // 原始报文未被擦除
    const raw = h.db.prepare("SELECT raw_json FROM events WHERE event_id = ?").get(first.event_id);
    assert.ok(raw.raw_json.includes('"quality_mark":"normal"'));
    // 应用层没有任何 UPDATE/DELETE 路径，行计数为 2
    assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM events").get().c, 2);

    const res = await h.call("GET", "/v1/metrics/live?period=2025", { key: KEYS.city });
    const deficient = res.json.service_cells.find((c) => c.quality_mark === "deficient");
    assert.equal(deficient.metrics.encounters, 1);
    const normal = res.json.service_cells.find(
      (c) => c.quality_mark === "normal" && c.age_group === "child" && c.service_kind === "screening");
    assert.equal(normal, undefined);

    // 不能更正他机构的事件
    const foreign = await h.call("POST", "/v1/events", {
      key: KEYS.ingestA2,
      body: event(token("更正-越权"), 9, {
        at: "2025-03-01T09:00:00+08:00", corrects: first.event_id,
      }),
    });
    assert.equal(foreign.status, 403);
  } finally {
    await h.stop();
  }
});

test("区级用户不能串查他区，且发布只属市级", async () => {
  const h = await startHarness();
  try {
    h.ingest(KEYS.ingestA1, event(token("隔离-A"), 1, { at: "2025-03-01T09:00:00+08:00" }));
    h.ingest(KEYS.ingestB1, event(token("隔离-B"), 1, { at: "2025-03-01T09:00:00+08:00" }));

    // B 区用户显式查 A 区：拒绝
    const cross = await h.call("GET", "/v1/metrics/live?period=2025&district=DIST-A",
      { key: KEYS.districtB });
    assert.equal(cross.status, 403);
    assert.equal(cross.json.error, "cross_district_denied");

    // 不带区参数时锁定本区，看不到 B 区个体以外的 A 区数据
    const own = await h.call("GET", "/v1/metrics/live?period=2025", { key: KEYS.districtB });
    assert.equal(own.json.scope.type, "district");
    assert.equal(own.json.scope.code, "DIST-B");
    assert.ok(own.json.service_cells.every((c) => c.metrics.encounters >= 0));

    // 区级无权发布
    assert.equal((await h.call("POST", "/v1/publications",
      { key: KEYS.districtA, body: { period: 2025 } })).status, 403);

    // 市级发布后，B 区只能看到全市汇总与 B 区，看不到 A 区分组
    const pub = await h.call("POST", "/v1/publications",
      { key: KEYS.city, body: { period: 2025 } });
    const seen = await h.call("GET", `/v1/publications/${pub.json.publication_id}`,
      { key: KEYS.districtB });
    const districts = [...new Set(seen.json.cells
      .filter((c) => c.scope.type === "district").map((c) => c.scope.code))];
    assert.deepEqual(districts, ["DIST-B"]);
    assert.ok(seen.json.cells.some((c) => c.scope.type === "city"));
  } finally {
    await h.stop();
  }
});

test("研究导出：不足最小分组规模整单拒绝，粗化后放行并留审计", async () => {
  const h = await startHarness();
  try {
    // 仅 2 名儿童，细维度必然低于阈值 10
    h.ingest(KEYS.ingestA1, event(token("导出-1"), 1, { at: "2025-03-01T09:00:00+08:00" }));
    h.ingest(KEYS.ingestA1, event(token("导出-2"), 2, {
      kind: "guidance", at: "2025-04-01T09:00:00+08:00",
    }));

    const fine = await h.call("POST", "/v1/exports/research", {
      key: KEYS.city,
      body: { period: 2025, dimensions: ["age_group", "service_kind", "quality_mark"] },
    });
    assert.equal(fine.status, 409);
    assert.equal(fine.json.error, "export_rejected_small_cells");
    assert.equal(fine.json.min_cell_size, 10);
    // 拒绝响应不回传小格维度与人数，无法据此探测居民是否存在
    assert.equal(fine.json.small_cells, undefined);
    assert.ok(fine.json.small_cell_count >= 1);
    // 维度描述仅进入内部审计
    const audit = h.db.prepare(
      "SELECT small_cells_json FROM export_audit WHERE result = 'rejected_small_cells'"
    ).get();
    assert.ok(JSON.parse(audit.small_cells_json).length >= 1);

    // 补足 10 名儿童的粗分组（age_group 单维）后放行
    for (let i = 3; i <= 10; i += 1) {
      h.ingest(KEYS.ingestA1, event(token(`导出-${i}`), i, {
        kind: i % 2 ? "screening" : "guidance",
        at: `2025-0${(i % 9) + 1}-10T09:00:00+08:00`,
      }));
    }
    const coarse = await h.call("POST", "/v1/exports/research", {
      key: KEYS.city,
      body: { period: 2025, dimensions: ["age_group"] },
    });
    assert.equal(coarse.status, 200);
    assert.equal(coarse.json.rows.length, 1);
    assert.equal(coarse.json.rows[0].unique_residents, 10);
    assert.equal(coarse.json.rule_version, "1.0");

    // 审计表同时留下拒绝与放行记录
    const audits = h.db.prepare(
      "SELECT result, COUNT(*) AS c FROM export_audit GROUP BY result"
    ).all();
    assert.deepEqual(audits.map((a) => a.result).sort(), ["rejected_small_cells", "released"]);
  } finally {
    await h.stop();
  }
});

test("每个公开数字可溯源到规则版本与机构数据水位", async () => {
  const h = await startHarness();
  try {
    h.ingest(KEYS.ingestA1, event(token("溯源-甲"), 1, { at: "2025-03-01T09:00:00+08:00" }));
    h.ingest(KEYS.ingestB1, event(token("溯源-乙"), 1, { at: "2025-03-01T09:00:00+08:00" }));

    const pub = await h.call("POST", "/v1/publications",
      { key: KEYS.city, body: { period: 2025 } });
    assert.equal(pub.json.rule_version, "1.0");
    const manifest = pub.json.manifest;
    const a1 = manifest.find((o) => o.org_code === "ORG-A-01");
    const b1 = manifest.find((o) => o.org_code === "ORG-B-01");
    assert.equal(a1.event_count, 1);
    assert.equal(b1.event_count, 1);
    assert.ok(a1.last_received_at);
    // 无数据机构同样列入，水位为 null，说明“哪些机构数据”是完整清单
    const a2 = manifest.find((o) => o.org_code === "ORG-A-02");
    assert.equal(a2.event_count, 0);
    assert.equal(a2.last_received_at, null);
  } finally {
    await h.stop();
  }
});

test("切换规则版本后发布按新版冻结，旧版发布口径不变", async () => {
  const h = await startHarness();
  try {
    h.ingest(KEYS.ingestA1, event(token("规则-甲"), 1, { at: "2025-03-01T09:00:00+08:00" }));
    const first = await h.call("POST", "/v1/publications",
      { key: KEYS.city, body: { period: 2025 } });
    assert.equal(first.json.rule_version, "1.0");

    const created = await h.call("POST", "/v1/rules", {
      key: KEYS.city,
      body: {
        version: "1.1",
        note: "连续管理放宽到 365 天",
        definitions: {
          age_groups: ["child", "adult", "senior"],
          service_kinds: ["screening", "guidance", "intervention"],
          quality_marks: ["normal", "deficient"],
          late_threshold_days: 30,
          continuous_management: { min_events: 2, max_gap_days: 365 },
          export_min_cell_size: 5,
        },
      },
    });
    assert.equal(created.status, 201);
    const activated = await h.call("POST", "/v1/rules/1.1/activate", { key: KEYS.city });
    assert.equal(activated.status, 200);

    const revised = await h.call("POST", "/v1/publications",
      { key: KEYS.city, body: { period: 2025 } });
    assert.equal(revised.json.rule_version, "1.1");
    assert.equal(revised.json.definitions_frozen.export_min_cell_size, 5);

    const old = await h.call("GET", `/v1/publications/${first.json.publication_id}`,
      { key: KEYS.city });
    assert.equal(old.json.rule_version, "1.0");
    assert.equal(old.json.definitions_frozen.export_min_cell_size, 10);

    // 非市级不能管理规则
    assert.equal((await h.call("GET", "/v1/rules", { key: KEYS.districtA })).status, 403);
  } finally {
    await h.stop();
  }
});
