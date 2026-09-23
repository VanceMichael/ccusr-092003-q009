# 分层口腔服务覆盖复算

市、区、社区机构使用脱敏居民引用上报检查、指导和干预记录，平台分别计算**人次、去重人数、首次覆盖、连续管理**，并支持年度发布冻结与带差异说明的修订版。

## 设计要点

- **脱敏**：机构只提交形如 `sha256:<64位十六进制>` 的不可逆居民引用、年龄组、服务类型、发生时间和质量标记；平台从不接收姓名、证件号等可逆标识，任何公开数字都无法反向定位居民。
- **只追加（append-only）**：迟到数据与更正都以**新事实行**进入。原上报 `raw_json` 永不更新、不删除；更正行通过 `corrects_event_id` 指向原行，统计时原行退出有效视图但仍可审计。
- **幂等上报**：`(org_code, source_sequence)` 唯一，重复投递返回 `duplicate`，不增加人次。
- **年度归属**：按发生时间字符串中的墙钟年份（带偏移量），避免 UTC 归一化造成跨年错位；`received_at` 构成数据水位。
- **冻结发布**：发布时冻结指标、**规则定义快照**、数据水位和**全部机构的贡献清单**；之后的迟到/更正不影响已发布版本，只能生成 `revision`，附逐项差异、补报/更正计数和机构水位变化。
- **权限隔离**：`city` / `district` / `ingest` 三种角色；区级用户被锁定在本区，无法查询他区个体、他区分组、他区机构水位或他区修订差异；规则管理与发布仅市级可用。
- **导出保护**：研究导出按申请维度计数，**任一分组去重人数低于阈值（默认 10）则整单拒绝（409）**；小格的维度描述只进内部审计，不随拒绝响应返回（存在性本身也是信号）。

## 指标口径

| 指标 | 含义 |
| --- | --- |
| `encounters`（人次） | 年度内有效事件行数；跨机构复诊重复计数 |
| `unique_residents`（去重人数） | 年度内该分组的不重复 `resident_token` 数 |
| `first_coverage`（首次覆盖） | 居民**历史最早一次**服务落在本年的人数；次年迟到的更早事件不回改已冻结版本 |
| `continuous_management`（连续管理） | 年龄组×质量标记（**跨服务类型**）下，年内 ≥2 次且相邻间隔 ≤180 天的居民数（阈值由规则版本定义） |

更正视图：截至统计水位已收到的更正行所指向的原行不参与计算；未到水位的更正不影响冻结版。

## HTTP 接口

所有业务接口需请求头 `X-API-Key`（演示密钥见迁移脚本，**生产必须更换**）。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | — | 健康检查 |
| POST | `/v1/events` | ingest | 上报一条事件（或迟到事实/更正），202 返回 `accepted`/`duplicate` |
| GET | `/v1/events` | 全部 | 列出可见事件（ingest 限本机构，district 限本区），支持 `period`、`org_code` |
| GET | `/v1/metrics/live` | city, district | 当前水位的实时指标，参数 `period`（必填）、`district`、`age_group`、`service_kind`、`quality_mark` |
| POST | `/v1/publications` | city | 冻结年度发布；同年再发自动成为修订版并附 `revision_diff` |
| GET | `/v1/publications` | city, district | 发布列表 |
| GET | `/v1/publications/:id` | city, district | 发布详情（区级只见全市汇总与本区） |
| POST | `/v1/exports/research` | city, district | 研究聚合导出，小格整单 409 |
| GET/POST | `/v1/rules`、`POST /v1/rules/:version/activate` | city | 规则版本管理 |

上报示例：

```json
{
  "resident_token": "sha256:9f2d2e0a56b34b1a7c44481cb27dd47be9d1ea1faf71fe0c0ec008b25ec333a1",
  "service_kind": "screening",
  "age_group": "child",
  "occurred_at": "2025-03-12T09:30:00+08:00",
  "source_sequence": 0,
  "quality_mark": "normal"
}
```

更正时在新事实上附加 `corrects_event_id` 与 `correction_reason`，`source_sequence` 继续递增。

每个发布数字都自带溯源三要素：`rule_version` + `definitions_frozen`（哪版口径）、`manifest`（哪些机构、各自事件数与水位）、`as_of_received_at`（数据水位）。

## 本地开发

运行 `make migrate` 初始化数据文件，`make test` 执行自动化检查（10 个端到端用例），`make run` 启动服务。也可以使用 `docker compose up --build` 在隔离容器中运行，宿主机端口由 `APP_PORT` 调整。`PORT` 指定监听端口，`DATABASE_PATH` 指定数据文件；`fixtures/example.json` 提供不含真实身份的本地示例，`contracts/entities.json` 记录字段约定。
