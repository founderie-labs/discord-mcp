#!/usr/bin/env node
// Standalone HTTP server.

import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { authConfigured, handleMcpRequest } from "./http.js";
import { parseKeys } from "./keys.js";

const cfg = loadConfig(); // fail at boot, not on the first request
const keyCount = parseKeys().length;
if (!authConfigured()) {
  console.error("[discord-mcp] Set MCP_KEYS (or MCP_AUTH_TOKEN). Refusing to start an open server.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

createServer((req, res) => void handleMcpRequest(req, res)).listen(port, host, () => {
  console.error(
    `[discord-mcp] listening on http://${host}:${port}/mcp (guild ${cfg.guildId}, ${keyCount} key(s))` +
      (cfg.readOnly ? " read-only" : ""),
  );
});
