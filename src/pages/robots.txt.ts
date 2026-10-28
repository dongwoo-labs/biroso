import type { APIRoute } from "astro";

// 실제 운영(PUBLIC_LIVE=1) 전에는 모든 검색엔진을 막는다
export const GET: APIRoute = ({ site }) => {
  const live = import.meta.env.PUBLIC_LIVE === "1";
  const body = live
    ? `User-agent: *\nAllow: /\nDisallow: /cart/\nDisallow: /checkout/\nDisallow: /order/\nDisallow: /api/\nSitemap: ${new URL("/sitemap.xml", site)}\n`
    : "User-agent: *\nDisallow: /\n";
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
