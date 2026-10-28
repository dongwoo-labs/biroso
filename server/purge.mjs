// 파기 작업(매일 크론):
//   1) 결제하지 않고 떠난 주문(결제 대기로 PENDING_ORDER_HOURS 지남): 주문·문진을 지우고, 다른 주문·예약이 없는 고객은 동의기록과 함께 지운다
//   2) 보유기간(INTAKE_RETENTION_DAYS)이 지난 문진(건강정보)
// 결제된 주문은 전자상거래법(대금결제·공급 기록 5년)에 따라 남긴다. 진료 기록은 한의원 전자차트에서 따로 관리한다.

export async function runPurge({ cfg, twenty, log = () => {} }, now = new Date()) {
  const out = { orders: 0, intakes: 0, people: 0 };
  const before = new Date(now.getTime() - cfg.pendingOrderHours * 3600_000).toISOString();
  for (const order of await twenty.listStalePendingOrders(before)) {
    for (const i of await twenty.intakesOfOrder(order.id)) { await twenty.hardDelete("intakes", i.id); out.intakes++; }
    await twenty.hardDelete("clinicOrders", order.id); out.orders++;
    if (order.customerId && await twenty.deletePersonIfOrphan(order.customerId)) out.people++;
  }
  const today = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  for (const i of await twenty.listExpiredIntakes(today)) { await twenty.hardDelete("intakes", i.id); out.intakes++; }
  log({ ts: now.toISOString(), event: "purge", ...out });
  return out;
}
