// 홈페이지 팝업 공지. 게시 중(ON)이고 지금이 게시 기간 안인 것만, 순서대로 보낸다.
// 모든 방문자가 부르므로 1분 동안 기억해 두고 Twenty를 다시 읽지 않는다. 개인정보는 없다.
const TTL = 60_000;
const cache = new WeakMap();

const text = (v, max) => String(v ?? "").trim().slice(0, max);
// 그림·링크 주소는 https(또는 사이트 안 경로)만 받는다
const safeUrl = (v) => {
  const s = text(v, 500);
  if (!s) return "";
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  try {
    return new URL(s).protocol === "https:" ? s : "";
  } catch {
    return "";
  }
};

export function activePopups(rows, now = new Date()) {
  const t = now.getTime();
  return rows
    .filter((r) => r.popupStatus === "ON")
    .filter((r) => !r.startsAt || new Date(r.startsAt).getTime() <= t)
    .filter((r) => !r.endsAt || new Date(r.endsAt).getTime() > t)
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
    .slice(0, 3)
    .map((r) => ({
      id: r.id,
      title: text(r.name, 80),
      body: text(r.body, 1000),
      imageUrl: safeUrl(r.imageUrl),
      linkUrl: safeUrl(r.linkUrl),
      // 고치면 '오늘 하루 보지 않기'를 다시 묻도록 판 표시를 같이 보낸다
      version: text(r.updatedAt, 40),
    }));
}

export async function getPopups({ twenty }, now = new Date()) {
  const hit = cache.get(twenty);
  if (hit && now.getTime() - hit.at < TTL) return { popups: activePopups(hit.rows, now) };
  const rows = await twenty.popupNotices();
  cache.set(twenty, { at: now.getTime(), rows });
  return { popups: activePopups(rows, now) };
}
