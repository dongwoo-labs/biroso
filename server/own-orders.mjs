// 자체 CRM이 업무 트랜잭션을 맡는다. 비로소는 검증된 응답을 받은 경우에만 다음 PG/CRM 단계를 실행한다.
import { createHash } from "node:crypto";
import { newOrderNo, orderPaymentForm, prepareOrder, Rejected } from "./orders.mjs";
import { PAY_METHOD, PaymentError } from "./nicepay.mjs";
import { validCommandKey } from "./own-crm.mjs";
import { toConsentRecords, toIntake, toNewPerson } from "./schema.mjs";

const isWon = (amount) => Number.isSafeInteger(amount) && amount >= 0;
const isOrderNo = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const isId = (value) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export async function createOwnOrder(raw, ctx, { cfg, crm }) {
  const { v, phones, orderFields } = prepareOrder(raw, ctx, cfg);
  const orderNo = newOrderNo(ctx.now);
  let price;
  try {
    price = await crm.command("orders", orderNo, {
      orderNo, items: v.items, person: toNewPerson(v, phones),
      intake: { name: `${v.name} · 주문 ${orderNo}`, ...toIntake(v.intake, {}, cfg, ctx.now) },
      consents: toConsentRecords(v, undefined, ctx, ["PRIVACY", "SENSITIVE", "TERMS", "DOSAGE", "MARKETING"]),
      order: orderFields, shipping: cfg.shipping,
    });
  } catch (error) {
    if (error.status === 409 && error.code === "cart_changed") throw new Rejected(409, "cart_changed", "장바구니의 상품이나 수량이 바뀌었어요. 다시 확인해 주세요.");
    throw error;
  }
  if (price.orderNo !== orderNo || ![price.itemsAmount, price.shippingFee, price.totalAmount, price.taxFreeAmount].every(isWon) ||
      price.itemsAmount + price.shippingFee !== price.totalAmount || price.totalAmount === 0 || price.taxFreeAmount > price.itemsAmount ||
      typeof price.goodsName !== "string" || !price.goodsName) throw new Error("Own CRM invalid order result");
  return orderPaymentForm(cfg, v, phones, orderNo, price);
}

export async function completeOwnPayment(form, { cfg, crm, nicepay, log = () => {} }) {
  const orderNo = isOrderNo(form.orderId) ? form.orderId : "";
  const fail = (reason) => `${cfg.siteUrl}/order/fail/?reason=${encodeURIComponent(reason)}${orderNo ? `&no=${orderNo}` : ""}`;
  const complete = () => `${cfg.siteUrl}/order/complete/?no=${orderNo}`;
  const reconcile = (stage) => {
    log({ event: "own_payment_reconcile", orderNo, stage });
    return fail(`결제 결과를 확인 중이에요. 중복 결제하지 말고 ${cfg.tel}로 연락 주세요.`);
  };
  const { tid } = form;
  const amount = Number(form.amount);
  if (form.authResultCode !== "0000") return fail("결제가 취소됐어요.");
  if (!orderNo || !isOrderNo(tid) || !isWon(amount) || amount === 0 || form.clientId !== nicepay.clientId || !nicepay.verify(form)) {
    return fail("결제 확인에 실패했어요. 다시 시도해 주세요.");
  }
  const order = await crm.findOrder(orderNo);
  if (!order || !isId(order.id)) return fail("주문을 찾지 못했어요.");
  if (order.orderStatus !== "PENDING") return order.pgTid === tid ? complete() : fail("이미 처리된 주문이에요.");

  const path = `orders/${order.id}/payment`;
  const key = createHash("sha256").update(tid).digest("hex");
  let attempt;
  try {
    attempt = await crm.command(`${path}/start`, key, { tid, amount });
  } catch (error) {
    if (error.code === "amount_mismatch") return fail("결제 금액이 주문과 달라요. 다시 주문해 주세요.");
    return reconcile("start");
  }
  if (attempt.executePg !== true || attempt.orderId !== order.id || attempt.orderStatus !== "PENDING") return reconcile("start");
  let paid;
  try {
    paid = await nicepay.approveOwn(tid, amount, orderNo);
  } catch (error) {
    if (!(error instanceof PaymentError) || error.code !== "approve_declined") return reconcile("approval");
    try { await crm.command(`${path}/fail`, key, { tid }); }
    catch { return reconcile("record_decline"); }
    return fail("결제사가 승인을 거절했어요.");
  }
  try {
    const receipt = typeof paid.receiptUrl === "string" ? URL.parse(paid.receiptUrl) : null;
    const result = await crm.command(`${path}/approve`, key, {
      tid, amount, paidAt: new Date(paid.paidAt).toISOString(), payMethod: PAY_METHOD[paid.payMethod],
      receiptUrl: receipt?.protocol === "https:" && !receipt.username && !receipt.password ? receipt.href : undefined,
    });
    if (result.orderId !== order.id || result.orderStatus !== "PAID") return reconcile("record_approval");
    return complete();
  } catch { return reconcile("record_approval"); }
}

export async function refundOwnOrder(body, key, { cfg, crm, nicepay, log = () => {} }) {
  if (!validCommandKey(key)) throw new Rejected(400, "idempotency_key_required", "환불 요청의 Idempotency-Key가 필요해요. 같은 요청을 다시 확인할 때는 같은 키를 쓰세요.");
  const { orderNo } = body ?? {};
  if (!isOrderNo(orderNo)) throw new Rejected(400, "invalid", "주문번호를 확인해 주세요.");
  const reason = String(body.reason ?? "고객 요청").slice(0, 50);
  const amount = body.amount == null ? undefined : Number(body.amount);
  if ((amount !== undefined && (!isWon(amount) || amount === 0))) throw new Rejected(422, "bad_amount", "환불 금액을 원 단위로 확인해 주세요.");
  const order = await crm.findOrder(orderNo);
  if (!order || !isId(order.id)) throw new Rejected(404, "not_found", "주문을 찾지 못했어요.");
  const path = `orders/${order.id}/refunds`;
  const reconcile = (stage) => {
    log({ event: "own_refund_reconcile", orderNo, stage });
    return new Rejected(409, "refund_reconciliation_required", `환불 결과를 확인 중이에요. 다시 환불하지 말고 ${cfg.tel}로 연락 주세요.`);
  };
  let reservation;
  try {
    reservation = await crm.command(`${path}/reserve`, key, { reason, amount, force: body.force === true });
  } catch (error) {
    if (error.code === "bad_amount") throw new Rejected(422, "bad_amount", "환불 금액이 남은 금액을 초과해요.");
    if (error.code === "prescribed") throw new Rejected(409, "prescribed", "처방이 확정된 주문은 교환·반품 기준으로 처리해요. 그래도 환불하려면 force를 켜 주세요.");
    if (error.code === "idempotency_conflict") throw new Rejected(409, "idempotency_conflict", "같은 요청 키로 다른 환불을 보낼 수 없어요.");
    if (error.code === "refund_in_progress") throw reconcile("reserve");
    if (error.status === 409) throw new Rejected(409, "refund_conflict", "주문 상태를 확인한 뒤 환불해 주세요.");
    // 선점 응답이 유실됐을 수 있다. 다음 호출이 새 키나 PG 재호출을 유도하지 않게 한다.
    if (error.retryable) throw reconcile("reserve");
    throw error;
  }
  if (reservation.orderId !== order.id) throw reconcile("reserve");
  if (reservation.executePg === false && reservation.refundId === null && reservation.orderStatus === "CANCELLED") return { orderNo, refunded: 0 };
  const { refundId, amount: reserved, taxFreeAmount, fullCancel } = reservation;
  if (reservation.executePg !== true || !isId(refundId) || !isOrderNo(order.pgTid) || !isWon(reserved) || reserved === 0 ||
      (amount !== undefined && reserved !== amount) || !isWon(taxFreeAmount) || taxFreeAmount > reserved ||
      typeof fullCancel !== "boolean") throw reconcile("reserve");
  let cancelled;
  try {
    // 부분 취소에는 PG에서 중복되지 않는 취소 요청 번호를 쓴다. 원거래는 tid로 지정한다.
    cancelled = await nicepay.cancelOwn({ tid: order.pgTid, orderId: fullCancel ? orderNo : `RF${refundId.replaceAll("-", "")}`,
      reason, amount: reserved, taxFreeAmount, fullCancel });
  } catch (error) {
    if (!(error instanceof PaymentError) || error.code !== "refund_declined") throw reconcile("provider");
    try { await crm.command(`${path}/fail`, refundId, { refundId }); }
    catch { throw reconcile("record_decline"); }
    throw new Rejected(409, "refund_declined", "결제사가 환불 요청을 거절했어요.");
  }
  try {
    const result = await crm.command(`${path}/complete`, refundId, { refundId });
    if (result.orderId !== order.id || result.refundId !== refundId || !isWon(result.refundedTotal) || !isWon(result.remaining)) {
      throw new Error("Own CRM invalid refund result");
    }
    return { orderNo, refunded: reserved, refundedTotal: result.refundedTotal, remaining: result.remaining, balance: cancelled.balanceAmt };
  } catch { throw reconcile("record_refund"); }
}
