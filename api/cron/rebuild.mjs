// Vercel 크론: 매일 새벽 홈페이지를 다시 배포해 Twenty 상품·이벤트·글 변경을 반영한다.
// Twenty 워크플로가 콘텐츠를 고칠 때마다 배포 훅을 부르지만, 그게 빠졌을 때를 위한 안전망이다.
// 필요한 환경변수: VERCEL_DEPLOY_HOOK_URL, CRON_SECRET (Vercel이 크론 요청에 Bearer로 붙인다)
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET, hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).end();
  if (!hook) return res.status(200).json({ skipped: "VERCEL_DEPLOY_HOOK_URL 없음" });
  const r = await fetch(hook, { method: "POST" });
  res.status(r.ok ? 200 : 502).json({ triggered: r.ok, status: r.status });
}
