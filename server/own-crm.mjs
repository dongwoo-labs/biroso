import { createRestOperations } from "./twenty.mjs";

export function ownCrmConfig(env) {
  const url = URL.parse(env.CRM_API_URL ?? "");
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CRM_API_URL에 자체 CRM의 HTTP(S) origin이 필요합니다.");
  }
  const token = env.CRM_API_TOKEN?.trim();
  const sealToken = env.CRM_API_SEAL_TOKEN?.trim();
  if (!token) throw new Error("CRM_API_TOKEN이 필요합니다.");
  if (!sealToken || sealToken === token) throw new Error("별도의 CRM_API_SEAL_TOKEN이 필요합니다.");
  return { url: url.origin, token, sealToken };
}

function ownRest(url, token, fetchImpl) {
  return createRestOperations(async (method, path, body) => {
    let res;
    try {
      res = await fetchImpl(`${url}/api/v1/biroso/rest${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "biroso-api/1.0" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("Own CRM connection failed");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Own CRM ${res.status}`);
    }
    return res.json().catch(() => { throw new Error("Own CRM invalid JSON response"); });
  });
}

export function createOwnWebsite({ url, token }, fetchImpl = fetch) {
  const { popupNotices, takenSlots, closures } = ownRest(url, token, fetchImpl);
  return { popupNotices, takenSlots, closures };
}

export function createOwnSealer({ url, sealToken }, fetchImpl = fetch) {
  const { listSignedCharts, updateChart } = ownRest(url, sealToken, fetchImpl);
  return { listSignedCharts, updateChart };
}
