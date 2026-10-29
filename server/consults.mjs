// 빠른 상담: 이름·휴대폰만 받는 전화 상담 신청(메디스트림 홈페이지의 '빠른 상담'과 같다).
// Twenty '빠른 상담'에 상담 대기로 쌓이고, 보관 기간(QUICK_CONSULT_RETENTION_DAYS)이 지나면 파기 작업이 지운다.

import { consultSchema, toConsentRecords, addDays } from "./schema.mjs";
import { checkCommon, upsertPerson } from "./orders.mjs";

export async function createConsult(raw, ctx, { cfg, twenty }) {
  const { v, phones } = checkCommon(consultSchema.safeParse(raw), ctx, cfg);
  const personId = await upsertPerson(v, phones, twenty);
  const row = await twenty.createConsult({
    name: `${v.name} 빠른 상담`, customerId: personId, interest: v.interest, consultStatus: "WAITING",
    purgeAfter: addDays(ctx.now, cfg.consultRetentionDays),
  });
  for (const r of toConsentRecords(v, personId, ctx, ["PRIVACY", "MARKETING"])) await twenty.createConsentRecord(r);
  return { consultId: row.id };
}
