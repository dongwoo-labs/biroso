import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { loadConfig } from "../server/config.mjs";
import { createHandler } from "../server/handler.mjs";
import { createOwnBusiness, createOwnSealer, createOwnWebsite } from "../server/own-crm.mjs";

const fixture = {
  CRM_BACKEND: "own", CRM_API_URL: "http://crm.test.invalid/", CRM_API_TOKEN: "site-fixture",
  CRM_API_SEAL_TOKEN: "sealer-fixture", SITE_URL: "http://site.test.invalid", ADMIN_SECRET: "admin-fixture", CRON_SECRET: "cron-fixture",
};

async function serve(fn, run) {
  const server = createServer(fn).listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("Twenty가 기본이고, 자체 CRM은 URL과 서로 다른 홈페이지·봉인 토큰이 모두 필요하다", () => {
  assert.equal(loadConfig({}).crmBackend, "twenty");
  assert.equal(loadConfig({ CRM_API_URL: fixture.CRM_API_URL }).crmBackend, "twenty");
  assert.throws(() => loadConfig({ CRM_BACKEND: "onw" }), /CRM_BACKEND/);
  assert.throws(() => loadConfig({ ...fixture, CRM_API_URL: "https://user@example.test/?query=1" }), /CRM_API_URL/);
  assert.throws(() => loadConfig({ ...fixture, CRM_API_TOKEN: "" }), /CRM_API_TOKEN/);
  assert.throws(() => loadConfig({ ...fixture, CRM_API_SEAL_TOKEN: "" }), /CRM_API_SEAL_TOKEN/);
  assert.throws(() => loadConfig({ ...fixture, CRM_API_SEAL_TOKEN: fixture.CRM_API_TOKEN }), /CRM_API_SEAL_TOKEN/);
});

test("자체 CRM의 회사 경로와 홈페이지·봉인 토큰을 분리한다", async () => {
  const calls = [];
  const fetchImpl = async (raw, { method, headers, redirect, body }) => {
    const url = new URL(raw);
    const object = url.pathname.split("/")[5];
    assert.equal(headers.Authorization === `Bearer ${object === "medicalRecords" ? fixture.CRM_API_SEAL_TOKEN : fixture.CRM_API_TOKEN}`, true);
    assert.equal(redirect, "error");
    calls.push([method, url.pathname, url.searchParams.get("starting_after"), body]);
    if (method === "PATCH") return Response.json({ data: {} });
    if (object !== "closures") return Response.json({ data: { [object]: [] } });
    return Response.json(url.searchParams.has("starting_after")
      ? { data: { closures: [{ date: "2026-11-24" }] } }
      : { data: { closures: [{ date: "2026-11-23" }] }, pageInfo: { hasNextPage: true, endCursor: "fixture-cursor" } });
  };
  const { ownCrm } = loadConfig(fixture);
  assert.deepEqual(await createOwnWebsite(ownCrm, fetchImpl).closures("2026-11-23", "2026-11-24"), ["2026-11-23", "2026-11-24"]);
  const sealer = createOwnSealer(ownCrm, fetchImpl);
  await sealer.listSignedCharts();
  await sealer.updateChart("fixture-id", { sealNo: 1, sealedAt: "2026-11-23T00:00:00Z" });
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ["GET", "/api/v1/biroso/rest/closures", null],
    ["GET", "/api/v1/biroso/rest/closures", "fixture-cursor"],
    ["GET", "/api/v1/biroso/rest/medicalRecords", null],
    ["PATCH", "/api/v1/biroso/rest/medicalRecords/fixture-id", null],
  ]);
  assert.deepEqual(JSON.parse(calls.at(-1)[3]), { sealNo: 1, sealedAt: "2026-11-23T00:00:00Z" });
});

test("자체 CRM 조회 실패에서 Twenty로 넘어가지 않고 오류 본문은 기록하지 않는다", async () => {
  const urls = [], logs = [];
  const cfg = loadConfig({ ...fixture, TWENTY_URL: "http://twenty.test.invalid" });
  const crmFetch = async (url) => { urls.push(url); return new Response("never-log-fixture-body", { status: 403 }); };
  await serve(createHandler(cfg, { crmFetch, log: (o) => logs.push(o) }), async (base) => {
    for (const suffix of ["popups", "closures"]) {
      const r = await fetch(`${base}/api/v1/${suffix}`);
      assert.equal(r.status, 502);
      assert.equal((await r.json()).error, "upstream");
    }
  });
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith("http://crm.test.invalid/api/v1/biroso/rest/")));
  assert.ok(logs.every(({ error }) => error === "Own CRM 403"));
});

test("업무 명령 응답 유실은 같은 키와 바이트로 CRM만 재호출하고 재생은 PG를 열지 않는다", async () => {
  const calls = [];
  const { ownCrm } = loadConfig(fixture);
  const client = createOwnBusiness(ownCrm, async (url, options) => {
    calls.push([new URL(url).pathname, options.headers["Idempotency-Key"], options.body]);
    if (calls.length === 1) throw new Error("lost response");
    return Response.json({ data: { executePg: true }, replayed: true });
  });
  assert.deepEqual(await client.command("orders/fixture/payment/start", "same-key", { tid: "fixture", amount: 100 }), { executePg: false });
  assert.deepEqual(calls, Array(2).fill(["/api/v1/biroso/commands/orders/fixture/payment/start", "same-key", '{"tid":"fixture","amount":100}']));
});

test("같은 키로 다른 본문을 보낸 명령의 충돌은 재시도하지 않고 원문을 노출하지 않는다", async () => {
  let calls = 0;
  const { ownCrm } = loadConfig(fixture);
  const client = createOwnBusiness(ownCrm, async () => {
    calls++;
    return Response.json({ code: "idempotency_conflict", error: "fixture private text" }, { status: 409 });
  });
  await assert.rejects(client.command("orders", "fixture-key", {}), { status: 409, code: "idempotency_conflict", message: "Own CRM 409" });
  assert.equal(calls, 1);
});

test("보유기간 파기는 별도 토큰으로 업무 명령 하나만 호출한다", async () => {
  const bindings = [];
  const env = { ...fixture, CRM_API_PURGE_TOKEN: "purge-fixture" };
  const { ownCrm } = loadConfig(env);
  const client = createOwnBusiness(ownCrm, async (url, options) => {
    assert.equal(options.headers.Authorization === `Bearer ${env.CRM_API_PURGE_TOKEN}`, true);
    assert.match(options.headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);
    bindings.push([new URL(url).pathname, options.method, JSON.parse(options.body)]);
    return Response.json({ data: { counts: { orders: 1, chats: 0 } }, replayed: false });
  });
  assert.deepEqual(await client.purgeRetention({ pendingOrderHours: 24, chatRetentionDays: 0 }), { orders: 1, chats: 0 });
  assert.deepEqual(bindings, [["/api/v1/biroso/commands/purge/retention", "POST", { pendingOrderHours: 24, chatRetentionDays: 0 }]]);
  assert.throws(() => loadConfig({ ...env, CRM_API_PURGE_TOKEN: fixture.CRM_API_TOKEN }), /CRM_API_PURGE_TOKEN/);
});

test("자체 여정 조회 오류는 빈 목록으로 바꾸지 않고, 고유 키 중복만 건너뛴다", async () => {
  const { ownCrm } = loadConfig(fixture);
  const client = createOwnBusiness(ownCrm, async (url, { method }) => {
    const { pathname, searchParams } = new URL(url);
    const object = pathname.split("/").at(-1);
    if (method === "GET") {
      assert.equal(searchParams.get("order_by"), "id[AscNullsLast]");
      return object === "counselThreads" ? new Response(null, { status: 403 }) : Response.json({ data: { [object]: [] } });
    }
    return Response.json({ error: object === "messages" ? "Duplicate record violates a unique constraint" : "Record conflicts with existing state" }, { status: 409 });
  });
  await assert.rejects(client.journeyData(), { status: 403 });
  assert.equal(await client.createMessage({}), false);
  await assert.rejects(client.createCounselMessage({}), { status: 409 });
});

test("합성 자체 어댑터 주입 시 상담과 파기 HTTP 경로가 전용 명령을 호출한다", async () => {
  const cfg = loadConfig({ ...fixture, MIN_FILL_MS: "0" });
  const calls = [];
  const ownBusiness = createOwnBusiness({ ...cfg.ownCrm, purgeToken: "purge-fixture" }, async (url, options) => {
    const path = new URL(url).pathname;
    calls.push([path, options.method]);
    const data = path.endsWith("/consults") ? { consultId: "fixture-id", personId: "fixture-person" } : { counts: { orders: 1 } };
    return Response.json({ data, replayed: false });
  });
  await serve(createHandler(cfg, { ownBusiness, log: () => {} }), async (base) => {
    const r = await fetch(`${base}/api/v1/consults`, { method: "POST", body: JSON.stringify({
      name: "합성 고객", phone: "010-1234-5678", noticeVersion: cfg.noticeVersions[0], consents: { privacy: true }, formOpenedAt: Date.now() - 1000,
    }) });
    assert.equal(r.status, 201);
    assert.equal((await fetch(`${base}/api/v1/purge`)).status, 401);
    const retention = await fetch(`${base}/api/v1/purge`, { headers: { Authorization: `Bearer ${fixture.CRON_SECRET}` } });
    assert.equal(retention.status, 200);
    assert.deepEqual(await retention.json(), { orders: 1 });
  });
  assert.deepEqual(calls, [["/api/v1/biroso/commands/consults", "POST"], ["/api/v1/biroso/commands/purge/retention", "POST"]]);
});

test("자체 CRM 업무 명령이 없는 초안은 PG 및 CRM 호출 전에 막는다", async () => {
  const cfg = loadConfig({ ...fixture, NICEPAY_CLIENT_ID: "S1_fixture" });
  let calls = 0;
  const unexpected = () => { calls++; throw new Error("No CRM or payment call is allowed"); };
  await serve(createHandler(cfg, { crmFetch: unexpected, nicepay: { verify: unexpected, approve: unexpected, cancel: unexpected, netCancel: unexpected } }), async (base) => {
    assert.equal((await (await fetch(`${base}/healthz`)).json()).payment, false);
    for (const suffix of ["orders", "appointments", "consults", "orders/refund"]) {
      const headers = suffix === "orders/refund" ? { Authorization: `Bearer ${fixture.ADMIN_SECRET}` } : {};
      const r = await fetch(`${base}/api/v1/${suffix}`, { method: "POST", headers, body: "{}" });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, "crm_unavailable");
    }
    for (const suffix of ["purge", "journeys"]) {
      const r = await fetch(`${base}/api/v1/${suffix}`, { headers: { Authorization: `Bearer ${fixture.CRON_SECRET}` } });
      assert.equal(r.status, 503);
    }
    const payment = await fetch(`${base}/api/v1/payments/return`, { method: "POST", redirect: "manual", body: "authResultCode=0000" });
    assert.equal(payment.status, 303);
    assert.equal(new URL(payment.headers.get("location")).pathname, "/order/fail/");
  });
  assert.equal(calls, 0);
});
