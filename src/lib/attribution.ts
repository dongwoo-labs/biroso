// 유입 정보 저장. 첫 방문의 UTM·클릭 ID·이전 사이트 주소·랜딩 URL을 30일간 이 브라우저에만 보관한다.
// 서버로는 주문·예약 때만 보내고, 개인을 식별하는 값은 담지 않는다. 유입 경로 분류는 server/channel.mjs가 한다.

const KEY = "biroso_attr";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UTM = ["source", "medium", "campaign", "content", "term"] as const;
// 광고 매체별 클릭 ID (구글, 메타, 네이버, 카카오)
const CLICK_IDS = ["gclid", "fbclid", "NaPm", "n_media", "kakao_click_id"];

type Attribution = { utm: Record<(typeof UTM)[number], string>; landingPage: string; clickId: string; referrer: string; savedAt: number };

// 우리 사이트 안에서 넘어온 경우는 이전 사이트로 치지 않는다
function externalReferrer(ref: string, u: URL) {
  try { return ref && new URL(ref).hostname !== u.hostname ? ref.slice(0, 1000) : ""; } catch { return ""; }
}

function fromUrl(u: URL, ref: string): Attribution {
  const utm = Object.fromEntries(UTM.map((k) => [k, u.searchParams.get(`utm_${k}`) ?? ""])) as Attribution["utm"];
  const click = CLICK_IDS.map((k) => (u.searchParams.get(k) ? `${k}=${u.searchParams.get(k)}` : "")).find(Boolean) ?? "";
  return { utm, landingPage: `${u.origin}${u.pathname}`, clickId: click.slice(0, 200), referrer: externalReferrer(ref, u), savedAt: Date.now() };
}

const isDirect = (a: Attribution) => !a.utm.source && !a.clickId && !a.referrer;

function load(): Attribution | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && Date.now() - v.savedAt < TTL_MS ? { referrer: "", ...v } : null;
  } catch { return null; }
}

export function captureAttribution(href = location.href, ref = document.referrer) {
  const now = fromUrl(new URL(href), ref);
  const saved = load();
  // 첫 접점 기준: 이미 저장된 값은 덮어쓰지 않는다. 단, 직접 방문 뒤에 검색·홍보 링크로 다시 오면 그쪽을 남긴다.
  if (!saved || (isDirect(saved) && !isDirect(now))) {
    try { localStorage.setItem(KEY, JSON.stringify(now)); } catch {}
  }
}

export function readAttribution(): Omit<Attribution, "savedAt"> {
  captureAttribution();
  const { savedAt, ...a } = load() ?? fromUrl(new URL(location.href), document.referrer);
  return a;
}
