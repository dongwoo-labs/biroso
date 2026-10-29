// API 서버 (node:http). 맥 셀프호스팅에서는 Caddy가 /api/* 를 이 서버로 넘긴다.
// 라우팅과 처리는 server/handler.mjs가 한다(Vercel 함수 api/v1/*.mjs와 같은 코드).
import http from "node:http";
import { loadConfig } from "./config.mjs";
import { createHandler } from "./handler.mjs";

const cfg = loadConfig();
if (!cfg.twentyApiKey) { console.error("TWENTY_API_KEY가 필요합니다."); process.exit(1); }
http.createServer(createHandler(cfg)).listen(cfg.port, () => console.error(`api :${cfg.port}`));
