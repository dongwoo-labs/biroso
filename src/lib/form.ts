// 주문서·진료 예약 폼이 함께 쓰는 도구: 휴대폰 번호 꼴 맞추기, 서버 오류를 칸 옆에 보여 주기, API 호출

export const formatPhone = (v: string) => {
  const d = v.replace(/\D/g, "").slice(0, 11);
  return d.length < 4 ? d : d.length < 8 ? `${d.slice(0, 3)}-${d.slice(3)}` : `${d.slice(0, 3)}-${d.slice(3, d.length - 4)}-${d.slice(-4)}`;
};

export function bindPhone(input: HTMLInputElement | null) {
  input?.addEventListener("input", () => { input.value = formatPhone(input.value); });
}

// 칸 이름(name 속성)과 서버 오류 경로(예: intake.birthYear)가 같게 맞춰 두고, 오류를 칸 아래에 붙인다
export function showErrors(form: HTMLFormElement, fields: Record<string, string> = {}) {
  form.querySelectorAll("[data-error]").forEach((e) => e.remove());
  form.querySelectorAll("[aria-invalid]").forEach((e) => e.removeAttribute("aria-invalid"));
  let first: HTMLElement | null = null;
  for (const [path, msg] of Object.entries(fields)) {
    const el = form.querySelector<HTMLElement>(`[name="${CSS.escape(path)}"]`);
    const host = el?.closest<HTMLElement>("[data-field]") ?? el?.parentElement;
    if (!el || !host) continue;
    el.setAttribute("aria-invalid", "true");
    const p = document.createElement("p");
    p.className = "error"; p.dataset.error = ""; p.textContent = msg;
    host.append(p);
    first ??= el;
  }
  first?.focus();
  return Boolean(first);
}

export async function postJson(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export const numOrNull = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? "").trim());
  return String(v ?? "").trim() && Number.isFinite(n) ? n : null;
};
export const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

// 문진 칸(IntakeFields)을 API 형태로. diet가 아니면 키·몸무게·복용 경험은 보내지 않는다.
export function readIntake(fd: FormData, diet: boolean) {
  const all = (k: string) => fd.getAll(k).map(String);
  return {
    sex: str(fd.get("intake.sex")), birthYear: numOrNull(fd.get("intake.birthYear")),
    heightCm: diet ? numOrNull(fd.get("intake.heightCm")) : null, weightKg: diet ? numOrNull(fd.get("intake.weightKg")) : null,
    pregnancy: str(fd.get("intake.sex")) === "M" ? "NONE" : str(fd.get("intake.pregnancy")) || "NONE",
    diseases: all("intake.diseases"), conditions: str(fd.get("intake.conditions")),
    recentMeds: all("intake.recentMeds"), medications: str(fd.get("intake.medications")),
    allergies: str(fd.get("intake.allergies")), dietHistory: diet ? str(fd.get("intake.dietHistory")) : "", symptoms: str(fd.get("intake.symptoms")),
  };
}

// 하나 이상 골라야 하는 선택 칸(data-multi)이 비었으면 오류를 더한다
export function checkMulti(form: HTMLFormElement, local: Record<string, string>) {
  form.querySelectorAll<HTMLElement>("[data-multi]").forEach((g) => {
    if (g.closest("[hidden]") || g.querySelector("input:checked")) return;
    local[g.dataset.multi!] ??= "하나 이상 골라 주세요. 없으면 '해당 없음'을 골라 주세요.";
  });
}
