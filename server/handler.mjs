// API 라우터 (node:http 형식의 (req, res) 처리 함수). Vercel 함수(api/v1/*.mjs)가 그대로 쓴다.
//   POST /v1/orders              주문서 제출 → 결제 대기 주문 + 결제창 값
//   POST /v1/payments/return     나이스페이 결제창 인증 결과(form POST) → 승인 → 완료/실패 페이지로 이동
//   POST /v1/orders/refund       환불(Bearer ADMIN_SECRET, Twenty 워크플로용)
//   GET  /v1/slots?date=         진료 예약 가능 시간
//   GET  /v1/closures            휴진일
//   POST /v1/appointments        진료 예약
//   GET  /v1/purge               파기 작업(Bearer CRON_SECRET, Vercel 크론)
//   GET  /healthz

import { loadConfig } from "./config.mjs";
import { createTwenty } from "./twenty.mjs";
import { createNicepay } from "./nicepay.mjs";
import { createOrder, completePayment, refundOrder, Rejected } from "./orders.mjs";
import { createAppointment, getSlots, getClosures } from "./appointments.mjs";
import { runPurge } from "./purge.mjs";

const MAX_BODY = 32 * 1024;

export function createRateLimiter(limit, windowMs = 10 * 60 * 1000) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 50_000) hits.clear();
    return true;
  };
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) return null; chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}

export function createHandler(cfg = loadConfig(), deps = {}) {
  const twenty = deps.twenty ?? createTwenty(cfg);
  const nicepay = deps.nicepay ?? (cfg.nicepay ? createNicepay(cfg.nicepay) : null);
  const allow = createRateLimiter(cfg.rateLimitPer10Min);
  const log = deps.log ?? ((o) => console.log(JSON.stringify(o)));
  const ctxDeps = { cfg, twenty, nicepay, log };

  return async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin && cfg.allowedOrigins.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" }
      : {};
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors });
      res.end(JSON.stringify(body));
    };
    const redirect = (to) => { res.writeHead(303, { Location: to, "Cache-Control": "no-store" }); res.end(); };
    const url = new URL(req.url ?? "/", "http://x");
    // Vercel에서는 /api/v1/... 로 들어온다
    const path = url.pathname.replace(/^\/api(?=\/)/, "").replace(/\/$/, "");
    const now = new Date();
    const ctx = { ip: (cfg.trustProxy && String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()) || req.socket?.remoteAddress || "", now };
    const fail = (e) => {
      if (e instanceof Rejected) return send(e.status, { error: e.code, message: e.message, fields: e.fields });
      log({ ts: now.toISOString(), event: "api_error", path, error: e.message });
      return send(502, { error: "upstream", message: `처리 중 문제가 생겼어요. ${cfg.tel}로 전화 주시면 바로 도와드릴게요.` });
    };
    const bearer = (secret) => Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;

    if (req.method === "GET" && path === "/healthz") return send(200, { ok: true, payment: Boolean(nicepay) });

    // 나이스페이가 결제창에서 바로 보내는 form POST. 출처가 결제창이라 Origin 검사 대신 서명·금액으로 확인한다.
    if (path === "/v1/payments/return") {
      if (req.method !== "POST" || !nicepay) return redirect(`${cfg.siteUrl}/order/fail/?reason=${encodeURIComponent("결제를 받을 수 없어요.")}`);
      const raw = await readBody(req).catch(() => null);
      const form = Object.fromEntries(new URLSearchParams(raw ?? ""));
      try { return redirect(await completePayment(form, ctxDeps)); }
      catch (e) {
        log({ ts: now.toISOString(), event: "payment_error", orderNo: form.orderId, error: e.message });
        return redirect(`${cfg.siteUrl}/order/fail/?no=${encodeURIComponent(form.orderId ?? "")}&reason=${encodeURIComponent(`결제 확인 중 문제가 생겼어요. ${cfg.tel}로 연락 주세요.`)}`);
      }
    }
    if (path === "/v1/purge") {
      if (!bearer(cfg.cronSecret)) return send(401, { error: "unauthorized" });
      try { return send(200, await runPurge(ctxDeps, now)); } catch (e) { return fail(e); }
    }
    if (path === "/v1/orders/refund") {
      if (!bearer(cfg.adminSecret) || !nicepay) return send(401, { error: "unauthorized" });
      try {
        const body = JSON.parse((await readBody(req)) ?? "{}");
        const r = await refundOrder(body, ctxDeps, now);
        log({ ts: now.toISOString(), event: "order_refunded", orderNo: r.orderNo, refunded: r.refunded });
        return send(200, r);
      } catch (e) { return e instanceof SyntaxError ? send(400, { error: "bad_json" }) : fail(e); }
    }

    if (!["/v1/orders", "/v1/appointments", "/v1/slots", "/v1/closures"].includes(path)) return send(404, { error: "not_found" });
    if (req.method === "OPTIONS") { res.writeHead(origin && cors["Access-Control-Allow-Origin"] ? 204 : 403, cors); return res.end(); }
    if (origin && !cors["Access-Control-Allow-Origin"]) return send(403, { error: "origin_not_allowed" });

    if (req.method === "GET" && path === "/v1/slots") {
      try { return send(200, await getSlots(url.searchParams.get("date") ?? "", ctxDeps, now)); } catch (e) { return fail(e); }
    }
    if (req.method === "GET" && path === "/v1/closures") {
      try { return send(200, await getClosures(ctxDeps, now)); } catch (e) { return fail(e); }
    }
    if (req.method !== "POST" || path === "/v1/slots" || path === "/v1/closures") return send(405, { error: "method_not_allowed" });
    if (!allow(ctx.ip)) return send(429, { error: "too_many_requests", message: `잠시 후 다시 시도해 주세요. 급하시면 ${cfg.tel}로 전화 주세요.` });

    let body;
    try {
      const raw = await readBody(req);
      if (raw === null) return send(413, { error: "too_large" });
      body = JSON.parse(raw);
    } catch { return send(400, { error: "bad_json" }); }

    try {
      if (path === "/v1/orders") {
        const r = await createOrder(body, ctx, ctxDeps);
        // 로그에는 개인정보를 남기지 않는다
        log({ ts: now.toISOString(), event: "order_created", orderNo: r.orderNo, amount: r.amounts.total });
        return send(201, r);
      }
      const r = await createAppointment(body, ctx, ctxDeps);
      log({ ts: now.toISOString(), event: "appointment_created", appointmentId: r.appointmentId });
      return send(201, { ok: true, label: r.label, message: "진료 예약을 받았어요. 예약 시간에 맞춰 연락드리거나 기다릴게요." });
    } catch (e) { return fail(e); }
  };
}
