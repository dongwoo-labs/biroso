// 진료기록 이상 알림과 매일 검증 기준값 보내기(관리자·원장).
// 받는 곳(설정한 것 모두에 보낸다):
//   문자   솔라피(CHART_ALERT_SOLAPI_API_KEY·SECRET, CHART_ALERT_SMS_FROM 등록 발신번호, CHART_ALERT_SMS_TO 받는 번호들)
//          키 받기 전 시험은 CHART_ALERT_SOLAPI_URL=http://fake-channels:3900 (crm 가짜 발송 서버). 운영은 비워 둔다
//   웹훅   CHART_ALERT_WEBHOOK_URL (슬랙·디스코드 호환 {text, content})
// 매일 보내는 '이상 없음 + 기준값'은 CHART_ANCHOR_SMS_TO(없으면 CHART_ALERT_SMS_TO)로 간다. 원장 휴대폰으로 받으면
// 관리자가 서버의 장부·로그를 함께 고쳐도 원장이 가진 기준값과 맞지 않아 드러난다.
// 글에는 환자 이름·진료 내용을 넣지 않는다(기록 ID 앞 8자리, 건수, 해시만).
import { createHmac, randomBytes } from "node:crypto";

export function solapiAuth(apiKey, apiSecret, now = new Date()) {
  const date = now.toISOString();
  const salt = randomBytes(16).toString("hex");
  const signature = createHmac("sha256", apiSecret).update(date + salt).digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

const digits = (s) => String(s ?? "").replace(/\D/g, "");
const list = (s) => String(s ?? "").split(",").map(digits).filter(Boolean);

export function alertConfig(env = process.env) {
  return {
    webhookUrl: env.CHART_ALERT_WEBHOOK_URL ?? "",
    solapi: { apiKey: env.CHART_ALERT_SOLAPI_API_KEY ?? "", apiSecret: env.CHART_ALERT_SOLAPI_API_SECRET ?? "", from: digits(env.CHART_ALERT_SMS_FROM), url: (env.CHART_ALERT_SOLAPI_URL || "https://api.solapi.com").replace(/\/+$/, "") },
    to: list(env.CHART_ALERT_SMS_TO),
    anchorTo: list(env.CHART_ANCHOR_SMS_TO),
    prefix: env.CHART_ALERT_PREFIX ?? "비로소한의원",
  };
}

// alert(text, { daily }) → 보낸 곳 목록. 아무 곳도 설정하지 않았으면 로그에만 남긴다.
export function createAlert(cfg, { log = () => {} } = {}, fetchImpl = fetch) {
  const sms = Boolean(cfg.solapi?.apiKey && cfg.solapi.apiSecret && cfg.solapi.from);
  return async function alert(text, { daily = false } = {}) {
    const body = `${cfg.prefix} ${text}`;
    const to = daily && cfg.anchorTo?.length ? cfg.anchorTo : cfg.to ?? [];
    const sent = [];
    const jobs = [];
    if (sms && to.length) {
      jobs.push(fetchImpl(`${cfg.solapi.url ?? "https://api.solapi.com"}/messages/v4/send-many/detail`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: solapiAuth(cfg.solapi.apiKey, cfg.solapi.apiSecret) },
        body: JSON.stringify({ messages: to.map((n) => ({ to: n, from: cfg.solapi.from, text: body, ...(body.length > 45 ? { type: "LMS", subject: "진료기록 점검" } : {}) })) }),
      }).then(async (r) => { if (!r.ok) throw new Error(`solapi ${r.status} ${await r.text()}`); sent.push("sms"); }));
    }
    if (cfg.webhookUrl) {
      jobs.push(fetchImpl(cfg.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: body, content: body }) })
        .then((r) => { if (!r.ok) throw new Error(`webhook ${r.status}`); sent.push("webhook"); }));
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === "rejected") log({ ts: new Date().toISOString(), event: "chart_alert_failed", error: r.reason?.message });
    log({ ts: new Date().toISOString(), event: daily ? "chart_anchor" : "chart_alert", text: body, sent });
    return sent;
  };
}
