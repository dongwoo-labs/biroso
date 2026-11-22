// 빌드할 때 CRM에서 공개 상품·행사·게시글·FAQ와 휴진일을 읽는다.
// 기본 Twenty 모드에서 연결 정보가 없을 때만 src/data의 기본값을 쓴다.
// 선택지 값(PAYMENT, DIET, COLUMN …)은 crm/setup_clinic_objects.py와 같아야 한다.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { ownCrmOrigin } from "../../server/own-crm.mjs";
import productsFile from "../data/products.json";
import eventsFile from "../data/events.json";
import postsFile from "../data/posts.json";
import faqsFile from "../data/faqs.json";
import clinic from "../data/clinic.json";

export const CATEGORY: Record<string, string> = {
  DIET: "비로소 다이어트", GONGJINDAN: "공진단 수壽", GYEONGOKGO: "경옥고 수壽", UHWANG: "우황청심원 수壽", DECOCTION: "탕약 수壽", SKINCARE: "RATIOLOGY 화장품", ETC: "기타",
};

// 게시판: 값 → 이름, 기존 사이트 주소(board/category-N/<게시판 ID>/<글 ID>). 주소는 검색·블로그 링크가 걸려 있어 그대로 쓴다.
export const BOARDS: Record<string, { name: string; path: string; id: string }> = {
  NEWS: { name: "비로소 소식담기", path: "category-22", id: "rvt6q7qczdwrm2k35srqgem9" },
  COLUMN: { name: "비로소 질환칼럼", path: "category-4", id: "skbtue45t4b0tzgdz8vp5byt" },
  START: { name: "비로소 시작하기", path: "category-2", id: "qgigfmjcl12dqvo1xw8hs07g" },
  HEALTH: { name: "비로소 건강의학", path: "category-16", id: "fc7sl5rq6ab661fspeiqn884" },
  LOCATION: { name: "비로소 오시는길", path: "category-3", id: "qjyymtm52krbmrxvkom02ijy" },
  HERBAL: { name: "비로소 한약치료", path: "category-5", id: "do8gqf0if01l19y7wkrve2jo" },
  PHARMACOPUNCTURE: { name: "비로소 약침치료", path: "category-6", id: "bax9nahsho3w4czhkheurpne" },
  BALANCE: { name: "비로소 균형치료", path: "category-9", id: "p50wb1k6q36eabnvsq64udbh" },
  DIET: { name: "비로소 다이어트", path: "category-21", id: "megzv5pgjhnq8i6mi2j6qmxb" },
  IMMUNE: { name: "비로소 면역치료", path: "category-10", id: "l1kvzej6x9lqjd7tlgzivtc5" },
  SOOBLOG: { name: "공진단 효능 및 복용 안내", path: "sooblog", id: "gcwglfes585x1hdk42lxi51q" },
};
export const EVENT_BOARD_ID = "u8hi3acecd1db7frunakwwt8";

// salesChannel: OWN(비로소 결제) | SOO_STORE(수壽 매장에서 처방 신청·결제). 수壽 매장 상품은 storeUrl로 보낸다.
export type Product = {
  id: string; slug: string; name: string; kind: "PAYMENT" | "RESERVATION"; category: string; title: string; summary: string;
  bodyHtml: string; regularPrice: number; salePrice: number; soldOut: boolean; taxFree: boolean; freeShipping: boolean;
  telemedicine: boolean; inPerson: boolean; attributes: [string, string][]; image: string | null; images: string[]; sortOrder: number;
  salesChannel: "OWN" | "SOO_STORE"; storeUrl: string | null;
};
export type Event = { slug: string; name: string; subtitle: string; summary: string; bodyHtml: string; image: string | null; startDate: string | null; endDate: string | null };
export type Post = { slug: string; board: string; name: string; summary: string; bodyHtml: string; image: string | null; publishedOn: string };
export type Faq = { q: string; a: string };

export const productHref = (p: { slug: string }) => `/telemedicine/${p.slug}/`;
export const eventHref = (e: { slug: string }) => `/board/events/${EVENT_BOARD_ID}/${e.slug}/`;
export const boardHref = (b: string) => `/board/${BOARDS[b]?.path ?? "category-22"}/`;
export const postHref = (p: Post) => `/board/${BOARDS[p.board]?.path ?? "category-22"}/${BOARDS[p.board]?.id ?? "news"}/${p.slug}/`;
export const discount = (p: Product) => (p.regularPrice > p.salePrice && p.regularPrice > 0 ? Math.round((1 - p.salePrice / p.regularPrice) * 100) : 0);
export const wonText = (n: number) => `${n.toLocaleString("ko-KR")}원`;

// 빌드는 저장소 최상위에서 돈다. 번들 뒤에는 import.meta.url 위치가 바뀌므로 작업 폴더 기준으로 찾는다.
const publicDir = join(process.cwd(), "public") + "/";

// 이 사이트의 public 안에 있는 그림(/media/…)이면 상대 경로로, 아니면 원래 주소 그대로 쓴다
function imagePath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : raw.startsWith("/") ? `https://local${raw}` : `https://${raw}`);
    if (u.pathname.length > 1 && existsSync(publicDir + decodeURIComponent(u.pathname.slice(1)))) return u.pathname;
    return u.hostname === "local" ? null : u.href;
  } catch { return null; }
}

// 사이트 절대 주소(https://…/media/…)는 상대 경로로 되돌린다.
export function renderMarkdown(md: string | null | undefined, own = false) {
  let src = String(md ?? "");
  src = src.replace(/\]\((https?:\/\/[^)\s]+)\)/g, (m, u) => { const p = imagePath(u); return p ? `](${p})` : m; });
  const html = marked.parse(src, { gfm: true, breaks: false, async: false }) as string;
  const content = own ? sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img"],
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ["src", "alt", "title"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
  }) : html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son[a-z]+="[^"]*"/gi, "");
  return content.replace(/<img /g, '<img loading="lazy" decoding="async" ')
    .replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
}

// 상품 정보: 한 줄에 "항목: 값"
const parseAttributes = (raw: string | null | undefined): [string, string][] =>
  String(raw ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.search(/[:：]/);
    return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, ""];
  }).filter(([k]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)); // 영문 키(옛 플랫폼 내부 값)는 손님 화면에 내보내지 않는다
const won = (c: { amountMicros?: number | null } | null | undefined) => (c?.amountMicros == null ? 0 : Math.round(c.amountMicros / 1_000_000));
const md = (rich: any) => (typeof rich === "string" ? rich : rich?.markdown ?? "");

type ContentConnection = { restUrl: string; key: string; own: boolean };

function contentConnection(): ContentConnection | null {
  const backend = process.env.CRM_BACKEND || "twenty";
  if (backend === "own") {
    const url = ownCrmOrigin(process.env.CRM_API_URL);
    const key = process.env.CRM_API_BUILDER_TOKEN?.trim();
    if (!key) throw new Error("CRM_API_BUILDER_TOKEN이 필요합니다.");
    return { restUrl: `${url}/api/v1/biroso/rest`, key, own: true };
  }
  if (backend !== "twenty") throw new Error("CRM_BACKEND는 twenty 또는 own이어야 합니다.");
  const url = process.env.TWENTY_URL, key = process.env.TWENTY_CONTENT_KEY || process.env.TWENTY_API_KEY;
  return url && key ? { restUrl: `${url.replace(/\/$/, "")}/rest`, key, own: false } : null;
}

// 읽기에 실패하면 빌드를 멈춘다. 빌더는 직전 릴리스를 유지한다.
async function listAll(conn: ContentConnection, plural: string, params: Record<string, string>) {
  const out: any[] = [];
  let cursor = "";
  for (;;) {
    const qs = new URLSearchParams({ ...params, limit: "60" });
    if (cursor) qs.set("starting_after", cursor);
    const res = await fetch(`${conn.restUrl}/${plural}?${qs}`, {
      headers: { Authorization: `Bearer ${conn.key}`, "User-Agent": "biroso-site-build/1.0" },
      ...(conn.own ? { redirect: "error", signal: AbortSignal.timeout(10_000) } as const : {}),
    });
    if (!res.ok) {
      if (conn.own) throw new Error(`자체 CRM에서 ${plural} 데이터를 읽지 못했습니다 (${res.status}).`);
      throw new Error(`Twenty ${plural}을(를) 읽지 못했습니다 (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.json();
    if (conn.own && (!Array.isArray(body?.data?.[plural]) || typeof body?.pageInfo?.hasNextPage !== "boolean")) {
      throw new Error(`자체 CRM ${plural}의 목록 응답 형식이 올바르지 않습니다.`);
    }
    out.push(...body.data[plural]);
    if (!body.pageInfo?.hasNextPage) return out;
    const next = body.pageInfo.endCursor;
    if (conn.own && (typeof next !== "string" || !next || next === cursor)) throw new Error(`자체 CRM ${plural}의 페이지 커서가 올바르지 않습니다.`);
    cursor = next;
  }
}
const shown = { filter: "published[eq]:true", order_by: "sortOrder[AscNullsLast]" };

const memo = <T,>(fn: () => Promise<T>) => { let p: Promise<T> | undefined; return () => (p ??= fn()); };

// 수壽 매장 상품: 비로소한의원 전용 매장(thesoo.co/@biroso) 주소와, 수壽 공개 API의 현재 가격·판매 여부.
// 수壽 API가 안 되면 Twenty 값을 그대로 쓴다(수壽 장애로 홈페이지 배포가 멈추지 않도록). 가격은 매장에서 다시 확인된다.
const SOO_API = "https://public-api.thesoo.co/market/products/";
export const sooStoreUrl = (id: string, slug: string) =>
  `${clinic.links.sooStore}/products/${encodeURIComponent(id)}?utm_source=biroso&utm_medium=referral&utm_campaign=${encodeURIComponent(slug)}`;

// 같은 수壽 상품을 옵션별로 여러 개 올려 두므로 상품마다 한 번만 읽는다
const sooCache = new Map<string, Promise<any>>();
const sooProduct = (id: string) => {
  if (!sooCache.has(id)) sooCache.set(id, (async () => {
    const res = await fetch(SOO_API + encodeURIComponent(id), { headers: { "User-Agent": "biroso-site-build/1.0" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()).data;
  })());
  return sooCache.get(id)!;
};

async function withSoo<T extends { slug: string; salePrice: number; regularPrice: number; soldOut: boolean; salesChannel: string; sooProductId?: string; sooOption?: string }>(p: T) {
  if (p.salesChannel !== "SOO_STORE" || !p.sooProductId) return { ...p, storeUrl: p.salesChannel === "SOO_STORE" ? clinic.links.sooStore : null };
  const out = { ...p, storeUrl: sooStoreUrl(p.sooProductId, p.slug) };
  try {
    const s = await sooProduct(p.sooProductId);
    if (!s.enabled || s.discontinued) out.soldOut = true;
    // 수량 옵션(예: "30환 단품 【-15%】")에 맞는 가격. 옵션이 없으면 상품 판매가.
    const value = (s.options ?? []).flatMap((o: any) => o.values ?? []).find((v: any) => v.name?.replace(/\s+/g, " ").trim() === (p.sooOption ?? "").replace(/\s+/g, " ").trim());
    const variant = value && (s.variants ?? []).find((x: any) => x.options?.some((o: any) => o.value_id === value.id));
    const price = Number(variant?.price ?? (p.sooOption ? NaN : s.sale_price ?? s.price));
    if (Number.isFinite(price) && price > 0) out.salePrice = price;
  } catch (e) {
    console.warn(`수壽 상품 ${p.sooProductId}(${p.slug})을 읽지 못해 CRM 값을 씁니다: ${(e as Error).message}`);
  }
  return out;
}

export const loadProducts = memo(async (): Promise<Product[]> => {
  const conn = contentConnection();
  const rows = conn ? (await listAll(conn, "products", shown)).map((p) => {
    const kind = p.kind ?? "PAYMENT", salesChannel = p.salesChannel ?? "OWN";
    const ownPayment = conn.own && kind === "PAYMENT" && salesChannel !== "SOO_STORE";
    const price = p.salePrice?.amountMicros != null ? p.salePrice : p.regularPrice;
    const salePrice = ownPayment ? won(price) : won(p.salePrice) || won(p.regularPrice);
    const invalidPrice = ownPayment && (price?.currencyCode !== "KRW" || !Number.isSafeInteger(salePrice) || salePrice <= 0 || salePrice > Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000));
    return {
      id: p.id, slug: p.slug || p.id, name: p.name ?? "", kind, category: p.category ?? "ETC", title: p.title ?? "",
      summary: p.summary ?? "", body: md(p.body), regularPrice: invalidPrice ? 0 : won(p.regularPrice), salePrice: invalidPrice ? 0 : salePrice,
      soldOut: Boolean(p.soldOut) || invalidPrice,
      taxFree: Boolean(p.taxFree), freeShipping: Boolean(p.freeShipping), telemedicine: Boolean(p.telemedicine),
      inPerson: Boolean(p.inPerson), attributes: p.attributes ?? "", image: p.imageUrl?.primaryLinkUrl ?? null,
      images: [p.imageUrl?.primaryLinkUrl, ...String(p.gallery ?? "").split(/\s+/)].filter(Boolean), sortOrder: p.sortOrder ?? 0,
      salesChannel, sooProductId: p.sooProductId ?? "", sooOption: p.sooOption ?? "",
    };
  }) : productsFile.items.filter((p) => p.published).map((p: any, i) => ({ salesChannel: "OWN", ...p, id: `local-${i}` }));
  return (await Promise.all(rows.map((p: any) => withSoo(p)))).map((p: any) => ({
    ...p, bodyHtml: renderMarkdown(p.body, conn?.own), attributes: parseAttributes(p.attributes),
    image: imagePath(p.image), images: [...new Set((p.images ?? []).map(imagePath).filter(Boolean))] as string[],
  }));
});

export const loadEvents = memo(async (): Promise<Event[]> => {
  const conn = contentConnection();
  const rows = conn ? (await listAll(conn, "clinicEvents", shown)).map((e) => ({
    slug: e.slug || e.id, name: e.name ?? "", subtitle: e.subtitle ?? "", summary: e.summary ?? "", body: md(e.body),
    image: e.imageUrl?.primaryLinkUrl ?? null, startDate: e.startDate ?? null, endDate: e.endDate ?? null,
  })) : eventsFile.items;
  return rows.map((e: any) => ({ ...e, bodyHtml: renderMarkdown(e.body, conn?.own), image: imagePath(e.image) }));
});

export const loadPosts = memo(async (): Promise<Post[]> => {
  const conn = contentConnection();
  const rows = conn ? (await listAll(conn, "posts", shown)).map((p) => ({
    slug: p.slug || p.id, board: p.board ?? "NEWS", name: p.name ?? "", summary: p.summary ?? "", body: md(p.body),
    image: p.imageUrl?.primaryLinkUrl ?? null, publishedOn: p.publishedOn ?? (p.createdAt ?? "").slice(0, 10),
  })) : postsFile.items.map((p) => ({ ...p, publishedOn: p.publishedAt }));
  return rows.map((p: any) => ({ ...p, bodyHtml: renderMarkdown(p.body, conn?.own), image: imagePath(p.image) }));
});

export const loadFaqs = memo(async (): Promise<Faq[]> => {
  const conn = contentConnection();
  if (!conn) return faqsFile.items.map((f) => ({ q: f.name, a: f.answer }));
  return (await listAll(conn, "faqs", shown)).map((f) => ({ q: f.name ?? "", a: f.answer ?? "" })).filter((f) => f.q && f.a);
});

// 진료 예약 달력에서 미리 막을 휴진일. 서버가 예약 때 다시 확인한다.
export const loadClosures = memo(async (): Promise<string[]> => {
  const conn = contentConnection();
  if (!conn) return clinic.holidays;
  return (await listAll(conn, "closures", {})).map((c) => String(c.date).slice(0, 10));
});

// 이벤트 기간 표시(예: 2026. 8. 24 – 10. 18)
export function periodText(e: Event) {
  if (!e.startDate) return "";
  const f = (d: string, withYear: boolean) => { const [y, m, dd] = d.split("-").map(Number); return `${withYear ? `${y}. ` : ""}${m}. ${dd}`; };
  return e.endDate ? `${f(e.startDate, true)} – ${f(e.endDate, e.endDate.slice(0, 4) !== e.startDate.slice(0, 4))}` : f(e.startDate, true);
}
