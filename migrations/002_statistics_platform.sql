
-- 脱敏统计平台：机构、凭据、规则版本、不可变事件日志、冻结发布、导出审计。
-- 约定：events 表只允许 INSERT（应用层不再 UPDATE/DELETE）；更正以新行进入，
-- 通过 corrects_event_id 指向原行，原上报 raw_json 永不擦除。

CREATE TABLE IF NOT EXISTS organizations (
    org_code      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    district_code TEXT NOT NULL,
    tier          TEXT NOT NULL CHECK (tier IN ('city', 'district', 'community'))
);

CREATE TABLE IF NOT EXISTS api_clients (
    api_key       TEXT PRIMARY KEY,
    role          TEXT NOT NULL CHECK (role IN ('city', 'district', 'ingest')),
    org_code      TEXT REFERENCES organizations(org_code),
    district_code TEXT,
    label         TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS rule_versions (
    version          TEXT PRIMARY KEY,
    status           TEXT NOT NULL DEFAULT 'deactivated' CHECK (status IN ('active', 'deactivated')),
    definitions_json TEXT NOT NULL,
    note             TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    activated_at     TEXT
);

CREATE TABLE IF NOT EXISTS events (
    event_id           TEXT PRIMARY KEY,
    org_code           TEXT NOT NULL REFERENCES organizations(org_code),
    resident_token     TEXT NOT NULL,
    district_code      TEXT NOT NULL,
    service_kind       TEXT NOT NULL,
    age_group          TEXT NOT NULL,
    occurred_at        TEXT NOT NULL,              -- 统一归一化为 UTC（...Z）
    occurred_year      INTEGER NOT NULL,           -- 年度归属：按发生地墙钟年份（避免 UTC 跨年错位）
    quality_mark       TEXT NOT NULL,
    source_sequence    INTEGER NOT NULL CHECK (source_sequence >= 0),
    corrects_event_id  TEXT REFERENCES events(event_id),
    correction_reason  TEXT,
    received_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    raw_json           TEXT NOT NULL,
    UNIQUE (org_code, source_sequence)
);

CREATE INDEX IF NOT EXISTS idx_events_district_time ON events(district_code, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_resident      ON events(resident_token);
CREATE INDEX IF NOT EXISTS idx_events_corrects      ON events(corrects_event_id);

CREATE TABLE IF NOT EXISTS publications (
    publication_id          TEXT PRIMARY KEY,
    period                  INTEGER NOT NULL,
    edition                 TEXT NOT NULL CHECK (edition IN ('original', 'revision')),
    supersedes_publication_id TEXT REFERENCES publications(publication_id),
    rule_version            TEXT NOT NULL,
    definitions_json        TEXT NOT NULL,         -- 冻结当时的口径快照
    as_of_received_at       TEXT NOT NULL,         -- 冻结数据水位
    manifest_json           TEXT NOT NULL,         -- 机构贡献清单与各自水位
    revision_diff_json      TEXT,
    created_by              TEXT NOT NULL,
    note                    TEXT NOT NULL DEFAULT '',
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS publication_metrics (
    publication_id TEXT NOT NULL REFERENCES publications(publication_id),
    scope_type     TEXT NOT NULL CHECK (scope_type IN ('city', 'district')),
    scope_code     TEXT NOT NULL DEFAULT '',
    age_group      TEXT NOT NULL,
    service_kind   TEXT NOT NULL,
    quality_mark   TEXT NOT NULL,
    metric         TEXT NOT NULL,
    value          INTEGER NOT NULL,
    PRIMARY KEY (publication_id, scope_type, scope_code, age_group, service_kind, quality_mark, metric)
);

CREATE TABLE IF NOT EXISTS export_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    client_role     TEXT NOT NULL,
    scope_code      TEXT NOT NULL,
    period          INTEGER NOT NULL,
    filter_json     TEXT NOT NULL,
    result          TEXT NOT NULL CHECK (result IN ('released', 'rejected_small_cells')),
    small_cells_json TEXT,
    row_count       INTEGER NOT NULL DEFAULT 0
);

-- 首版口径（与代码 DEFAULT_RULE_DEFINITIONS 保持一致）
INSERT INTO rule_versions(version, status, definitions_json, note, activated_at)
VALUES (
    '1.0',
    'active',
    '{"age_groups":["child","adult","senior"],"service_kinds":["screening","guidance","intervention"],"quality_marks":["normal","deficient"],"late_threshold_days":30,"continuous_management":{"min_events":2,"max_gap_days":180},"export_min_cell_size":10}',
    '首版年度覆盖统计口径',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(version) DO NOTHING;

-- 演示机构与密钥（生产部署必须替换）
INSERT INTO organizations(org_code, name, district_code, tier) VALUES
    ('ORG-A-01', 'A区口腔防治院',     'DIST-A', 'district'),
    ('ORG-A-02', 'A区社区卫生服务中心', 'DIST-A', 'community'),
    ('ORG-B-01', 'B区口腔防治院',     'DIST-B', 'district')
ON CONFLICT(org_code) DO NOTHING;

INSERT INTO api_clients(api_key, role, org_code, district_code, label) VALUES
    ('demo-city-key',       'city',     NULL,       NULL,     '市级平台（演示）'),
    ('demo-district-a-key', 'district', NULL,       'DIST-A', 'A区区级用户（演示）'),
    ('demo-district-b-key', 'district', NULL,       'DIST-B', 'B区区级用户（演示）'),
    ('demo-ingest-a1-key',  'ingest',   'ORG-A-01', 'DIST-A', 'A区防治院上报（演示）'),
    ('demo-ingest-a2-key',  'ingest',   'ORG-A-02', 'DIST-A', 'A区社区中心上报（演示）'),
    ('demo-ingest-b1-key',  'ingest',   'ORG-B-01', 'DIST-B', 'B区防治院上报（演示）')
ON CONFLICT(api_key) DO NOTHING;
