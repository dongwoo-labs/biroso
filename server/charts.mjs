// 진료기록 봉인과 무결성 검사.
//
// 진료기록(medicalRecord)은 원장이 업무 화면(crm console)에서 쓰고 서명한다. 서명한 기록은 화면에서 고칠 수 없고,
// 고칠 때는 사유와 함께 새 판(version + 1, 같은 chainId)을 만든다. 그래도 Twenty 자체에서는 누구든 권한이 있으면
// 값을 바꿀 수 있으므로, 이 작업이 서명한 기록을 Twenty 밖 장부에 봉인해 증거로 남긴다.
//
//   seal   (10분마다) 서명했지만 아직 봉인하지 않은 기록 → 내용 해시를 다시 계산해 서명 해시와 맞춰 보고,
//          장부(JSONL, 줄마다 앞 줄의 해시를 이어 붙인 해시 체인)에 암호화한 내용을 한 줄 더한 뒤 sealedAt·sealNo를 채운다.
//   verify (매일) 장부 체인이 끊기지 않았는지, 봉인한 기록의 지금 Twenty 값이 봉인할 때와 같은지 본다.
//          달라진 기록이 있으면 목록으로 돌려주고 로그에 남긴다(장부에서 원래 내용을 되살릴 수 있다).
//
// 해시 규칙(contentHash)은 console(src/industries/clinic-chart.ts)과 같아야 한다. 테스트에 같은 예시 값이 있다.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

// 서명이 덮는 칸. 순서와 이름을 바꾸면 예전 해시와 맞지 않으니 더하기만 한다.
export const CHART_FIELDS = [
  "customerId", "appointmentId", "doctorId", "visitAt",
  "chiefComplaint", "history", "findings", "diagnosis", "treatment", "prescriptionNote", "plan",
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
const entryHash = (e) => sha256(JSON.stringify([e.prev, e.seq, e.at, e.recordId, e.chainId, e.version, e.contentHash, e.data]));

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
export function planSeal(records, entries, key, now) {
  const done = new Set(entries.map((e) => e.recordId));
  let prev = entries.at(-1)?.hash ?? "";
  let seq = entries.length;
  const lines = [], patches = [], problems = [];
  for (const r of records) {
    if (r.recordStatus !== "SIGNED" || done.has(r.id)) continue;
    const h = contentHash(r);
    // 서명할 때 화면이 계산한 해시와 다르면 서명 뒤에 누가 고친 것이다. 그래도 지금 값으로 봉인하고 표시한다.
    if (r.contentHash && r.contentHash !== h) problems.push({ recordId: r.id, why: "서명 해시와 지금 내용이 달라요" });
    const e = { seq: ++seq, at: now.toISOString(), recordId: r.id, chainId: r.chainId ?? "", version: r.version ?? 1, contentHash: h,
      data: encrypt(key, JSON.stringify(Object.fromEntries(CHART_FIELDS.map((k) => [k, r[k] ?? null])))), prev };
    e.hash = entryHash(e);
    prev = e.hash;
    lines.push(e);
    patches.push({ id: r.id, patch: { sealedAt: e.at, sealNo: e.seq } });
  }
  return { lines, patches, problems };
}

// 봉인 뒤 Twenty 값이 바뀐 기록 찾기
export function findTampered(records, entries) {
  const sealed = new Map(entries.map((e) => [e.recordId, e]));
  const out = [];
  const seen = new Set();
  for (const r of records) {
    seen.add(r.id);
    const e = sealed.get(r.id);
    if (e && contentHash(r) !== e.contentHash) out.push({ recordId: r.id, sealNo: e.seq, why: "봉인 뒤 내용이 바뀌었어요" });
    if (e && r.recordStatus !== "SIGNED") out.push({ recordId: r.id, sealNo: e.seq, why: "서명 상태가 풀렸어요" });
  }
  for (const e of entries) if (!seen.has(e.recordId)) out.push({ recordId: e.recordId, sealNo: e.seq, why: "Twenty에서 기록이 사라졌어요" });
  return out;
}

export async function runSeal({ twenty, ledger, key, log = () => {} }, now = new Date()) {
  if (!key) throw new Error("CHART_LEDGER_KEY가 없어 봉인할 수 없습니다.");
  const records = await twenty.listSignedCharts();
  const entries = await ledger.read();
  const chain = verifyChain(entries);
  if (!chain.ok) throw new Error(`진료기록 장부가 깨졌습니다(${chain.at}번 줄: ${chain.why}). 백업에서 되살린 뒤 다시 실행하세요.`);
  const { lines, patches, problems } = planSeal(records, entries, key, now);
  await ledger.append(lines);
  for (const p of patches) await twenty.updateChart(p.id, p.patch);
  for (const p of problems) log({ ts: now.toISOString(), event: "chart_hash_mismatch", ...p });
  return { sealed: lines.length, problems };
}

export async function runVerify({ twenty, ledger, log = () => {} }, now = new Date()) {
  const entries = await ledger.read();
  const chain = verifyChain(entries);
  const tampered = chain.ok ? findTampered(await twenty.listSignedCharts(true), entries) : [];
  for (const t of tampered) log({ ts: now.toISOString(), event: "chart_tampered", ...t });
  if (!chain.ok) log({ ts: now.toISOString(), event: "chart_ledger_broken", ...chain });
  return { chain, tampered };
}

// 장부에서 한 기록의 봉인 당시 내용 꺼내기(되살릴 때)
export function openEntry(key, entry) {
  return JSON.parse(decrypt(key, entry.data));
}
