# 分层口腔服务覆盖复算

三级口腔防治机构提交不可逆居民引用、年龄组、服务类型、发生时间和质量标记，平台在**不持有居民身份**的前提下分别计算人次、去重人数、首次覆盖与连续管理，并支持年度冻结发布与带差异说明的修订版。

## 为什么需要它

直接把“一百万人次”当作人数会把跨机构复诊重复计入，夸大儿童与老年人的实际服务范围。本平台：

- 只保存居民引用的 HMAC 摘要，不存原文；
- 跨机构复诊按摘要去重，2 人次可只算 1 人；
- 迟到数据与更正以**新事实**进入，触发器禁止改删原上报；
- 年度发布冻结规则版本、统计区间、数据水位与贡献机构；
- 补报只能形成带逐格差异说明的修订版，原版永久可查；
- 区级凭据强制限定本区，研究导出不足最小分组规模整体拒绝；
- 每个公开数字都可溯源到规则版本、水位与机构清单，却不能反向定位居民。

## 本地开发

```bash
make migrate     # 初始化/升级数据库文件（默认 ./data/app.sqlite3）
make bootstrap   # 登记首个规则版本与 admin 客户端，打印一次性密钥
make test        # 执行自动化测试（13 项，覆盖全部关键性质）
make run         # 启动 HTTP 服务（默认端口 8080）
```

也可使用 `docker compose up --build` 在隔离容器中运行，宿主机端口由 `APP_PORT` 调整；生产环境必须经环境注入 `RESIDENT_PEPPER`（平台侧哈希胡椒，默认值 `development-pepper` 仅供本地）。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口（默认 8080） |
| `DATABASE_PATH` | SQLite 数据文件位置 |
| `RESIDENT_PEPPER` | 居民引用二次摘要的 HMAC 胡椒，生产必须自定义并妥善保管 |
| `APP_CLOCK` | 固定当前时间（带偏移量 ISO 8601），仅用于测试/回放以模拟迟到与补报 |

## HTTP 接口

除 `GET /health` 外，所有接口都需要 `Authorization: Bearer <api_key>`。

### 机构上报

`POST /v1/events`（facility）

```json
{
  "resident_token": "TOKEN-...",
  "service_kind": "screening",
  "age_group": "child",
  "occurred_at": "2025-03-01T10:00:00+08:00",
  "quality_flag": "ok",
  "source_sequence": 1042,
  "idempotency_key": "fac-F1-2025-1042"
}
```

撤回/更正以新事实发送，另需 `"fact_action": "retraction"` 与 `"target_event_id": 12`（只能指向本机构原上报）。重放幂等键返回 202 且 `status:"duplicate"`。

### 聚合查询

`GET /v1/metrics?year=2025&group_by=age_group`（district / city / research）

- 支持 `group_by=age_group|service_kind|district_code`（可逗号组合，但需在规则版本允许清单内）；
- district 角色**自动强制**限定本区；
- 返回 provisional 实时值（带当前水位与作用域说明），未经冻结。

### 研究导出

`GET /v1/research/export?year=2025&group_by=age_group`（research / city）

任一分组去重人数低于阈值返回 `422 minimum_cell_size_violation`，响应只列被抑制的维度键，不列人数。

### 年度发布（admin）

- `POST /v1/admin/rule-versions` — 登记口径版本（可定 `first_visit_gap_days`、`continuity_window_days`、`min_cell_size` 等）；
- `POST /v1/admin/clients` — 登记客户端并签发一次性密钥；
- `POST /v1/publications` — 冻结年度（可指定 `watermark`）；同年度重复冻结 409；
- `POST /v1/publications/{code}/revisions` — 冻结后补报形成修订版（水位必须晚于父版），响应与库内均含逐格差异；
- `GET /v1/publications/{code}` — 发布元数据与各修订版溯源信息（规则版本、水位、差异摘要）；
- `GET /v1/publications/{code}/indicators?revision_no=0` — 读取指定修订版的物化指标，未指定则取最新版。

每个指标行附 `contributing_facilities` 与该版规则版本、水位，满足“数字可说明采用了哪版规则和哪些机构数据”。

## 安全边界

1. **不可逆**：库内无居民原文，仅 `HMAC-SHA256` 摘要；API 密钥同样只存 SHA-256 摘要。
2. **只追加**：`service_events` 的 UPDATE/DELETE 被触发器拒绝（测试覆盖）。
3. **冻结不可变**：发布头与指标行不可更新；修订水位只能前进。
4. **隔离**：district 作用域由凭据决定，不信请求体自报的区/机构。
5. **抑制**：小组拒绝响应不含具体人数，避免差分外泄。

## 项目结构

```
migrations/     SQL 表结构、视图与不可变触发器
src/db.js       迁移运行器与事务助手（node:sqlite）
src/ingest.js   上报校验、脱敏摘要、幂等、更正/撤回
src/metrics.js  四类指标与水位感知有效记录
src/publications.js 冻结发布、修订版与逐格差异
src/query.js    实时聚合、区级隔离、研究导出抑制
src/auth.js     Bearer 摘要认证与角色
src/admin.js    规则版本与客户端登记
test/           13 项 node:test 端到端测试
```
