// 연락 여정: 기준 사건 + N일 → 연락 업무(contactTask)를 만든다(매일 크론). 업스트림 연락 여정을 대신한다.
//   사건: 복약 시작·중간·끝(처방), 내원 완료·첫 내원·노쇼·예약 취소·마지막 내원(예약·환자), 패키지 만료
//   - 단계(contactRule)를 켠 시각(activeFrom) 뒤에 생긴 사건만 대상('지금부터 들어오는 건만')
//   - 예정일이 오늘이거나 최근 3일 안이면 만든다(크론이 하루 빠져도 따라잡음). dedupeKey(<단계>:<사건>)로 한 번만.
//   - 광고성 단계는 광고 수신 동의자만, 정보성 메시지는 알림 수신 거부자를 뺀다. '연락 그만'(광고·전체·여정)도 지킨다.
//   - 아직 하지 않은 연락 업무는 사건이 바뀌면(다시 예약함, 예약 상태가 바뀜, 패키지 연장, 수신 거부) 자동 취소한다.
// 판단은 plan()이 하고(테스트), runJourneys()는 Twenty에서 읽고 쓴다.

const DAY = 86_400_000;
const KST = 9 * 3600_000;
const CATCH_UP_DAYS = 3;
const UPCOMING = ["REQUESTED", "CONFIRMED", "ARRIVED", "IN_ROOM", "TREATED", "DONE"];

const kstDate = (d) => new Date(new Date(d).getTime() + KST).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
// "2026-11-05" + "11:00" (한국 시간) → ISO
const at = (ymd, hhmm) => new Date(`${ymd}T${/^\d\d:\d\d$/.test(hhmm ?? "") ? hhmm : "10:00"}:00+09:00`).toISOString();

// 처방 시작일(수령일, 없으면 처방일)과 복용 종료일
export function rxDates(rx) {
  const start = (rx.receivedOn || rx.prescribedOn || "").slice(0, 10);
  if (!start) return null;
  const days = Math.max(1, Number(rx.days) || 1);
  const end = (rx.endsOn || "").slice(0, 10) || addDays(start, days - 1);
  return { start, mid: addDays(start, Math.floor((days - 1) / 2)), end };
}

// 단계 하나의 사건들: { key, personId, date(사건 날짜, 한국), since(사건이 생긴 시각) }
export function eventsOf(rule, d) {
  const out = [];
  const push = (personId, sourceId, date, since) => personId && date && out.push({ key: `${rule.id}:${sourceId}`, sourceId, personId, date, since: since ?? `${date}T00:00:00+09:00` });
  const apptsOf = new Map();
  for (const a of d.appointments) apptsOf.set(a.customerId, [...(apptsOf.get(a.customerId) ?? []), a]);
  // 사건 뒤에 다시 잡은 예약이 있으면 그 사건으로는 연락하지 않는다
  const rebooked = (personId, after, exceptId) => (apptsOf.get(personId) ?? []).some((a) => a.id !== exceptId && UPCOMING.includes(a.appointmentStatus) && a.scheduledAt && new Date(a.scheduledAt) > new Date(after));
  switch (rule.event) {
    case "RX_START":
    case "RX_MID":
    case "RX_END":
      for (const rx of d.prescriptions) {
        const x = rxDates(rx);
        if (!x || rx.doneCheckedAt) continue;
        push(rx.customerId, rx.id, { RX_START: x.start, RX_MID: x.mid, RX_END: x.end }[rule.event], rx.createdAt);
      }
      break;
    case "VISIT_DONE":
      for (const a of d.appointments) if (a.appointmentStatus === "DONE") push(a.customerId, a.id, kstDate(a.paidAt || a.scheduledAt), a.paidAt || a.scheduledAt);
      break;
    case "NO_SHOW":
    case "CANCELLED":
      for (const a of d.appointments) {
        if (a.appointmentStatus !== (rule.event === "NO_SHOW" ? "NO_SHOW" : "CANCELLED") || !a.scheduledAt) continue;
        const when = rule.event === "NO_SHOW" ? a.scheduledAt : a.updatedAt || a.scheduledAt;
        if (!rebooked(a.customerId, rule.event === "NO_SHOW" ? a.scheduledAt : when, a.id)) push(a.customerId, a.id, kstDate(when), when);
      }
      break;
    case "FIRST_VISIT":
      for (const p of d.people) if (p.firstVisitAt) push(p.id, `${p.id}@${p.firstVisitAt.slice(0, 10)}`, p.firstVisitAt.slice(0, 10));
      break;
    case "NO_RETURN":
      for (const p of d.people) {
        const last = (p.lastVisitAt ?? "").slice(0, 10);
        // '미내원 N일'은 그날이 되는 순간이 사건이다(켠 뒤에 N일을 넘긴 환자만)
        if (last && !rebooked(p.id, `${last}T23:59:59+09:00`)) push(p.id, `${p.id}@${last}`, last, `${addDays(last, Number(rule.offsetDays) || 0)}T00:00:00+09:00`);
      }
      break;
    case "PACKAGE_END":
      for (const k of d.packages) if (k.packageStatus === "ACTIVE" && k.endsOn) push(k.customerId, `${k.id}@${k.endsOn.slice(0, 10)}`, k.endsOn.slice(0, 10), k.createdAt);
      break;
  }
  return out;
}

// 이 사람에게 이 단계로 연락해도 되나
export function allowed(rule, p) {
  if (!p) return false;
  if (p.contactStop === "ALL") return false;
  if (rule.isAd && (!p.consentMarketing || p.contactStop === "AD")) return false;
  if (!rule.isAd && rule.channel === "MESSAGE" && p.consentNotice === false) return false;
  const stopped = String(p.stoppedJourneys ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return !stopped.includes(rule.journey);
}

// 만들 연락 업무와 취소할 연락 업무
export function plan(d, now = new Date()) {
  const today = kstDate(now);
  const people = new Map(d.people.map((p) => [p.id, p]));
  const have = new Set(d.tasks.map((t) => t.dedupeKey).filter(Boolean));
  const valid = new Set();
  const create = [];
  for (const rule of d.rules) {
    if (!rule.active) continue;
    const from = rule.activeFrom ? new Date(rule.activeFrom) : null;
    for (const e of eventsOf(rule, d)) {
      if (from && new Date(e.since) < from) continue;
      const p = people.get(e.personId);
      if (!allowed(rule, p)) continue;
      valid.add(e.key);
      const due = addDays(e.date, Number(rule.offsetDays) || 0);
      if (due > today || due < addDays(today, -CATCH_UP_DAYS) || have.has(e.key)) continue;
      have.add(e.key);
      create.push({
        name: `${rule.journey ?? "연락"} · ${[p.name?.lastName, p.name?.firstName].filter(Boolean).join("") || "환자"}`,
        customerId: e.personId,
        contactRuleId: rule.id,
        channel: rule.channel ?? "CALL",
        isAd: Boolean(rule.isAd),
        dueAt: at(due, rule.timeOfDay),
        taskStatus: "TODO",
        sourceEvent: rule.event,
        sourceId: e.sourceId,
        dedupeKey: e.key,
      });
    }
  }
  // 여정이 만든, 아직 하지 않은 연락 중 사건이 더는 맞지 않는 것
  const rules = new Map(d.rules.map((r) => [r.id, r]));
  const cancel = [];
  for (const t of d.tasks) {
    if (t.taskStatus !== "TODO" || !t.contactRuleId || !t.dedupeKey) continue;
    const rule = rules.get(t.contactRuleId);
    if (valid.has(t.dedupeKey)) continue;
    const p = people.get(t.customerId);
    const reason = !rule?.active ? "연락 단계를 껐어요" : rule && !allowed(rule, p) ? "연락 그만·수신 거부" : "예약·처방·패키지가 바뀌었어요";
    cancel.push({ id: t.id, patch: { taskStatus: "CANCELLED", cancelReason: reason, doneAt: now.toISOString() } });
  }
  return { create, cancel };
}

export async function runJourneys({ twenty, log = () => {} }, now = new Date()) {
  const d = await twenty.journeyData();
  const { create, cancel } = plan(d, now);
  let created = 0;
  for (const row of create) {
    if (await twenty.createContactTask(row)) created++;
  }
  for (const c of cancel) await twenty.updateContactTask(c.id, c.patch);
  const out = { created, cancelled: cancel.length };
  log({ ts: now.toISOString(), event: "journeys", ...out });
  return out;
}
