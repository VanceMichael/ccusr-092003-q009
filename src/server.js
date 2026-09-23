
const http = require("node:http");
const { openAppDatabase } = require("./db");
const platform = require("./platform");

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new platform.HttpError(413, "payload_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new platform.HttpError(400, "invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function createServer(database) {
  const db = database || openAppDatabase(process.env.DATABASE_PATH);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://local");
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);

    try {
      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      // 除健康检查外，所有业务接口都要求密钥；角色由领域层进一步约束。
      const client = platform.authenticate(db, request.headers["x-api-key"]);

      if (request.method === "POST" && path === "/v1/events") {
        const body = await readJsonBody(request);
        sendJson(response, 202, platform.ingestEvent(db, client, body));
        return;
      }

      if (request.method === "GET" && path === "/v1/events") {
        sendJson(response, 200, {
          events: platform.listEvents(db, client, {
            period: query.period,
            orgCode: query.org_code,
          }),
        });
        return;
      }

      if (request.method === "GET" && path === "/v1/metrics/live") {
        sendJson(response, 200, platform.liveMetrics(db, client, query));
        return;
      }

      if (request.method === "GET" && path === "/v1/rules") {
        platform.requireRole(client, "city");
        sendJson(response, 200, { rule_versions: platform.listRuleVersions(db) });
        return;
      }

      if (request.method === "POST" && path === "/v1/rules") {
        platform.requireRole(client, "city");
        const body = await readJsonBody(request);
        sendJson(response, 201, platform.createRuleVersion(db, body));
        return;
      }

      const activateMatch = path.match(/^\/v1\/rules\/([^/]+)\/activate$/);
      if (request.method === "POST" && activateMatch) {
        platform.requireRole(client, "city");
        platform.activateRuleVersion(db, decodeURIComponent(activateMatch[1]));
        sendJson(response, 200, { status: "activated", version: decodeURIComponent(activateMatch[1]) });
        return;
      }

      if (request.method === "POST" && path === "/v1/publications") {
        const body = await readJsonBody(request);
        sendJson(response, 201, platform.createPublication(db, client, body));
        return;
      }

      if (request.method === "GET" && path === "/v1/publications") {
        sendJson(response, 200, {
          publications: platform.listPublications(db, client, query.period),
        });
        return;
      }

      const publicationMatch = path.match(/^\/v1\/publications\/([^/]+)$/);
      if (request.method === "GET" && publicationMatch) {
        sendJson(response, 200,
          platform.getPublication(db, client, decodeURIComponent(publicationMatch[1])));
        return;
      }

      if (request.method === "POST" && path === "/v1/exports/research") {
        const body = await readJsonBody(request);
        sendJson(response, 200, platform.researchExport(db, client, body));
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof platform.HttpError) {
        sendJson(response, error.status, { error: error.code, ...(error.details || {}) });
        return;
      }
      // 不向调用方回传内部细节
      // eslint-disable-next-line no-console
      console.error("unhandled error:", error);
      sendJson(response, 500, { error: "internal_error" });
    }
  });

  server.on("close", () => {
    if (!database) db.close();
  });

  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0");
}

module.exports = { createServer };
