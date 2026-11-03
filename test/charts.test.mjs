import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alertConfig, createAlert } from "../server/alert.mjs";
import { canonical, contentHash, createLedger, findTampered, openEntry, parseKey, planSeal, runSeal, runVerify, verifyChain } from "../server/charts.mjs";

const key = parseKey("11".repeat(32));
// 서명할 때처럼 contentHash를 채운다(x에 contentHash가 있으면 그 값). sign: false면 해시는 x 적용 전 값(서명 뒤 고친 것)
const raw = (id, x = {}) => ({
  id, recordStatus: "SIGNED", customerId: "p1", appointmentId: "a1", doctorId: "m1", visitAt: "2026-11-03T05:00:00.000Z",
  chiefComplaint: "요통 3일", history: "", findings: "맥 현", diagnosis: "요추 염좌", treatment: "침 10혈", prescriptionNote: null, carePlan: "3일 뒤 재진",
  chainId: id, version: 1, supersedes: null, amendReason: null, signedAt: "2026-11-03T05:20:00.000Z", ...x,
});
const rec = (id, x = {}) => ({ contentHash: contentHash(raw(id, x)), ...raw(id, x), ...("contentHash" in x ? { contentHash: x.contentHash } : {}) });
// 서명한 뒤 x로 고친 기록(서명 해시는 고치기 전 값)
const editedAfterSign = (id, x) => ({ ...raw(id, x), contentHash: contentHash(raw(id)) });

test("해시 규칙: console과 같은 예시 값, 빈 값·일시 표기 차이는 같게 본다", () => {
  const r = raw("r1");
  // console(src/industries/clinic-chart.ts) 테스트와 같은 값
  assert.equal(contentHash(r), "4866eced104c1ea845fbd89cf20547a4b49a0df04e74284d381bfdb7cd049c8f");
  assert.equal(contentHash({ ...r, visitAt: "2026-11-03T05:00:00Z", history: null, prescriptionNote: "" }), contentHash(r));
  assert.notEqual(contentHash({ ...r, diagnosis: "요추 염좌 " }), contentHash(r));
  assert.ok(canonical(r).startsWith('[["customerId","p1"]'));
});

test("봉인: 서명한 기록만, 한 번만, 해시 체인으로 이어지고 내용은 암호화", () => {
  const now = new Date("2026-11-03T05:30:00Z");
  const first = planSeal([rec("r1"), rec("r2", { recordStatus: "DRAFT" })], [], key, now);
  assert.equal(first.lines.length, 1);
  assert.deepEqual(first.patches, [{ id: "r1", patch: { sealedAt: now.toISOString(), sealNo: 1 } }]);
  assert.ok(!first.lines[0].data.includes("요통"));
  assert.equal(openEntry(key, first.lines[0]).chiefComplaint, "요통 3일");
  const second = planSeal([rec("r1", { sealNo: 1 }), rec("r4"), rec("r3", { contentHash: "다른값" })], first.lines, key, now);
  // r3은 해시가 달라 봉인하지 않고 의심 줄만 남긴다(봉인 번호 없음)
  assert.deepEqual(second.lines.map((l) => [l.recordId, l.kind ?? "seal"]), [["r4", "seal"], ["r3", "suspect"]]);
  assert.deepEqual(second.patches.map((p) => p.id), ["r4"]);
  assert.equal(second.lines[0].prev, first.lines[0].hash);
  assert.deepEqual(second.problems.map((p) => p.recordId), ["r3"]);
  assert.equal(verifyChain([...first.lines, ...second.lines]).ok, true);
  // 같은 내용의 의심 줄은 다시 남기지 않고, 봉인도 하지 않는다
  const third = planSeal([rec("r3", { contentHash: "다른값" })], [...first.lines, ...second.lines], key, now);
  assert.deepEqual([third.lines.length, third.patches.length, third.problems.length], [0, 0, 1]);
});

test("장부 줄을 고치거나 빼면 체인 검사가 잡는다", () => {
  const now = new Date("2026-11-03T05:30:00Z");
  const { lines } = planSeal([rec("r1"), rec("r2"), rec("r3")], [], key, now);
  assert.equal(verifyChain(lines).ok, true);
  assert.deepEqual(verifyChain([lines[0], lines[2]]), { ok: false, at: 2, why: "순번이 비었어요" });
  const edited = lines.map((l) => ({ ...l }));
  edited[1].contentHash = "x";
  assert.equal(verifyChain(edited).why, "줄 내용이 바뀌었어요");
});

test("봉인 뒤 Twenty 값이 바뀌거나, 서명이 풀리거나, 사라지면 찾는다", () => {
  const { lines } = planSeal([rec("r1"), rec("r2"), rec("r3")], [], key, new Date());
  const found = findTampered([rec("r1"), editedAfterSign("r2", { diagnosis: "다른 진단" }), rec("r4", { recordStatus: "DRAFT" })], lines);
  assert.deepEqual(found.map((f) => [f.recordId, f.why]), [["r2", "봉인 뒤 내용이 바뀌었어요"], ["r3", "Twenty에서 기록이 사라졌어요"]]);
  assert.deepEqual(findTampered([rec("r1", { recordStatus: "DRAFT" })], lines.slice(0, 1)).map((f) => f.why), ["서명 상태가 풀렸어요"]);
});

test("runSeal·runVerify: 파일 장부에 쓰고 다시 읽어 검사", async () => {
  const dir = await mkdtemp(join(tmpdir(), "charts-"));
  const ledger = createLedger(join(dir, "sub", "ledger.jsonl"));
  let records = [rec("r1"), rec("r2")];
  const patched = [];
  const twenty = { listSignedCharts: async () => records, updateChart: async (id, patch) => patched.push([id, patch.sealNo]) };
  const alerts = [];
  const alert = async (text, o = {}) => alerts.push([o.daily ? "daily" : "alert", text]);
  const checks = createLedger(join(dir, "sub", "checks.jsonl"));
  const now = new Date("2026-11-03T05:30:00Z");
  assert.deepEqual(await runSeal({ twenty, ledger, key, alert }, now), { sealed: 2, suspect: 0, problems: [] });
  assert.deepEqual(patched, [["r1", 1], ["r2", 2]]);
  assert.deepEqual(await runSeal({ twenty, ledger, key, alert }, now), { sealed: 0, suspect: 0, problems: [] });
  const good = await runVerify({ twenty, ledger, checks, alert }, now);
  assert.equal(good.ok, true);
  assert.equal(alerts.at(-1)[0], "daily");
  assert.ok(alerts.at(-1)[1].includes(good.head.slice(0, 16)));
  records = [rec("r1"), editedAfterSign("r2", { carePlan: "몰래 고침" })];
  const v = await runVerify({ twenty, ledger, checks, alert }, now);
  assert.equal(v.chain.ok, true);
  assert.equal(v.ok, false);
  assert.deepEqual(v.tampered.map((t) => t.recordId), ["r2"]);
  assert.match(alerts.at(-1)[1], /진료기록 이상.*1건/);
  assert.deepEqual((await checks.read()).map((c) => c.ok), [true, false]);
  // 서명한 지 1시간 넘게 봉인 안 된 기록(해시가 달라 보류된 것 포함)
  records = [rec("r1"), rec("r2"), editedAfterSign("r5", { treatment: "고침" })];
  await runSeal({ twenty, ledger, key, alert }, now);
  assert.match(alerts.at(-1)[1], /봉인하지 않고 증거로/);
  const late = await runVerify({ twenty, ledger, checks, alert }, new Date("2026-11-03T07:00:00Z"));
  assert.deepEqual(late.unsealed.map((u) => u.recordId), ["r5"]);
  await assert.rejects(runSeal({ twenty, ledger, key: null, alert }), /CHART_LEDGER_KEY/);
  assert.match(alerts.at(-1)[1], /봉인 작업 실패/);
});

test("봉인 번호 쓰기 실패는 다음에 다시 적고, 장부와 다른 봉인 번호는 잡는다", async () => {
  const now = new Date("2026-11-03T05:30:00Z");
  const first = planSeal([rec("r1"), rec("r2")], [], key, now);
  // r2의 봉인 번호 쓰기가 실패해 Twenty에는 비어 있음 → 다시 적기(새 줄 없음)
  const again = planSeal([rec("r1", { sealNo: 1 }), rec("r2")], first.lines, key, now);
  assert.deepEqual([again.lines.length, again.patches], [0, [{ id: "r2", patch: { sealedAt: first.lines[1].at, sealNo: 2 } }]]);
  // 장부에 없는데 봉인 번호가 적힌 기록은 봉인하지 않는다
  const odd = planSeal([rec("r9", { sealNo: 7 })], first.lines, key, now);
  assert.deepEqual([odd.patches.length, odd.lines[0].kind, odd.problems[0].why], [0, "suspect", "장부에 없는 봉인 번호가 적혀 있어 봉인하지 않았어요"]);
  const t = findTampered([rec("r1", { sealNo: 5 }), rec("r2", { sealNo: 2 }), rec("r9", { sealNo: 7 })], first.lines);
  assert.deepEqual(t.map((x) => [x.recordId, x.why]), [["r1", "봉인 번호가 장부와 달라요"], ["r9", "장부에 없는 봉인 번호예요"]]);
});

test("메일 알림: 이상 알림과 매일 기준값을 받는 주소로 보낸다", async () => {
  const cfg = alertConfig({ CHART_ALERT_SMTP_URL: "smtps://u:p@smtp.example.com:465", CHART_ALERT_MAIL_FROM: "a@example.com", CHART_ALERT_MAIL_TO: "x@example.com, y@example.com" });
  const mails = [];
  const alert = createAlert(cfg, { sendMail: async (m) => mails.push(m) }, async () => assert.fail("fetch 안 함"));
  assert.deepEqual(await alert("[진료기록 이상] 1건"), ["mail"]);
  assert.deepEqual(await alert("이상 없음 abcd", { daily: true }), ["mail"]);
  assert.deepEqual(mails.map((m) => [m.to, m.subject, m.text]), [
    ["x@example.com, y@example.com", "비로소한의원 진료기록 이상 알림", "비로소한의원 [진료기록 이상] 1건"],
    ["x@example.com, y@example.com", "비로소한의원 진료기록 매일 점검", "비로소한의원 이상 없음 abcd"],
  ]);
  const logs = [];
  const failing = createAlert(cfg, { sendMail: async () => { throw new Error("535 auth"); }, log: (l) => logs.push(l) });
  assert.deepEqual(await failing("x"), []);
  assert.equal(logs[0].event, "chart_alert_failed");
});
