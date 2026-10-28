// 장바구니. 이 브라우저에만 보관한다(로그인 없음). 상품 주소(slug)와 수량만 담고, 가격은 주문 API가 Twenty 가격으로 다시 계산한다.

export type Line = { slug: string; qty: number };
const KEY = "biroso_cart";
export const MAX_QTY = 20;

export function readCart(): Line[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((l) => typeof l?.slug === "string" && Number.isInteger(l?.qty) && l.qty > 0) : [];
  } catch { return []; }
}

export function writeCart(lines: Line[]) {
  try { localStorage.setItem(KEY, JSON.stringify(lines.filter((l) => l.qty > 0))); } catch {}
  refreshCartBadge();
}

export function addToCart(slug: string, qty = 1) {
  const lines = readCart();
  const l = lines.find((x) => x.slug === slug);
  if (l) l.qty = Math.min(MAX_QTY, l.qty + qty); else lines.push({ slug, qty: Math.min(MAX_QTY, qty) });
  writeCart(lines);
}

export function setQty(slug: string, qty: number) {
  writeCart(readCart().map((l) => (l.slug === slug ? { ...l, qty: Math.max(0, Math.min(MAX_QTY, qty)) } : l)));
}

export const clearCart = () => writeCart([]);

// 바로 처방 신청(장바구니를 거치지 않는 주문). 주문서는 이 값이 있으면 장바구니 대신 이것만 주문한다.
const DIRECT = "biroso_direct";
export function setDirect(line: Line | null) {
  try { line ? sessionStorage.setItem(DIRECT, JSON.stringify(line)) : sessionStorage.removeItem(DIRECT); } catch {}
}
export function readDirect(): Line | null {
  try { const v = JSON.parse(sessionStorage.getItem(DIRECT) ?? "null"); return v?.slug ? v : null; } catch { return null; }
}

export function refreshCartBadge() {
  const n = readCart().reduce((s, l) => s + l.qty, 0);
  document.querySelectorAll<HTMLElement>("[data-cart-badge]").forEach((b) => { b.hidden = n === 0; b.textContent = String(n); });
}
