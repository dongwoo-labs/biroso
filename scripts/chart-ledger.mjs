#!/usr/bin/env node
// 진료기록 봉인 장부 보기·되살리기 도구(관리자용). 장부 파일과 CHART_LEDGER_KEY가 있는 곳(api 컨테이너)에서 실행한다.
//   docker compose exec api node scripts/chart-ledger.mjs check                 체인 검사, 줄 수, 끝 해시(원장이 받은 기준값과 대조)
//   docker compose exec api node scripts/chart-ledger.mjs show <기록 ID>        봉인 당시 내용(복호화, JSON) — 변조됐을 때 원래 내용
//   docker compose exec api node scripts/chart-ledger.mjs sql <기록 ID>         원래 내용으로 되돌리는 SQL(검토 후 DB 관리자가 실행)
// 되돌리기는 서명한 기록을 고치는 일이라 DB 트리거가 막는다. SQL은 트리거를 잠시 비켜 가며(session_replication_role) 그 실행이
// DB 감사 로그(pgaudit)에 남는다. 원장 확인을 받고, 사고 기록(README '진료기록 이상 대응')에 함께 남긴다.
import { CHART_FIELDS, createLedger, openEntry, parseKey, verifyChain } from "../server/charts.mjs";

const [cmd, id] = process.argv.slice(2);
const ledger = createLedger(process.env.CHART_LEDGER_PATH ?? "/data/charts/ledger.jsonl");
const entries = await ledger.read();
const chain = verifyChain(entries);

if (cmd === "check") {
  console.log(JSON.stringify({ ...chain, entries: entries.length, head16: chain.head?.slice(0, 16) }, null, 2));
  process.exit(chain.ok ? 0 : 1);
}
if (!["show", "sql"].includes(cmd) || !id) {
  console.error("사용: chart-ledger.mjs check | show <기록 ID> | sql <기록 ID>");
  process.exit(2);
}
const key = parseKey(process.env.CHART_LEDGER_KEY);
if (!key) throw new Error("CHART_LEDGER_KEY가 없습니다");
if (!chain.ok) console.error(`주의: 장부 체인이 깨졌습니다(${chain.at}번 줄: ${chain.why}). 백업의 장부와 대조하세요.`);
const entry = entries.filter((e) => e.recordId === id && !e.kind).at(-1);
if (!entry) throw new Error(`봉인한 기록이 아닙니다: ${id}`);
const data = openEntry(key, entry);
if (cmd === "show") {
  console.log(JSON.stringify({ sealNo: entry.seq, sealedAt: entry.at, contentHash: entry.contentHash, record: data }, null, 2));
} else {
  const lit = (v) => (v == null ? "null" : `'${String(v).replaceAll("'", "''")}'`);
  const cols = CHART_FIELDS.map((k) => `"${k}" = ${lit(data[k])}`);
  cols.push(`"contentHash" = ${lit(entry.contentHash)}`, `"recordStatus" = 'SIGNED'`, `"sealNo" = ${entry.seq}`, `"sealedAt" = ${lit(entry.at)}`, `"deletedAt" = null`);
  console.log(`-- 봉인 ${entry.seq}번(${entry.at}) 내용으로 되돌리기. 워크스페이스 스키마를 확인하고 실행한다.
begin;
set local session_replication_role = replica;
update <워크스페이스 스키마>."_medicalRecord" set ${cols.join(",\n  ")}
where id = ${lit(id)};
commit;`);
}
