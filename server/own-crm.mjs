import { randomUUID } from "node:crypto";
import { createRestOperations } from "./twenty.mjs";

export function ownCrmConfig(env) {
  const url = URL.parse(env.CRM_API_URL ?? "");
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CRM_API_URL에 자체 CRM의 HTTP(S) origin이 필요합니다.");
  }
  const token = env.CRM_API_TOKEN?.trim();
  const sealToken = env.CRM_API_SEAL_TOKEN?.trim();
  const purgeToken = env.CRM_API_PURGE_TOKEN?.trim();
  if (!token) throw new Error("CRM_API_TOKEN이 필요합니다.");
  if (!sealToken || sealToken === token) throw new Error("별도의 CRM_API_SEAL_TOKEN이 필요합니다.");
  if (purgeToken && [token, sealToken].includes(purgeToken)) throw new Error("파기에는 별도의 CRM_API_PURGE_TOKEN이 필요합니다.");
  return { url: url.origin, token, sealToken, purgeToken };
}

const commandCodes = new Set([
  "invalid_request", "unauthorized", "forbidden", "not_found", "conflict", "unsupported_media_type", "audit_unavailable",
  "idempotency_conflict", "cart_changed", "amount_mismatch", "payment_in_progress", "refund_in_progress", "bad_amount", "prescribed",
  "invalid_product", "slot_taken",
]);

class OwnCrmError extends Error {
  constructor(message, status, code, retryable = false) {
    super(message);
    Object.assign(this, { status, code, retryable });
  }
}

function ownRequest(url, token, fetchImpl) {
  return async (method, path, body, key) => {
    let res;
    try {
      res = await fetchImpl(`${url}/api/v1/biroso${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "biroso-api/1.0",
          ...(key === undefined ? {} : { "Idempotency-Key": key }),
        },
        body,
      });
    } catch {
      throw new OwnCrmError("Own CRM connection failed", undefined, undefined, true);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const code = res.status === 409 && json?.error === "Duplicate record violates a unique constraint" ? "duplicate"
        : commandCodes.has(json?.code) ? json.code : undefined;
      throw new OwnCrmError(`Own CRM ${res.status}`, res.status, code, [502, 503, 504].includes(res.status));
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new OwnCrmError("Own CRM invalid JSON response", undefined, undefined, true);
    return json;
  };
}

function ownRest(url, token, fetchImpl, options) {
  const request = ownRequest(url, token, fetchImpl);
  return createRestOperations((method, path, body) => request(method, `/rest${path}`, JSON.stringify(body)), options);
}

export const validCommandKey = (key) => typeof key === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(key);

function ownCommand(url, token, fetchImpl) {
  const request = ownRequest(url, token, fetchImpl);
  return async (path, key, body) => {
    if (!validCommandKey(key)) throw new Error("Invalid CRM idempotency key");
    const encoded = JSON.stringify(body);
    const send = async () => {
      const r = await request("POST", `/commands/${path}`, encoded, key);
      if (typeof r.replayed !== "boolean" || !r.data || typeof r.data !== "object" || Array.isArray(r.data)) {
        throw new OwnCrmError("Own CRM invalid command response", undefined, undefined, true);
      }
      // 선점 응답 재생은 절대로 결제사 재호출 권한이 아니다.
      return r.replayed && Object.hasOwn(r.data, "executePg") ? { ...r.data, executePg: false } : r.data;
    };
    try { return await send(); }
    catch (error) { if (!error.retryable) throw error; return send(); }
  };
}

export function createOwnWebsite({ url, token }, fetchImpl = fetch) {
  const { popupNotices, takenSlots, closures } = ownRest(url, token, fetchImpl);
  return { popupNotices, takenSlots, closures };
}

export function createOwnBusiness({ url, token, purgeToken }, fetchImpl = fetch) {
  const {
    productsBySlugs, takenSlots, closures, findOrder, journeyData, createMessage, createCounselMessage,
    updateMessage, createContactTask, updateContactTask,
  } = ownRest(url, token, fetchImpl, { strictJourneys: true });
  const retention = purgeToken && ownCommand(url, purgeToken, fetchImpl);
  return {
    productsBySlugs, takenSlots, closures, findOrder, journeyData, createMessage, createCounselMessage,
    updateMessage, createContactTask, updateContactTask,
    command: ownCommand(url, token, fetchImpl),
    async purgeRetention({ pendingOrderHours, chatRetentionDays }) {
      if (!retention) throw new Error("CRM_API_PURGE_TOKEN이 필요합니다.");
      const { counts } = await retention("purge/retention", randomUUID(), { pendingOrderHours, chatRetentionDays });
      if (!counts || typeof counts !== "object" || Array.isArray(counts) ||
          !Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Own CRM invalid purge counts");
      return counts;
    },
  };
}

export function createOwnSealer({ url, sealToken }, fetchImpl = fetch) {
  const { listSignedCharts, updateChart } = ownRest(url, sealToken, fetchImpl);
  return { listSignedCharts, updateChart };
}
