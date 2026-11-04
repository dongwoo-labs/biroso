import { test } from "node:test";
import assert from "node:assert/strict";
import { createTwenty } from "../server/twenty.mjs";

test("주문·예약 없는 사람을 파기하면 연결한 고객 상담(대화·메시지)도 지운다", async () => {
  const deleted = [];
  const msgs = { t1: ["cm1", "cm2"] };
  const fetchImpl = async (url, { method }) => {
    const u = new URL(url);
    const [, , plural, id] = u.pathname.split("/");
    if (method === "DELETE") {
      deleted.push(`${plural}/${id}`);
      for (const k of Object.keys(msgs)) msgs[k] = msgs[k].filter((x) => x !== id);
      return new Response("{}");
    }
    if (plural === "people") return new Response(JSON.stringify({ data: { person: { id: "p1", consentRecords: [{ id: "c1" }], messages: [], counselThreads: [{ id: "t1" }] } } }));
    if (plural === "counselMessages") {
      const t = /counselThreadId\[eq\]:"(\w+)"/.exec(u.searchParams.get("filter"))[1];
      return new Response(JSON.stringify({ data: { counselMessages: (msgs[t] ?? []).map((id) => ({ id })) } }));
    }
    if (plural === "timelineActivities") return new Response(JSON.stringify({ data: { timelineActivities: [] } }));
    throw new Error(`unexpected ${plural}`);
  };
  const twenty = createTwenty({ twentyUrl: "http://t", twentyApiKey: "k" }, fetchImpl);
  assert.equal(await twenty.deletePersonIfOrphan("p1"), true);
  assert.deepEqual(deleted, ["consentRecords/c1", "counselMessages/cm1", "counselMessages/cm2", "counselThreads/t1", "people/p1"]);
});
