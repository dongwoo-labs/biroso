// Twenty REST API 얇은 클라이언트. 이 서비스가 쓰는 호출만 둔다.

export class TwentyError extends Error {
  constructor(status, body) {
    super(`Twenty ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
  }
}

// 고유값 필드(isUnique)에 같은 값이 이미 있어 거절된 경우
export const isDuplicate = (e) => e instanceof TwentyError && [400, 409].includes(e.status) && /duplicate|unique/i.test(e.message);

// 파기해도 되는 고객인가: 주문·예약·문진·상담·수납·처방·패키지·연락 업무·진료기록이 하나도 없고, 차트번호가 없는(한의원 환자가 아닌) 사람.
// 차트번호가 있는 환자는 진료기록 보존 대상이라 온라인 주문 파기와 함께 지우지 않는다.
export function isOrphan(p) {
  if (!p || p.chartNo) return false;
  return !["clinicOrders", "appointments", "intakes", "consultRequests", "payments", "prescriptions", "patientPackages", "contactTasks", "medicalRecords"].some((k) => (p[k]?.length ?? 0) > 0);
}

export class SlotTaken extends Error {
  constructor(slotKey) {
    super(`예약 칸이 이미 찼습니다: ${slotKey}`);
    this.slotKey = slotKey;
  }
}

const won = (c) => (c?.amountMicros == null ? null : Math.round(c.amountMicros / 1_000_000));
export const money = (n) => ({ amountMicros: Math.round(n) * 1_000_000, currencyCode: "KRW" });

// Twenty 상품 레코드 → 가격 계산용
export const toProduct = (p) => ({
  id: p.id,
  slug: p.slug || p.id,
  name: p.name ?? "",
  kind: p.kind ?? "PAYMENT",
  published: Boolean(p.published),
  salesChannel: p.salesChannel ?? "OWN",
  soldOut: Boolean(p.soldOut),
  taxFree: Boolean(p.taxFree),
  freeShipping: Boolean(p.freeShipping),
  telemedicine: Boolean(p.telemedicine),
  inPerson: Boolean(p.inPerson),
  salePrice: won(p.salePrice) ?? won(p.regularPrice),
  // 비어 있으면 재고를 세지 않는다
  stock: typeof p.stock === "number" ? p.stock : null,
});

export function createTwenty({ twentyUrl, twentyApiKey }, fetchImpl = fetch) {
  async function call(method, path, body) {
    const res = await fetchImpl(`${twentyUrl}/rest${path}`, {
      method,
      // Twenty Cloud(Cloudflare)는 User-Agent 없는 요청을 막을 수 있다
      headers: { Authorization: `Bearer ${twentyApiKey}`, "Content-Type": "application/json", "User-Agent": "biroso-api/1.0" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new TwentyError(res.status, text);
    return text ? JSON.parse(text) : {};
  }
  const q = (filter, extra = "") => `?filter=${encodeURIComponent(filter)}${extra}`;
  const quoted = (vals) => vals.map((v) => JSON.stringify(String(v))).join(",");
  async function listAll(plural, filter, extra = "") {
    const out = [];
    let cursor = "";
    for (;;) {
      const r = await call("GET", `/${plural}${q(filter, `&limit=60${extra}${cursor ? `&starting_after=${cursor}` : ""}`)}`);
      out.push(...r.data[plural]);
      if (!r.pageInfo?.hasNextPage) return out;
      cursor = r.pageInfo.endCursor;
    }
  }

  return {
    // 주소(slug) 또는 레코드 ID로 상품을 찾는다
    async productsBySlugs(slugs) {
      if (!slugs.length) return [];
      const ids = slugs.filter((s) => /^[0-9a-f-]{36}$/.test(s));
      const bySlug = `slug[in]:[${quoted(slugs)}]`;
      const found = await listAll("products", ids.length ? `or(${bySlug},id[in]:[${quoted(ids)}])` : bySlug);
      return found.map(toProduct);
    },
    // 결제한 수량만큼 상품 재고를 뺀다(재고를 세는 상품만). 0 밑으로는 내리지 않는다.
    async takeStock(items) {
      const ids = [...new Set(items.map((i) => i.productId).filter(Boolean))];
      if (!ids.length) return [];
      const rows = await listAll("products", `id[in]:[${quoted(ids)}]`, "&depth=0");
      const out = [];
      for (const p of rows) {
        if (typeof p.stock !== "number") continue;
        const qty = items.filter((i) => i.productId === p.id).reduce((n, i) => n + (Number(i.qty) || 0), 0);
        const stock = Math.max(0, p.stock - qty);
        await call("PATCH", `/products/${p.id}`, stock === 0 ? { stock, soldOut: true } : { stock });
        out.push({ id: p.id, stock });
      }
      return out;
    },
    // 홈페이지 팝업 공지: 게시 중인 것(기간은 handler가 거른다)
    async popupNotices() {
      return listAll("popupNotices", `popupStatus[eq]:"ON"`, "&depth=0");
    },
    async findPersonByPhone(nationalNumber) {
      const r = await call("GET", `/people${q(`phones.primaryPhoneNumber[eq]:"${nationalNumber}"`, "&limit=1")}`);
      return r.data.people[0] ?? null;
    },
    async createPerson(person) {
      return (await call("POST", "/people", person)).data.createPerson;
    },
    async updatePerson(id, patch) {
      await call("PATCH", `/people/${id}`, patch);
    },
    async createConsentRecord(row) {
      return (await call("POST", "/consentRecords", row)).data.createConsentRecord;
    },
    async createOrder(row) {
      return (await call("POST", "/clinicOrders", row)).data.createClinicOrder;
    },
    async findOrder(orderNo) {
      const r = await call("GET", `/clinicOrders${q(`name[eq]:"${orderNo}"`, "&limit=1")}`);
      return r.data.clinicOrders[0] ?? null;
    },
    async updateOrder(id, patch) {
      await call("PATCH", `/clinicOrders/${id}`, patch);
    },
    async createConsult(row) {
      return (await call("POST", "/consultRequests", row)).data.createConsultRequest;
    },
    async listExpiredConsults(today) {
      return listAll("consultRequests", `purgeAfter[lt]:"${today}"`);
    },
    async createIntake(row) {
      return (await call("POST", "/intakes", row)).data.createIntake;
    },
    // slotKey가 이미 있으면 SlotTaken을 던진다(고유값 필드라 Twenty가 원자적으로 막는다)
    async createAppointment(row) {
      try {
        return (await call("POST", "/appointments", row)).data.createAppointment;
      } catch (e) {
        if (isDuplicate(e)) throw new SlotTaken(row.slotKey);
        throw e;
      }
    },
    async findAppointmentBySlotKey(slotKey) {
      const r = await call("GET", `/appointments${q(`slotKey[eq]:"${slotKey}"`, "&limit=1")}`);
      return r.data.appointments[0] ?? null;
    },
    async updateAppointment(id, patch) {
      await call("PATCH", `/appointments/${id}`, patch);
    },
    // 그 날(한국 시간) 잡혀 있는, 취소되지 않은 예약 시각
    async takenSlots(fromIso, toIso) {
      const rows = await listAll("appointments", `and(scheduledAt[gte]:"${fromIso}",scheduledAt[lt]:"${toIso}",appointmentStatus[neq]:"CANCELLED")`);
      return rows.map((a) => new Date(a.scheduledAt).toISOString());
    },
    async closures(fromDate, toDate) {
      const rows = await listAll("closures", `and(date[gte]:"${fromDate}",date[lte]:"${toDate}")`);
      return rows.map((c) => String(c.date).slice(0, 10));
    },

    // 연락 여정(server/journey.mjs): 판단에 필요한 레코드를 모두 읽는다(한의원 한 곳 규모, 관계는 id만)
    async journeyData() {
      const all = (plural) => listAll(plural, "", "&depth=0");
      const [rules, tasks, prescriptions, appointments, people, packages, messages, orders, threads, talks] = await Promise.all([
        all("contactRules"),
        all("contactTasks"),
        all("prescriptions"),
        all("appointments"),
        all("people"),
        all("patientPackages"),
        // 여정이 만든 발송(중복 방지 키가 있는 것)만
        listAll("messages", "dedupeKey[is]:NOT_NULL", "&depth=0"),
        // 한약 발송 안내용(송장 넣은 주문), 톡톡 안내용(환자와 이어진 대화, 여정이 보낸 톡톡)
        listAll("clinicOrders", "shippedAt[is]:NOT_NULL", "&depth=0").catch(() => []),
        listAll("counselThreads", "customerId[is]:NOT_NULL", "&depth=0").catch(() => []),
        listAll("counselMessages", "dedupeKey[is]:NOT_NULL", "&depth=0").catch(() => []),
      ]);
      return { rules, tasks, prescriptions, appointments, people, packages, messages, orders, threads, talks, clinicName: process.env.CLINIC_NAME || "비로소한의원" };
    },
    async createMessage(row) {
      try {
        await call("POST", "/messages", row);
        return true;
      } catch (e) {
        if (isDuplicate(e)) return false;
        throw e;
      }
    },
    // 같은 dedupeKey가 이미 있으면 false
    async createCounselMessage(row) {
      try {
        await call("POST", "/counselMessages", row);
        return true;
      } catch (e) {
        if (isDuplicate(e)) return false;
        throw e;
      }
    },
    async updateMessage(id, patch) {
      await call("PATCH", `/messages/${id}`, patch);
    },
    // 같은 dedupeKey가 이미 있으면(다른 실행이 먼저 만듦) 만들지 않고 false
    async createContactTask(row) {
      try {
        await call("POST", "/contactTasks", row);
        return true;
      } catch (e) {
        if (isDuplicate(e)) return false;
        throw e;
      }
    },
    async updateContactTask(id, patch) {
      await call("PATCH", `/contactTasks/${id}`, patch);
    },

    // 진료기록 봉인: 서명한 기록(검사 때는 봉인했던 기록도 — 서명 상태가 풀렸는지 보려고)
    async listSignedCharts(includeSealed = false) {
      return listAll("medicalRecords", includeSealed ? 'or(recordStatus[eq]:"SIGNED",sealNo[is]:NOT_NULL)' : 'recordStatus[eq]:"SIGNED"', "&depth=0");
    },
    async updateChart(id, patch) {
      await call("PATCH", `/medicalRecords/${id}`, patch);
    },

    // 파기: 결제하지 않고 떠난 주문(+ 그 주문의 문진), 보유기간이 지난 문진·빠른 상담
    async listStalePendingOrders(beforeIso) {
      return listAll("clinicOrders", `and(orderStatus[eq]:"PENDING",createdAt[lt]:"${beforeIso}")`, "&depth=1");
    },
    async listExpiredIntakes(today) {
      return listAll("intakes", `purgeAfter[lt]:"${today}"`);
    },
    async listOldStaffMessages(beforeIso) {
      return listAll("staffMessages", `createdAt[lt]:"${beforeIso}"`, "&depth=0");
    },
    async intakesOfOrder(orderId) {
      return listAll("intakes", `clinicOrderId[eq]:"${orderId}"`);
    },
    async hardDelete(plural, id) {
      await call("DELETE", `/${plural}/${id}?soft_delete=false`);
    },
    // 주문·예약·상담이 하나도 없는 고객(결제하지 않고 떠난 사람, 보관 기간이 지난 상담 신청자)은 동의기록과 함께 지운다
    async deletePersonIfOrphan(personId) {
      const p = (await call("GET", `/people/${personId}?depth=1`)).data.person;
      if (!isOrphan(p)) return false;
      for (const c of p.consentRecords ?? []) await call("DELETE", `/consentRecords/${c.id}?soft_delete=false`);
      // 발송 내역은 파기를 막지 않고 함께 지운다
      for (const m of p.messages ?? []) await call("DELETE", `/messages/${m.id}?soft_delete=false`);
      // 이 사람을 연결한 고객 상담(네이버 톡톡 등) 대화와 메시지도 함께 지운다(객체가 아직 없으면 counselThreads가 비어 있다)
      for (const t of p.counselThreads ?? []) {
        for (;;) {
          const ms = await call("GET", `/counselMessages${q(`counselThreadId[eq]:"${t.id}"`, "&limit=60&depth=0")}`);
          if (!ms.data.counselMessages.length) break;
          for (const m of ms.data.counselMessages) await call("DELETE", `/counselMessages/${m.id}?soft_delete=false`);
        }
        await call("DELETE", `/counselThreads/${t.id}?soft_delete=false`);
      }
      for (;;) {
        const tl = await call("GET", `/timelineActivities${q(`targetPersonId[eq]:"${personId}"`, "&limit=60")}`);
        if (!tl.data.timelineActivities.length) break;
        for (const a of tl.data.timelineActivities) await call("DELETE", `/timelineActivities/${a.id}?soft_delete=false`);
      }
      await call("DELETE", `/people/${personId}?soft_delete=false`);
      return true;
    },
  };
}
