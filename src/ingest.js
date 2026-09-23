"use strict";

const { parseIsoOffset } = require("./time");
const { residentDigest } = require("./crypto_util");
const { withTransaction } = require("./db");
const { nowIso } = require("./clock");

const AGE_GROUPS = new Set(["child", "adolescent", "adult", "senior"]);
const SERVICE_KINDS = new Set(["screening", "guidance", "intervention"]);
const QUALITY_FLAGS = new Set(["ok", "provisional", "invalid"]);
const FACT_ACTIONS = new Set(["report", "correction", "retraction"]);

const DAY_SECONDS = 86400;

class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
    this.statusCode = 400;
  }
}

// 仅校验并整理字段，机构与区由凭据决定，绝不采信请求体自报身份
function validateEventPayload(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("body", "请求体必须为 JSON 对象");
  }
  const errors = [];
  const requireString = (field, maxLength = 128) => {
    const value = body[field];
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
      errors.push(`${field} 必须为非空字符串（最长 ${maxLength}）`);
    }
    return value;
  };

  const token = requireString("resident_token", 256);
  const serviceKind = body.service_kind;
  if (!SERVICE_KINDS.has(serviceKind)) errors.push("service_kind 取值非法");
  const ageGroup = body.age_group;
  if (!AGE_GROUPS.has(ageGroup)) errors.push("age_group 取值非法");
  const qualityFlag = body.quality_flag === undefined ? "ok" : body.quality_flag;
  if (!QUALITY_FLAGS.has(qualityFlag)) errors.push("quality_flag 取值非法");
  const factAction = body.fact_action === undefined ? "report" : body.fact_action;
  if (!FACT_ACTIONS.has(factAction)) errors.push("fact_action 取值非法");

  const occurredAt = body.occurred_at;
  let epoch = null;
  if (typeof occurredAt !== "string" || (epoch = parseIsoOffset(occurredAt)) === null) {
    errors.push("occurred_at 必须为带偏移量的 ISO 8601 时间");
  } else if (epoch > Date.now() / 1000 + DAY_SECONDS) {
    errors.push("occurred_at 不能晚于当前时间一天以上");
  }

  const sequence = body.source_sequence;
  if (!Number.isInteger(sequence) || sequence < 0) {
    errors.push("source_sequence 必须为非负整数");
  }
  const idempotencyKey = requireString("idempotency_key");

  let targetEventId = null;
  if (factAction === "correction" || factAction === "retraction") {
    targetEventId = body.target_event_id;
    if (!Number.isInteger(targetEventId) || targetEventId <= 0) {
      errors.push("correction/retraction 必须提供有效的 target_event_id");
      targetEventId = null;
    }
  }
  if (factAction === "report" && body.target_event_id !== undefined) {
    errors.push("report 不允许携带 target_event_id");
  }

  if (errors.length > 0) {
    const error = new ValidationError(null, errors.join("；"));
    error.errors = errors;
    throw error;
  }
  return {
    token,
    serviceKind,
    ageGroup,
    qualityFlag,
    factAction,
    occurredAt,
    epoch,
    sequence,
    idempotencyKey,
    targetEventId,
  };
}

function submitEvent(database, client, body) {
  if (client.role !== "facility") {
    throw Object.assign(new Error("仅机构凭据可上报服务事实"), { statusCode: 403 });
  }
  const payload = validateEventPayload(body);

  if (payload.targetEventId !== null) {
    const target = database
      .prepare("SELECT id, facility_id, fact_action FROM service_events WHERE id = ?")
      .get(payload.targetEventId);
    if (!target) throw new ValidationError("target_event_id", "目标事件不存在");
    if (target.facility_id !== client.facility_id) {
      // 不允许借更正触碰他机构事实
      throw Object.assign(new Error("不能更正或撤回他机构事件"), { statusCode: 403 });
    }
    if (target.fact_action !== "report") {
      throw new ValidationError("target_event_id", "更正/撤回必须指向原始 report 事件");
    }
  }

  const hash = residentDigest(payload.token);
  const receivedAt = nowIso();
  const insert = database.prepare(
    `INSERT INTO service_events
       (resident_ref_hash, district_code, facility_id, service_kind, age_group,
        occurred_at, occurred_at_epoch, quality_flag, fact_action, target_event_id,
        source_sequence, idempotency_key, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  try {
    const result = withTransaction(database, () =>
      insert.run(
        hash,
        client.district_code,
        client.facility_id,
        payload.serviceKind,
        payload.ageGroup,
        payload.occurredAt,
        payload.epoch,
        payload.qualityFlag,
        payload.factAction,
        payload.targetEventId,
        payload.sequence,
        payload.idempotencyKey,
        receivedAt
      )
    );
    return {
      status: "accepted",
      event_id: Number(result.lastInsertRowid),
      fact_action: payload.factAction,
    };
  } catch (error) {
    // 幂等重放：返回原事件编号，不产生新事实
    if (String(error.message).includes("UNIQUE constraint failed")) {
      const existing = database
        .prepare(
          `SELECT id, fact_action FROM service_events
           WHERE facility_id = ? AND idempotency_key = ?`
        )
        .get(client.facility_id, payload.idempotencyKey);
      return {
        status: "duplicate",
        event_id: existing.id,
        fact_action: existing.fact_action,
      };
    }
    throw error;
  }
}

module.exports = {
  AGE_GROUPS,
  SERVICE_KINDS,
  QUALITY_FLAGS,
  ValidationError,
  validateEventPayload,
  submitEvent,
};
