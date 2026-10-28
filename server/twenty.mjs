// Twenty REST API 얇은 클라이언트. 이 서비스가 쓰는 호출만 둔다.

export class TwentyError extends Error {
  constructor(status, body) {
    super(`Twenty ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
  }
}

const won = (c) => (c?.amountMicros == null ? null : Math.round(c.amountMicros / 1_000_000));
export const money = (n) => ({ amountMicros: Math.round(n) * 1_000_000, currencyCode: "KRW" });

// Twenty 상품 레코드 → 가격 계산용
export const toProduct = (p) => ({
  id: p.id, slug: p.slug || p.id, name: p.name ?? "", kind: p.kind ?? "PAYMENT", published: Boolean(p.published),
  soldOut: Boolean(p.soldOut), taxFree: Boolean(p.taxFree), freeShipping: Boolean(p.freeShipping),
  telemedicine: Boolean(p.telemedicine), inPerson: Boolean(p.inPerson),
  salePrice: won(p.salePrice) ?? won(p.regularPrice),
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
    async createIntake(row) {
      return (await call("POST", "/intakes", row)).data.createIntake;
    },
    async createAppointment(row) {
      return (await call("POST", "/appointments", row)).data.createAppointment;
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

    // 파기: 결제하지 않고 떠난 주문(+ 그 주문의 문진), 보유기간이 지난 문진
    async listStalePendingOrders(beforeIso) {
      return listAll("clinicOrders", `and(orderStatus[eq]:"PENDING",createdAt[lt]:"${beforeIso}")`, "&depth=1");
    },
    async listExpiredIntakes(today) {
      return listAll("intakes", `purgeAfter[lt]:"${today}"`);
    },
    async intakesOfOrder(orderId) {
      return listAll("intakes", `clinicOrderId[eq]:"${orderId}"`);
    },
    async hardDelete(plural, id) {
      await call("DELETE", `/${plural}/${id}?soft_delete=false`);
    },
    // 주문·예약이 하나도 없는 고객(결제하지 않고 떠난 사람)은 동의기록과 함께 지운다
    async deletePersonIfOrphan(personId) {
      const p = (await call("GET", `/people/${personId}?depth=1`)).data.person;
      if (!p || (p.clinicOrders?.length ?? 0) > 0 || (p.appointments?.length ?? 0) > 0 || (p.intakes?.length ?? 0) > 0) return false;
      for (const c of p.consentRecords ?? []) await call("DELETE", `/consentRecords/${c.id}?soft_delete=false`);
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
