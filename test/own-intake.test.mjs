import test from "node:test";
import assert from "node:assert/strict";
import { createOwnAppointment } from "../server/appointments.mjs";
import { createOwnConsult } from "../server/consults.mjs";
import { Rejected } from "../server/orders.mjs";

const ctx = { ip: "192.0.2.1", now: new Date("2026-11-23T00:00:00Z") };
const cfg = {
  noticeVersions: ["test-v1"], minFillMs: 500, intakeRetentionDays: 365, consultRetentionDays: 90,
  hours: [{ days: [1], open: "09:00", close: "18:00" }],
  slotMinutes: 30, slotCapacity: 2, slotLeadHours: 2, slotDays: 30,
};
const raw = {
  name: "김가상", phone: "010-1234-5678", noticeVersion: "test-v1", formOpenedAt: ctx.now.getTime() - 1000,
  landingPage: "/telemedicine/sample", utm: { source: "sample" }, consents: { privacy: true, sensitive: true, marketing: false },
};
const appointment = {
  ...raw, product: "sample", method: "PHONE", date: "2026-11-23", time: "11:30",
  intake: { sex: "M", birthYear: 1990, pregnancy: "PREGNANT", diseases: ["NONE"], recentMeds: ["NONE"] },
};
const product = { id: "sample-product", name: "시험 진료", published: true, kind: "RESERVATION", telemedicine: true, inPerson: true };
const scheduledAt = "2026-11-23T02:30:00.000Z";
const consent = (type, name, granted = true) => ({
  noticeVersion: "test-v1", collectedAt: "2026-11-23T00:00:00.000Z", collectedIp: "192.0.2.1",
  sourceUrl: "/telemedicine/sample", name, consentType: type, granted,
});
const privacy = consent("PRIVACY", "개인정보 수집·이용 동의");
const sensitive = consent("SENSITIVE", "건강정보 수집·이용 동의");
const marketing = consent("MARKETING", "광고성 정보 수신 미동의", false);
const commandKey = /^[A-Za-z0-9._:-]{1,128}$/;

function appointmentReads(overrides = {}) {
  return {
    async productsBySlugs(slugs) { assert.deepEqual(slugs, ["sample"]); return [product]; },
    async takenSlots(from, to) {
      assert.deepEqual([from, to], ["2026-11-22T15:00:00.000Z", "2026-11-23T15:00:00.000Z"]);
      return [scheduledAt];
    },
    async closures(from, to) { assert.deepEqual([from, to], ["2026-11-23", "2026-11-23"]); return []; },
    ...overrides,
  };
}

function assertPerson(person) {
  assert.deepEqual(person.name, { firstName: "가상", lastName: "김" });
  assert.deepEqual(person.phones, { primaryPhoneNumber: "1012345678", primaryPhoneCountryCode: "KR", primaryPhoneCallingCode: "+82" });
  assert.equal(person.utmSource, "sample");
  assert.equal(person.landingPage, "/telemedicine/sample");
  assert.equal(person.consentMarketing, false);
}

test("자체 예약: 읽기 검증 뒤 정원·문진·동의를 명령 한 번에 넘기고 기존 응답을 돌려준다", async () => {
  const calls = [];
  const crm = appointmentReads({
    async command(...args) {
      calls.push(args);
      return { appointmentId: "appointment-id", personId: "person-id", slotKey: `${scheduledAt}#1` };
    },
  });
  const label = "11/23 11:30 전화 · 시험 진료";
  assert.deepEqual(await createOwnAppointment(appointment, ctx, { cfg, crm }), { appointmentId: "appointment-id", label });
  assert.equal(calls.length, 1);
  const [path, key, body] = calls[0];
  assert.equal(path, "appointments");
  assert.match(key, commandKey);
  const { person, ...rest } = body;
  assertPerson(person);
  assert.deepEqual(rest, {
    name: label, productId: "sample-product", method: "PHONE", scheduledAt, capacity: 2,
    intake: {
      name: `김가상 · 예약 ${label}`, sex: "M", birthYear: 1990, heightCm: null, weightKg: null, pregnancy: "NONE",
      diseases: ["NONE"], conditions: "", recentMeds: ["NONE"], medications: "", allergies: "", dietHistory: "", symptoms: "", purgeAfter: "2027-11-23",
    },
    consents: [privacy, sensitive, marketing],
  });
});

test("자체 빠른 상담: 문진을 보내지 않고 접수마다 다른 키를 쓴다", async () => {
  const calls = [];
  const crm = {
    async command(...args) { calls.push(args); return { consultId: "consult-id", personId: "person-id" }; },
  };
  const input = { ...raw, interest: " 시험 상담 ", intake: appointment.intake };
  assert.deepEqual(await createOwnConsult(input, ctx, { cfg, crm }), { consultId: "consult-id" });
  assert.deepEqual(await createOwnConsult(input, ctx, { cfg, crm }), { consultId: "consult-id" });
  assert.equal(calls.length, 2);
  const [path, key, body] = calls[0];
  assert.equal(path, "consults");
  assert.match(key, commandKey);
  assert.match(calls[1][1], commandKey);
  assert.notEqual(calls[1][1], key);
  const { person, ...rest } = body;
  assertPerson(person);
  assert.deepEqual(rest, { name: "김가상 빠른 상담", interest: "시험 상담", purgeAfter: "2027-02-21", consents: [privacy, marketing] });
  assert.deepEqual(calls[1][2], body);
});

const rejects = (status, code, message, fields) => (e) => {
  assert.ok(e instanceof Rejected);
  assert.deepEqual({ status: e.status, code: e.code, message: e.message, fields: e.fields }, { status, code, message, fields });
  return true;
};
const invalidProduct = rejects(409, "invalid_product", "예약할 수 없는 진료예요. 페이지를 새로 고쳐 주세요.");
const slotTaken = rejects(409, "slot_taken", "방금 그 시간이 마감됐어요. 다른 시간을 골라 주세요.", { time: "다른 시간을 골라 주세요." });

test("자체 접수: 기존 폼·휴대폰·동의 버전 검증을 CRM 호출 전에 실행한다", async () => {
  await assert.rejects(createOwnAppointment({ ...appointment, website: "bot" }, ctx, { cfg, crm: {} }), rejects(400, "rejected", "요청을 처리할 수 없어요."));
  await assert.rejects(createOwnConsult({ ...raw, phone: "02-123-4567" }, ctx, { cfg, crm: {} }),
    rejects(422, "invalid", "입력값을 확인해 주세요.", { phone: "휴대폰 번호를 확인해 주세요. 예: 010-1234-5678" }));
  await assert.rejects(createOwnConsult({ ...raw, noticeVersion: "old" }, ctx, { cfg, crm: {} }),
    rejects(409, "stale_notice", "안내문이 바뀌었어요. 페이지를 새로 고친 뒤 다시 시도해 주세요."));
});

test("자체 예약: 상품·방식·휴진·진료시간·최소 간격·정원을 사전 검증한다", async () => {
  for (const products of [[], [{ ...product, published: false }], [{ ...product, kind: "SALE" }]]) {
    await assert.rejects(createOwnAppointment(appointment, ctx, { cfg, crm: { productsBySlugs: async () => products } }), invalidProduct);
  }
  await assert.rejects(createOwnAppointment(appointment, ctx, { cfg, crm: { productsBySlugs: async () => [{ ...product, telemedicine: false }] } }),
    rejects(422, "invalid", "이 진료는 한의원에서만 받을 수 있어요.", { method: "한의원 진료를 골라 주세요." }));
  await assert.rejects(createOwnAppointment({ ...appointment, method: "VISIT" }, ctx, { cfg, crm: { productsBySlugs: async () => [{ ...product, inPerson: false }] } }),
    rejects(422, "invalid", "이 진료는 전화로만 받을 수 있어요.", { method: "전화 진료를 골라 주세요." }));
  for (const [input, crm] of [
    [appointment, appointmentReads({ closures: async () => [appointment.date] })],
    [appointment, appointmentReads({ takenSlots: async () => [scheduledAt, scheduledAt] })],
    [{ ...appointment, time: "18:00" }, appointmentReads()],
    [{ ...appointment, time: "10:30" }, appointmentReads()],
  ]) {
    await assert.rejects(createOwnAppointment(input, ctx, { cfg, crm }), slotTaken);
  }
});

test("자체 예약: 사전 검증 뒤에 발생한 CRM 업무 충돌을 기존 공개 오류로 바꾼다", async () => {
  for (const [code, expected] of [["invalid_product", invalidProduct], ["slot_taken", slotTaken]]) {
    let calls = 0;
    const crm = appointmentReads({ command: async () => { calls++; throw Object.assign(new Error("CRM conflict"), { status: 409, code }); } });
    await assert.rejects(createOwnAppointment(appointment, ctx, { cfg, crm }), expected);
    assert.equal(calls, 1);
  }
});

test("자체 접수: 권한 오류·일반 충돌을 업무 충돌로 바꾸거나 서비스에서 재시도하지 않는다", async () => {
  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [403, "slot_taken"], [409, "idempotency_conflict"], [409, "conflict"]]) {
    const error = Object.assign(new Error("CRM failure"), { status, code });
    let calls = 0;
    const crm = appointmentReads({ command: async () => { calls++; throw error; } });
    await assert.rejects(createOwnAppointment(appointment, ctx, { cfg, crm }), (e) => e === error);
    await assert.rejects(createOwnConsult(raw, ctx, { cfg, crm }), (e) => e === error);
    assert.equal(calls, 2);
  }
});
