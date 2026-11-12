#!/usr/bin/env node
// stdio transport.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { SCOPES, scopedConfig, type Scope } from "./keys.js";

const scope = (process.env.MCP_STDIO_SCOPE ?? "admin") as Scope;
if (!SCOPES.includes(scope)) throw new Error(`MCP_STDIO_SCOPE must be one of ${SCOPES.join(", ")}`);
const cfg = loadConfig();
const server = createServer(scope === "admin" ? cfg : scopedConfig(cfg, { name: "local", scope }));
await server.connect(new StdioServerTransport());
console.error(
  `[discord-mcp] stdio ready (guild ${cfg.guildId})` +
    (cfg.readOnly ? " read-only" : ""),
);
