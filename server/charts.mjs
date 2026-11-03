// 진료기록 봉인과 무결성 검사.
//
// 진료기록(medicalRecord)은 원장이 업무 화면(crm console)에서 쓰고 서명한다. 서명한 기록은 화면에서 고칠 수 없고,
// 고칠 때는 사유와 함께 새 판(version + 1, 같은 chainId)을 만든다. 그래도 Twenty 자체에서는 누구든 권한이 있으면
// 값을 바꿀 수 있으므로, 이 작업이 서명한 기록을 Twenty 밖 장부에 봉인해 증거로 남긴다.
//
//   seal   (10분마다) 서명했지만 아직 봉인하지 않은 기록 → 내용 해시를 다시 계산해 서명 해시와 맞춰 보고,
//          장부(JSONL, 줄마다 앞 줄의 해시를 이어 붙인 해시 체인)에 암호화한 내용을 한 줄 더한 뒤 sealedAt·sealNo를 채운다.
//          해시가 다르면 봉인하지 않고 '의심' 줄(kind: "suspect", 그때 내용의 암호화 사본)만 증거로 남긴 뒤 알린다.
//   verify (매일) 장부 체인이 끊기지 않았는지, 봉인한 기록의 지금 Twenty 값이 봉인할 때와 같은지,
//          서명한 지 1시간이 넘도록 봉인되지 않은 기록이 없는지 본다. 결과는 검사 이력(checks.jsonl)에 남기고,
//          이상이 있으면 관리자·원장에게 알린다. 이상이 없어도 장부 끝 해시(검증 기준값)를 원장에게 보낸다 —
//          장부와 DB를 함께 다루는 관리자가 장부를 통째로 다시 써도, 원장이 받아 둔 기준값과 맞지 않아 드러난다.
//
// 1차 방어는 DB 트리거(crm/chart_guard.sql)다: 서명 검증, 서명 원본 수정·삭제 차단. 이 작업은 그 밖(DB 관리자 직접 수정 등)을 잡는다.
//
// 해시 규칙(contentHash)은 console(src/industries/clinic-chart.ts)과 같아야 한다. 테스트에 같은 예시 값이 있다.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

// 서명이 덮는 칸. 순서와 이름을 바꾸면 예전 해시와 맞지 않으니 더하기만 한다.
export const CHART_FIELDS = [
  "customerId", "appointmentId", "doctorId", "visitAt",
  "chiefComplaint", "history", "findings", "diagnosis", "treatment", "prescriptionNote", "carePlan",
  "chainId", "version", "supersedes", "amendReason", "signedAt",
];
const TIMES = new Set(["visitAt", "signedAt"]);

// 값 맞추기: 빈 값은 "", 일시는 ISO(밀리초 포함), 숫자는 문자열
function norm(key, v) {
  if (v == null || v === "") return "";
  if (TIMES.has(key)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
  }
  return String(v);
}

export function canonical(rec) {
  return JSON.stringify(CHART_FIELDS.map((k) => [k, norm(k, rec[k])]));
}

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
export const contentHash = (rec) => sha256(canonical(rec));

// 장부 한 줄의 내용 암호화(AES-256-GCM). 키는 CHART_LEDGER_KEY(32바이트 hex 또는 base64).
export function parseKey(raw) {
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("CHART_LEDGER_KEY는 32바이트(hex 64자 또는 base64)여야 합니다.");
  return buf;
}
export function encrypt(key, text) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}
export function decrypt(key, packed) {
  const [iv, tag, body] = packed.split(".").map((x) => Buffer.from(x, "base64"));
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

// 장부 줄: { seq, at, recordId, chainId, version, contentHash, data(암호문), prev, hash }
// hash = sha256(prev + 나머지 칸). 한 줄이라도 고치거나 빼면 그 뒤 체인이 모두 깨진다.
// kind는 의심 줄에만 있다(예전 줄의 해시가 바뀌지 않게, 있을 때만 해시에 넣는다).
const entryHash = (e) => sha256(JSON.stringify([e.prev, e.seq, e.at, e.recordId, e.chainId, e.version, e.contentHash, e.data, ...(e.kind ? [e.kind] : [])]));

export function verifyChain(entries) {
  let prev = "";
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i + 1) return { ok: false, at: i + 1, why: "순번이 비었어요" };
    if (e.prev !== prev) return { ok: false, at: e.seq, why: "앞 줄과 이어지지 않아요" };
    if (entryHash(e) !== e.hash) return { ok: false, at: e.seq, why: "줄 내용이 바뀌었어요" };
    prev = e.hash;
  }
  return { ok: true, count: entries.length, head: prev };
}

export function createLedger(path) {
  return {
    async read() {
      const text = await readFile(path, "utf8").catch((e) => (e.code === "ENOENT" ? "" : Promise.reject(e)));
      return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    async append(lines) {
      if (!lines.length) return;
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
    },
  };
}

// 봉인할 줄 만들기(파일·Twenty 없이 테스트한다)
// 서명 해시와 지금 내용이 다르면(서명 뒤 누가 고침) 봉인하지 않고 의심 줄만 남긴다. 같은 내용의 의심 줄은 한 번만.
export function planSeal(records, entries, key, now) {
  const done = new Set(entries.filter((e) => !e.kind).map((e) => e.recordId));
  const suspected = new Set(entries.filter((e) => e.kind === "suspect").map((e) => `${e.recordId} ${e.contentHash}`));
  let prev = entries.at(-1)?.hash ?? "";
  let seq = entries.length;
  const lines = [], patches = [], problems = [];
  const line = (r, h, kind) => {
    const e = { seq: ++seq, at: now.toISOString(), recordId: r.id, chainId: r.chainId ?? "", version: r.version ?? 1, contentHash: h,
      data: encrypt(key, JSON.stringify(Object.fromEntries(CHART_FIELDS.map((k) => [k, r[k] ?? null])))), prev, ...(kind ? { kind } : {}) };
    e.hash = entryHash(e);
    prev = e.hash;
    lines.push(e);
    return e;
  };
  const sealedBy = new Map(entries.filter((e) => !e.kind).map((e) => [e.recordId, e]));
  for (const r of records) {
    if (r.recordStatus !== "SIGNED") continue;
    if (done.has(r.id)) {
      // 장부에는 있는데 Twenty에 봉인 번호를 못 적은 기록(지난번 쓰기 실패) → 다시 적는다
      const e = sealedBy.get(r.id);
      if (r.sealNo == null) patches.push({ id: r.id, patch: { sealedAt: e.at, sealNo: e.seq } });
      continue;
    }
    const h = contentHash(r);
    const why = !r.contentHash || r.contentHash !== h ? "서명 해시와 지금 내용이 달라 봉인하지 않았어요"
      : r.sealNo != null ? "장부에 없는 봉인 번호가 적혀 있어 봉인하지 않았어요" : "";
    if (why) {
      problems.push({ recordId: r.id, why });
      if (!suspected.has(`${r.id} ${h}`)) line(r, h, "suspect");
      continue;
    }
    const e = line(r, h);
    patches.push({ id: r.id, patch: { sealedAt: e.at, sealNo: e.seq } });
  }
  return { lines, patches, problems };
}

// 봉인 뒤 Twenty 값이 바뀐 기록 찾기
export function findTampered(records, entries) {
  const sealed = new Map(entries.filter((e) => !e.kind).map((e) => [e.recordId, e]));
  const out = [];
  const seen = new Set();
  for (const r of records) {
    seen.add(r.id);
    const e = sealed.get(r.id);
    if (e && contentHash(r) !== e.contentHash) out.push({ recordId: r.id, sealNo: e.seq, why: "봉인 뒤 내용이 바뀌었어요" });
    if (e && r.recordStatus !== "SIGNED") out.push({ recordId: r.id, sealNo: e.seq, why: "서명 상태가 풀렸어요" });
    if (e && r.sealNo != null && Number(r.sealNo) !== e.seq) out.push({ recordId: r.id, sealNo: e.seq, why: "봉인 번호가 장부와 달라요" });
    if (!e && r.sealNo != null) out.push({ recordId: r.id, sealNo: Number(r.sealNo), why: "장부에 없는 봉인 번호예요" });
  }
  for (const e of sealed.values()) if (!seen.has(e.recordId)) out.push({ recordId: e.recordId, sealNo: e.seq, why: "Twenty에서 기록이 사라졌어요" });
  return out;
}

// 서명한 지 오래됐는데 봉인되지 않은 기록(봉인 작업이 멈췄거나 해시가 달라 보류됨)
export function findUnsealed(records, entries, now, maxMs = 60 * 60 * 1000) {
  const sealed = new Set(entries.filter((e) => !e.kind).map((e) => e.recordId));
  return records
    .filter((r) => r.recordStatus === "SIGNED" && !sealed.has(r.id) && now - new Date(r.signedAt ?? 0) > maxMs)
    .map((r) => ({ recordId: r.id, why: "서명한 지 1시간이 넘었는데 봉인되지 않았어요" }));
}

export async function runSeal({ twenty, ledger, key, log = () => {}, alert = async () => {} }, now = new Date()) {
  try {
    if (!key) throw new Error("CHART_LEDGER_KEY가 없어 봉인할 수 없습니다.");
    const records = await twenty.listSignedCharts();
    const entries = await ledger.read();
    const chain = verifyChain(entries);
    if (!chain.ok) throw new Error(`진료기록 장부가 깨졌습니다(${chain.at}번 줄: ${chain.why}). 백업에서 되살린 뒤 다시 실행하세요.`);
    const { lines, patches, problems } = planSeal(records, entries, key, now);
    // 장부를 먼저 쓰고(증거) Twenty에 봉인 번호를 적는다. 적기에 실패한 기록은 다음 실행에서 다시 적는다.
    await ledger.append(lines);
    const failed = [];
    for (const p of patches) await twenty.updateChart(p.id, p.patch).catch((e) => failed.push({ recordId: p.id, error: e.message }));
    for (const p of problems) log({ ts: now.toISOString(), event: "chart_hash_mismatch", ...p });
    if (failed.length) {
      log({ ts: now.toISOString(), event: "chart_seal_patch_failed", failed });
      await alert(`[진료기록 이상] 봉인 번호를 적지 못한 기록 ${failed.length}건(다음 실행에서 다시 시도). 기록: ${failed.map((f) => f.recordId.slice(0, 8)).join(", ")}`);
    }
    const fresh = problems.filter((p) => lines.some((l) => l.kind === "suspect" && l.recordId === p.recordId));
    if (fresh.length) await alert(`[진료기록 이상] 봉인하지 않고 증거로 남긴 기록 ${fresh.length}건(서명 뒤 내용 변경 또는 장부와 다른 봉인 번호). 기록: ${fresh.map((p) => p.recordId.slice(0, 8)).join(", ")}`);
    const sealedNow = lines.filter((l) => !l.kind).length;
    return { sealed: sealedNow, suspect: lines.length - sealedNow, problems, ...(failed.length ? { failed } : {}) };
  } catch (e) {
    log({ ts: now.toISOString(), event: "chart_seal_failed", error: e.message });
    await alert(`[진료기록 이상] 봉인 작업 실패: ${e.message}`);
    throw e;
  }
}

export async function runVerify({ twenty, ledger, checks, log = () => {}, alert = async () => {} }, now = new Date()) {
  let entries = [], chain, tampered = [], unsealed = [], error = null;
  try {
    entries = await ledger.read();
    chain = verifyChain(entries);
    if (chain.ok) {
      const records = await twenty.listSignedCharts(true);
      tampered = findTampered(records, entries);
      unsealed = findUnsealed(records, entries, now);
    }
  } catch (e) {
    error = e.message;
    chain = chain ?? { ok: false, why: e.message };
  }
  for (const t of tampered) log({ ts: now.toISOString(), event: "chart_tampered", ...t });
  if (!chain.ok) log({ ts: now.toISOString(), event: "chart_ledger_broken", ...chain });
  const ok = chain.ok && !tampered.length && !unsealed.length && !error;
  const result = { ts: now.toISOString(), ok, chain, tampered, unsealed, error, entries: entries.length, head: chain.ok ? chain.head : null };
  if (checks) await checks.append([result]);
  const date = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  if (ok) {
    await alert(`[진료기록 점검 ${date}] 이상 없음. 장부 ${entries.length}줄, 기준값 ${String(chain.head).slice(0, 16) || "-"} (이 문자는 지우지 말고 보관해 주세요)`, { daily: true });
  } else {
    const what = [
      !chain.ok && `장부 체인 깨짐(${chain.at ?? "-"}번 줄: ${chain.why})`,
      tampered.length && `봉인 뒤 바뀌거나 사라진 기록 ${tampered.length}건`,
      unsealed.length && `봉인 안 된 서명 기록 ${unsealed.length}건`,
      error && `검사 실패: ${error}`,
    ].filter(Boolean).join(", ");
    await alert(`[진료기록 이상 ${date}] ${what}. 관리자는 서버 로그와 장부를 확인해 주세요.`);
  }
  return result;
}

// 장부에서 한 기록의 봉인 당시 내용 꺼내기(되살릴 때)
export function openEntry(key, entry) {
  return JSON.parse(decrypt(key, entry.data));
}
