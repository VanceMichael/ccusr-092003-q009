"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { applyMigrations } = require("../src/db");
const { createServer } = require("../src/server");
const { createRuleVersion, createClient } = require("../src/admin");
const { residentDigest } = require("../src/crypto_util");

// ---------- 测试夹具 ----------

async function startHarness() {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);

  const server = createServer(database);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const keys = {};
  const issue = (body) => {
    const result = createClient(database, body);
    keys[body.client_id] = result.api_key;
    return result;
  };
  createRuleVersion(database, { version_code: "rules-2025", min_cell_size: 5 });
  issue({ client_id: "admin", role: "admin" });
  issue({ client_id: "fac1", role: "facility", facility_id: "F1", district_code: "D1" });
  issue({ client_id: "fac2", role: "facility", facility_id: "F2", district_code: "D1" });
  issue({ client_id: "fac3", role: "facility", facility_id: "F3", district_code: "D2" });
  issue({ client_id: "dist1", role: "district", district_code: "D1" });
  issue({ client_id: "dist2", role: "district", district_code: "D2" });
  issue({ client_id: "city", role: "city" });
  issue({ client_id: "research", role: "research" });

  const clientRows = {
    fac1: { client_id: "fac1", role: "facility", facility_id: "F1", district_code: "D1" },
    fac2: { client_id: "fac2", role: "facility", facility_id: "F2", district_code: "D1" },
    fac3: { client_id: "fac3", role: "facility", facility_id: "F3", district_code: "D2" },
  };

  async function api(as, method, pathName, body) {
    const response = await fetch(`${base}${pathName}`, {
      method,
      headers: {
        ...(as ? { authorization: `Bearer ${keys[as]}` } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  function stop() {
    return new Promise((resolve) => server.close(resolve));
  }

  return { database, api, stop, clientRows, keys, base };
}

const event = (overrides) => ({
  resident_token: "R-1",
  service_kind: "screening",
  age_group: "child",
  occurred_at: "2025-03-01T10:00:00+08:00",
  source_sequence: 1,
  idempotency_key: "k",
  ...overrides,
});

test("健康检查可匿名访问，业务端点必须携带凭据", async (context) => {
  const { api, stop, base } = await startHarness();
  context.after(stop);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const noCreds = await api(null, "GET", "/v1/metrics?year=2025");
  assert.equal(noCreds.status, 401);

  const authed = await api("city", "GET", "/v1/metrics?year=2025");
  assert.equal(authed.status, 200);
});

test("跨机构复诊按人去重：2 人次 = 1 人", async (context) => {
  const { api, stop } = await startHarness();
  context.after(stop);

  process.env.APP_CLOCK = "2026-01-10T00:00:00Z";
  const r1 = await api("fac1", "POST", "/v1/events", event({ idempotency_key: "a" }));
  assert.equal(r1.status, 202);
  const r2 = await api("fac2", "POST", "/v1/events", event({
    occurred_at: "2025-04-01T10:00:00+08:00",
    source_sequence: 2,
    idempotency_key: "b",
  }));
  assert.equal(r2.status, 202);

  const metrics = await api("city", "GET", "/v1/metrics?year=2025");
  assert.equal(metrics.status, 200);
  const total = metrics.body.cells.find((cell) => JSON.stringify(cell.dimension_key) === "{}");
  assert.deepEqual(total.metrics, {
    encounters: 2,
    persons: 1,
    first_coverage: 1,
    continuous_management: 1,
  });
  assert.ok(total.contributing_facilities.includes("F1"));
  assert.ok(total.contributing_facilities.includes("F2"));
});

test("幂等键重放不产生新事实", async (context) => {
  const { api, stop, database } = await startHarness();
  context.after(stop);

  process.env.APP_CLOCK = "2026-01-10T00:00:00Z";
  const payload = event({ idempotency_key: "once" });
  const first = await api("fac1", "POST", "/v1/events", payload);
  const again = await api("fac1", "POST", "/v1/events", payload);
  assert.equal(first.status, 202);
  assert.equal(again.status, 202);
  assert.equal(again.body.status, "duplicate");
  assert.equal(first.body.event_id, again.body.event_id);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM service_events").get().n, 1);
});

test("区级用户只能看到本区，无法串查他区", async (context) => {
  const { api, stop } = await startHarness();
  context.after(stop);

  process.env.APP_CLOCK = "2026-01-10T00:00:00Z";
  await api("fac1", "POST", "/v1/events", event({ resident_token: "R-A", idempotency_key: "d1" }));
  await api("fac3", "POST", "/v1/events", event({ resident_token: "R-B", district_unused: true, idempotency_key: "d2" }));

  const d1 = await api("dist1", "GET", "/v1/metrics?year=2025");
  const d2 = await api("dist2", "GET", "/v1/metrics?year=2025");
  assert.equal(d1.body.cells[0].metrics.persons, 1);
  assert.equal(d2.body.cells[0].metrics.persons, 1);
  assert.deepEqual(d1.body.scope, { level: "district", district_code: "D1" });
  // 区聚合不返回任何居民引用或机构外个体明细
  assert.equal(JSON.stringify(d1.body).includes("R-"), false);
});

test("研究导出不足最小分组规模时被拒绝，达标后放行", async (context) => {
  const { api, stop } = await startHarness();
  context.after(stop);

  process.env.APP_CLOCK = "2026-01-10T00:00:00Z";
  await api("fac1", "POST", "/v1/events", event({ resident_token: "R-A", idempotency_key: "s1" }));

  const blocked = await api("research", "GET", "/v1/research/export?year=2025&group_by=age_group");
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error, "minimum_cell_size_violation");
  assert.equal(blocked.body.min_cell_size, 5);
  // 拒绝负载不得包含具体人数或居民引用
  assert.equal(JSON.stringify(blocked.body).includes("R-A"), false);

  // 同一分组补足到 5 人（每人单次服务）
  for (let i = 0; i < 5; i += 1) {
    await api("fac1", "POST", "/v1/events", event({
      resident_token: `R-B${i}`,
      idempotency_key: `s-${i}`,
      source_sequence: i + 10,
    }));
  }
  // 此时合计 6 人、儿童组 6 人，均达到阈值
  const allowed = await api("research", "GET", "/v1/research/export?year=2025&group_by=age_group");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.export_kind, "research");
  assert.equal(allowed.body.min_cell_size_applied, 5);
});

test("撤回以新事实进入：原上报保留，有效口径随事实链更新", async (context) => {
  const { api, stop, database } = await startHarness();
  context.after(stop);

  process.env.APP_CLOCK = "2026-01-10T00:00:00Z";
  const created = await api("fac1", "POST", "/v1/events", event({ idempotency_key: "orig" }));
  process.env.APP_CLOCK = "2026-02-10T00:00:00Z";
  const retracted = await api("fac1", "POST", "/v1/events", event({
    fact_action: "retraction",
    target_event_id: created.body.event_id,
    source_sequence: 2,
    idempotency_key: "retract",
  }));
  assert.equal(retracted.status, 202);

  // 原行未被擦掉，且其内容未被修改
  const original = database.prepare("SELECT * FROM service_events WHERE id = ?").get(created.body.event_id);
  assert.equal(original.fact_action, "report");
  assert.equal(original.age_group, "child");
  const allRows = database.prepare("SELECT COUNT(*) AS n FROM service_events").get().n;
  assert.equal(allRows, 2);

  // 有效记录视图不再产出该记录
  const effective = database.prepare("SELECT COUNT(*) AS n FROM effective_records").get().n;
  assert.equal(effective, 0);
});

test("事实表禁止 UPDATE 与 DELETE", async (context) => {
  const { api, stop, database } = await startHarness();
  context.after(stop);

  process.env.APP_CLOCK = "2026-01-10T00:00:00Z";
  const created = await api("fac1", "POST", "/v1/events", event({ idempotency_key: "imm" }));
  assert.throws(() => database.exec("UPDATE service_events SET age_group='senior' WHERE id=1"), /禁止更新/);
  assert.throws(() => database.exec("DELETE FROM service_events WHERE id=1"), /禁止删除/);
  assert.equal(database.prepare("SELECT age_group FROM service_events WHERE id=?").get(created.body.event_id).age_group, "child");
});

test("不能更正或撤回他机构事件", async (context) => {
  const { api, stop } = await startHarness();
  context.after(stop);

  process.env.APP_CLOCK = "2026-01-10T00:00:00Z";
  const created = await api("fac1", "POST", "/v1/events", event({ idempotency_key: "owner" }));
  const forbidden = await api("fac2", "POST", "/v1/events", event({
    fact_action: "retraction",
    target_event_id: created.body.event_id,
    idempotency_key: "trespass",
    source_sequence: 3,
  }));
  assert.equal(forbidden.status, 403);
});

test("非法时间与缺字段被拒绝", async (context) => {
  const { api, stop } = await startHarness();
  context.after(stop);

  const noOffset = await api("fac1", "POST", "/v1/events", event({
    occurred_at: "2025-03-01T10:00:00",
    idempotency_key: "bad-1",
  }));
  assert.equal(noOffset.status, 400);
  const impossible = await api("fac1", "POST", "/v1/events", event({
    occurred_at: "2025-02-30T10:00:00+08:00",
    idempotency_key: "bad-2",
  }));
  assert.equal(impossible.status, 400);
  const badEnum = await api("fac1", "POST", "/v1/events", event({
    age_group: "toddler",
    idempotency_key: "bad-3",
  }));
  assert.equal(badEnum.status, 400);
});

test("年度发布冻结口径与水位；补报只能生成带差异的修订版，原版不变", async (context) => {
  const { api, stop } = await startHarness();
  context.after(stop);

  process.env.APP_CLOCK = "2026-01-15T00:00:00Z";
  await api("fac1", "POST", "/v1/events", event({ resident_token: "R-1", idempotency_key: "y1" }));
  await api("fac2", "POST", "/v1/events", event({
    resident_token: "R-1",
    occurred_at: "2025-05-01T10:00:00+08:00",
    service_kind: "guidance",
    idempotency_key: "y2",
    source_sequence: 2,
  }));

  const frozen = await api("admin", "POST", "/v1/publications", {
    year: 2025,
    watermark: "2026-01-31T00:00:00Z",
  });
  assert.equal(frozen.status, 201);
  assert.equal(frozen.body.revision_no, 0);
  assert.equal(frozen.body.rule_version_code, "rules-2025");

  const v0 = await api("city", "GET", "/v1/publications/COVERAGE-2025/indicators?revision_no=0");
  const totalPersons = v0.body.cells.find(
    (cell) => JSON.stringify(cell.dimension_key) === "{}" && cell.metric === "persons"
  ).value;
  const totalEncounters = v0.body.cells.find(
    (cell) => JSON.stringify(cell.dimension_key) === "{}" && cell.metric === "encounters"
  ).value;
  assert.equal(totalPersons, 1);
  assert.equal(totalEncounters, 2);
  assert.equal(v0.body.rule_version_code, "rules-2025");

  // 冻结后补报一名新儿童
  process.env.APP_CLOCK = "2026-02-15T00:00:00Z";
  await api("fac1", "POST", "/v1/events", event({
    resident_token: "R-2",
    service_kind: "intervention",
    occurred_at: "2025-06-01T10:00:00+08:00",
    idempotency_key: "y3",
    source_sequence: 3,
  }));

  // 不能重新冻结同一年度
  const duplicate = await api("admin", "POST", "/v1/publications", { year: 2025 });
  assert.equal(duplicate.status, 409);

  const revised = await api("admin", "POST", "/v1/publications/COVERAGE-2025/revisions", {
    watermark: "2026-02-28T00:00:00Z",
  });
  assert.equal(revised.status, 201);
  assert.equal(revised.body.revision_no, 1);
  assert.equal(revised.body.difference.facts_added_in_period, 1);
  const changedTotal = revised.body.difference.changed_cells.find(
    (change) => JSON.stringify(change.dimension_key) === "{}" && change.metric === "persons"
  );
  assert.deepEqual({ from: changedTotal.from, to: changedTotal.to }, { from: 1, to: 2 });

  // 修订水位不能倒退
  const backward = await api("admin", "POST", "/v1/publications/COVERAGE-2025/revisions", {
    watermark: "2026-02-01T00:00:00Z",
  });
  assert.equal(backward.status, 400);

  // 原版指标仍然是冻结时的值
  const v0Again = await api("city", "GET", "/v1/publications/COVERAGE-2025/indicators?revision_no=0");
  const v0Persons = v0Again.body.cells.find(
    (cell) => JSON.stringify(cell.dimension_key) === "{}" && cell.metric === "persons"
  ).value;
  assert.equal(v0Persons, 1);

  // 元数据可溯源：规则版本、水位、机构贡献
  const meta = await api("city", "GET", "/v1/publications/COVERAGE-2025");
  assert.equal(meta.body.original.rule_version_code, "rules-2025");
  assert.equal(meta.body.original.watermark, "2026-01-31T00:00:00Z");
  assert.equal(meta.body.revisions.length, 2);
  assert.equal(meta.body.revisions[1].difference_summary.parent_revision_no, 0);
});

test("连续管理：年内两次合格服务且间隔不超过窗口", async (context) => {
  const { api, stop } = await startHarness();
  context.after(stop);

  process.env.APP_CLOCK = "2026-01-10T00:00:00Z";
  // 管理者：1 月与 6 月各一次
  await api("fac1", "POST", "/v1/events", event({
    resident_token: "KEEP",
    age_group: "senior",
    occurred_at: "2025-01-10T09:00:00+08:00",
    idempotency_key: "c1",
  }));
  await api("fac2", "POST", "/v1/events", event({
    resident_token: "KEEP",
    age_group: "senior",
    service_kind: "intervention",
    occurred_at: "2025-06-10T09:00:00+08:00",
    idempotency_key: "c2",
    source_sequence: 2,
  }));
  // 单次服务者：不计入连续管理
  await api("fac1", "POST", "/v1/events", event({
    resident_token: "ONCE",
    age_group: "adult",
    occurred_at: "2025-03-10T09:00:00+08:00",
    idempotency_key: "c3",
    source_sequence: 3,
  }));

  const metrics = await api("city", "GET", "/v1/metrics?year=2025");
  const total = metrics.body.cells.find((cell) => JSON.stringify(cell.dimension_key) === "{}").metrics;
  assert.equal(total.persons, 2);
  assert.equal(total.continuous_management, 1);
  assert.equal(total.first_coverage, 2);
});

test("库内仅保存居民引用摘要，接口不返回可逆标识", async (context) => {
  const { api, stop, database } = await startHarness();
  context.after(stop);

  process.env.APP_CLOCK = "2026-01-10T00:00:00Z";
  await api("fac1", "POST", "/v1/events", event({ resident_token: "SECRET-TOKEN", idempotency_key: "p1" }));

  const stored = database.prepare("SELECT resident_ref_hash FROM service_events").all();
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].resident_ref_hash, "SECRET-TOKEN");
  assert.equal(stored[0].resident_ref_hash, residentDigest("SECRET-TOKEN"));

  const metrics = await api("city", "GET", "/v1/metrics?year=2025&group_by=age_group");
  assert.equal(metrics.body.cells.some((cell) => JSON.stringify(cell).includes("SECRET-TOKEN")), false);
  assert.equal(metrics.body.cells.some((cell) => JSON.stringify(cell).includes(stored[0].resident_ref_hash)), false);
});

test("角色边界：机构不能查询聚合，非管理员不能发布或登记规则", async (context) => {
  const { api, stop } = await startHarness();
  context.after(stop);

  assert.equal((await api("fac1", "GET", "/v1/metrics?year=2025")).status, 403);
  // 研究角色不能借普通聚合端点绕过最小分组抑制
  assert.equal((await api("research", "GET", "/v1/metrics?year=2025")).status, 403);
  assert.equal((await api("city", "POST", "/v1/publications", { year: 2025 })).status, 403);
  assert.equal((await api("dist1", "POST", "/v1/admin/rule-versions", { version_code: "x" })).status, 403);
  assert.equal((await api("research", "POST", "/v1/events", event({ idempotency_key: "z" }))).status, 403);
});
