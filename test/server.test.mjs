import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { createHandler } from "../server/handler.mjs";
import { priceOrder, isRemote } from "../server/pricing.mjs";
import { availableSlots, daySlots, weekday } from "../server/slots.mjs";
import { verifyAuthSignature, createNicepay, PaymentError } from "../server/nicepay.mjs";
import { SlotTaken } from "../server/twenty.mjs";
import { runPurge } from "../server/purge.mjs";

const SHIPPING = { base: 3500, remoteExtra: 2000, freeOver: 100000 };
const HOURS = [
  { days: [1, 2, 4, 5], open: "10:30", close: "20:00" },
  { days: [3], open: "10:00", close: "15:00" },
  { days: [6], open: "10:00", close: "13:30" },
];
const won = (n) => ({ amountMicros: n * 1_000_000, currencyCode: "KRW" });

const PRODUCTS = [
  { id: "11111111-1111-1111-1111-111111111111", slug: "biyulhwan", name: "비율환(30포)", kind: "PAYMENT", published: true, salePrice: won(43000), taxFree: true },
  { id: "22222222-2222-2222-2222-222222222222", slug: "gongjindan", name: "침향공진단 10환", kind: "PAYMENT", published: true, salePrice: won(176000), taxFree: true },
  { id: "33333333-3333-3333-3333-333333333333", slug: "soldout", name: "품절 상품", kind: "PAYMENT", published: true, salePrice: won(10000), soldOut: true },
  { id: "44444444-4444-4444-4444-444444444444", slug: "diet-consult", name: "다이어트 처방 상담", kind: "RESERVATION", published: true, telemedicine: true, inPerson: true },
  { id: "55555555-5555-5555-5555-555555555555", slug: "chuna", name: "추나", kind: "RESERVATION", published: true, telemedicine: false, inPerson: true },
];

// Twenty 대신 메모리에 기록하는 가짜 클라이언트
function fakeTwenty() {
  const s = { people: [], orders: [], intakes: [], consents: [], appointments: [], closures: ["2026-11-04"], deleted: [] };
  const id = (p) => `${p}${Math.random().toString(16).slice(2, 10)}`;
  const { toProduct } = { toProduct: (p) => ({ ...p, salePrice: p.salePrice ? p.salePrice.amountMicros / 1e6 : null, soldOut: Boolean(p.soldOut), taxFree: Boolean(p.taxFree), freeShipping: Boolean(p.freeShipping), telemedicine: Boolean(p.telemedicine), inPerson: Boolean(p.inPerson) }) };
  return {
    s,
    async productsBySlugs(slugs) { return PRODUCTS.filter((p) => slugs.includes(p.slug) || slugs.includes(p.id)).map(toProduct); },
    async findPersonByPhone(n) { return s.people.find((p) => p.phones.primaryPhoneNumber === n) ?? null; },
    async createPerson(p) { const r = { id: id("p"), ...p }; s.people.push(r); return r; },
    async updatePerson(pid, patch) { Object.assign(s.people.find((x) => x.id === pid), patch); },
    async createConsentRecord(r) { s.consents.push(r); return r; },
    async createOrder(r) { const o = { id: id("o"), createdAt: new Date().toISOString(), ...r }; s.orders.push(o); return o; },
    async findOrder(no) { return s.orders.find((o) => o.name === no) ?? null; },
    async updateOrder(oid, patch) { Object.assign(s.orders.find((o) => o.id === oid), patch); },
    async createIntake(r) { const i = { id: id("i"), ...r }; s.intakes.push(i); return i; },
    // Twenty 고유값 필드처럼 slotKey가 겹치면 거절한다. 동시 요청이 겹치도록 한 박자 쉰다.
    async createAppointment(r) {
      await new Promise((ok) => setTimeout(ok, 5));
      if (r.slotKey && s.appointments.some((a) => a.slotKey === r.slotKey)) throw new SlotTaken(r.slotKey);
      const a = { id: id("a"), ...r }; s.appointments.push(a); return a;
    },
    async findAppointmentBySlotKey(k) { return s.appointments.find((a) => a.slotKey === k) ?? null; },
    async updateAppointment(aid, patch) { Object.assign(s.appointments.find((a) => a.id === aid), patch); },
    async takenSlots(from, to) { return s.appointments.filter((a) => a.scheduledAt >= from && a.scheduledAt < to && a.appointmentStatus !== "CANCELLED").map((a) => a.scheduledAt); },
    async closures(from, to) { return s.closures.filter((d) => d >= from && d <= to); },
    async listStalePendingOrders(before) { return s.orders.filter((o) => o.orderStatus === "PENDING" && o.createdAt < before); },
    async listExpiredIntakes(today) { return s.intakes.filter((i) => i.purgeAfter < today); },
    async intakesOfOrder(oid) { return s.intakes.filter((i) => i.clinicOrderId === oid); },
    async hardDelete(plural, rid) { s.deleted.push(`${plural}/${rid}`); for (const k of ["orders", "intakes"]) s[k] = s[k].filter((x) => x.id !== rid); },
    async deletePersonIfOrphan(pid) {
      if (s.orders.some((o) => o.customerId === pid) || s.appointments.some((a) => a.customerId === pid)) return false;
      s.people = s.people.filter((p) => p.id !== pid); s.deleted.push(`people/${pid}`); return true;
    },
  };
}

const SECRET = "test-secret";
function fakeNicepay({ approveFails = false, approveError = null, netCancelCode = "0000" } = {}) {
  const calls = [];
  return {
    calls, clientId: "S2_test",
    verify: (f) => verifyAuthSignature(f, SECRET),
    async approve(tid, amount, orderId) {
      calls.push(["approve", tid, amount]);
      if (approveFails) throw new PaymentError("approve_failed", "한도 초과");
      if (approveError) throw approveError;
      return { resultCode: "0000", status: "paid", tid, amount, orderId, paidAt: "2026-10-29T10:00:00.000+0900", payMethod: "card", receiptUrl: "https://npg.nicepay.co.kr/receipt" };
    },
    async cancel(tid, orderId, reason, amt) { calls.push(["cancel", tid, orderId, reason, amt]); return { resultCode: "0000", balanceAmt: 0 }; },
    async netCancel(orderId) { calls.push(["netcancel", orderId]); return { resultCode: netCancelCode }; },
  };
}

const cfg = {
  allowedOrigins: ["https://biroso.vercel.app"], siteUrl: "https://biroso.vercel.app", noticeVersions: ["2026-11-01"],
  rateLimitPer10Min: 50, minFillMs: 2000, trustProxy: false, intakeRetentionDays: 365, pendingOrderHours: 24,
  nicepay: { clientId: "S2_test", secretKey: SECRET, apiUrl: "https://sandbox-api.nicepay.co.kr" },
  shipping: SHIPPING, hours: HOURS, slotMinutes: 30, slotCapacity: 1, slotLeadHours: 2, slotDays: 30,
  cronSecret: "cron", adminSecret: "admin", tel: "02-2039-0520",
};

async function withServer(fn, { twenty = fakeTwenty(), nicepay = fakeNicepay() } = {}) {
  const srv = http.createServer(createHandler(cfg, { twenty, nicepay, log: () => {} }));
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base, twenty, nicepay); } finally { srv.close(); }
}

const intake = { sex: "F", birthYear: 1990, heightCm: 162, weightKg: 68, pregnancy: "NONE", medications: "", conditions: "", allergies: "", dietHistory: "처음", symptoms: "" };
const order = (over = {}) => ({
  name: "김영희", phone: "010-5555-6666", items: [{ slug: "biyulhwan", qty: 1 }], payMethod: "CARD",
  recipient: { zip: "04104", address1: "서울 마포구 굴레방로 9-1", address2: "2층", memo: "" }, consultTime: "평일 오후",
  intake, consents: { privacy: true, sensitive: true, terms: true, marketing: false }, noticeVersion: "2026-11-01",
  landingPage: "https://biroso.vercel.app/telemedicine/biyulhwan/", formOpenedAt: Date.now() - 10_000, ...over,
});
const postJson = (base, path, b, origin = "https://biroso.vercel.app") =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(b) });
const sign = (authToken, amount) => createHash("sha256").update(`${authToken}S2_test${amount}${SECRET}`).digest("hex");
const returnForm = (base, fields) => fetch(`${base}/api/v1/payments/return`, {
  method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
});

test("배송비: 기본 3,500원, 10만원 이상 무료, 제주 +2,000원, 방문 수령은 0원", () => {
  const ps = PRODUCTS.map((p) => ({ ...p, salePrice: p.salePrice ? p.salePrice.amountMicros / 1e6 : null }));
  assert.equal(priceOrder([{ slug: "biyulhwan", qty: 1 }], ps, { zip: "04104" }, SHIPPING).shippingFee, 3500);
  assert.equal(priceOrder([{ slug: "biyulhwan", qty: 3 }], ps, { zip: "04104" }, SHIPPING).shippingFee, 0);
  assert.equal(priceOrder([{ slug: "biyulhwan", qty: 1 }], ps, { zip: "63100" }, SHIPPING).shippingFee, 5500);
  assert.equal(priceOrder([{ slug: "biyulhwan", qty: 1 }], ps, { pickup: true, zip: "63100" }, SHIPPING).shippingFee, 0);
  const p = priceOrder([{ slug: "biyulhwan", qty: 1 }, { slug: "gongjindan", qty: 1 }, { slug: "biyulhwan", qty: 1 }], ps, { zip: "04104" }, SHIPPING);
  assert.equal(p.itemsAmount, 43000 * 2 + 176000);
  assert.equal(p.taxFreeAmount, p.itemsAmount);
  assert.equal(p.goodsName, "비율환(30포) 외 1건");
  assert.ok(isRemote("40220") && !isRemote("04104"));
  assert.throws(() => priceOrder([{ slug: "soldout", qty: 1 }], ps, {}, SHIPPING), /품절/);
  assert.throws(() => priceOrder([{ slug: "diet-consult", qty: 1 }], ps, {}, SHIPPING), /판매하지 않는/);
});

test("예약 시간: 요일별 진료시간, 휴진일·지난 시간·찬 칸 제외", () => {
  assert.equal(weekday("2026-11-01"), 0); // 일요일
  assert.deepEqual(daySlots("2026-11-01", HOURS, 30), []);
  assert.equal(daySlots("2026-11-07", HOURS, 30).at(-1), "13:00"); // 토 10:00~13:30
  assert.equal(daySlots("2026-11-02", HOURS, 30)[0], "10:30");
  const now = new Date("2026-11-02T11:00:00+09:00");
  const s = availableSlots("2026-11-02", { hours: HOURS, now, taken: [new Date("2026-11-02T15:00:00+09:00").toISOString()] });
  assert.equal(s.find((x) => x.time === "12:30").available, false); // 2시간 이내
  assert.equal(s.find((x) => x.time === "13:00").available, true);
  assert.equal(s.find((x) => x.time === "15:00").available, false); // 이미 예약
  assert.deepEqual(availableSlots("2026-11-04", { hours: HOURS, now, closures: ["2026-11-04"] }), []);
  assert.deepEqual(availableSlots("2026-10-30", { hours: HOURS, now }), []); // 지난 날
});

test("주문 → 결제 승인: 금액은 서버가 계산하고, 서명·금액이 맞으면 결제 완료로 바꾼다", () => withServer(async (base, t, np) => {
  const r = await postJson(base, "/api/v1/orders", order({ items: [{ slug: "biyulhwan", qty: 1 }], amount: 1 }));
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.pay.amount, 46500);
  assert.equal(body.pay.taxFreeAmt, 43000);
  assert.equal(body.pay.method, "card");
  assert.equal(body.pay.returnUrl, "https://biroso.vercel.app/api/v1/payments/return");
  assert.equal(t.s.orders[0].orderStatus, "PENDING");
  assert.equal(t.s.intakes[0].clinicOrderId, t.s.orders[0].id);
  assert.equal(t.s.intakes[0].weightKg, 68);
  assert.deepEqual(t.s.consents.map((c) => [c.consentType, c.granted]), [["PRIVACY", true], ["SENSITIVE", true], ["TERMS", true], ["MARKETING", false]]);

  const res = await returnForm(base, { authResultCode: "0000", tid: "T1", clientId: "S2_test", orderId: body.orderNo, amount: "46500", authToken: "tok", signature: sign("tok", 46500) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `https://biroso.vercel.app/order/complete/?no=${body.orderNo}`);
  assert.equal(t.s.orders[0].orderStatus, "PAID");
  assert.equal(t.s.orders[0].pgTid, "T1");
  assert.deepEqual(np.calls[0], ["approve", "T1", 46500]);

  // 같은 결과가 다시 와도(새로 고침) 두 번 승인하지 않는다
  const again = await returnForm(base, { authResultCode: "0000", tid: "T1", clientId: "S2_test", orderId: body.orderNo, amount: "46500", authToken: "tok", signature: sign("tok", 46500) });
  assert.match(again.headers.get("location"), /\/order\/complete\//);
  assert.equal(np.calls.length, 1);
}));

test("서명이 틀리거나 금액이 다르면 승인하지 않는다", () => withServer(async (base, t, np) => {
  const body = await (await postJson(base, "/api/v1/orders", order())).json();
  const bad = await returnForm(base, { authResultCode: "0000", tid: "T1", clientId: "S2_test", orderId: body.orderNo, amount: "46500", authToken: "tok", signature: "0".repeat(64) });
  assert.match(bad.headers.get("location"), /\/order\/fail\//);
  const cheap = await returnForm(base, { authResultCode: "0000", tid: "T1", clientId: "S2_test", orderId: body.orderNo, amount: "100", authToken: "tok", signature: sign("tok", 100) });
  assert.match(cheap.headers.get("location"), /\/order\/fail\//);
  assert.equal(np.calls.length, 0);
  assert.equal(t.s.orders[0].orderStatus, "PENDING");
}));

test("주문 기록이 실패하면 승인된 결제를 자동으로 취소한다", async () => {
  const twenty = fakeTwenty();
  twenty.updateOrder = async () => { throw new Error("Twenty 500"); };
  await withServer(async (base, t, np) => {
    const body = await (await postJson(base, "/api/v1/orders", order())).json();
    const res = await returnForm(base, { authResultCode: "0000", tid: "T9", clientId: "S2_test", orderId: body.orderNo, amount: "46500", authToken: "a", signature: sign("a", 46500) });
    assert.match(res.headers.get("location"), /\/order\/fail\//);
    assert.equal(np.calls[1][0], "cancel");
  }, { twenty });
});

test("승인 응답의 주문번호가 다르면(같은 금액 주문 바꿔치기) 승인한 결제를 취소하고 기록하지 않는다", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push([url, JSON.parse(init.body)]);
    const body = url.endsWith("/cancel") ? { resultCode: "0000" } : { resultCode: "0000", status: "paid", tid: "TA", amount: 46500, orderId: "BR_A" };
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  const np = createNicepay({ clientId: "S2_test", secretKey: SECRET, apiUrl: "https://x" }, fetchImpl);
  await assert.rejects(np.approve("TA", 46500, "BR_B"), (e) => e instanceof PaymentError && e.code === "order_mismatch");
  assert.equal(sent[1][0], "https://x/v1/payments/TA/cancel");
  assert.equal(sent[1][1].orderId, "BR_A");
  assert.equal((await np.approve("TA", 46500, "BR_A")).orderId, "BR_A");

  const mismatch = new PaymentError("order_mismatch", "결제 정보가 주문과 달라요. 결제는 취소했어요.");
  await withServer(async (base, t, fake) => {
    const body = await (await postJson(base, "/api/v1/orders", order())).json();
    const res = await returnForm(base, { authResultCode: "0000", tid: "TA", clientId: "S2_test", orderId: body.orderNo, amount: "46500", authToken: "a", signature: sign("a", 46500) });
    assert.match(res.headers.get("location"), /\/order\/fail\//);
    assert.equal(t.s.orders[0].orderStatus, "PENDING");
    assert.ok(!fake.calls.some((c) => c[0] === "netcancel"));
  }, { nicepay: fakeNicepay({ approveError: mismatch }) });
});

test("승인 응답을 읽지 못하면 망취소하고, 망취소도 실패하면 연락을 안내한다", async () => {
  for (const [code, want] of [["0000", /취소했어요/], ["9999", /연락/]]) {
    await withServer(async (base, t, np) => {
      const body = await (await postJson(base, "/api/v1/orders", order())).json();
      const res = await returnForm(base, { authResultCode: "0000", tid: "T5", clientId: "S2_test", orderId: body.orderNo, amount: "46500", authToken: "a", signature: sign("a", 46500) });
      const reason = new URL(res.headers.get("location")).searchParams.get("reason");
      assert.match(reason, want);
      assert.deepEqual(np.calls.at(-1), ["netcancel", body.orderNo]);
      assert.equal(t.s.orders[0].orderStatus, "PENDING");
    }, { nicepay: fakeNicepay({ approveError: new PaymentError("bad_response", "나이스페이 응답을 읽지 못했어요 (502)"), netCancelCode: code }) });
  }
});

test("필수 동의·주소가 없으면 받지 않고, 방문 수령은 주소 없이 받는다", () => withServer(async (base) => {
  const noSensitive = await postJson(base, "/api/v1/orders", order({ consents: { privacy: true, sensitive: false, terms: true } }));
  assert.equal(noSensitive.status, 422);
  assert.ok((await noSensitive.json()).fields["consents.sensitive"]);
  const noAddr = await postJson(base, "/api/v1/orders", order({ recipient: {} }));
  assert.equal(noAddr.status, 422);
  const pickup = await postJson(base, "/api/v1/orders", order({ recipient: {}, pickup: true }));
  assert.equal(pickup.status, 201);
  assert.equal((await pickup.json()).amounts.shipping, 0);
  const other = await postJson(base, "/api/v1/orders", order(), "https://evil.example");
  assert.equal(other.status, 403);
}));

test("환불: 처방 확정 전에는 전액 취소, 확정 뒤에는 막는다", () => withServer(async (base, t, np) => {
  const body = await (await postJson(base, "/api/v1/orders", order())).json();
  await returnForm(base, { authResultCode: "0000", tid: "T2", clientId: "S2_test", orderId: body.orderNo, amount: "46500", authToken: "x", signature: sign("x", 46500) });
  const refund = (b, auth = "Bearer admin") => fetch(`${base}/api/v1/orders/refund`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await refund({ orderNo: body.orderNo }, "Bearer nope")).status, 401);
  t.s.orders[0].orderStatus = "PRESCRIBED";
  assert.equal((await refund({ orderNo: body.orderNo })).status, 409);
  t.s.orders[0].orderStatus = "PAID";
  const ok = await refund({ orderNo: body.orderNo, reason: "고객 변심" });
  assert.equal(ok.status, 200);
  assert.equal(t.s.orders[0].orderStatus, "REFUNDED");
  assert.deepEqual(np.calls.at(-1).slice(0, 4), ["cancel", "T2", body.orderNo, "고객 변심"]);
  assert.equal(np.calls.at(-1)[4], undefined); // 항상 전액
}));

test("환불: 부분 금액은 받지 않는다", () => withServer(async (base, t, np) => {
  const body = await (await postJson(base, "/api/v1/orders", order())).json();
  await returnForm(base, { authResultCode: "0000", tid: "T3", clientId: "S2_test", orderId: body.orderNo, amount: "46500", authToken: "x", signature: sign("x", 46500) });
  const res = await fetch(`${base}/api/v1/orders/refund`, { method: "POST", headers: { Authorization: "Bearer admin", "Content-Type": "application/json" }, body: JSON.stringify({ orderNo: body.orderNo, amount: 10000 }) });
  assert.equal(res.status, 422);
  assert.equal(t.s.orders[0].orderStatus, "PAID");
  assert.ok(!np.calls.some((c) => c[0] === "cancel"));
}));

test("진료 예약: 가능한 칸만 받고, 같은 칸은 두 번 받지 않는다", () => withServer(async (base, t) => {
  // 다음 주 월요일 15:00
  const d = new Date(Date.now() + 9 * 3600_000);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  const date = d.toISOString().slice(0, 10);
  const slots = await (await fetch(`${base}/api/v1/slots?date=${date}`, { headers: { Origin: "https://biroso.vercel.app" } })).json();
  assert.ok(slots.slots.find((s) => s.time === "15:00").available);
  const appt = (over = {}) => ({
    name: "박철수", phone: "010-1234-5678", product: "diet-consult", method: "PHONE", date, time: "15:00", intake,
    consents: { privacy: true, sensitive: true, marketing: true }, noticeVersion: "2026-11-01", formOpenedAt: Date.now() - 10_000, ...over,
  });
  assert.equal((await postJson(base, "/api/v1/appointments", appt())).status, 201);
  assert.equal(t.s.appointments[0].scheduledAt, new Date(`${date}T15:00:00+09:00`).toISOString());
  assert.equal(t.s.intakes[0].appointmentId, t.s.appointments[0].id);
  assert.equal(t.s.people[0].consentMarketing, true);
  assert.equal((await postJson(base, "/api/v1/appointments", appt({ phone: "010-2222-3333" }))).status, 409);
  assert.equal((await postJson(base, "/api/v1/appointments", appt({ product: "chuna", time: "16:00" }))).status, 422);

  // 같은 칸에 동시에 들어와도 하나만 받는다
  const both = await Promise.all(["010-3333-4444", "010-5555-7777"].map((phone) => postJson(base, "/api/v1/appointments", appt({ phone, time: "17:00" }))));
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
  assert.equal(t.s.appointments.filter((a) => a.slotKey?.startsWith(new Date(`${date}T17:00:00+09:00`).toISOString())).length, 1);

  // 취소된 예약의 자리는 다시 잡을 수 있다(직원이 Twenty에서 취소해도 자리 키는 남아 있다)
  t.s.appointments[0].appointmentStatus = "CANCELLED";
  assert.equal((await postJson(base, "/api/v1/appointments", appt({ phone: "010-2222-3333" }))).status, 201);
  assert.match(t.s.appointments[0].slotKey, /^released:/);
}));

test("파기: 결제하지 않은 주문과 그 문진·고객, 보유기간 지난 문진을 지운다", async () => {
  const t = fakeTwenty();
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  t.s.people.push({ id: "p1", phones: { primaryPhoneNumber: "1055556666" } }, { id: "p2", phones: { primaryPhoneNumber: "1011112222" } });
  t.s.orders.push({ id: "o1", name: "BR1", orderStatus: "PENDING", createdAt: old, customerId: "p1" }, { id: "o2", name: "BR2", orderStatus: "PAID", createdAt: old, customerId: "p2" });
  t.s.intakes.push({ id: "i1", clinicOrderId: "o1", purgeAfter: "2099-01-01" }, { id: "i2", clinicOrderId: "o2", purgeAfter: "2000-01-01" });
  const r = await runPurge({ cfg, twenty: t });
  assert.deepEqual(r, { orders: 1, intakes: 2, people: 1 });
  assert.deepEqual(t.s.orders.map((o) => o.id), ["o2"]);
  assert.deepEqual(t.s.people.map((p) => p.id), ["p2"]);
});
