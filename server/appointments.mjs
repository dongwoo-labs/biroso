// 진료 예약(전화 진료·한의원 진료). 원본 사이트의 '진료 예약' 상품(예약형)마다 받는다. 결제는 없다.

import { appointmentSchema, toIntake, toConsentRecords } from "./schema.mjs";
import { availableSlots, kstIso, kstDate } from "./slots.mjs";
import { checkCommon, upsertPerson, Rejected } from "./orders.mjs";
import { SlotTaken } from "./twenty.mjs";

// 예약 칸 잡기. 칸마다 정원만큼 자리 키(<예약 시각>#<번호>)가 있고, slotKey가 Twenty 고유값 필드라
// 동시에 같은 자리를 잡으면 하나만 성공한다(Vercel 인스턴스가 여러 개여도 안전).
// 자리 주인이 취소됐거나 직원이 Twenty에서 시간을 옮긴 예약이면 그 자리를 풀고 다시 잡는다.
async function reserveSeat(row, scheduledAt, capacity, twenty) {
  for (let seat = 0; seat < capacity; seat++) {
    const slotKey = `${scheduledAt}#${seat}`;
    for (let tries = 0; tries < 2; tries++) {
      try {
        return await twenty.createAppointment({ ...row, slotKey });
      } catch (e) {
        if (!(e instanceof SlotTaken)) throw e;
        const holder = await twenty.findAppointmentBySlotKey(slotKey);
        const stale = holder && (holder.appointmentStatus === "CANCELLED" || new Date(holder.scheduledAt).toISOString() !== scheduledAt);
        if (!stale) break;
        await twenty.updateAppointment(holder.id, { slotKey: `released:${holder.id}` });
      }
    }
  }
  return null;
}

const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);

async function slotsFor(date, { cfg, twenty }, now) {
  const from = kstIso(date, "00:00"), to = kstIso(nextDay(date), "00:00");
  const [taken, closures] = await Promise.all([twenty.takenSlots(from, to), twenty.closures(date, date)]);
  return availableSlots(date, {
    hours: cfg.hours, closures, taken, now, minutes: cfg.slotMinutes, capacity: cfg.slotCapacity, leadHours: cfg.slotLeadHours, days: cfg.slotDays,
  });
}

// GET /v1/slots?date=YYYY-MM-DD
export async function getSlots(date, deps, now = new Date()) {
  return { date, slots: await slotsFor(date, deps, now) };
}

// GET /v1/closures — 앞으로 slotDays일 동안의 휴진일(달력에서 미리 막는 용도)
export async function getClosures({ cfg, twenty }, now = new Date()) {
  const from = kstDate(now), to = kstDate(new Date(now.getTime() + cfg.slotDays * 86400_000));
  return { closures: await twenty.closures(from, to) };
}

export async function createAppointment(raw, ctx, deps) {
  const { cfg, twenty } = deps;
  const { v, phones } = checkCommon(appointmentSchema.safeParse(raw), ctx, cfg);
  const [product] = await twenty.productsBySlugs([v.product]);
  if (!product || !product.published || product.kind !== "RESERVATION") throw new Rejected(409, "invalid_product", "예약할 수 없는 진료예요. 페이지를 새로 고쳐 주세요.");
  if (v.method === "PHONE" && !product.telemedicine) throw new Rejected(422, "invalid", "이 진료는 한의원에서만 받을 수 있어요.", { method: "한의원 진료를 골라 주세요." });
  if (v.method === "VISIT" && !product.inPerson) throw new Rejected(422, "invalid", "이 진료는 전화로만 받을 수 있어요.", { method: "전화 진료를 골라 주세요." });

  const slot = (await slotsFor(v.date, deps, ctx.now)).find((s) => s.time === v.time);
  if (!slot?.available) throw new Rejected(409, "slot_taken", "방금 그 시간이 마감됐어요. 다른 시간을 골라 주세요.", { time: "다른 시간을 골라 주세요." });

  const personId = await upsertPerson(v, phones, twenty);
  const label = `${v.date.slice(5).replace("-", "/")} ${v.time} ${v.method === "PHONE" ? "전화" : "내원"} · ${product.name}`;
  const scheduledAt = kstIso(v.date, v.time);
  const appt = await reserveSeat({
    name: label, customerId: personId, productId: product.id, method: v.method, scheduledAt, appointmentStatus: "REQUESTED",
  }, scheduledAt, cfg.slotCapacity, twenty);
  if (!appt) throw new Rejected(409, "slot_taken", "방금 그 시간이 마감됐어요. 다른 시간을 골라 주세요.", { time: "다른 시간을 골라 주세요." });
  await twenty.createIntake({ name: `${v.name} · 예약 ${label}`, ...toIntake(v.intake, { customerId: personId, appointmentId: appt.id }, cfg, ctx.now) });
  for (const row of toConsentRecords(v, personId, ctx, ["PRIVACY", "SENSITIVE", "MARKETING"])) await twenty.createConsentRecord(row);
  return { appointmentId: appt.id, label };
}
