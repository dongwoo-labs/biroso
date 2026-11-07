import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, rxDates, allowed, runJourneys } from "../server/journey.mjs";

// 2026-11-05(목) 07:00 KST
const now = new Date("2026-11-04T22:00:00Z");
const person = (id, x = {}) => ({ id, name: { lastName: "김", firstName: id }, consentNotice: true, ...x });
const rule = (id, x) => ({ id, journey: "복약 관리", channel: "CALL", offsetDays: 0, timeOfDay: "11:00", active: true, activeFrom: "2026-10-01T00:00:00Z", ...x });
const base = () => ({ rules: [], tasks: [], prescriptions: [], appointments: [], people: [person("p1"), person("p2")], packages: [] });

test("복약 날짜: 수령일 기준, 없으면 처방일", () => {
  assert.deepEqual(rxDates({ receivedOn: "2026-11-01", days: 15 }), { start: "2026-11-01", mid: "2026-11-08", end: "2026-11-15" });
  assert.deepEqual(rxDates({ prescribedOn: "2026-11-01", days: 1 }), { start: "2026-11-01", mid: "2026-11-01", end: "2026-11-01" });
  assert.equal(rxDates({ days: 10 }), null);
});

test("복약 3일차 전화: 오늘 예정이면 만들고, 이미 있으면 다시 만들지 않는다", () => {
  const d = base();
  d.rules = [rule("r1", { triggerEvent: "RX_START", offsetDays: 3 })];
  d.prescriptions = [
    { id: "x1", customerId: "p1", receivedOn: "2026-11-02", days: 30, createdAt: "2026-11-01T01:00:00Z" },
    { id: "x2", customerId: "p2", receivedOn: "2026-11-04", days: 30, createdAt: "2026-11-01T01:00:00Z" }, // 내일 예정
  ];
  const { create } = plan(d, now);
  assert.equal(create.length, 1);
  assert.equal(create[0].dedupeKey, "r1:x1");
  assert.equal(create[0].dueAt, "2026-11-05T02:00:00.000Z");
  assert.equal(create[0].customerId, "p1");
  d.tasks = [{ id: "t1", dedupeKey: "r1:x1", taskStatus: "TODO", contactRuleId: "r1", customerId: "p1" }];
  assert.deepEqual(plan(d, now), { create: [], cancel: [], send: [], unsend: [] });
});

test("켜기 전에 생긴 사건은 대상이 아니고, 3일 넘게 지난 예정은 만들지 않는다", () => {
  const d = base();
  d.rules = [rule("r1", { triggerEvent: "RX_END", offsetDays: -3, activeFrom: "2026-11-03T00:00:00Z" })];
  d.prescriptions = [
    { id: "old", customerId: "p1", receivedOn: "2026-10-20", days: 19, createdAt: "2026-10-20T01:00:00Z" },
    { id: "new", customerId: "p2", receivedOn: "2026-11-04", days: 4, createdAt: "2026-11-04T01:00:00Z" }, // 끝 11/7 - 3 = 11/4
    { id: "late", customerId: "p2", receivedOn: "2026-11-03", days: 1, createdAt: "2026-11-03T01:00:00Z" }, // 끝 11/3 - 3 = 10/31: 3일 넘음
  ];
  assert.deepEqual(plan(d, now).create.map((c) => c.sourceId), ["new"]);
});

test("노쇼 다음날 전화는 다시 예약하면 자동 취소", () => {
  const d = base();
  d.rules = [rule("r2", { journey: "노쇼·취소", triggerEvent: "NO_SHOW", offsetDays: 1 })];
  d.appointments = [{ id: "a1", customerId: "p1", appointmentStatus: "NO_SHOW", scheduledAt: "2026-11-04T01:00:00Z" }];
  assert.equal(plan(d, now).create[0]?.dedupeKey, "r2:a1");
  d.tasks = [{ id: "t1", dedupeKey: "r2:a1", taskStatus: "TODO", contactRuleId: "r2", customerId: "p1" }];
  d.appointments.push({ id: "a2", customerId: "p1", appointmentStatus: "CONFIRMED", scheduledAt: "2026-11-10T01:00:00Z" });
  const { create, cancel } = plan(d, now);
  assert.equal(create.length, 0);
  assert.deepEqual(cancel.map((c) => [c.id, c.patch.taskStatus, c.patch.cancelReason]), [["t1", "CANCELLED", "예약·처방·패키지가 바뀌었어요"]]);
});

test("광고·정보성 동의와 연락 그만하기 범위", () => {
  const ad = { isAd: true, channel: "MESSAGE", journey: "재내원" };
  const info = { isAd: false, channel: "MESSAGE", journey: "복약 관리" };
  const call = { isAd: false, channel: "CALL", journey: "복약 관리" };
  assert.equal(allowed(ad, person("a")), false);
  assert.equal(allowed(ad, person("a", { consentMarketing: true })), true);
  assert.equal(allowed(ad, person("a", { consentMarketing: true, contactStop: "AD" })), false);
  assert.equal(allowed(info, person("a", { consentNotice: false })), false);
  assert.equal(allowed(call, person("a", { consentNotice: false })), true);
  assert.equal(allowed(call, person("a", { contactStop: "ALL" })), false);
  assert.equal(allowed(call, person("a", { stoppedJourneys: "노쇼·취소, 복약 관리" })), false);
  // 수신 거부하면 아직 안 한 연락은 취소
  const d = base();
  d.rules = [rule("r3", { journey: "재내원", triggerEvent: "NO_RETURN", offsetDays: 90, isAd: true, channel: "MESSAGE" })];
  d.people = [person("p1", { lastVisitAt: "2026-08-07", consentMarketing: true }), person("p2", { lastVisitAt: "2026-06-01", consentMarketing: true })];
  assert.deepEqual(plan(d, now).create.map((c) => c.customerId), ["p1"]); // p2는 켜기 전에 90일을 넘김
  d.tasks = [{ id: "t1", dedupeKey: "r3:p1@2026-08-07", taskStatus: "TODO", contactRuleId: "r3", customerId: "p1" }];
  d.people[0].contactStop = "AD";
  assert.equal(plan(d, now).cancel[0].patch.cancelReason, "연락 그만·수신 거부");
});

test("패키지 만료 2주 전: 연장하면 예전 연락은 취소되고 새 만료일로 다시 잡힌다", () => {
  const d = base();
  d.rules = [rule("r4", { journey: "패키지", triggerEvent: "PACKAGE_END", offsetDays: -14 })];
  d.packages = [{ id: "k1", customerId: "p1", packageStatus: "ACTIVE", endsOn: "2026-11-19", createdAt: "2026-10-02T00:00:00Z" }];
  assert.equal(plan(d, now).create[0].dedupeKey, "r4:k1@2026-11-19");
  d.tasks = [{ id: "t1", dedupeKey: "r4:k1@2026-11-19", taskStatus: "TODO", contactRuleId: "r4", customerId: "p1" }];
  d.packages[0].endsOn = "2026-12-19";
  const r = plan(d, now);
  assert.equal(r.create.length, 0);
  assert.equal(r.cancel[0].id, "t1");
});

test("runJourneys: 중복으로 거절된 건은 세지 않는다", async () => {
  const d = base();
  d.rules = [rule("r1", { triggerEvent: "RX_START", offsetDays: 3 })];
  d.prescriptions = [{ id: "x1", customerId: "p1", receivedOn: "2026-11-02", days: 30, createdAt: "2026-11-01T01:00:00Z" }];
  const twenty = { journeyData: async () => d, createContactTask: async () => false, updateContactTask: async () => {} };
  assert.deepEqual(await runJourneys({ twenty }, now), { created: 0, cancelled: 0, queued: 0, unqueued: 0 });
});

test("예약 알림: 자동 발송 문구가 있으면 연락 업무 대신 발송을 만들고, 지난 날 것은 따라잡지 않는다", () => {
  const d = base();
  d.rules = [rule("r5", { journey: "예약 알림", triggerEvent: "APPT", offsetDays: -1, timeOfDay: "18:00", channel: "MESSAGE", messageTemplateId: "tpl" })];
  d.appointments = [
    { id: "a1", customerId: "p1", appointmentStatus: "CONFIRMED", scheduledAt: "2026-11-06T05:30:00Z", createdAt: "2026-11-01T00:00:00Z" }, // 내일 14:30
    { id: "a2", customerId: "p2", appointmentStatus: "CONFIRMED", scheduledAt: "2026-11-05T05:30:00Z", createdAt: "2026-11-01T00:00:00Z" }, // 오늘: 어제 보냈어야 함
  ];
  const r = plan(d, now);
  assert.equal(r.create.length, 0);
  assert.equal(r.send.length, 1);
  const m = r.send[0];
  assert.equal(m.dedupeKey, "r5:a1@2026-11-06T05:30:00.000Z");
  assert.equal(m.scheduledAt, "2026-11-05T09:00:00.000Z");
  assert.deepEqual(m.variables, { "고객": "김p1", "날짜": "11/6(금)", "시간": "14:30" });
  assert.equal(m.messageTemplateId, "tpl");
  // 예약 시각이 바뀌면 예전 발송은 취소하고 새로 잡는다
  d.messages = [{ id: "m1", dedupeKey: m.dedupeKey, msgStatus: "QUEUED", customerId: "p1" }];
  d.appointments[0].scheduledAt = "2026-11-06T06:30:00Z";
  const r2 = plan(d, now);
  assert.deepEqual(r2.unsend.map((u) => [u.id, u.patch.msgStatus]), [["m1", "CANCELLED"]]);
  assert.equal(r2.send[0].variables["시간"], "15:30");
  // 이미 보낸 건은 건드리지 않는다
  d.messages[0].msgStatus = "SENT";
  assert.equal(plan(d, now).unsend.length, 0);
});
