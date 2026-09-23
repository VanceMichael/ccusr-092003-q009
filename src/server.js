"use strict";

const http = require("node:http");
const { openDatabase } = require("./db");
const { authenticate } = require("./auth");
const { submitEvent, ValidationError } = require("./ingest");
const { createRuleVersion, createClient } = require("./admin");
const {
  createPublication,
  createRevision,
  getPublication,
  getRevisionIndicators,
} = require("./publications");
const { liveQuery, researchExport } = require("./query");

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) {
      throw Object.assign(new Error("请求体超过 1 MiB 限制"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400 });
  }
}

function createServer(database) {
  const db = database || openDatabase();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname;

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      // 除健康检查外全部需要凭据
      const client = authenticate(db, request);
      if (!client) {
        sendJson(response, 401, { error: "unauthorized", message: "缺少或无效的 Bearer 凭据" });
        return;
      }

      // ---------- 机构上报 ----------
      if (request.method === "POST" && path === "/v1/events") {
        const body = await readJsonBody(request);
        const result = submitEvent(db, client, body);
        sendJson(response, 202, result);
        return;
      }

      // ---------- 管理：规则版本与客户端 ----------
      if (request.method === "POST" && path === "/v1/admin/rule-versions") {
        if (client.role !== "admin") {
          sendJson(response, 403, { error: "forbidden", message: "仅管理员可登记规则版本" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 201, createRuleVersion(db, body));
        return;
      }

      if (request.method === "POST" && path === "/v1/admin/clients") {
        if (client.role !== "admin") {
          sendJson(response, 403, { error: "forbidden", message: "仅管理员可登记客户端" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 201, createClient(db, body));
        return;
      }

      // ---------- 年度冻结发布与修订 ----------
      if (request.method === "POST" && path === "/v1/publications") {
        if (client.role !== "admin") {
          sendJson(response, 403, { error: "forbidden", message: "仅管理员可冻结年度发布" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 201, createPublication(db, client, body));
        return;
      }

      if (request.method === "POST" && /^\/v1\/publications\/[^/]+\/revisions$/.test(path)) {
        if (client.role !== "admin") {
          sendJson(response, 403, { error: "forbidden", message: "仅管理员可生成修订版" });
          return;
        }
        const code = decodeURIComponent(path.split("/")[3]);
        const body = await readJsonBody(request);
        sendJson(response, 201, createRevision(db, client, { ...body, publication_code: code }));
        return;
      }

      if (request.method === "GET" && /^\/v1\/publications\/[^/]+$/.test(path)) {
        if (!["city", "research", "admin", "district"].includes(client.role)) {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        const code = decodeURIComponent(path.split("/")[3]);
        sendJson(response, 200, getPublication(db, code));
        return;
      }

      if (request.method === "GET" && /^\/v1\/publications\/[^/]+\/indicators$/.test(path)) {
        if (!["city", "research", "admin", "district"].includes(client.role)) {
          sendJson(response, 403, { error: "forbidden" });
          return;
        }
        const code = decodeURIComponent(path.split("/")[3]);
        const revisionNo = url.searchParams.has("revision_no")
          ? Number(url.searchParams.get("revision_no"))
          : null;
        sendJson(response, 200, getRevisionIndicators(db, code, revisionNo));
        return;
      }

      // ---------- 实时聚合 ----------
      if (request.method === "GET" && path === "/v1/metrics") {
        if (client.role !== "district" && client.role !== "city") {
          sendJson(response, 403, {
            error: "forbidden",
            message: "实时聚合仅向区级与市级开放；研究导出请使用 /v1/research/export",
          });
          return;
        }
        // district 角色的作用域在查询层强制为本区，无法借参数串查他区
        sendJson(response, 200, liveQuery(db, client, url.searchParams));
        return;
      }

      if (request.method === "GET" && path === "/v1/research/export") {
        if (client.role !== "research" && client.role !== "city") {
          sendJson(response, 403, { error: "forbidden", message: "该端点仅向研究与市级角色开放" });
          return;
        }
        try {
          sendJson(response, 200, researchExport(db, client, url.searchParams));
        } catch (error) {
          if (error.statusCode === 422) {
            sendJson(response, 422, error.payload);
            return;
          }
          throw error;
        }
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ValidationError || error.statusCode) {
        sendJson(response, error.statusCode || 400, {
          error: error.field ? "validation_error" : "request_error",
          field: error.field,
          message: error.message,
          details: error.errors,
        });
        return;
      }
      // 触发器拦截（只追加/冻结保护）：返回 409，不外泄堆栈
      if (String(error.message).includes("RAISE(ABORT)") || /禁止|不可/.test(error.message)) {
        sendJson(response, 409, { error: "immutability_violation", message: error.message });
        return;
      }
      // eslint-disable-next-line no-console
      console.error(error);
      sendJson(response, 500, { error: "internal_error" });
    }
  });

  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  const server = createServer();
  server.listen(port, "0.0.0.0");
  // eslint-disable-next-line no-console
  console.log(`服务监听 0.0.0.0:${port}`);
}

module.exports = { createServer };
