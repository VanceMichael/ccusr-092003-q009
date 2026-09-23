"use strict";

// 严格解析带偏移量的 ISO 8601 时间，返回 Unix 秒（浮点）。
// 拒绝无时区、非法日期（如 2 月 30 日）等简写形式。
const ISO_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function parseIsoOffset(value) {
  if (typeof value !== "string") return null;
  const match = ISO_OFFSET.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "0", frac = "0", sign, oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const fractionMs = Math.round(Number(`0.${frac}`) * 1000);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, fractionMs);
  const constructed = new Date(utcMs);
  // 通过 UTC 分量回查，拦截 2025-02-30 这类进位日期
  if (
    constructed.getUTCFullYear() !== year ||
    constructed.getUTCMonth() !== month - 1 ||
    constructed.getUTCDate() !== day ||
    constructed.getUTCHours() !== hour ||
    constructed.getUTCMinutes() !== minute ||
    constructed.getUTCSeconds() !== second
  ) {
    return null;
  }
  let epochMs = utcMs;
  if (sign) {
    const offsetSeconds = Number(oh) * 3600 + Number(om) * 60;
    if (Number(oh) > 23 || Number(om) > 59) return null;
    epochMs -= sign === "+" ? offsetSeconds * 1000 : -offsetSeconds * 1000;
  }
  return epochMs / 1000;
}

module.exports = { parseIsoOffset };
