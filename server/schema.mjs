// 주문서·진료 예약 입력 검증과 Twenty 레코드 형태로의 변환

import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { classifyChannel } from "./channel.mjs";

const text = (max) => z.string().trim().max(max).optional().default("");
const utmText = text(200);
const thisYear = new Date().getFullYear();

const attribution = {
  utm: z.object({ source: utmText, medium: utmText, campaign: utmText, content: utmText, term: utmText }).optional().default({}),
  landingPage: text(500),
  clickId: text(200),
  referrer: text(1000),
};
const bot = {
  // 사람에게 보이지 않는 칸(비어 있어야 함), 폼을 연 시각
  website: z.string().max(0, "invalid").optional().default(""),
  formOpenedAt: z.number().int().positive(),
};
const required = (msg) => z.literal(true, { error: msg });

// 문진 선택지(메디스트림 기본 문진표와 같은 목록). crm/setup_clinic_objects.py의 DISEASES·MEDS와 같아야 한다.
export const DISEASES = ["NONE", "HEART", "DIABETES", "HYPERTENSION", "HEPATITIS", "NEURO_PSYCH", "RESPIRATORY", "GASTRO", "OSTEOPOROSIS", "HAIR_LOSS", "KIDNEY_URO", "ATOPY", "PROSTATE", "OTHER"];
export const MEDS = ["NONE", "ANTIDEPRESSANT", "ASTHMA", "HYPERTENSION", "THYROID", "DIABETES", "OTHER"];
// 하나 이상 골라야 하고, '해당 없음'은 다른 것과 함께 고를 수 없다
const choices = (values, msg) => z.array(z.enum(values, { error: msg })).min(1, msg).max(values.length)
  .transform((a) => [...new Set(a)])
  .refine((a) => !(a.includes("NONE") && a.length > 1), "'해당 없음'과 다른 항목을 함께 고를 수 없어요.");

// 문진(건강정보). 다이어트 상품이면 키·몸무게를 받는다(화면에서 필수로 표시).
const intakeSchema = z.object({
  sex: z.enum(["F", "M"], { error: "성별을 골라 주세요." }),
  birthYear: z.number({ error: "출생 연도를 입력해 주세요." }).int().min(thisYear - 110, "출생 연도를 확인해 주세요.").max(thisYear, "출생 연도를 확인해 주세요."),
  heightCm: z.number().min(80).max(230).nullable().optional().default(null),
  weightKg: z.number().min(20).max(250).nullable().optional().default(null),
  pregnancy: z.enum(["NONE", "PREGNANT", "NURSING", "PLANNING"]).optional().default("NONE"),
  diseases: choices(DISEASES, "질병 경험을 골라 주세요. 없으면 '해당 없음'을 골라 주세요."),
  conditions: text(500),
  recentMeds: choices(MEDS, "최근 한 달 동안 먹은 약을 골라 주세요. 없으면 '해당 없음'을 골라 주세요."),
  medications: text(500),
  allergies: text(300),
  dietHistory: text(300),
  symptoms: text(1000),
}).superRefine((v, ctx) => {
  if (v.diseases.includes("OTHER") && !v.conditions) ctx.addIssue({ code: "custom", path: ["conditions"], message: "어떤 질병인지 적어 주세요." });
  if (v.recentMeds.includes("OTHER") && !v.medications) ctx.addIssue({ code: "custom", path: ["medications"], message: "어떤 약인지 적어 주세요." });
}).transform((v) => (v.sex === "M" ? { ...v, pregnancy: "NONE" } : v)); // 임신·수유는 여성에게만 묻는다

const consents = z.object({
  privacy: required("개인정보 수집·이용에 동의해 주세요."),
  sensitive: required("건강정보 수집·이용에 동의해 주세요."),
  marketing: z.boolean().optional().default(false),
});

const person = {
  name: z.string().trim().min(2, "이름을 2자 이상 입력해 주세요.").max(30),
  phone: z.string().trim().min(9, "휴대폰 번호를 확인해 주세요.").max(20),
};

export const orderSchema = z.object({
  ...person,
  items: z.array(z.object({ slug: z.string().trim().min(1).max(60), qty: z.number().int().min(1).max(20) })).min(1, "장바구니가 비어 있어요.").max(30),
  pickup: z.boolean().optional().default(false),
  recipient: z.object({
    name: text(30), phone: text(20),
    zip: text(10), address1: text(200), address2: text(100), memo: text(100),
  }).optional().default({}),
  consultTime: text(60),
  payMethod: z.enum(["CARD", "KAKAOPAY", "NAVERPAY"]).optional().default("CARD"),
  intake: intakeSchema,
  consents: consents.extend({
    terms: required("구매 조건을 확인하고 동의해 주세요."),
    dosage: required("상품의 복용 방법과 주의사항을 확인해 주세요."),
  }),
  noticeVersion: z.string().trim().min(1).max(40),
  ...attribution,
  ...bot,
}).superRefine((v, ctx) => {
  if (v.pickup) return;
  const r = v.recipient;
  if (!/^\d{5}$/.test(r.zip)) ctx.addIssue({ code: "custom", path: ["recipient", "zip"], message: "주소 검색으로 우편번호를 넣어 주세요." });
  if (r.address1.length < 5) ctx.addIssue({ code: "custom", path: ["recipient", "address1"], message: "배송받을 주소를 넣어 주세요." });
});

export const appointmentSchema = z.object({
  ...person,
  product: z.string().trim().min(1).max(60),
  method: z.enum(["PHONE", "VISIT"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜를 골라 주세요."),
  time: z.string().regex(/^\d{2}:\d{2}$/, "시간을 골라 주세요."),
  intake: intakeSchema,
  consents,
  noticeVersion: z.string().trim().min(1).max(40),
  ...attribution,
  ...bot,
});

// 빠른 상담: 이름·휴대폰만 받는다. 건강정보는 받지 않는다(상담 전화 때 묻는다).
export const consultSchema = z.object({
  ...person,
  interest: text(60),
  consents: z.object({ privacy: required("개인정보 수집·이용에 동의해 주세요."), marketing: z.boolean().optional().default(false) }),
  noticeVersion: z.string().trim().min(1).max(40),
  ...attribution,
  ...bot,
});

// 국내 휴대폰 번호만 받는다. Twenty PHONES 필드 형식으로 돌려준다.
export function normalizeMobile(raw) {
  const p = parsePhoneNumberFromString(String(raw ?? ""), "KR");
  if (!p || !p.isValid() || p.country !== "KR" || p.getType() !== "MOBILE") return null;
  return { primaryPhoneNumber: p.nationalNumber, primaryPhoneCountryCode: "KR", primaryPhoneCallingCode: "+82" };
}

// 한국 이름을 성/이름으로 나눈다. 두 글자 성은 목록으로 처리한다.
const TWO_CHAR_SURNAMES = ["남궁", "제갈", "선우", "황보", "독고", "사공", "서문", "동방", "어금", "망절"];
export function splitKoreanName(full) {
  const n = full.replace(/\s+/g, "");
  if (!/^[가-힣]+$/.test(n)) {
    const parts = full.trim().split(/\s+/);
    return { lastName: parts.length > 1 ? parts.at(-1) : "", firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : full.trim() };
  }
  const sur = n.length >= 4 && TWO_CHAR_SURNAMES.includes(n.slice(0, 2)) ? 2 : 1;
  return { lastName: n.slice(0, sur), firstName: n.slice(sur) };
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 신규 고객. 유입 정보는 첫 접점 기준으로 이때만 기록한다.
export function toNewPerson(input, phones) {
  const { channel, referrer, keyword } = classifyChannel(input);
  return {
    name: splitKoreanName(input.name), phones,
    utmSource: input.utm.source, utmMedium: input.utm.medium, utmCampaign: input.utm.campaign,
    utmContent: input.utm.content, utmTerm: input.utm.term,
    landingPage: input.landingPage, clickId: input.clickId,
    acquisitionChannel: channel, referrer, searchKeyword: keyword,
    consentMarketing: input.consents.marketing,
  };
}

export function toIntake(intake, links, cfg, now) {
  return {
    ...links,
    sex: intake.sex, birthYear: intake.birthYear, heightCm: intake.heightCm, weightKg: intake.weightKg,
    pregnancy: intake.pregnancy, diseases: intake.diseases, conditions: intake.conditions,
    recentMeds: intake.recentMeds, medications: intake.medications,
    allergies: intake.allergies, dietHistory: intake.dietHistory, symptoms: intake.symptoms,
    purgeAfter: addDays(now, cfg.intakeRetentionDays),
  };
}

// 동의원장에 남길 행. 필수 동의는 동의한 경우에만 접수되므로 항상 '동의'로 남고, 광고 수신은 동의·미동의 모두 남긴다.
export function toConsentRecords(input, personId, ctx, types) {
  const base = { noticeVersion: input.noticeVersion, collectedAt: ctx.now.toISOString(), collectedIp: ctx.ip, sourceUrl: input.landingPage, personId };
  const label = { PRIVACY: "개인정보 수집·이용", SENSITIVE: "건강정보 수집·이용", TERMS: "구매 조건·약관", DOSAGE: "복용 방법·주의사항 확인", MARKETING: "광고성 정보 수신" };
  return types.map((t) => {
    const granted = Boolean(input.consents[t.toLowerCase()]);
    return { ...base, name: `${label[t]} ${granted ? "동의" : "미동의"}`, consentType: t, granted };
  });
}

// zod 오류를 { "필드.경로": "메시지" }로
export const fieldErrors = (error) => Object.fromEntries(error.issues.map((i) => [i.path.join("."), i.message]));
