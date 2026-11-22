import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../server/config.mjs";
import { createNicepay } from "../server/nicepay.mjs";
import { completeOwnPayment, createOwnOrder, refundOwnOrder } from "../server/own-orders.mjs";

const cfg = loadConfig({ SITE_URL: "https://clinic.test.invalid", NICEPAY_CLIENT_ID: "fixture", MIN_FILL_MS: "0" });
const orderId = "11111111-1111-4111-8111-111111111111", refundId = "22222222-2222-4222-8222-222222222222";
const orderNo = "BR261122ABCDEF", tid = "fixture-tid", noResult = () => { throw new Error("unexpected call"); };
const form = { authResultCode: "0000", orderId: orderNo, tid, amount: "12000", clientId: "fixture" };
const paid = { resultCode: "0000", status: "paid", amount: 12000, orderId: orderNo, tid, paidAt: "2026-11-22T12:00:00+09:00", payMethod: "card" };
const start = { orderId, orderStatus: "PENDING", executePg: true };
const reserve = { orderId, orderStatus: "PAID", refundId, amount: 3000, taxFreeAmount: 2000, fullCancel: false, executePg: true };
const pathOf = (value) => new URL(value).pathname;

function fixture({ orderStatus = "PENDING", pgTid, command = noResult, pg = noResult } = {}) {
  const commands = [], payments = [], logs = [];
  const gateway = createNicepay({ clientId: "fixture", secretKey: "fixture", apiUrl: "https://pg.test.invalid" }, async (url, options) => {
    const body = JSON.parse(options.body);
    payments.push({ path: pathOf(url), body, redirect: options.redirect });
    return pg(body);
  });
  return {
    commands, payments, logs, cfg, nicepay: { ...gateway, verify: () => true }, log: (record) => logs.push(record),
    crm: { findOrder: async () => ({ id: orderId, orderStatus, pgTid }), command: async (path, key, body) => {
      commands.push({ path, key, body: JSON.parse(JSON.stringify(body)) });
      return command(path, key, body);
    } },
  };
}

test("주문은 고객·문진·동의를 한 명령에 보내고 CRM이 계산한 가격을 결제창에 전달한다", async () => {
  const now = new Date("2026-11-22T10:00:00.000Z");
  const raw = { name: "합성 고객", phone: "010-1234-5678", pickup: true, items: [{ slug: "fixture-item", qty: 2, price: 1 }],
    intake: { sex: "M", birthYear: 1990, diseases: ["NONE"], recentMeds: ["NONE"] },
    consents: { privacy: true, sensitive: true, terms: true, dosage: true, marketing: false }, noticeVersion: cfg.noticeVersions[0], formOpenedAt: now.getTime() - 10_000 };
  const d = fixture({ command: (_path, _key, b) => ({ orderNo: b.orderNo, orderId, itemsAmount: 12000, shippingFee: 0, totalAmount: 12000, taxFreeAmount: 12000, goodsName: "합성 상품" }) });
  const result = await createOwnOrder(raw, { now, ip: "127.0.0.1" }, d);
  assert.equal(d.commands.length, 1);
  const [{ path, key, body }] = d.commands;
  assert.equal(path, "orders");
  assert.equal(key, body.orderNo);
  assert.equal(result.pay.amount, 12000);
  assert.equal(result.pay.goodsName, "합성 상품");
  assert.deepEqual(body.items, [{ slug: "fixture-item", qty: 2 }]);
  assert.equal(body.person.phones.primaryPhoneNumber, "1012345678");
  assert.equal(body.order.deliveryMethod, "PICKUP");
  assert.equal(Object.hasOwn(body.order, "shippingAddress"), false);
  assert.equal(Object.hasOwn(body.intake, "clinicOrderId"), false);
  assert.ok(body.consents.every((row) => !Object.hasOwn(row, "personId")));
  assert.equal(body.consents.length, 5);
});

test("결제는 CRM 선점이 허용한 때만 PG를 호출하고 검증된 승인만 기록한다", async () => {
  const d = fixture({ command: (path) => path.endsWith("/start") ? start : { orderId, orderStatus: "PAID" }, pg: () => Response.json(paid) });
  assert.equal(pathOf(await completeOwnPayment(form, d)), "/order/complete/");
  assert.deepEqual(d.commands.map((c) => c.path.split("/").at(-1)), ["start", "approve"]);
  assert.equal(d.commands[0].key, d.commands[1].key);
  assert.deepEqual(d.commands[1].body, { tid, amount: 12000, paidAt: "2026-11-22T03:00:00.000Z", payMethod: "CARD" });
  assert.deepEqual(d.payments, [{ path: `/v1/payments/${tid}`, body: { amount: 12000 }, redirect: "error" }]);
  const replay = fixture({ command: () => ({ ...start, executePg: false }) });
  assert.equal(pathOf(await completeOwnPayment(form, replay)), "/order/fail/");
  assert.equal(replay.payments.length, 0);
  assert.equal(replay.commands[0].key, d.commands[0].key);
  const settled = fixture({ orderStatus: "PAID", pgTid: tid });
  assert.equal(pathOf(await completeOwnPayment(form, settled)), "/order/complete/");
  assert.equal(settled.commands.length, 0);
  assert.equal(settled.payments.length, 0);
});

test("PG 불명확·다른 TID·CRM 기록 유실에는 승인이나 자동취소를 다시 호출하지 않는다", async () => {
  for (const [pg, expected] of [
    [() => { throw new Error("disconnect"); }, ["start"]],
    [() => Response.json({ ...paid, orderId: "ANOTHER" }), ["start"]],
    [() => Response.json({ ...paid, tid: "another-tid" }), ["start"]],
    [() => Response.json(paid), ["start", "approve"]],
  ]) {
    const d = fixture({ command: (path) => path.endsWith("/start") ? start : noResult(), pg });
    assert.equal(pathOf(await completeOwnPayment(form, d)), "/order/fail/");
    assert.equal(d.payments.length, 1);
    assert.deepEqual(d.commands.map((c) => c.path.split("/").at(-1)), expected);
    assert.equal(d.logs[0].event, "own_payment_reconcile");
  }
});

test("PG가 같은 거래의 승인을 명시적으로 거절한 경우만 payment/fail을 기록한다", async () => {
  const d = fixture({ command: (path) => path.endsWith("/start") ? start : { orderId, orderStatus: "PENDING" },
    pg: () => Response.json({ ...paid, status: "failed", resultCode: "U311" }, { status: 400 }) });
  assert.equal(pathOf(await completeOwnPayment(form, d)), "/order/fail/");
  assert.deepEqual(d.commands.map((c) => c.path.split("/").at(-1)), ["start", "fail"]);
  assert.equal(d.payments.length, 1);
});

test("부분 환불은 선점한 금액의 PG 확인 후 완료하며, 동일 요청 재입력에는 PG를 호출하지 않는다", async () => {
  const partial = fixture({ orderStatus: "PAID", pgTid: tid, command: (path) => path.endsWith("/reserve") ? reserve
    : { orderId, refundId, refundedTotal: 3000, remaining: 9000 }, pg: (b) => Response.json({ resultCode: "0000", orderId: b.orderId, tid,
      cancelledTid: "pg-cancel", cancels: [{ tid: "pg-cancel", amount: 3000 }], balanceAmt: 9000, status: "partialCancelled" }) });
  const request = { orderNo, amount: 3000 };
  assert.deepEqual(await refundOwnOrder(request, "caller-refund-1", partial), { orderNo, refunded: 3000, refundedTotal: 3000, remaining: 9000, balance: 9000 });
  assert.deepEqual(partial.commands.map((c) => c.key), ["caller-refund-1", refundId]);
  assert.deepEqual(partial.payments[0].body, { reason: "고객 요청", orderId: "RF22222222222242228222222222222222", cancelAmt: 3000, taxFreeAmt: 2000 });
  const replay = fixture({ orderStatus: "PAID", pgTid: tid, command: () => ({ ...reserve, executePg: false }) });
  await assert.rejects(refundOwnOrder(request, "caller-refund-1", replay), { code: "refund_reconciliation_required" });
  assert.equal(replay.payments.length, 0);
  const pending = fixture({ command: () => ({ orderId, orderStatus: "CANCELLED", executePg: false, refundId: null }) });
  assert.deepEqual(await refundOwnOrder({ orderNo }, "caller-2", pending), { orderNo, refunded: 0 });
  assert.equal(pending.payments.length, 0);
  await assert.rejects(refundOwnOrder(request, undefined, partial), { code: "idempotency_key_required" });
  assert.equal(partial.payments.length, 1);
});

test("환불 응답이 불명확하거나 다른 취소 건이면 선점을 유지하고, 확정 금액 거절만 fail로 처리한다", async () => {
  for (const [pg, code, actions] of [
    [() => { throw new Error("disconnect"); }, "refund_reconciliation_required", ["reserve"]],
    [(b) => Response.json({ resultCode: "0000", orderId: b.orderId, tid, balanceAmt: 9000, status: "partialCancelled",
      cancelledTid: "unexpected", cancels: [{ tid: "different", amount: 3000 }] }), "refund_reconciliation_required", ["reserve"]],
    [(b) => Response.json({ resultCode: "U319", orderId: b.orderId, tid }, { status: 400 }), "refund_declined", ["reserve", "fail"]],
  ]) {
    const d = fixture({ orderStatus: "PAID", pgTid: tid, command: (path) => path.endsWith("/reserve") ? reserve : { orderId, refundId }, pg });
    await assert.rejects(refundOwnOrder({ orderNo, amount: 3000 }, "caller-refund-1", d), { code });
    assert.deepEqual(d.commands.map((c) => c.path.split("/").at(-1)), actions);
    assert.equal(d.payments.length, 1);
  }
});
