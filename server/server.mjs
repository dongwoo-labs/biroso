// API 서버 (node:http). 맥 셀프호스팅에서는 Caddy가 /api/* 를 이 서버로 넘긴다.
// 라우팅과 처리는 server/handler.mjs가 한다.
import http from "node:http";
import { loadConfig } from "./config.mjs";
import { createHandler } from "./handler.mjs";
import { createOwnBusiness } from "./own-crm.mjs";

const cfg = loadConfig();
if (cfg.crmBackend === "twenty" && !cfg.twentyApiKey) { console.error("TWENTY_API_KEY가 필요합니다."); process.exit(1); }
if (cfg.crmBackend === "own" && !cfg.ownCrm.purgeToken) { console.error("CRM_API_PURGE_TOKEN이 필요합니다."); process.exit(1); }
const deps = cfg.crmBackend === "own" ? { ownBusiness: createOwnBusiness(cfg.ownCrm) } : {};
http.createServer(createHandler(cfg, deps)).listen(cfg.port, () => console.error(`api :${cfg.port}`));
