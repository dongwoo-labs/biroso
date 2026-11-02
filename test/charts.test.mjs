import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, contentHash, createLedger, findTampered, openEntry, parseKey, planSeal, runSeal, runVerify, verifyChain } from "../server/charts.mjs";

const key = parseKey("11".repeat(32));
const rec = (id, x = {}) => ({
  id, recordStatus: "SIGNED", customerId: "p1", appointmentId: "a1", doctorId: "m1", visitAt: "2026-11-03T05:00:00.000Z",
  chiefComplaint: "요통 3일", history: "", findings: "맥 현", diagnosis: "요추 염좌", treatment: "침 10혈", prescriptionNote: null, carePlan: "3일 뒤 재진",
  chainId: id, version: 1, supersedes: null, amendReason: null, signedAt: "2026-11-03T05:20:00.000Z", ...x,
});

test("해시 규칙: console과 같은 예시 값, 빈 값·일시 표기 차이는 같게 본다", () => {
  const r = rec("r1");
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
  const second = planSeal([rec("r1"), rec("r3", { contentHash: "다른값" })], first.lines, key, now);
  assert.equal(second.lines.length, 1);
  assert.equal(second.lines[0].prev, first.lines[0].hash);
  assert.deepEqual(second.problems.map((p) => p.recordId), ["r3"]);
  assert.equal(verifyChain([...first.lines, ...second.lines]).ok, true);
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
  const found = findTampered([rec("r1"), rec("r2", { diagnosis: "다른 진단" }), rec("r4", { recordStatus: "DRAFT" })], lines);
  assert.deepEqual(found.map((f) => [f.recordId, f.why]), [["r2", "봉인 뒤 내용이 바뀌었어요"], ["r3", "Twenty에서 기록이 사라졌어요"]]);
  assert.deepEqual(findTampered([rec("r1", { recordStatus: "DRAFT" })], lines.slice(0, 1)).map((f) => f.why), ["서명 상태가 풀렸어요"]);
});

test("runSeal·runVerify: 파일 장부에 쓰고 다시 읽어 검사", async () => {
  const dir = await mkdtemp(join(tmpdir(), "charts-"));
  const ledger = createLedger(join(dir, "sub", "ledger.jsonl"));
  let records = [rec("r1"), rec("r2")];
  const patched = [];
  const twenty = { listSignedCharts: async () => records, updateChart: async (id, patch) => patched.push([id, patch.sealNo]) };
  assert.deepEqual(await runSeal({ twenty, ledger, key }), { sealed: 2, problems: [] });
  assert.deepEqual(patched, [["r1", 1], ["r2", 2]]);
  assert.deepEqual(await runSeal({ twenty, ledger, key }), { sealed: 0, problems: [] });
  records = [rec("r1"), rec("r2", { carePlan: "몰래 고침" })];
  const v = await runVerify({ twenty, ledger });
  assert.equal(v.chain.ok, true);
  assert.deepEqual(v.tampered.map((t) => t.recordId), ["r2"]);
  await assert.rejects(runSeal({ twenty, ledger, key: null }), /CHART_LEDGER_KEY/);
});
