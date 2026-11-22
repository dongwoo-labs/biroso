import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import notice from "../src/data/notice.json" with { type: "json" };
import { once } from "node:events";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { kstDate, kstIso } from "../server/slots.mjs";

assert.ok(process.env.BIROSO_OWN_E2E === "1" && process.env.PGHOST === "api-db" && process.env.PGDATABASE === "crm_api", "격리 Compose 스택에서만 실행한다.");
const { provision, editAccount } = await import("/app/auth.mjs");
const { createApi } = await import("/app/server.mjs");
const { siteRebuilder } = await import("/app/site-rebuild.mjs");
const { Pool } = createRequire("/app/package.json")("pg");
const base = "http://127.0.0.1:8788";
const dateIn = (days) => kstDate(new Date(Date.now() + days * 86400_000));

test("자체 CRM 공개 콘텐츠 빌드, 커밋 훅 재빌드와 실패 시 릴리스 유지", { timeout: 180_000 }, async () => {
  const db = new Pool();
  const app = new Pool({ user: "crm_api_biroso", password: process.env.CRM_API_DB_BIROSO_PASSWORD });
  const email = "builder-e2e@example.test", origin = "http://crm-fixture.test";
  const rebuild = siteRebuilder(process.env);
  const writer = createApi({ pools: { biroso: app }, origins: { biroso: origin }, rebuild,
    // Cloudflare Access 검증만 격리 표본으로 교체한다. 직원 조회, 쓰기, 커밋, 재빌드 훅은 실제 동작을 사용한다.
    verify: { biroso: async () => email } });
  const readPage = (file) => readFile(`/site/current/${file}`, "utf8");
  const status = async () => {
    const r = await fetch(new URL("/healthz", process.env.CRM_API_REBUILD_BIROSO_URL), { signal: AbortSignal.timeout(2_000) });
    assert.equal(r.status, 200);
    return r.json();
  };
  const waitForBuild = async (previous) => {
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline) {
      const { last, building } = await status();
      if (!building && last && last.at !== previous?.at) return last;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail("새 빌드 결과를 확인하지 못했다.");
  };
  writer.listen(0, "127.0.0.1");
  try {
    await once(writer, "listening");
    const builderId = await provision(db, "biroso", { role: "builder", secret: process.env.CRM_API_BUILDER_TOKEN });
    await provision(db, "biroso", { role: "operations", email, name: { firstName: "합성 운영" } });
    await db.query(`INSERT INTO biroso.products(name,slug,kind,published,"salePriceAmountMicros","salePriceCurrencyCode") VALUES
      ('빌더 공개 예약','builder-reservation','RESERVATION',true,12345000000,'KRW'),
      ('빌더 비공개 상품','builder-draft','PAYMENT',false,100000000,'KRW')`);
    await db.query(`INSERT INTO biroso."clinicEvents"(name,slug,published) VALUES ('빌더 공개 행사','builder-event',true)`);
    await db.query(`INSERT INTO biroso.posts(name,slug,board,published,body)
      VALUES ('빌더 공개 글','builder-post','NEWS',true,jsonb_build_object('markdown',$1::text))`,
    ["**공개 본문**\n\n<img src='/media/example.png' alt='합성 그림' onerror=''>"]);
    await db.query(`INSERT INTO biroso.products(name,slug,kind,published,"salePriceAmountMicros","salePriceCurrencyCode","regularPriceAmountMicros","regularPriceCurrencyCode")
      VALUES ('빌더 결제 불가','builder-zero-sale','PAYMENT',true,0,'KRW',30000000000,'KRW'),
             ('빌더 공개 결제','builder-payment','PAYMENT',true,NULL,NULL,12345000000,'KRW')`);
    await db.query(`INSERT INTO biroso.closures(name,date) VALUES ('빌더 휴진','2099-11-18')`);
    const { rows: [{ id }] } = await db.query(`INSERT INTO biroso.faqs(name,answer,published,"sortOrder")
      VALUES ('빌더 공개 질문','빌더 첫 답변',true,0) RETURNING id`);
    await db.query(`INSERT INTO biroso.faqs(name,answer,published,"sortOrder")
      SELECT '빌더 질문 ' || n,'빌더 페이지 시험',true,n FROM generate_series(1,60) AS n`);
    await db.query(`INSERT INTO biroso.faqs(name,answer,published) VALUES ('빌더 비공개 질문','노출 금지',false)`);
    assert.equal(await readPage("index.html"), "Twenty 격리 표본");
    assert.equal((await status()).last, null);

    // 기존 사이트 볼륨에서는 전환 시 첫 빌드 요청이 필요하다.
    await rebuild("biroso");
    const first = await waitForBuild(null);
    assert.equal(first.ok, true);
    const faq = await readPage("faq/index.html");
    assert.ok(faq.includes("빌더 첫 답변") && faq.includes("빌더 질문 60") && !faq.includes("빌더 비공개 질문"));
    const home = await readPage("index.html");
    for (const title of ["빌더 공개 예약", "빌더 공개 행사"]) assert.ok(home.includes(title), title);
    const post = await readPage("board/category-22/rvt6q7qczdwrm2k35srqgem9/builder-post/index.html");
    assert.match(post, /빌더 공개 글/);
    assert.match(post, /<strong>공개 본문<\/strong>/);
    assert.match(post, /src="\/media\/example\.png" alt="합성 그림"/);
    assert.doesNotMatch(post, /onerror=/);
    const payment = await readPage("telemedicine/builder-zero-sale/index.html");
    assert.match(payment, /data-add disabled/);
    assert.match(await readPage("telemedicine/builder-payment/index.html"), /12,345원/);
    const denied = await fetch("http://crm-own-api:3300/api/v1/biroso/rest/people", {
      headers: { Authorization: `Bearer ${process.env.CRM_API_BUILDER_TOKEN}` },
    });
    assert.equal(denied.status, 403);
    await denied.body.cancel();
    const reservation = await readPage("telemedicine/builder-reservation/index.html");
    assert.match(reservation, /data-closures="[^"]*2099-11-18/);
    await assert.rejects(readPage("telemedicine/builder-draft/index.html"), { code: "ENOENT" });

    const response = await fetch(`http://127.0.0.1:${writer.address().port}/api/v1/biroso/rest/faqs/${id}`, {
      method: "PATCH", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "빌더 커밋 뒤 답변" }),
    });
    assert.equal(response.status, 200);
    await response.body.cancel();
    const second = await waitForBuild(first);
    assert.equal(second.ok, true);
    assert.notEqual(second.release, first.release);
    assert.ok((await readPage("faq/index.html")).includes("빌더 커밋 뒤 답변"));

    await editAccount(db, "biroso", builderId, "stop");
    await rebuild("biroso");
    assert.equal((await waitForBuild(second)).ok, false);
    assert.equal(await readlink("/site/current"), `releases/${second.release}`);
    assert.ok((await readPage("faq/index.html")).includes("빌더 커밋 뒤 답변"));
  } finally {
    writer.close();
    await Promise.all([db.end(), app.end()]);
  }
});

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
  await db.query(`INSERT INTO biroso.appointments(name,"appointmentStatus","scheduledAt")
    VALUES ('합성 추가 예약','CONFIRMED',$1)`, [scheduledAt]);
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

// 결과를 기록한 뒤 소켓을 끊어 승인/환불이 실행됐는데 응답만 사라진 경우를 만든다.
async function fakeNicepay(req, res, transactions, calls, clientId, secret) {
  const route = /^\/v1\/payments\/([\w-]+)(\/cancel)?$/.exec(req.url);
  const [, tid, cancel] = route ?? [];
  const tx = transactions.get(tid);
  const record = { tid, op: cancel ? "cancel" : "approve" };
  calls.push(record);
  if (!tx || req.method !== "POST" || req.headers.authorization !== `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`) {
    return res.writeHead(400).end();
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  record.body = body;
  let result;
  if (!cancel && body.amount === tx.amount && !tx.approved) {
    tx.approved = true;
    tx.balance = tx.amount;
    result = { orderId: tx.orderNo, amount: tx.amount, status: "paid", paidAt: new Date().toISOString(), payMethod: "card" };
    if (tx.loseApproval) return req.socket.destroy();
  } else if (cancel && tx.balance > 0) {
    const amount = body.cancelAmt ?? tx.balance;
    if (amount > tx.balance) return res.writeHead(400).end();
    tx.balance -= amount;
    const cancelledTid = `fake-cancel-${calls.length}`;
    result = { orderId: body.orderId, amount, balanceAmt: tx.balance, status: tx.balance ? "partialCancelled" : "cancelled",
      cancelledTid, cancels: [{ tid: cancelledTid, amount }] };
    if (tx.loseRefund) return req.socket.destroy();
  } else {
    return res.writeHead(400).end();
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ...result, tid, resultCode: "0000" }));
}

const form = (suffix) => ({
  name: "합성 고객", phone: `010-0000-${suffix}`, noticeVersion: notice.version, formOpenedAt: Date.now() - 10_000,
  consents: { privacy: true, sensitive: true, terms: true, dosage: true, marketing: false },
  intake: { sex: "M", birthYear: 1990, diseases: ["NONE"], recentMeds: ["NONE"], symptoms: "합성 문진" },
});

test("비로소 실제 프로세스 → 자체 CRM → PostgreSQL", { timeout: 40_000 }, async (t) => {
  const db = new Pool();
  const websiteToken = randomBytes(32).toString("base64url"), sealToken = randomBytes(32).toString("base64url");
  const purgeToken = randomBytes(32).toString("base64url"), cron = randomBytes(32).toString("base64url");
  const dir = await mkdtemp(join(tmpdir(), "biroso-own-"));
  const admin = randomBytes(32).toString("base64url");
  const clientId = "nicepay-local-fixture", pgSecret = randomBytes(32).toString("base64url");
  const pgCalls = [], transactions = new Map();
  let legacyCalls = 0, webhookCalls = 0;
  const fake = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/webhook") {
      webhookCalls++;
      req.resume();
      res.writeHead(204).end();
    } else if (req.url.startsWith("/v1/payments/")) {
      fakeNicepay(req, res, transactions, pgCalls, clientId, pgSecret).catch(() => res.writeHead(500).end());
    } else {
      legacyCalls++;
      res.writeHead(503).end();
    }
  }).listen(0, "127.0.0.1");
  let child;
  try {
    await once(fake, "listening");
    const { bookingDate, closure, chartId } = await fixture(db, websiteToken, sealToken);
    await provision(db, "biroso", { role: "purge", secret: purgeToken });
    const sink = `http://127.0.0.1:${fake.address().port}`;
    const oldLedger = '{"seq":7,"fixture":"Twenty"}\n';
    const oldChecks = '{"fixture":"Twenty verification"}\n';
    await writeFile(join(dir, "ledger.jsonl"), oldLedger);
    await writeFile(join(dir, "checks.jsonl"), oldChecks);
    child = spawn(process.execPath, ["/biroso/server/server.mjs"], { cwd: "/biroso", stdio: ["ignore", "ignore", "inherit"], env: {
      CRM_BACKEND: "own", CRM_API_URL: "http://api:3300", CRM_API_TOKEN: websiteToken, CRM_API_SEAL_TOKEN: sealToken,
      CRM_API_PURGE_TOKEN: purgeToken,
      TWENTY_URL: sink, SITE_URL: base, CRON_SECRET: cron, CHART_LEDGER_PATH: join(dir, "ledger.jsonl"),
      CHART_LEDGER_KEY: randomBytes(32).toString("hex"), CHART_ALERT_WEBHOOK_URL: `${sink}/webhook`,
      TWENTY_API_KEY: randomBytes(32).toString("base64url"), ADMIN_SECRET: admin, NOTICE_VERSIONS: notice.version,
      SLOT_CAPACITY: "2", NICEPAY_CLIENT_ID: clientId, NICEPAY_SECRET_KEY: pgSecret, NICEPAY_API_URL: sink,
    } });
    await waitForSite(child);
    const call = async (path, authorize = false) => {
      const startedAt = new Date();
      const r = await fetch(`${base}/api/v1/${path}`, { headers: authorize ? { Authorization: `Bearer ${cron}` } : {} });
      if (r.status !== 200) {
        const { rows } = await db.query(`SELECT action,resource,status FROM biroso."_accessLog"
          WHERE at >= $1 AND status >= 400 ORDER BY at`, [startedAt]);
        assert.equal(r.status, 200, `${path}, CRM failures: ${JSON.stringify(rows)}`);
      }
      return r.json();
    };
    await t.test("공지, 휴진·찬 예약 칸, 차트 봉인과 검증", async () => {
      const notRebuild = await fetch(process.env.CRM_API_REBUILD_BIROSO_URL, {
        method: "POST", headers: { Authorization: `Bearer ${cron}` },
      });
      assert.equal(notRebuild.status, 401);
      await notRebuild.body.cancel();
      const notVerify = await fetch(`${base}/api/v1/charts/verify`, {
        headers: { Authorization: `Bearer ${process.env.CRM_API_REBUILD_BIROSO_SECRET}` },
      });
      assert.equal(notVerify.status, 401);
      await notVerify.body.cancel();
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
      assert.equal(verify.source, "own");
      assert.equal(webhookCalls, 1);
      const ledger = await readFile(join(dir, "own", "ledger.jsonl"), "utf8");
      assert.equal(ledger.includes("합성 증상"), false);
      assert.equal(JSON.parse(ledger).seq, 1);
      assert.equal(JSON.parse(await readFile(join(dir, "own", "checks.jsonl"), "utf8")).head, verify.head);
      assert.equal(await readFile(join(dir, "ledger.jsonl"), "utf8"), oldLedger);
      assert.equal(await readFile(join(dir, "checks.jsonl"), "utf8"), oldChecks);
      const { rows } = await db.query(`SELECT "sealNo", "sealedAt" IS NOT NULL AS sealed FROM biroso."medicalRecords" WHERE id=$1`, [chartId]);
      assert.deepEqual(rows, [{ sealNo: "1", sealed: true }]);
    });

    const post = async (path, body, extra = {}) => {
      const r = await fetch(`${base}/api/v1/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...extra }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    const one = async (sql, args) => (await db.query(sql, args)).rows[0];
    const insert = async (sql, args) => (await one(`${sql} RETURNING id`, args)).id;
    const order = async (slug, suffix) => {
      await db.query(`INSERT INTO biroso.products(name,slug,published,stock,"salePriceAmountMicros","salePriceCurrencyCode")
        VALUES ('합성 상품',$1,true,1,10000000000,'KRW')`, [slug]);
      const { status, body } = await post("orders", { ...form(suffix), pickup: true, items: [{ slug, qty: 1, price: 1 }] });
      assert.equal(status, 201, body.error);
      assert.equal(body.pay.amount, 10000);
      assert.equal(body.pay.returnUrl === `${base}/api/v1/payments/return`, true, "콜백은 격리 서버로만 보낸다.");
      const tid = `fake-${slug}`;
      const tx = { orderNo: body.orderNo, amount: body.pay.amount, balance: 0 };
      transactions.set(tid, tx);
      const authToken = randomBytes(16).toString("hex");
      const signature = createHash("sha256").update(`${authToken}${clientId}${tx.amount}${pgSecret}`).digest("hex");
      const callback = async () => {
        const res = await fetch(body.pay.returnUrl, { method: "POST", redirect: "manual", body: new URLSearchParams({
          orderId: tx.orderNo, tid, amount: tx.amount, clientId, authToken, signature, authResultCode: "0000",
        }) });
        assert.equal(res.status, 303);
        return new URL(res.headers.get("location"));
      };
      const refund = (key, amount) => post("orders/refund", { orderNo: tx.orderNo, amount }, {
        Authorization: `Bearer ${admin}`, "Idempotency-Key": key,
      });
      const state = () => one(`SELECT o.id,o."orderStatus",o."pgTid",o."paidAt" IS NOT NULL AS paid,p.stock::int,p."soldOut",
        (SELECT coalesce(sum(amount_micros),0)::bigint / 1000000 FROM biroso.refunds WHERE order_id=o.id AND status='SUCCEEDED')::int AS refunded
        FROM biroso."clinicOrders" o
        CROSS JOIN biroso.products p WHERE o.name=$1 AND p.slug=$2`, [tx.orderNo, slug]);
      const calls = () => pgCalls.filter((row) => row.tid === tid);
      return { callback, refund, state, tx, tid, calls };
    };

    await t.test("구매 폼·PG 승인과 재생, CRM 재고 1회, 부분 환불과 잔액 전액 환불", async () => {
      const sale = await order("sale", "0101");
      assert.equal(sale.calls().length, 0);
      assert.equal((await sale.state()).stock, 1);
      assert.equal((await sale.callback()).pathname, "/order/complete/");
      assert.equal((await sale.callback()).pathname, "/order/complete/");
      const { id, ...paid } = await sale.state();
      assert.deepEqual(paid, { orderStatus: "PAID", pgTid: sale.tid, paid: true, stock: 0, soldOut: true, refunded: 0 });
      assert.deepEqual(sale.calls().map(({ op }) => op), ["approve"]);
      const partial = await sale.refund("partial", 3000);
      assert.equal(partial.status, 200, partial.body.error);
      assert.deepEqual([partial.body.refunded, partial.body.remaining], [3000, 7000]);
      assert.equal((await sale.state()).orderStatus, "PARTIAL_REFUNDED");
      const replay = await sale.refund("partial", 3000);
      assert.deepEqual([replay.status, replay.body.error], [409, "refund_reconciliation_required"]);
      assert.equal(sale.calls().length, 2);
      const final = await sale.refund("remainder");
      assert.equal(final.status, 200, final.body.error);
      assert.deepEqual([final.body.refunded, final.body.remaining], [7000, 0]);
      const closed = await sale.state();
      assert.deepEqual([closed.orderStatus, closed.refunded, closed.stock], ["REFUNDED", 10000, 0]);
      assert.deepEqual(sale.calls().map(({ op, body }) => [op, body.cancelAmt, body.taxFreeAmt]),
        [["approve", undefined, undefined], ["cancel", 3000, 3000], ["cancel", 7000, 7000]]);
      assert.deepEqual(await one(`SELECT count(*)::int AS n FROM biroso.refunds WHERE order_id=$1 AND status='SUCCEEDED'`, [id]), { n: 2 });
    });

    await t.test("첫 환불에서 전액 취소: 원주문 번호로 1회", async () => {
      const sale = await order("full-cancel", "0105");
      assert.equal((await sale.callback()).pathname, "/order/complete/");
      const refund = await sale.refund("full");
      assert.equal(refund.status, 200, refund.body.error);
      assert.deepEqual([refund.body.refunded, refund.body.remaining], [10000, 0]);
      const replay = await sale.refund("full");
      assert.deepEqual([replay.status, replay.body.error], [409, "refund_reconciliation_required"]);
      assert.deepEqual(sale.calls().map(({ op }) => op), ["approve", "cancel"]);
      assert.equal(sale.calls()[1].body.orderId, sale.tx.orderNo);
      assert.equal(Object.hasOwn(sale.calls()[1].body, "cancelAmt"), false);
      const closed = await sale.state();
      assert.deepEqual([closed.orderStatus, closed.refunded, closed.stock], ["REFUNDED", 10000, 0]);
    });

    await t.test("가짜 PG에만 기존 환불이 있어 잔액이 다르면 CRM은 선점을 유지한다", async () => {
      const sale = await order("manual-cancel", "0106");
      assert.equal((await sale.callback()).pathname, "/order/complete/");
      sale.tx.balance = 7000;
      const r = await sale.refund("after-manual-cancel", 7000);
      assert.deepEqual([r.status, r.body.error], [409, "refund_reconciliation_required"]);
      assert.deepEqual(sale.calls().map(({ op }) => op), ["approve", "cancel"]);
      assert.equal(sale.tx.balance, 0);
      const current = await sale.state();
      assert.deepEqual([current.orderStatus, current.refunded], ["PAID", 0]);
      assert.deepEqual((await db.query(`SELECT status FROM biroso.refunds WHERE order_id=$1`, [current.id])).rows, [{ status: "PENDING" }]);
    });

    await t.test("결제 직전 재고 소진: PG 호출 0건", async () => {
      const sale = await order("sold-before-pay", "0102");
      await db.query(`UPDATE biroso.products SET stock=0 WHERE slug='sold-before-pay'`);
      const result = await sale.callback();
      assert.equal(result.pathname, "/order/fail/");
      assert.match(result.searchParams.get("reason"), /상품이나 재고가 바뀌었어요/);
      assert.equal(sale.calls().length, 0);
      assert.equal((await sale.state()).orderStatus, "PENDING");
    });

    await t.test("PG 승인·환불 결과 유실: 재생에도 PG 추가 호출·자동취소 없음", async () => {
      const approval = await order("lost-approval", "0103");
      approval.tx.loseApproval = true;
      for (let i = 0; i < 2; i++) {
        const result = await approval.callback();
        assert.equal(result.pathname, "/order/fail/");
        assert.match(result.searchParams.get("reason"), /결제 결과를 확인 중/);
      }
      assert.deepEqual(approval.calls().map(({ op }) => op), ["approve"]);
      assert.equal(approval.tx.balance, 10000);
      const unresolved = await approval.state();
      assert.deepEqual([unresolved.orderStatus, unresolved.stock], ["PENDING", 1]);
      assert.deepEqual(await one(`SELECT count(*)::int AS n FROM biroso."_paymentAttempts" WHERE order_id=$1 AND failed_at IS NULL`,
        [unresolved.id]), { n: 1 });

      const sale = await order("lost-refund", "0104");
      assert.equal((await sale.callback()).pathname, "/order/complete/");
      sale.tx.loseRefund = true;
      for (const key of ["lost", "lost", "different-key"]) {
        const r = await sale.refund(key);
        assert.deepEqual([r.status, r.body.error], [409, "refund_reconciliation_required"]);
      }
      assert.deepEqual(sale.calls().map(({ op, body }) => [op, body.cancelAmt]), [["approve", undefined], ["cancel", undefined]]);
      assert.equal(sale.tx.balance, 0);
      const unresolvedRefund = await sale.state();
      assert.equal(unresolvedRefund.orderStatus, "PAID");
      assert.deepEqual((await db.query(`SELECT status FROM biroso.refunds WHERE order_id=$1`, [unresolvedRefund.id])).rows, [{ status: "PENDING" }]);
    });

    await t.test("기존 무키 예약을 포함한 정원 경합, 문진·동의와 빠른 상담", async () => {
      await db.query(`INSERT INTO biroso.products(name,slug,kind,published,telemedicine) VALUES ('합성 진료','visit','RESERVATION',true,true)`);
      const scheduledAt = kstIso(bookingDate, "11:00");
      await db.query(`INSERT INTO biroso.appointments(name,"appointmentStatus","scheduledAt","slotKey","deletedAt") VALUES
        ('합성 기존 예약','CONFIRMED',$1,NULL,NULL), ('합성 취소','CANCELLED',$1,$2,NULL),
        ('합성 휴지통','CONFIRMED',$1,$3,now())`, [scheduledAt, `${scheduledAt}#0`, `${scheduledAt}#1`]);
      const attempts = await Promise.all(["0201", "0202"].map((suffix) => post("appointments", {
        ...form(suffix), product: "visit", method: "PHONE", date: bookingDate, time: "11:00",
      })));
      assert.deepEqual(attempts.map(({ status }) => status).sort(), [201, 409], attempts.map(({ body }) => body.error).join(", "));
      assert.equal(attempts.find(({ status }) => status === 409).body.error, "slot_taken");
      assert.deepEqual(await one(`SELECT
        (SELECT count(*)::int FROM biroso.appointments WHERE "scheduledAt"=$1 AND "deletedAt" IS NULL AND "appointmentStatus" <> 'CANCELLED') AS active,
        (SELECT count(*)::int FROM biroso.appointments WHERE "scheduledAt"=$1 AND "slotKey"=$2) AS seats,
        (SELECT count(*)::int FROM biroso.intakes i JOIN biroso.appointments a ON a.id=i."appointmentId"
          WHERE a."slotKey"=$2 AND i."customerId"=a."customerId" AND i.symptoms='합성 문진') AS intakes,
        (SELECT array_agg(c."consentType" ORDER BY c."consentType") FROM biroso."consentRecords" c
          JOIN biroso.appointments a ON a."customerId"=c."personId" WHERE a."slotKey"=$2) AS consents,
        (SELECT count(*)::int FROM biroso.people WHERE "phonesPrimary" IN ('1000000201','1000000202')) AS people`,
      [scheduledAt, `${scheduledAt}#0`]),
      { active: 2, seats: 1, intakes: 1, consents: ["MARKETING", "PRIVACY", "SENSITIVE"], people: 1 });
      const quick = await post("consults", { ...form("0203"), interest: "합성 문의" });
      assert.equal(quick.status, 201, quick.body.error);
      assert.deepEqual(await one(`SELECT c."consultStatus", c.interest,
        c."purgeAfter" - (SELECT (min("collectedAt") AT TIME ZONE 'UTC')::date FROM biroso."consentRecords" WHERE "personId"=p.id) AS days,
        (SELECT count(*)::int FROM biroso.intakes WHERE "customerId"=p.id) AS intakes,
        (SELECT array_agg("consentType" ORDER BY "consentType") FROM biroso."consentRecords" WHERE "personId"=p.id) AS consents
        FROM biroso."consultRequests" c JOIN biroso.people p ON p.id=c."customerId" WHERE p."phonesPrimary"='1000000203'`),
      { consultStatus: "WAITING", interest: "합성 문의", days: 90, intakes: 0, consents: ["MARKETING", "PRIVACY"] });
    });

    await t.test("보유기간 파기: 만료 상담·문진·미결제 삭제, 진행 결제·진료기록 등 보존", async () => {
      const expired = await insert(`INSERT INTO biroso.intakes("purgeAfter") VALUES (CURRENT_DATE-2)`);
      const fresh = await insert(`INSERT INTO biroso.intakes("purgeAfter") VALUES (CURRENT_DATE+2)`);
      const consult = await insert(`INSERT INTO biroso."consultRequests"("purgeAfter") VALUES (CURRENT_DATE-2)`);
      const abandoned = await insert(`INSERT INTO biroso."clinicOrders"("createdAt",name) VALUES (now()-interval '3 days','abandoned')`);
      const abandonedIntake = await insert(`INSERT INTO biroso.intakes("clinicOrderId","purgeAfter") VALUES ($1,CURRENT_DATE+2)`, [abandoned]);
      const pending = await insert(`INSERT INTO biroso."clinicOrders"("createdAt",name) VALUES (now()-interval '3 days','unresolved')`);
      await db.query(`INSERT INTO biroso."_paymentAttempts"(order_id,tid) VALUES ($1,'fake-unresolved')`, [pending]);
      const pendingIntake = await insert(`INSERT INTO biroso.intakes("clinicOrderId","purgeAfter") VALUES ($1,CURRENT_DATE-2)`, [pending]);
      const paid = await insert(`INSERT INTO biroso."clinicOrders"("createdAt","orderStatus","paidAt") VALUES (now()-interval '3 days','PAID',now())`);
      const counts = await call("purge", true);
      assert.deepEqual([counts.intakes, counts.consultRequests, counts.clinicOrders], [2, 1, 1]);
      assert.deepEqual(await one(`SELECT
        (SELECT array_agg(id ORDER BY id) FROM biroso.intakes WHERE id=ANY($1::uuid[])) AS intakes,
        (SELECT array_agg(id ORDER BY id) FROM biroso."clinicOrders" WHERE id=ANY($2::uuid[])) AS orders,
        EXISTS(SELECT 1 FROM biroso."consultRequests" WHERE id=$3) AS consult,
        EXISTS(SELECT 1 FROM biroso."medicalRecords" WHERE id=$4) AS chart`,
      [[expired, fresh, abandonedIntake, pendingIntake], [abandoned, pending, paid], consult, chartId]),
      { intakes: [fresh, pendingIntake].sort(), orders: [pending, paid].sort(), consult: false, chart: true });
      assert.ok(Object.values(await call("purge", true)).every((count) => count === 0));
    });

    await t.test("톡톡 variables: CRM이 문구를 만들고 재생해도 대기열 1건", async () => {
      const person = await insert(`INSERT INTO biroso.people(name,"consentNotice") VALUES ('{"firstName":"고객","lastName":"합성"}',true)`);
      const shipment = await insert(`INSERT INTO biroso."clinicOrders"("customerId","orderStatus","shippingStatus","shippedAt",carrier,"trackingNo")
        VALUES ($1,'PAID','SHIPPED',now()-interval '1 hour','CJ','E2E-123')`, [person]);
      const thread = await insert(`INSERT INTO biroso."counselThreads"("customerId",channel,"channelUser") VALUES ($1,'NAVER_TALK','synthetic-thread')`, [person]);
      const rule = await insert(`INSERT INTO biroso."contactRules"("triggerEvent",channel,active,"timeOfDay",script)
        VALUES ('SHIPPED','TALKTALK',true,'00:00','#{고객} 님, #{한의원} #{택배사} #{송장}')`);
      assert.equal((await call("journeys", true)).talked, 1);
      assert.equal((await call("journeys", true)).talked, 0);
      const messages = await db.query(`SELECT "counselThreadId","messageText","sendStatus","sentFrom" FROM biroso."counselMessages" WHERE "dedupeKey"=$1`,
        [`${rule}:${shipment}`]);
      assert.deepEqual(messages.rows, [{ counselThreadId: thread, messageText: "합성고객 님, 비로소한의원 CJ대한통운 E2E-123", sendStatus: "QUEUED", sentFrom: "JOURNEY" }]);
    });
    assert.equal(legacyCalls, 0);
    assert.ok(pgCalls.every(({ tid }) => transactions.has(tid)), "가짜 PG에 알려지지 않은 거래 또는 망취소 호출이 없어야 한다.");
  } finally {
    if (child?.exitCode === null) { child.kill(); await once(child, "exit"); }
    await new Promise((resolve) => fake.close(resolve));
    await db.end();
    // 매 실행이 만든 임시 장부 경로만 제거한다.
    await rm(dir, { recursive: true, force: true });
  }
});
