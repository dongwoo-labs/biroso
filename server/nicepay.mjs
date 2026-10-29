// 나이스페이 결제창(Server 승인 모델) 연동
//   1) 화면이 AUTHNICE.requestPay로 결제창을 연다(clientId, orderId, amount, goodsName, returnUrl)
//   2) 인증이 끝나면 나이스페이가 returnUrl로 authResultCode·tid·amount·authToken·signature를 POST한다
//   3) 서버가 서명과 금액을 확인한 뒤 승인 API(POST /v1/payments/{tid})를 부른다
// 문서: https://github.com/nicepayments/nicepay-manual (api/payment-window-server.md, api/cancel.md)

import { createHash, timingSafeEqual } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export class PaymentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// 인증 결과 서명: hex(sha256(authToken + clientId + amount + SecretKey))
export function verifyAuthSignature({ authToken, clientId, amount, signature }, secretKey) {
  if (!authToken || !signature) return false;
  const want = Buffer.from(sha256(`${authToken}${clientId}${amount}${secretKey}`));
  const got = Buffer.from(String(signature));
  return want.length === got.length && timingSafeEqual(want, got);
}

// 결제 수단: 화면 값 → 결제창 method
export const METHOD = { CARD: "card", KAKAOPAY: "kakaopay", NAVERPAY: "naverpayCard" };
// 승인 응답 payMethod → Twenty 결제 수단
export const PAY_METHOD = { card: "CARD", kakaopay: "KAKAOPAY", naverpay: "NAVERPAY", bank: "BANK" };

export function createNicepay({ clientId, secretKey, apiUrl }, fetchImpl = fetch) {
  const auth = `Basic ${Buffer.from(`${clientId}:${secretKey}`).toString("base64")}`;
  async function call(path, body) {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new PaymentError("bad_response", `나이스페이 응답을 읽지 못했어요 (${res.status})`); }
    return json;
  }
  return {
    clientId,
    verify: (fields) => verifyAuthSignature(fields, secretKey),
    // 결제창이 돌려준 orderId는 서명에 들어가지 않으므로, 승인 응답의 orderId가 우리 주문과 같은지 확인한다.
    // 다르면(같은 금액의 다른 주문으로 바꿔치기) 승인된 결제를 바로 취소한다.
    async approve(tid, amount, orderId) {
      const r = await call(`/v1/payments/${encodeURIComponent(tid)}`, { amount });
      if (r.resultCode !== "0000" || r.status !== "paid" || Number(r.amount) !== Number(amount)) {
        throw new PaymentError("approve_failed", r.resultMsg || "결제 승인에 실패했어요.");
      }
      if (r.orderId !== orderId) {
        // 취소가 실패하면 망취소로 한 번 더 시도하고, 그래도 안 되면 '해결 안 됨'으로 알린다(직원 확인 필요)
        let cancelError = null;
        try {
          await this.cancel(r.tid ?? tid, r.orderId, "주문 정보 불일치로 자동 취소");
        } catch (c) {
          const nc = await this.netCancel(r.orderId).catch((n) => ({ resultMsg: n.message }));
          if (nc?.resultCode !== "0000") cancelError = `${c.message} / 망취소: ${nc?.resultCode ?? ""} ${nc?.resultMsg ?? ""}`.trim();
        }
        const err = cancelError
          ? new PaymentError("unresolved", "결제 정보가 주문과 달라 결제를 취소하려 했지만 확인하지 못했어요.")
          : new PaymentError("order_mismatch", "결제 정보가 주문과 달라요. 결제는 취소했어요.");
        Object.assign(err, { paidOrderId: r.orderId, paidTid: r.tid ?? tid, cancelError });
        throw err;
      }
      return r;
    },
    // cancelAmt가 없으면 전액 취소. 부분 취소면 그중 면세 금액(taxFreeAmt)을 함께 보낸다.
    async cancel(tid, orderId, reason, cancelAmt, taxFreeAmt) {
      const body = { reason: String(reason).slice(0, 50), orderId };
      if (cancelAmt) body.cancelAmt = cancelAmt;
      if (cancelAmt && taxFreeAmt) body.taxFreeAmt = taxFreeAmt;
      const r = await call(`/v1/payments/${encodeURIComponent(tid)}/cancel`, body);
      if (r.resultCode !== "0000") throw new PaymentError("cancel_failed", r.resultMsg || "결제 취소에 실패했어요.");
      return r;
    },
    // 승인 결과가 불확실할 때(응답 끊김 등) 1시간 안에만 쓸 수 있는 망취소
    netCancel: (orderId) => call("/v1/payments/netcancel", { orderId }),
  };
}
