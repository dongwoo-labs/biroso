// 사이트 재빌드 서버. Vercel 배포 훅을 대신한다(의존성 없음).
//   POST /rebuild   빌드를 시작하고 바로 202를 돌려준다. Authorization: Bearer CRON_SECRET
//                   빌드 중에 다시 오면 끝난 뒤 한 번 더 빌드한다.
//   GET  /healthz   마지막 빌드 결과
// 처음 뜰 때 올라간 사이트가 없으면 바로 빌드한다.
// 성공하면 dist를 SITE_DIR/releases/<시각>에 복사하고 SITE_DIR/current 링크를 한 번에 바꾼다.
// 실패하면(Twenty에 닿지 않는 등) 직전 사이트를 그대로 둔다. 옛 값이 조용히 바뀌지 않게 하려는 것이다.
//
// 환경변수: CRON_SECRET, SITE_DIR(기본 /site), BUILD_DIR(npm run build를 돌릴 곳, 기본 현재 폴더), PORT(기본 8080)
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const SECRET = process.env.CRON_SECRET ?? "";
const SITE_DIR = process.env.SITE_DIR ?? "/site";
const BUILD_DIR = process.env.BUILD_DIR ?? process.cwd();
const KEEP = 3;
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

let running = null, again = false, last = null;

function npmBuild() {
  return new Promise((resolve) => {
    const p = spawn("npm", ["run", "build"], { cwd: BUILD_DIR, stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", () => resolve(1));
    p.on("close", resolve);
  });
}

async function build() {
  const started = Date.now();
  const code = await npmBuild();
  if (code !== 0) { last = { ok: false, at: new Date().toISOString() }; return log({ event: "build_failed", code }); }
  const id = new Date(started).toISOString().replace(/[:.]/g, "-");
  const releases = path.join(SITE_DIR, "releases");
  await fs.mkdir(releases, { recursive: true });
  await fs.cp(path.join(BUILD_DIR, "dist"), path.join(releases, id), { recursive: true });
  const tmp = path.join(SITE_DIR, "current.tmp");
  await fs.rm(tmp, { force: true });
  await fs.symlink(path.join("releases", id), tmp);
  await fs.rename(tmp, path.join(SITE_DIR, "current"));
  for (const old of (await fs.readdir(releases)).sort().slice(0, -KEEP)) await fs.rm(path.join(releases, old), { recursive: true, force: true });
  last = { ok: true, at: new Date().toISOString(), release: id };
  log({ event: "build_done", release: id, ms: Date.now() - started });
}

function trigger() {
  if (running) { again = true; return; }
  running = build()
    .catch((e) => { last = { ok: false, at: new Date().toISOString() }; log({ event: "build_error", error: e.message }); })
    .finally(() => { running = null; if (again) { again = false; trigger(); } });
}

http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const p = (req.url ?? "/").split("?")[0];
  if (p === "/healthz") return send(200, { building: Boolean(running), last });
  if (p !== "/rebuild") return send(404, { error: "not_found" });
  if (req.method !== "POST") return send(405, { error: "method_not_allowed" });
  if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { error: "unauthorized" });
  trigger();
  send(202, { queued: true });
}).listen(Number(process.env.PORT ?? 8080), () => log({ event: "builder_ready" }));

fs.access(path.join(SITE_DIR, "current")).catch(() => trigger());
