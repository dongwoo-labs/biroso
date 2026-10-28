// 주문 → 결제 → 승인. 원본 사이트와 같은 흐름이다:
//   상품 결제(처방 신청) → 원장님 전화 진료 → 처방 확정·조제 → 발송.
// 처방 확정 전에는 전액 환불할 수 있다(직원이 Twenty에서 환불을 요청하면 refundOrder가 처리).

import { randomBytes } from "node:crypto";
import { orderSchema, normalizeMobile, toNewPerson, toIntake, toConsentRecords, fieldErrors } from "./schema.mjs";
import { priceOrder, PricingError } from "./pricing.mjs";
import { METHOD, PAY_METHOD, PaymentError } from "./nicepay.mjs";
import { money } from "./twenty.mjs";

export class Rejected extends Error {
  constructor(status, code, message, fields) {
    super(message);
    Object.assign(this, { status, code, fields });
  }
}

// 주문번호: BR + 한국 날짜 + 임의 6자(나이스페이 orderId는 64바이트 이하, 영문·숫자)
export function newOrderNo(now = new Date()) {
  const d = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(2, 10).replace(/-/g, "");
  return `BR${d}${randomBytes(4).toString("hex").slice(0, 6).toUpperCase()}`;
}

export function checkCommon(parsed, ctx, cfg) {
  if (!parsed.success) {
    const fields = fieldErrors(parsed.error);
    if (fields.website) throw new Rejected(400, "rejected", "요청을 처리할 수 없어요.");
    throw new Rejected(422, "invalid", "입력값을 확인해 주세요.", fields);
  }
  const v = parsed.data;
  if (ctx.now.getTime() - v.formOpenedAt < cfg.minFillMs) throw new Rejected(400, "rejected", "요청을 처리할 수 없어요.");
  if (!cfg.noticeVersions.includes(v.noticeVersion)) {
    throw new Rejected(409, "stale_notice", "안내문이 바뀌었어요. 페이지를 새로 고친 뒤 다시 시도해 주세요.");
  }
  const phones = normalizeMobile(v.phone);
  if (!phones) throw new Rejected(422, "invalid", "입력값을 확인해 주세요.", { phone: "휴대폰 번호를 확인해 주세요. 예: 010-1234-5678" });
  return { v, phones };
}

// 같은 번호의 고객이 있으면 그 고객에 붙인다. 이름·유입 정보는 첫 기록을 그대로 둔다.
export async function upsertPerson(v, phones, twenty) {
  const existing = await twenty.findPersonByPhone(phones.primaryPhoneNumber);
  if (!existing) return (await twenty.createPerson(toNewPerson(v, phones))).id;
  if (v.consents.marketing && !existing.consentMarketing) await twenty.updatePerson(existing.id, { consentMarketing: true });
  return existing.id;
}

// 주문서 제출: 결제 대기 주문을 만들고 결제창에 넘길 값을 돌려준다
export async function createOrder(raw, ctx, { cfg, twenty }) {
  if (!cfg.nicepay) throw new Rejected(503, "payment_off", `지금은 온라인 결제를 받지 않아요. ${cfg.tel}로 전화 주시면 도와드릴게요.`);
  const { v, phones } = checkCommon(orderSchema.safeParse(raw), ctx, cfg);
  const recipientPhones = v.pickup ? null : normalizeMobile(v.recipient.phone || v.phone);
  if (!v.pickup && !recipientPhones) throw new Rejected(422, "invalid", "입력값을 확인해 주세요.", { "recipient.phone": "받는 분 휴대폰 번호를 확인해 주세요." });

  let price;
  try {
    const products = await twenty.productsBySlugs([...new Set(v.items.map((i) => i.slug))]);
    price = priceOrder(v.items, products, { pickup: v.pickup, zip: v.recipient.zip }, cfg.shipping);
  } catch (e) {
    if (e instanceof PricingError) throw new Rejected(409, "cart_changed", e.message, e.slug ? { [`items.${e.slug}`]: e.message } : undefined);
    throw e;
  }

  const personId = await upsertPerson(v, phones, twenty);
  const orderNo = newOrderNo(ctx.now);
  const order = await twenty.createOrder({
    name: orderNo, orderStatus: "PENDING", customerId: personId,
    itemsSummary: price.itemsSummary, items: price.items,
    itemsAmount: money(price.itemsAmount), shippingFee: money(price.shippingFee),
    totalAmount: money(price.totalAmount), taxFreeAmount: money(price.taxFreeAmount),
    payMethod: v.payMethod, pickup: v.pickup, consultTime: v.consultTime,
    recipientName: v.pickup ? v.name : (v.recipient.name || v.name),
    recipientPhone: recipientPhones ?? phones,
    shippingAddress: v.pickup ? undefined : {
      addressStreet1: v.recipient.address1, addressStreet2: v.recipient.address2, addressPostcode: v.recipient.zip, addressCountry: "South Korea",
    },
    deliveryMemo: v.recipient.memo,
  });
  await twenty.createIntake({ name: `${v.name} · 주문 ${orderNo}`, ...toIntake(v.intake, { customerId: personId, clinicOrderId: order.id }, cfg, ctx.now) });
  for (const row of toConsentRecords(v, personId, ctx, ["PRIVACY", "SENSITIVE", "TERMS", "MARKETING"])) await twenty.createConsentRecord(row);

  return {
    orderNo,
    pay: {
      clientId: cfg.nicepay.clientId, method: METHOD[v.payMethod], orderId: orderNo,
      amount: price.totalAmount, taxFreeAmt: price.taxFreeAmount, goodsName: price.goodsName,
      returnUrl: `${cfg.siteUrl}/api/v1/payments/return`, buyerName: v.name, buyerTel: phones.primaryPhoneNumber,
    },
    amounts: { items: price.itemsAmount, shipping: price.shippingFee, total: price.totalAmount },
  };
}

const wonOf = (c) => (c?.amountMicros == null ? null : Math.round(c.amountMicros / 1_000_000));

// 결제창이 돌려준 인증 결과 처리: 서명·금액 확인 → 승인 → 주문을 결제 완료로.
// 돌려주는 값: 이동할 주소(완료 또는 실패 페이지)
export async function completePayment(form, { cfg, twenty, nicepay, log }) {
  const fail = (reason, orderNo = "") => `${cfg.siteUrl}/order/fail/?reason=${encodeURIComponent(reason)}${orderNo ? `&no=${encodeURIComponent(orderNo)}` : ""}`;
  const orderNo = String(form.orderId ?? "");
  if (form.authResultCode !== "0000") return fail(form.authResultMsg || "결제가 취소됐어요.", orderNo);
  if (form.clientId !== nicepay.clientId || !nicepay.verify(form)) {
    log({ event: "payment_bad_signature", orderNo });
    return fail("결제 확인에 실패했어요. 다시 시도해 주세요.", orderNo);
  }
  const order = await twenty.findOrder(orderNo);
  if (!order) return fail("주문을 찾지 못했어요.", orderNo);
  // 이미 승인된 주문(새로 고침·뒤로 가기)은 완료 페이지로 보낸다
  if (order.orderStatus !== "PENDING") return order.pgTid ? `${cfg.siteUrl}/order/complete/?no=${encodeURIComponent(orderNo)}` : fail("이미 처리된 주문이에요.", orderNo);
  const amount = wonOf(order.totalAmount);
  if (Number(form.amount) !== amount) {
    log({ event: "payment_amount_mismatch", orderNo, expected: amount, got: form.amount });
    return fail("결제 금액이 주문과 달라요. 다시 주문해 주세요.", orderNo);
  }

  let paid;
  try {
    paid = await nicepay.approve(form.tid, amount);
  } catch (e) {
    log({ event: "payment_approve_failed", orderNo, error: e.message });
    // 응답이 끊겨 승인 여부를 모르면 망취소로 되돌린다(1시간 안에만 가능)
    if (!(e instanceof PaymentError)) await nicepay.netCancel(orderNo).catch(() => {});
    return fail(e instanceof PaymentError ? e.message : "결제 승인 중 문제가 생겼어요. 결제되지 않았어요.", orderNo);
  }

  try {
    await twenty.updateOrder(order.id, {
      orderStatus: "PAID", pgTid: paid.tid, paidAt: paid.paidAt && paid.paidAt !== "0" ? paid.paidAt : new Date().toISOString(),
      payMethod: PAY_METHOD[paid.payMethod] ?? order.payMethod,
      receiptUrl: paid.receiptUrl ? { primaryLinkUrl: paid.receiptUrl, primaryLinkLabel: "매출전표", secondaryLinks: [] } : undefined,
    });
  } catch (e) {
    // 돈은 빠졌는데 주문 기록이 안 된 상태를 남기지 않는다
    log({ event: "payment_record_failed", orderNo, error: e.message });
    await nicepay.cancel(paid.tid, orderNo, "주문 기록 실패로 자동 취소").catch((c) => log({ event: "payment_autocancel_failed", orderNo, error: c.message }));
    return fail(`결제를 기록하지 못해 자동으로 취소했어요. ${cfg.tel}로 연락 주세요.`, orderNo);
  }
  log({ event: "order_paid", orderNo, amount });
  return `${cfg.siteUrl}/order/complete/?no=${encodeURIComponent(orderNo)}`;
}

// 환불(처방 확정 전 취소). Twenty 워크플로나 직원 도구가 ADMIN_SECRET으로 부른다.
export async function refundOrder(body, { twenty, nicepay }, now = new Date()) {
  const orderNo = String(body?.orderNo ?? "");
  const reason = String(body?.reason ?? "고객 요청").slice(0, 50);
  const order = await twenty.findOrder(orderNo);
  if (!order) throw new Rejected(404, "not_found", "주문을 찾지 못했어요.");
  if (order.orderStatus === "REFUNDED") return { orderNo, already: true };
  if (order.orderStatus === "PENDING") {
    await twenty.updateOrder(order.id, { orderStatus: "CANCELLED", cancelReason: reason, cancelledAt: now.toISOString() });
    return { orderNo, refunded: 0 };
  }
  if (!order.pgTid) throw new Rejected(409, "no_payment", "결제 기록이 없어 환불할 수 없어요.");
  // 처방 확정 뒤에는 조제가 시작돼 교환·반품 기준으로 처리한다(원본 사이트 주문 취소 안내). 강제로 하려면 force.
  if (["PRESCRIBED", "SHIPPED", "DONE"].includes(order.orderStatus) && !body.force) {
    throw new Rejected(409, "prescribed", "처방이 확정된 주문은 교환·반품 기준으로 처리해요. 그래도 환불하려면 force를 켜 주세요.");
  }
  const amount = body.amount ? Number(body.amount) : undefined;
  const r = await nicepay.cancel(order.pgTid, orderNo, reason, amount);
  await twenty.updateOrder(order.id, { orderStatus: "REFUNDED", cancelReason: reason, cancelledAt: now.toISOString() });
  return { orderNo, refunded: amount ?? wonOf(order.totalAmount), balance: r.balanceAmt };
}
