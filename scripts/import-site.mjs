// 기존 홈페이지(biroso.kmdclinic.co.kr)의 상품·진료 예약·이벤트·게시글·FAQ·정책 문구를 읽어
// src/data/*.json(Twenty가 비어 있을 때 쓰는 기본값, crm/seed_content.py가 Twenty로 옮기는 원본)과
// public/media/*(그림)로 저장한다. 한 번 옮긴 뒤에는 Twenty에서 관리하므로 다시 돌릴 일은 거의 없다.
//
// 사용: npm run import-site [-- --base https://biroso.kmdclinic.co.kr]
// 원본 사이트는 Next.js(App Router)라서 화면 HTML 대신 페이지에 실린 서버 데이터(RSC)를 읽는다.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import sharp from "sharp";

const BASE = (process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "https://biroso.kmdclinic.co.kr").replace(/\/$/, "");
const ROOT = new URL("..", import.meta.url).pathname;
const DATA = join(ROOT, "src/data");
const MEDIA = join(ROOT, "public/media");
const UA = "Mozilla/5.0 (biroso-import/1.0)";

// 메뉴의 게시판(board/category-N)과 이 사이트에서 쓰는 게시판 값. 값은 crm/setup_clinic_objects.py의 BOARDS와 같다.
export const BOARDS = {
  "category-22": "NEWS", "category-4": "COLUMN", "category-2": "START", "category-16": "HEALTH", "category-3": "LOCATION",
  "category-5": "HERBAL", "category-6": "PHARMACOPUNCTURE", "category-9": "BALANCE", "category-21": "DIET", "category-10": "IMMUNE",
};
// 원내 상품 분류(원본 product_category 이름 → 값)
const CATEGORIES = { "비로소 다이어트": "DIET", "공진단 수壽": "GONGJINDAN", "경옥고 수壽": "GYEONGOKGO", "우황청심원 수壽": "UHWANG", "탕약 수壽": "DECOCTION" };
// 원본 attributes 키 → 화면 이름
const ATTR_LABEL = { amount: "상품 용량", ingredients: "주요 성분", benefits: "상품 효과", expiry_info: "사용 기한", note: "기타 사항" };

const get = async (path) => {
  const res = await fetch(BASE + path, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.text();
};

// RSC 흐름을 한 문자열로 모으고, "$36" 같은 참조가 가리키는 긴 글(36:T<길이>,<본문>)을 찾는 함수를 함께 돌려준다
function flight(html) {
  const parts = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => JSON.parse(`"${m[1]}"`));
  const s = parts.join("");
  const buf = Buffer.from(s, "utf8");
  const texts = new Map();
  for (const m of s.matchAll(/(?:^|\n|\])([0-9a-f]+):T([0-9a-f]+),/g)) {
    const start = Buffer.byteLength(s.slice(0, m.index + m[0].length), "utf8");
    texts.set(m[1], buf.subarray(start, start + parseInt(m[2], 16)).toString("utf8"));
  }
  const ref = (v) => (typeof v === "string" && /^\$[0-9a-f]+$/.test(v) ? texts.get(v.slice(1)) ?? "" : v ?? "");
  return { s, ref };
}

// 흐름 안에서 queryKey가 맞는 dehydrated 쿼리의 data를 꺼낸다
function queries(s) {
  const out = [];
  for (const m of s.matchAll(/\{"dehydratedAt":\d+,"state":\{"data":/g)) {
    try {
      const obj = JSON.parse(balanced(s, m.index));
      out.push({ key: obj.queryKey, data: obj.state.data });
    } catch { /* 참조로만 된 조각은 건너뛴다 */ }
  }
  return out;
}
function balanced(s, i) {
  let depth = 0, inStr = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(i, j + 1);
  }
  throw new Error("unbalanced");
}

// 그림을 내려받아 public/media/<해시>.<확장자>에 두고 사이트 경로를 돌려준다
const saved = new Map();
async function media(url) {
  if (!url) return null;
  if (saved.has(url)) return saved.get(url);
  const p = (async () => {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) { console.warn("  그림 실패", res.status, url); return null; }
    const type = res.headers.get("content-type") ?? "";
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" }[type.split(";")[0]]
      ?? (url.split("?")[0].match(/\.([a-z0-9]{3,4})$/i)?.[1] ?? "bin").toLowerCase();
    const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
    const raw = Buffer.from(await res.arrayBuffer());
    // 원본 그림은 수 MB짜리 PNG가 많다. 화면 폭(최대 1200px)에 맞춰 webp로 줄여 저장한다. gif·svg는 그대로 둔다.
    if (ext === "gif" || ext === "svg") { await writeFile(join(MEDIA, `${hash}.${ext}`), raw); return `/media/${hash}.${ext}`; }
    await sharp(raw).rotate().resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 80 }).toFile(join(MEDIA, `${hash}.webp`));
    return `/media/${hash}.webp`;
  })();
  saved.set(url, p);
  return p;
}
// 원본은 그림을 리사이즈 서버(image.web.medistream.co.kr/…/https%3A…) 주소로 넣기도 한다. 원본 파일 주소로 바꾼다.
const originalUrl = (u) => {
  const m = String(u).match(/https?%3A%2F%2F[^"'\s)]+/i);
  return m ? decodeURIComponent(m[0]) : u;
};

const td = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", emDelimiter: "*" });
td.use(gfm);
td.remove(["script", "style", "iframe"]);
td.addRule("emptyParagraph", { filter: (n) => n.nodeName === "P" && !n.textContent.trim() && !n.querySelector("img"), replacement: () => "\n\n" });

// 본문 HTML → 마크다운. 그림은 내려받아 사이트 경로로 바꾼다.
async function bodyMarkdown(html) {
  if (!html) return "";
  const urls = [...String(html).matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  let out = String(html);
  for (const u of urls) {
    const local = await media(originalUrl(u.replace(/&amp;/g, "&")));
    if (local) out = out.split(u).join(local);
  }
  return tidy(td.turndown(simplifyTables(out)));
}
// 원본 표는 칸마다 <p>와 꾸밈 속성이 붙어 있어 turndown이 마크다운 표로 못 바꾼다. 군더더기를 걷어 낸다.
const simplifyTables = (h) => h.replace(/<colgroup>[\s\S]*?<\/colgroup>/g, "")
  .replace(/<(table|tbody|thead|tr|td|th)\b[^>]*>/g, "<$1>")
  // 머리글 줄이 없는 표는 첫 줄을 머리글로 본다(마크다운 표는 머리글이 있어야 한다)
  .replace(/<table>([\s\S]*?)<\/table>/g, (t, inner) => /<th>/.test(inner) ? t
    : `<table>${inner.replace(/<tr>([\s\S]*?)<\/tr>/, (_, r) => `<tr>${r.replace(/<(\/?)td>/g, "<$1th>")}</tr>`)}</table>`)
  .replace(/<(td|th)>\s*((?:<p[^>]*>[\s\S]*?<\/p>\s*)+)<\/\1>/g, (_, tag, inner) => `<${tag}>${inner.replace(/<\/p>\s*<p[^>]*>/g, " ").replace(/<\/?p[^>]*>/g, "")}</${tag}>`);
// turndown 결과 다듬기: 목록 사이 빈 줄, 과한 이스케이프, 폭 없는 공백
const tidy = (md) => md.replace(/\u200b/g, "").replace(/^(\s*)-\s{2,}/gm, "$1- ").replace(/\n[ \t]+\n/g, "\n\n")
  .replace(/(^- [^\n]*)\n\n(?=- )/gm, "$1\n").replace(/(^- [^\n]*)\n\n(?=- )/gm, "$1\n").replace(/\\([\[\]])/g, "$1").replace(/\n{3,}/g, "\n\n").trim();

const firstImage = (o) => {
  const imgs = [...(o.featured_images ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  const pick = imgs.find((i) => i.is_representative) ?? imgs[0];
  return pick?.default_image?.url ?? null;
};
const allImages = (o) => [...(o.featured_images ?? [])].sort((a, b) => a.sort_order - b.sort_order).map((i) => i.default_image?.url).filter(Boolean);
const htmlText = (h) => String(h ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();

// 원본 플랫폼 내부 값(redirectProductId, isAddOne 같은 영문 키)은 손님에게 보일 내용이 아니라 뺀다
const internalKey = (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !ATTR_LABEL[k];
function attributesText(a) {
  if (!a) return "";
  if (Array.isArray(a)) return a.filter((x) => x.name && !internalKey(x.name)).map((x) => `${x.name}: ${x.value}`).join("\n");
  return Object.entries(a).filter(([k]) => !internalKey(k)).map(([k, v]) => `${ATTR_LABEL[k] ?? k}: ${v}`).join("\n");
}

async function main() {
  await mkdir(DATA, { recursive: true });
  await mkdir(MEDIA, { recursive: true });

  // 1) 원내 상품 목록(결제형)과 진료 예약(예약형) 목록
  const productIds = new Set();
  for (const path of ["/telemedicine/product", "/telemedicine/reservation", "/"]) {
    const html = await get(path);
    for (const m of html.matchAll(/\/telemedicine\/([a-z0-9]{20,})/g)) productIds.add(m[1]);
    const { s } = flight(html);
    for (const m of s.matchAll(/"documentId":"([a-z0-9]{24})","name":"[^"]*","sku"/g)) productIds.add(m[1]);
    for (const m of s.matchAll(/\{"sort_order":-?\d+,"id":\d+,"documentId":"([a-z0-9]{24})","name":"[^"]*","sku"/g)) productIds.add(m[1]);
  }

  // 2) 상품마다 상세 페이지에서 본문까지 읽는다
  const products = [];
  let company = null, settings = [];
  for (const id of productIds) {
    const { s, ref } = flight(await get(`/telemedicine/${id}`));
    const qs = queries(s);
    const p = qs.find((q) => q.data?.documentId === id && "regular_price" in q.data)?.data;
    company ??= qs.find((q) => q.key?.[0] === "company")?.data;
    if (!settings.length) settings = qs.find((q) => q.key?.[0] === "companySetting")?.data ?? [];
    if (!p) { console.warn("상품을 못 읽음", id); continue; }
    const reservation = p.product_type === "reservation";
    const images = await Promise.all(allImages(p).map(media));
    products.push({
      slug: p.documentId,
      name: p.name.trim(),
      kind: reservation ? "RESERVATION" : "PAYMENT",
      category: reservation ? "RESERVATION" : (CATEGORIES[p.product_category?.name] ?? "ETC"),
      title: p.title ?? "",
      summary: String(p.description ?? "").trim(),
      body: await bodyMarkdown(ref(p.body)),
      regularPrice: p.regular_price ?? 0,
      salePrice: p.sale_price ?? 0,
      soldOut: Boolean(p.is_sold_out),
      taxFree: Boolean(p.is_tax_free),
      telemedicine: Boolean(p.telemedicine_available),
      inPerson: Boolean(p.in_person_available),
      attributes: attributesText(p.attributes),
      freeShipping: /무료\s*배송/.test(attributesText(p.attributes)),
      image: images.find(Boolean) ?? null,
      images: images.filter(Boolean),
      sortOrder: (p.product_category?.sort_order ?? 0) * 100 + (p.sort_order ?? 0),
      published: Boolean(p.enabled),
    });
    console.log("상품", p.name);
  }

  // 3) 이벤트와 게시판 글: 목록 페이지에서 글 주소를 모으고 글마다 본문을 읽는다
  const home = await get("/");
  const postPaths = new Set();
  for (const path of ["/board/events", ...Object.keys(BOARDS).map((b) => `/board/${b}`)]) {
    const html = path === "/" ? home : await get(path);
    for (const m of html.matchAll(/href="(\/board\/[a-z0-9-]+\/[a-z0-9]{20,}\/[a-z0-9]{20,})"/g)) postPaths.add(m[1]);
  }
  const events = [], posts = [];
  for (const path of postPaths) {
    const [, , board, , docId] = path.split("/");
    const { s, ref } = flight(await get(path));
    const c = queries(s).find((q) => q.data?.documentId === docId && "title_text" in q.data)?.data;
    if (!c) { console.warn("글을 못 읽음", path); continue; }
    const row = {
      slug: docId,
      boardId: path.split("/")[3],
      name: c.title_text.trim(),
      subtitle: c.subtitle ?? "",
      summary: htmlText(ref(c.summary)).slice(0, 300),
      body: await bodyMarkdown(ref(c.body)),
      image: await media(firstImage(c)),
      publishedAt: (c.publishedAt ?? c.createdAt ?? "").slice(0, 10),
      sortOrder: c.sort_order ?? 0,
      published: true,
    };
    if (board === "events") {
      // 기간은 목록 카드에만 글로 있다(예: "2026. 08. 24 - 10. 18"). 본문의 "이벤트 기간"에서도 찾는다.
      const m = row.body.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일[^~]*~\s*(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/);
      const d = (y, mo, da) => `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
      events.push({ ...row, startDate: m ? d(m[1], m[2], m[3]) : null, endDate: m ? d(m[4] ?? m[1], m[5], m[6]) : null });
    } else {
      posts.push({ ...row, board: BOARDS[board] ?? "NEWS" });
    }
    console.log("글", board, row.name);
  }

  // 4) FAQ: 페이지의 구조화 데이터(FAQPage)에서 읽는다
  const faqHtml = await get("/faq");
  const faqLd = [...faqHtml.matchAll(/"@type\\?":\\?"FAQPage[\s\S]*?\]\}/g)][0]?.[0] ?? "";
  const faqs = [...faqLd.matchAll(/"name\\?":\\?"([^"\\]+)\\?",\\?"acceptedAnswer\\?":\{\\?"@type\\?":\\?"Answer\\?",\\?"text\\?":\\?"([^"\\]+)/g)]
    .map((m, i) => ({ name: m[1], answer: m[2], sortOrder: i, published: true }));

  // 5) 한의원 정보와 배송·취소·교환 안내
  const setting = (k) => settings.find((x) => x.key === k)?.value ?? "";
  const holidays = (() => { try { return JSON.parse(setting("holiday")).holidays ?? []; } catch { return []; } })();
  // 손으로 고친 항목(진료시간, 바로가기 링크, 배송비 등)은 두고, 원본에서 온 항목만 덮어쓴다
  const clinicPath = join(DATA, "clinic.json");
  const clinic = existsSync(clinicPath) ? JSON.parse(await readFile(clinicPath, "utf8")) : {};
  Object.assign(clinic, {
    name: company?.name ?? clinic.name ?? "비로소한의원",
    ceo: company?.representative_name ?? clinic.ceo ?? "",
    address: company?.address ?? clinic.address ?? "",
    tel: (company?.phone ?? "").replace(/^(02)(\d{3,4})(\d{4})$/, "$1-$2-$3") || clinic.tel,
    bizNo: (company?.business_registration_number ?? "").replace(/^(\d{3})(\d{2})(\d{5})$/, "$1-$2-$3") || clinic.bizNo,
    mailOrderNo: company?.e_commerce_number || clinic.mailOrderNo || "",
    introduction: company?.introduction ?? clinic.introduction ?? "",
    policies: {
      shipping: tidy(td.turndown(setting("shipping_policy"))),
      order: tidy(td.turndown(setting("order_policy"))),
      return: tidy(td.turndown(setting("return_policy"))),
    },
    holidays,
  });

  const write = (name, v) => writeFile(join(DATA, name), JSON.stringify(v, null, 2) + "\n");
  const asOf = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  await write("products.json", { asOf, source: BASE, items: products.sort((a, b) => a.sortOrder - b.sortOrder) });
  await write("events.json", { asOf, source: BASE, items: events.sort((a, b) => a.sortOrder - b.sortOrder) });
  await write("posts.json", { asOf, source: BASE, items: posts });
  await write("faqs.json", { asOf, source: BASE, items: faqs });
  await writeFile(clinicPath, JSON.stringify(clinic, null, 2) + "\n");
  console.log(`완료: 상품 ${products.length}, 이벤트 ${events.length}, 글 ${posts.length}, FAQ ${faqs.length}, 그림 ${saved.size}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
