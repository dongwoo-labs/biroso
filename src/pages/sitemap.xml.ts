import type { APIRoute } from "astro";
import { loadProducts, loadEvents, loadPosts, productHref, eventHref, postHref, boardHref, BOARDS } from "../lib/content";

export const GET: APIRoute = async ({ site }) => {
  const paths = [
    "/", "/telemedicine/product/", "/telemedicine/reservation/", "/board/events/", "/faq/", "/npay/",
    ...Object.keys(BOARDS).map(boardHref),
    ...(await loadProducts()).map(productHref),
    ...(await loadEvents()).map(eventHref),
    ...(await loadPosts()).map(postHref),
  ];
  const urls = paths.map((p) => `<url><loc>${new URL(p, site).href}</loc></url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
