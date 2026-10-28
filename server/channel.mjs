// 주문·예약 고객이 어디서 왔는지(유입 경로) 판단한다. 렌탈ON lead-api의 channel.mjs와 같은 규칙이다.
// 우선순위: 광고 클릭 ID → 홍보 링크(UTM) → 이전 사이트 주소(리퍼러) → 직접 방문.
// 구글은 검색어를 넘기지 않고, 네이버·다음은 일부만 넘긴다. 정확한 검색어는 서치 콘솔·서치어드바이저에서 본다.

export const CHANNELS = [
  ["AD", "유료 광고"],
  ["NAVER_SEARCH", "네이버 검색"],
  ["GOOGLE_SEARCH", "구글 검색"],
  ["OTHER_SEARCH", "기타 검색(다음·빙 등)"],
  ["COMMUNITY", "블로그·카페"],
  ["SOCIAL", "SNS"],
  ["MESSAGE", "문자·카카오톡"],
  ["OFFLINE", "전단·QR"],
  ["CAMPAIGN", "기타 홍보 링크"],
  ["REFERRAL", "다른 사이트"],
  ["DIRECT", "직접 방문"],
];

// 광고 클릭에만 붙는 ID. fbclid는 페이스북·인스타그램이 일반 게시물 링크에도 붙이므로 광고로 보지 않는다.
const PAID_CLICK = /^(gclid|NaPm|n_media|kakao_click_id)=/;
const PAID_MEDIUM = /^(cpc|ppc|paid|ad|ads|display|sa|da|gfa|banner)$/i;
// 홍보 링크 만들기 페이지(/links)의 utm_medium 값과 맞춘다
const MEDIUM = { blog: "COMMUNITY", community: "COMMUNITY", cafe: "COMMUNITY", social: "SOCIAL", message: "MESSAGE", sms: "MESSAGE", offline: "OFFLINE", qr: "OFFLINE" };
const SOURCE = [
  [/naver_?blog|naver_?cafe|blog|cafe|tistory|daangn|danggeun|community/i, "COMMUNITY"],
  [/insta|facebook|^fb$|youtube|tiktok|threads|twitter|^x$|kakaostory|band/i, "SOCIAL"],
  [/kakao_?(channel|talk|ch)|kakaotalk|^sms$|^lms$|^mms$|message/i, "MESSAGE"],
  [/flyer|leaflet|poster|^qr|offline|전단/i, "OFFLINE"],
];

// [호스트 규칙, 경로, 검색어 파라미터]
const REFERRERS = [
  [/^(m\.)?search\.naver\.com$/, "NAVER_SEARCH", "query"],
  [/^(www\.)?google\.[a-z.]+$/, "GOOGLE_SEARCH", "q"],
  [/^(m\.)?search\.daum\.net$|^(www\.)?bing\.com$|^search\.zum\.com$|^duckduckgo\.com$|^search\.yahoo\.com$/, "OTHER_SEARCH", "q"],
  [/^(m\.)?(blog|cafe|post|in)\.naver\.com$|\.tistory\.com$|^brunch\.co\.kr$|^(m\.)?cafe\.daum\.net$|^(www\.)?daangn\.com$/, "COMMUNITY", ""],
  [/(^|\.)(instagram|facebook|youtube|threads)\.(com|net)$|^youtu\.be$|^t\.co$|^(www\.)?x\.com$|^(www\.)?tiktok\.com$|^story\.kakao\.com$|^band\.us$/, "SOCIAL", ""],
];

function parseUrl(s) {
  try { return s ? new URL(s) : null; } catch { return null; }
}

// 리퍼러를 저장용(호스트+경로)과 검색어로 나눈다. 다른 쿼리 값은 버린다.
export function readReferrer(raw, ownHost = "") {
  const u = parseUrl(raw);
  if (!u || !/^https?:$/.test(u.protocol) || (ownHost && u.hostname === ownHost)) return { host: "", referrer: "", keyword: "", channel: "" };
  const host = u.hostname.toLowerCase();
  const rule = REFERRERS.find(([re]) => re.test(host));
  const keyword = rule?.[2] ? (u.searchParams.get(rule[2]) ?? "").trim().slice(0, 100) : "";
  return { host, referrer: `${u.origin}${u.pathname}`.slice(0, 300), keyword, channel: rule?.[1] ?? "REFERRAL" };
}

export function classifyChannel({ utm = {}, clickId = "", referrer = "", landingPage = "" }) {
  const ownHost = parseUrl(landingPage)?.hostname ?? "";
  const ref = readReferrer(referrer, ownHost);
  const keyword = ref.keyword || (utm.term ?? "");
  const out = (channel) => ({ channel, referrer: ref.referrer, keyword });

  if (PAID_CLICK.test(clickId) || PAID_MEDIUM.test(utm.medium ?? "")) return out("AD");
  if (utm.source || utm.medium) {
    if (MEDIUM[utm.medium?.toLowerCase()]) return out(MEDIUM[utm.medium.toLowerCase()]);
    return out(SOURCE.find(([re]) => re.test(utm.source ?? ""))?.[1] ?? "CAMPAIGN");
  }
  if (ref.channel) return out(ref.channel);
  if (clickId.startsWith("fbclid=")) return out("SOCIAL");
  return out("DIRECT");
}

export const channelLabel = (c) => CHANNELS.find(([v]) => v === c)?.[1] ?? c;
