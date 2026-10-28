// 주문 금액 계산. 화면이 보낸 금액은 쓰지 않고 Twenty의 상품 가격으로 다시 계산한다.

// 도서산간 우편번호(택배 추가 배송비 대상). 제주와 주요 섬 지역만 넣었다. 택배사 기준표가 바뀌면 여기를 고친다.
const REMOTE_ZIP = [
  [63000, 63644], // 제주
  [22386, 22388], [23004, 23010], [23100, 23116], [23124, 23136], // 인천 옹진·강화 섬
  [31708, 31708], [32133, 32133], [33411, 33411], // 충남 섬(당진·태안·보령)
  [40200, 40240], // 경북 울릉
  [52570, 52571], [53031, 53033], [53089, 53104], // 경남 섬(사천·통영)
  [54000, 54000], [56347, 56349], // 전북 섬(군산·부안)
  [57068, 57069], [58760, 58762], [58800, 58810], [58816, 58818], [58826, 58826], [58828, 58866], [58953, 58958],
  [59102, 59103], [59106, 59106], [59127, 59127], [59129, 59129], [59137, 59166], [59650, 59650], [59766, 59766], [59781, 59790], // 전남 섬
];

export const isRemote = (zip) => {
  const n = Number(String(zip ?? "").trim());
  return Number.isInteger(n) && REMOTE_ZIP.some(([a, b]) => n >= a && n <= b);
};

export class PricingError extends Error {
  constructor(message, slug) { super(message); this.slug = slug; }
}

// lines: [{ slug, qty }], products: Twenty 상품(이미 원 단위로 바꾼 것) [{ id, slug, name, salePrice, taxFree, freeShipping, soldOut, kind, published }]
export function priceOrder(lines, products, { pickup = false, zip = "" } = {}, shipping) {
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  const items = [];
  const merged = new Map();
  for (const l of lines) merged.set(l.slug, (merged.get(l.slug) ?? 0) + l.qty);
  for (const [slug, qty] of merged) {
    const p = bySlug.get(slug);
    if (!p || !p.published || p.kind !== "PAYMENT") throw new PricingError("판매하지 않는 상품이 있어요. 장바구니를 확인해 주세요.", slug);
    if (p.soldOut) throw new PricingError(`${p.name}은(는) 품절됐어요.`, slug);
    if (!Number.isInteger(p.salePrice) || p.salePrice <= 0) throw new PricingError(`${p.name}은(는) 가격이 정해지지 않았어요. 한의원으로 문의해 주세요.`, slug);
    items.push({ productId: p.id, slug, name: p.name, unitPrice: p.salePrice, qty, amount: p.salePrice * qty, taxFree: Boolean(p.taxFree), freeShipping: Boolean(p.freeShipping) });
  }
  if (!items.length) throw new PricingError("장바구니가 비어 있어요.");
  const itemsAmount = items.reduce((n, i) => n + i.amount, 0);
  let shippingFee = 0;
  if (!pickup) {
    const free = itemsAmount >= shipping.freeOver || items.every((i) => i.freeShipping);
    shippingFee = (free ? 0 : shipping.base) + (isRemote(zip) ? shipping.remoteExtra : 0);
  }
  // 한약(의약품)은 면세, 배송비는 과세
  const taxFreeAmount = items.filter((i) => i.taxFree).reduce((n, i) => n + i.amount, 0);
  const totalAmount = itemsAmount + shippingFee;
  const first = items[0].name;
  const goodsName = (items.length > 1 ? `${first} 외 ${items.length - 1}건` : first).slice(0, 40);
  const itemsSummary = items.map((i) => `${i.name} × ${i.qty}`).join("\n");
  return { items, itemsAmount, shippingFee, taxFreeAmount, totalAmount, goodsName, itemsSummary };
}
