import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { loadConfig } from "../server/config.mjs";
import { createHandler } from "../server/handler.mjs";
import { createOwnSealer, createOwnWebsite } from "../server/own-crm.mjs";

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
