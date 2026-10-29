// 예약 작업. Vercel 크론을 대신한다(의존성 없음). 시각은 한국 시간이다.
// JOBS 환경변수에 한 줄에 하나씩 "HH:MM [요일] METHOD URL"을 적는다. 요일(sun~sat)을 빼면 매일.
//   03:00 POST http://builder:8080/rebuild
//   10:00 mon GET http://api:8788/v1/purge
// 요청에는 Authorization: Bearer CRON_SECRET을 붙이고, 결과를 한 줄 JSON으로 남긴다.
const SECRET = process.env.CRON_SECRET ?? "";
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

const jobs = (process.env.JOBS ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
  const parts = line.split(/\s+/);
  const day = DAYS.includes(parts[1]) ? DAYS.indexOf(parts.splice(1, 1)[0]) : null;
  const [time, method, url] = parts;
  if (!/^\d\d:\d\d$/.test(time) || !method || !url) throw new Error(`JOBS 줄을 읽지 못했습니다: ${line}`);
  return { line, time, day, method, url };
});

const fired = new Set();
async function tick() {
  const kst = new Date(Date.now() + 9 * 3600_000);
  const time = kst.toISOString().slice(11, 16), date = kst.toISOString().slice(0, 10);
  for (const j of jobs) {
    if (j.time !== time || (j.day !== null && j.day !== kst.getUTCDay())) continue;
    const key = `${date} ${j.line}`;
    if (fired.has(key)) continue;
    fired.add(key);
    try {
      const r = await fetch(j.url, { method: j.method, headers: { Authorization: `Bearer ${SECRET}` }, signal: AbortSignal.timeout(300_000) });
      log({ event: "job", job: j.line, status: r.status, body: (await r.text()).slice(0, 300) });
    } catch (e) { log({ event: "job_error", job: j.line, error: e.message }); }
  }
  for (const k of fired) if (!k.startsWith(date)) fired.delete(k);
}

log({ event: "cron_ready", jobs: jobs.map((j) => j.line) });
setInterval(tick, 20_000);
tick();
