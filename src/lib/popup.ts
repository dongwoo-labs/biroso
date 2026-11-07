// 홈페이지 팝업 공지(업무 화면 › 팝업 공지에서 게시). 서버 /api/v1/popups가 게시 중인 것만 준다.
// '오늘 하루 보지 않기'는 이 브라우저에 오늘 날짜로 기억하고, 내용을 고치면(판이 바뀌면) 다시 보인다.
// '닫기'는 이 탭에서만 기억한다. 저장소를 못 쓰는 브라우저(사생활 보호 모드)는 매번 보인다.
type Popup = { id: string; title: string; body: string; imageUrl: string; linkUrl: string; version: string };

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
const keyOf = (p: Popup) => `popup:${p.id}:${p.version}`;
const read = (s: Storage | undefined, k: string) => {
  try {
    return s?.getItem(k) ?? null;
  } catch {
    return null;
  }
};
const write = (s: Storage | undefined, k: string, v: string) => {
  try {
    s?.setItem(k, v);
  } catch {
    /* 저장 못 해도 닫기는 된다 */
  }
};
const hidden = (p: Popup) => read(localStorage, keyOf(p)) === today() || read(sessionStorage, keyOf(p)) === "1";

let shown = false;
export async function showPopups() {
  if (shown || document.getElementById("popup-notice")) return;
  shown = true;
  let list: Popup[] = [];
  try {
    const r = await fetch("/api/v1/popups");
    list = r.ok ? ((await r.json()).popups ?? []) : [];
  } catch {
    return;
  }
  const queue = list.filter((p) => !hidden(p));
  if (queue.length) open(queue);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function open(queue: Popup[]) {
  const p = queue[0];
  const prev = document.activeElement as HTMLElement | null;
  const wrap = el("div", "fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center");
  wrap.id = "popup-notice";
  const box = el("div", "w-full max-w-sm overflow-hidden rounded-3xl bg-paper shadow-xl");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "popup-notice-title");
  const content = p.linkUrl ? el("a", "block no-underline text-ink") : el("div", "block");
  if (content instanceof HTMLAnchorElement) {
    content.href = p.linkUrl;
    if (/^https:/.test(p.linkUrl) && !p.linkUrl.startsWith(location.origin)) {
      content.target = "_blank";
      content.rel = "noopener";
    }
  }
  if (p.imageUrl) {
    const img = el("img", "block max-h-[60vh] w-full object-cover");
    img.src = p.imageUrl;
    img.alt = p.title;
    content.append(img);
  }
  const text = el("div", "flex flex-col gap-2 px-5 pt-5");
  const h = el("h2", "text-[19px] font-bold leading-snug", p.title);
  h.id = "popup-notice-title";
  text.append(h);
  if (p.body) text.append(el("p", "whitespace-pre-line text-[15px] leading-relaxed text-ink-soft", p.body));
  content.append(text);
  const bar = el("div", "grid grid-cols-2 gap-2 p-5");
  const skip = el("button", "btn btn-secondary", "오늘 하루 보지 않기");
  const close = el("button", "btn btn-primary", queue.length > 1 ? "다음" : "닫기");
  skip.type = close.type = "button";
  bar.append(skip, close);
  box.append(content, bar);
  wrap.append(box);
  const done = (forToday: boolean) => {
    write(forToday ? localStorage : sessionStorage, keyOf(p), forToday ? today() : "1");
    wrap.remove();
    document.removeEventListener("keydown", onKey);
    if (queue.length > 1) open(queue.slice(1));
    else prev?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") done(false);
  };
  skip.addEventListener("click", () => done(true));
  close.addEventListener("click", () => done(false));
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) done(false);
  });
  document.addEventListener("keydown", onKey);
  document.body.append(wrap);
  close.focus();
}
