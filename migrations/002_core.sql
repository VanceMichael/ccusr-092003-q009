-- 核心业务表
-- 设计原则：原始上报为只追加事实；迟到数据与更正以新事实进入，不修改、不删除原事实。

-- 规则版本：每次口径变化产生新版本，年度发布冻结所采用的规则版本
CREATE TABLE IF NOT EXISTS rule_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_code TEXT NOT NULL UNIQUE,
    -- 首次覆盖口径：该居民在平台最早一条有效服务记录之前 first_visit_gap_days 天内无任何记录
    first_visit_gap_days INTEGER NOT NULL DEFAULT 90,
    -- 连续管理口径：统计年内与上一次有效服务间隔不超过 continuity_window_days 天
    continuity_window_days INTEGER NOT NULL DEFAULT 365,
    excluded_quality_flags TEXT NOT NULL DEFAULT '["invalid"]', -- 计入人次但不计入覆盖类指标的质量标记
    dimensions TEXT NOT NULL DEFAULT '["age_group","service_kind","district_code"]',
    min_cell_size INTEGER NOT NULL DEFAULT 5,                    -- 研究导出最小分组规模
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 上报方与用户：facility 只能看本机构；district 只能看本区（不能串查他区个体）；
-- city 可跨区但只取聚合；research 同 city，但导出受最小分组规模约束；admin 负责发布与配管
CREATE TABLE IF NOT EXISTS api_clients (
    client_id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('facility','district','city','research','admin')),
    district_code TEXT,
    facility_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- API 密钥仅保存 sha256 摘要
CREATE TABLE IF NOT EXISTS api_keys (
    key_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES api_clients(client_id)
);

-- 只追加事件流：重复发送用 (facility_id, idempotency_key) 幂等拦截
CREATE TABLE IF NOT EXISTS service_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 居民引用经机构侧加盐哈希后提交，平台永不持有可逆引用
    resident_ref_hash TEXT NOT NULL,
    district_code TEXT NOT NULL,
    facility_id TEXT NOT NULL,
    service_kind TEXT NOT NULL,
    age_group TEXT NOT NULL,
    occurred_at TEXT NOT NULL,               -- ISO 8601 带偏移量原文
    occurred_at_epoch REAL NOT NULL,         -- 换算的 Unix 秒，用于排序与窗口计算
    quality_flag TEXT NOT NULL DEFAULT 'ok',
    fact_action TEXT NOT NULL CHECK (fact_action IN ('report','correction','retraction')),
    target_event_id INTEGER,                 -- correction/retraction 指向原上报事件
    source_sequence BIGINT NOT NULL,         -- 机构内单调序号
    idempotency_key TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (facility_id, idempotency_key),
    FOREIGN KEY (target_event_id) REFERENCES service_events(id)
);

CREATE INDEX IF NOT EXISTS idx_events_facility ON service_events(facility_id);
CREATE INDEX IF NOT EXISTS idx_events_district ON service_events(district_code);
CREATE INDEX IF NOT EXISTS idx_events_epoch ON service_events(occurred_at_epoch);
CREATE INDEX IF NOT EXISTS idx_events_hash_epoch ON service_events(resident_ref_hash, occurred_at_epoch);

-- 有效记录：每条事实链（原上报 + 其更正/撤回）按接收时间取最新一条；撤回链不产出有效记录。
-- 迟到数据是 occurred_at 早、received_at 晚的新 report，自然进入对应链之外的新链。
CREATE VIEW IF NOT EXISTS effective_records AS
WITH ranked AS (
    SELECT
        e.*,
        COALESCE(e.target_event_id, e.id) AS target_id,
        ROW_NUMBER() OVER (
            PARTITION BY COALESCE(e.target_event_id, e.id)
            ORDER BY e.received_at DESC, e.id DESC
        ) AS rn
    FROM service_events e
)
SELECT
    id, resident_ref_hash, district_code, facility_id, service_kind, age_group,
    occurred_at, occurred_at_epoch, quality_flag, fact_action, source_sequence, received_at
FROM ranked
WHERE rn = 1 AND fact_action <> 'retraction';

-- 事件表只追加：任何 UPDATE/DELETE 都被拒绝，原上报不可被擦掉
CREATE TRIGGER IF NOT EXISTS trg_events_no_update
BEFORE UPDATE ON service_events
BEGIN
    SELECT RAISE(ABORT, 'service_events 为只追加事实表，禁止更新');
END;

CREATE TRIGGER IF NOT EXISTS trg_events_no_delete
BEFORE DELETE ON service_events
BEGIN
    SELECT RAISE(ABORT, 'service_events 为只追加事实表，禁止删除');
END;

-- 年度发布：冻结规则版本与数据水位
CREATE TABLE IF NOT EXISTS publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publication_code TEXT NOT NULL UNIQUE,   -- 如 COVERAGE-2025
    year INTEGER NOT NULL,
    period_start TEXT NOT NULL,              -- ISO 8601 带偏移量
    period_end TEXT NOT NULL,
    rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
    status TEXT NOT NULL DEFAULT 'frozen' CHECK (status IN ('frozen','superseded')),
    watermark TEXT NOT NULL,                 -- 冻结时刻：只纳入 received_at <= watermark 的事实
    created_by TEXT REFERENCES api_clients(client_id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    notes TEXT NOT NULL DEFAULT ''
);

-- 修订版：冻结后补报不能回改原版，只能生成带差异说明的修订版
CREATE TABLE IF NOT EXISTS publication_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publication_id INTEGER NOT NULL REFERENCES publications(id),
    revision_no INTEGER NOT NULL,            -- 原版为 0
    parent_revision_id INTEGER REFERENCES publication_revisions(id),
    rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
    watermark TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded')),
    difference_summary TEXT NOT NULL DEFAULT '',
    created_by TEXT REFERENCES api_clients(client_id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (publication_id, revision_no)
);

-- 修订版指标单元格：每个公开数字都带维度键、口径版本与贡献机构清单
CREATE TABLE IF NOT EXISTS revision_indicators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    revision_id INTEGER NOT NULL REFERENCES publication_revisions(id),
    dimension_key TEXT NOT NULL DEFAULT '{}', -- JSON，如 {"age_group":"child"}；总数为 {}
    metric TEXT NOT NULL CHECK (metric IN ('encounters','persons','first_coverage','continuous_management')),
    value INTEGER NOT NULL,
    contributing_facilities TEXT NOT NULL DEFAULT '[]', -- JSON 机构 ID 数组
    UNIQUE (revision_id, dimension_key, metric)
);

CREATE INDEX IF NOT EXISTS idx_rev_ind_rev ON revision_indicators(revision_id);

-- 冻结发布后禁止修改发布头与指标
CREATE TRIGGER IF NOT EXISTS trg_publications_no_update
BEFORE UPDATE ON publications
BEGIN
    SELECT RAISE(ABORT, '发布一经冻结不可修改，补报请创建修订版');
END;

CREATE TRIGGER IF NOT EXISTS trg_revision_immutable
BEFORE UPDATE ON publication_revisions
WHEN NEW.publication_id IS NOT OLD.publication_id
  OR NEW.revision_no IS NOT OLD.revision_no
  OR NEW.parent_revision_id IS NOT OLD.parent_revision_id
  OR NEW.rule_version_id IS NOT OLD.rule_version_id
  OR NEW.watermark IS NOT OLD.watermark
  OR NEW.difference_summary IS NOT OLD.difference_summary
BEGIN
    SELECT RAISE(ABORT, '修订版内容不可变，仅允许 current→superseded 状态流转');
END;

CREATE TRIGGER IF NOT EXISTS trg_indicators_no_update
BEFORE UPDATE ON revision_indicators
BEGIN
    SELECT RAISE(ABORT, '冻结指标不可修改');
END;

CREATE TRIGGER IF NOT EXISTS trg_publications_no_delete
BEFORE DELETE ON publications
BEGIN
    SELECT RAISE(ABORT, '冻结发布不可删除');
END;

CREATE TRIGGER IF NOT EXISTS trg_revision_no_delete
BEFORE DELETE ON publication_revisions
BEGIN
    SELECT RAISE(ABORT, '修订版不可删除');
END;

CREATE TRIGGER IF NOT EXISTS trg_indicators_no_delete
BEFORE DELETE ON revision_indicators
BEGIN
    SELECT RAISE(ABORT, '冻结指标不可删除');
END;

CREATE TRIGGER IF NOT EXISTS trg_rule_versions_no_update
BEFORE UPDATE ON rule_versions
BEGIN
    SELECT RAISE(ABORT, '规则版本不可修改，口径变更须登记新版本');
END;
