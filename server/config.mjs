// 환경변수에서 설정을 읽는다. 기본값은 로컬 개발용이다.
import clinic from "../src/data/clinic.json" with { type: "json" };

const list = (v, d) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);

// Vercel에 배포하면 그 배포 주소(미리보기·운영)를 허용 목록에 자동으로 더한다.
const vercelOrigins = (env) =>
  [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean).map((h) => `https://${h}`);

export function loadConfig(env = process.env) {
  const siteUrl = (env.SITE_URL ?? (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:4321")).replace(/\/$/, "");
  const clientId = env.NICEPAY_CLIENT_ID ?? "";
  return {
    port: Number(env.PORT ?? 8788),
    twentyUrl: (env.TWENTY_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    twentyApiKey: env.TWENTY_API_KEY ?? "",
    siteUrl,
    allowedOrigins: [...list(env.ALLOWED_ORIGINS, "http://localhost:4321"), siteUrl, ...vercelOrigins(env)].map((o) => new URL(o).origin),
    // 현재 게시 중인 동의문 버전. 화면이 다른 버전을 보내면 거절한다(src/data/notice.json의 version과 같아야 한다).
    noticeVersions: list(env.NOTICE_VERSIONS, "2026-11-02"),
    rateLimitPer10Min: Number(env.RATE_LIMIT_PER_10MIN ?? 10),
    minFillMs: Number(env.MIN_FILL_MS ?? 2500),
    trustProxy: env.TRUST_PROXY === "1" || env.VERCEL === "1",
    // 문진(건강정보) 보유기간(일). 처리방침에 적은 기간과 같아야 한다. 진료 기록은 한의원 전자차트에 따로 남긴다.
    intakeRetentionDays: Number(env.INTAKE_RETENTION_DAYS ?? 365),
    // 빠른 상담 신청(이름·휴대폰) 보관 기간(일). 처리방침(src/data/notice.json의 consult)과 같아야 한다.
    consultRetentionDays: Number(env.QUICK_CONSULT_RETENTION_DAYS ?? 90),
    // 결제하지 않고 떠난 주문(결제 대기)을 지우기까지의 시간
    pendingOrderHours: Number(env.PENDING_ORDER_HOURS ?? 24),
    // 나이스페이 결제창(Server 승인). 샌드박스 키(S1_/S2_로 시작)면 샌드박스 API로 승인한다.
    nicepay: clientId ? {
      clientId,
      secretKey: env.NICEPAY_SECRET_KEY ?? "",
      apiUrl: (env.NICEPAY_API_URL ?? (/^S\d_/.test(clientId) ? "https://sandbox-api.nicepay.co.kr" : "https://api.nicepay.co.kr")).replace(/\/$/, ""),
    } : null,
    shipping: clinic.shipping,
    hours: clinic.hours,
    // 진료 예약 칸 길이(분), 한 칸에 받을 수 있는 예약 수, 지금부터 몇 시간 뒤부터 받을지, 며칠 뒤까지 받을지
    slotMinutes: Number(env.SLOT_MINUTES ?? 30),
    slotCapacity: Number(env.SLOT_CAPACITY ?? 1),
    slotLeadHours: Number(env.SLOT_LEAD_HOURS ?? 2),
    slotDays: Number(env.SLOT_DAYS ?? 30),
    // Vercel 크론(CRON_SECRET), Twenty 워크플로의 환불 요청(ADMIN_SECRET)
    cronSecret: env.CRON_SECRET ?? "",
    adminSecret: env.ADMIN_SECRET ?? "",
    tel: clinic.tel,
  };
}
