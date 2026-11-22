import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { kstDate, kstIso } from "../server/slots.mjs";

assert.ok(process.env.BIROSO_OWN_E2E === "1" && process.env.PGHOST === "api-db" && process.env.PGDATABASE === "crm_api", "격리 Compose 스택에서만 실행한다.");
const { provision } = await import("/app/auth.mjs");
const { Pool } = createRequire("/app/package.json")("pg");
const base = "http://127.0.0.1:8788";
const dateIn = (days) => kstDate(new Date(Date.now() + days * 86400_000));

async function fixture(db, websiteToken, sealToken) {
  await provision(db, "biroso", { role: "website", secret: websiteToken });
  await provision(db, "biroso", { role: "sealer", secret: sealToken });
  const doctorId = await provision(db, "biroso", {
    role: "clinician", email: "doctor@example.test", name: { firstName: "합성" }, secret: randomBytes(24).toString("hex"),
  });
  const bookingDate = Array.from({ length: 7 }, (_, index) => dateIn(index + 2)).find((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1);
  const closure = dateIn(1);
  const scheduledAt = kstIso(bookingDate, "10:30");
  await db.query(`INSERT INTO biroso.closures(name,date) VALUES ('합성 휴진',$1)`, [closure]);
  await db.query(`INSERT INTO biroso."popupNotices"(name,"popupStatus",body) VALUES ('합성 공지','ON','격리 시험'), ('게시 안 함','OFF','숨김')`);
  const customerId = (await db.query(`INSERT INTO biroso.people(name) VALUES ('{"firstName":"합성"}') RETURNING id`)).rows[0].id;
  const appointmentId = (await db.query(`INSERT INTO biroso.appointments(name,"customerId","appointmentStatus","scheduledAt")
    VALUES ('합성 예약',$1,'REQUESTED',$2) RETURNING id`, [customerId, scheduledAt])).rows[0].id;
  const id = randomUUID(), now = new Date().toISOString();
  const chart = { id, name: "합성 차트", customerId, appointmentId, doctorId, visitAt: now, signedAt: now, recordStatus: "SIGNED",
    chiefComplaint: "합성 증상", diagnosis: "합성 진단", treatment: "합성 치료", chainId: id, version: 1 };
  chart.contentHash = (await db.query("SELECT biroso.chart_hash($1) AS hash", [chart])).rows[0].hash;
  await db.query("SELECT biroso.import_signed_chart($1)", [chart]);
  return { bookingDate, closure, chartId: id };
}

async function waitForSite(child) {
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) {
    if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) }).catch(() => null))?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("비로소 API가 기동하지 않았다.");
}

test("비로소 실제 프로세스 → 자체 CRM → PostgreSQL: 공지, 휴진·찬 예약 칸, 진료기록 봉인과 검증", { timeout: 25_000 }, async () => {
  const db = new Pool();
  const websiteToken = randomBytes(32).toString("base64url"), sealToken = randomBytes(32).toString("base64url");
  const cron = randomBytes(32).toString("base64url");
  const dir = await mkdtemp(join(tmpdir(), "biroso-own-"));
  let legacyCalls = 0, webhookCalls = 0;
  const fake = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/webhook") {
      webhookCalls++;
      req.resume();
      res.writeHead(204).end();
    } else {
      legacyCalls++;
      res.writeHead(503).end();
    }
  }).listen(0, "127.0.0.1");
  let child;
  try {
    await once(fake, "listening");
    const { bookingDate, closure, chartId } = await fixture(db, websiteToken, sealToken);
    const sink = `http://127.0.0.1:${fake.address().port}`;
    child = spawn(process.execPath, ["/biroso/server/server.mjs"], { cwd: "/biroso", stdio: ["ignore", "ignore", "inherit"], env: {
      CRM_BACKEND: "own", CRM_API_URL: "http://api:3300", CRM_API_TOKEN: websiteToken, CRM_API_SEAL_TOKEN: sealToken,
      TWENTY_URL: sink, SITE_URL: base, CRON_SECRET: cron, CHART_LEDGER_PATH: join(dir, "ledger.jsonl"),
      CHART_LEDGER_KEY: randomBytes(32).toString("hex"), CHART_ALERT_WEBHOOK_URL: `${sink}/webhook`,
    } });
    await waitForSite(child);
    const call = async (path, authorize = false) => {
      const r = await fetch(`${base}/api/v1/${path}`, { headers: authorize ? { Authorization: `Bearer ${cron}` } : {} });
      assert.equal(r.status, 200, path);
      return r.json();
    };
    assert.deepEqual((await call("popups")).popups.map(({ title }) => title), ["합성 공지"]);
    assert.deepEqual((await call("closures")).closures, [closure]);
    const { slots } = await call(`slots?date=${bookingDate}`);
    assert.equal(slots.find(({ time }) => time === "10:30")?.available, false);
    assert.equal(slots.find(({ time }) => time === "11:00")?.available, true);
    assert.deepEqual((await call(`slots?date=${closure}`)).slots, []);
    assert.deepEqual(await call("charts/seal", true), { sealed: 1, suspect: 0, problems: [] });
    assert.deepEqual(await call("charts/seal", true), { sealed: 0, suspect: 0, problems: [] });
    const verify = await call("charts/verify", true);
    assert.equal(verify.ok, true);
    assert.equal(verify.entries, 1);
    assert.equal(webhookCalls, 1);
    assert.equal(legacyCalls, 0);
    const ledger = await readFile(join(dir, "ledger.jsonl"), "utf8");
    assert.equal(ledger.includes("합성 증상"), false);
    const { rows } = await db.query(`SELECT "sealNo", "sealedAt" IS NOT NULL AS sealed FROM biroso."medicalRecords" WHERE id=$1`, [chartId]);
    assert.deepEqual(rows, [{ sealNo: "1", sealed: true }]);
  } finally {
    if (child?.exitCode === null) { child.kill(); await once(child, "exit"); }
    await new Promise((resolve) => fake.close(resolve));
    await db.end();
    // 매 실행이 만든 임시 장부 경로만 제거한다.
    await rm(dir, { recursive: true, force: true });
  }
});
