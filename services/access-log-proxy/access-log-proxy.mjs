// Twenty 앞단 접속기록 프록시 (의존성 없음, Node 20+)
//
// 개인정보의 안전성 확보조치 기준 제8조의 접속기록 항목을 남긴다:
//   계정(누가) · 접속일시 · 접속지(IP) · 처리한 정보주체(레코드 ID) · 수행업무(조회/수정/삭제/내보내기)
// 한 줄에 JSON 하나씩 stdout 또는 LOG_FILE로 쓰고, Loki·OpenSearch 등 별도 저장소로 수집한다.
//
// 환경변수
//   UPSTREAM   Twenty 서버 주소 (기본 http://127.0.0.1:3000)
//   PORT       프록시 포트 (기본 3100). Twenty의 SERVER_URL은 이 프록시의 공개 주소여야 한다.
//   LOG_FILE   지정하면 파일에 추가 기록 (미지정 시 stdout)
//   TRUST_XFF  앞에 Caddy 같은 리버스 프록시가 있을 때 1 (X-Forwarded-For 첫 값을 IP로 사용)

import http from "node:http";
import fs from "node:fs";

const UPSTREAM = new URL(process.env.UPSTREAM || "http://127.0.0.1:3000");
const PORT = Number(process.env.PORT || 3100);
const TRUST_XFF = process.env.TRUST_XFF === "1";
const out = process.env.LOG_FILE ? fs.createWriteStream(process.env.LOG_FILE, { flags: "a" }) : process.stdout;
const MAX_BODY = 20 * 1024 * 1024;
const MAX_IDS = 500;

// 세션 쿠키 → 사용자. Twenty의 currentUser를 같은 쿠키로 물어 5분간 캐시한다.
const sessionCache = new Map();

function upstreamJson(path, headers, body) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: UPSTREAM.hostname, port: UPSTREAM.port, path, method: "POST", headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body), "accept-encoding": "identity" } },
      (res) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } }); },
    );
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); } catch { return null; }
}

async function whoIs(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const p = decodeJwt(auth.slice(7));
    if (p?.type === "API_KEY") return { kind: "api_key", id: p.jti, workspace: p.workspaceId };
    if (p) return { kind: "user", id: p.sub, workspace: p.workspaceId };
  }
  const m = /twenty-session=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return { kind: "anonymous" };
  const hit = sessionCache.get(m[1]);
  if (hit && hit.exp > Date.now()) return hit.who;
  const r = await upstreamJson("/metadata", { cookie: req.headers.cookie, host: req.headers.host, origin: req.headers.origin || `http://${req.headers.host}` },
    JSON.stringify({ query: "{currentUser{id email}}" }));
  const u = r?.data?.currentUser;
  const who = u ? { kind: "user", id: u.id, email: u.email } : { kind: "session_unresolved" };
  sessionCache.set(m[1], { who, exp: Date.now() + 5 * 60 * 1000 });
  return who;
}

// 응답 JSON에서 레코드 ID를 모은다. { id: "uuid", ... } 형태의 객체를 레코드로 본다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function collectIds(node, acc) {
  if (acc.size >= MAX_IDS || node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) collectIds(n, acc); return; }
  if (typeof node.id === "string" && UUID.test(node.id)) acc.add(node.id);
  for (const v of Object.values(node)) if (v && typeof v === "object") collectIds(v, acc);
}

// 요청에 들어 있는 UUID(수정·삭제 대상 레코드 ID)만 모은다. 이름·전화번호 같은 값은 기록하지 않는다.
function collectUuidStrings(node, acc) {
  if (acc.size >= MAX_IDS || node == null) return;
  if (typeof node === "string") { if (UUID.test(node)) acc.add(node); return; }
  if (typeof node === "object") for (const v of Object.values(node)) collectUuidStrings(v, acc);
}

function classify(method, path, gqlBody) {
  if (path.startsWith("/rest/")) {
    const object = path.split("?")[0].split("/")[2];
    const action = { GET: "read", POST: "create", PATCH: "update", PUT: "update", DELETE: "delete" }[method] || method;
    return { api: "rest", object, action };
  }
  // 주석(#...)을 지우고 본다. 앞에 주석을 붙여 변경 작업을 조회로 보이게 하는 것을 막는다.
  const q = String(gqlBody?.query || "").replace(/#[^\n\r]*/g, "");
  const op = gqlBody?.operationName || /(?:query|mutation)\s+(\w+)/.exec(q)?.[1] || null;
  let action = /^\s*mutation/.test(q) ? "write" : "read";
  if (/export/i.test(op || "")) action = "export";
  if (/delete|destroy/i.test(op || "")) action = "delete";
  return { api: "graphql", operation: op, action };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const reqBody = Buffer.concat(chunks);
    const path = req.url || "/";
    const audited = path.startsWith("/graphql") || path.startsWith("/rest/");
    // Host는 그대로 넘긴다. Twenty가 Origin과 Host를 대조해 세션 쿠키를 발급하기 때문이다.
    const headers = { ...req.headers, "x-forwarded-host": req.headers.host };
    if (audited) headers["accept-encoding"] = "identity";

    const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port, path, method: req.method, headers }, (upRes) => {
      const ct = upRes.headers["content-type"] || "";
      if (!audited || !ct.includes("json")) {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        return;
      }
      const resChunks = []; let size = 0;
      upRes.on("data", (c) => { size += c.length; if (size <= MAX_BODY) resChunks.push(c); res.write(c); });
      upRes.on("end", async () => {
        res.end();
        let gqlBody = null, resJson = null;
        try { gqlBody = reqBody.length ? JSON.parse(reqBody) : null; } catch {}
        try { resJson = size <= MAX_BODY ? JSON.parse(Buffer.concat(resChunks)) : null; } catch {}
        const kind = classify(req.method, path, gqlBody);
        const ids = new Set(); collectIds(resJson?.data, ids);
        // 변수·쿼리스트링에는 고객 이름, 전화번호, 검색어가 들어갈 수 있어 값은 남기지 않는다.
        // 접속기록은 파기 대상 밖에서 1년 이상 보관되므로 레코드 ID와 항목 이름만 남긴다.
        const vars = kind.api === "graphql" && gqlBody?.variables && typeof gqlBody.variables === "object" ? gqlBody.variables : null;
        const targets = new Set(); collectUuidStrings(vars, targets);
        const qs = path.includes("?") ? new URLSearchParams(path.slice(path.indexOf("?") + 1)) : null;
        const ip = (TRUST_XFF && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;
        const entry = {
          ts: new Date().toISOString(), ip, who: await whoIs(req), method: req.method,
          path: path.split("?")[0], query_params: qs ? [...new Set(qs.keys())] : undefined,
          ...kind, status: upRes.statusCode, record_count: ids.size, record_ids: [...ids],
          target_ids: targets.size ? [...targets] : undefined, variable_keys: vars ? Object.keys(vars) : undefined,
          user_agent: req.headers["user-agent"],
        };
        out.write(JSON.stringify(entry) + "\n");
      });
      res.writeHead(upRes.statusCode, upRes.headers);
    });
    up.on("error", (e) => { res.writeHead(502); res.end("upstream error"); out.write(JSON.stringify({ ts: new Date().toISOString(), error: e.message, path: path.split("?")[0] }) + "\n"); });
    up.end(reqBody);
  });
});

// 웹소켓(실시간 구독)은 그대로 터널링한다
server.on("upgrade", (req, socket, head) => {
  const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: req.url, method: req.method, headers: req.headers });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  up.on("error", () => socket.destroy());
  up.end(head);
});

server.listen(PORT, () => console.error(`access-log-proxy :${PORT} -> ${UPSTREAM.origin}`));
