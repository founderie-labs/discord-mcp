// Stateless Streamable HTTP transport. Auth is by named keys (keys.ts).

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type Config } from "./config.js";
import { createServer, VERSION } from "./server.js";
import { matchKey, parseKeys, scopedConfig, type Key } from "./keys.js";
import { setupPage } from "./setup-page.js";

export function authConfigured(env = process.env): boolean {
  return parseKeys(env).length > 0 || /^(1|true|yes)$/i.test(env.MCP_ALLOW_NO_AUTH ?? "");
}

let keys: Key[] | undefined;

/** The key presented with this request, "open" when auth is disabled, or undefined. */
function authenticate(req: IncomingMessage, pathSecret: string | undefined, env = process.env): Key | "open" | undefined {
  keys ??= parseKeys(env);
  if (!keys.length) return /^(1|true|yes)$/i.test(env.MCP_ALLOW_NO_AUTH ?? "") ? "open" : undefined;
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  return matchKey(keys, bearer) ?? matchKey(keys, pathSecret);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

let cached: Config | undefined;

/**
 * Handle one HTTP request. Shared by the standalone server below and the Vercel function.
 * `parsedBody` is passed when the platform has already parsed JSON (Vercel does).
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "");

  // On Vercel, rewrites route everything to /api/mcp and mark the page in ?page=.
  const page = url.searchParams.get("page");
  if (path === "/health" || path === "/api/health" || page === "health") {
    return json(res, 200, { ok: true, name: "discord-mcp", version: VERSION });
  }

  if ((path === "" || path === "/setup" || page === "setup") && req.method === "GET") {
    let keyCount = 0;
    let keyError: string | undefined;
    try {
      keyCount = parseKeys().length;
    } catch (err) {
      keyError = (err as Error).message;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer",
    });
    res.end(
      setupPage({
        version: VERSION,
        token: Boolean(process.env.DISCORD_BOT_TOKEN),
        guild: Boolean(process.env.DISCORD_GUILD_ID),
        keys: keyCount,
        keyError,
        admin: !/^(0|false|no|off)$/i.test(process.env.DISCORD_ENABLE_ADMIN ?? ""),
      }),
    );
    return;
  }

  const m = path.match(/^(?:\/api)?\/mcp(?:\/([^/]+))?$/);
  if (!m) return json(res, 404, { error: "Not found. The MCP endpoint is /mcp" });
  const pathSecret = m[1] ?? url.searchParams.get("secret") ?? undefined;

  let key: ReturnType<typeof authenticate>;
  try {
    key = authenticate(req, pathSecret);
  } catch (err) {
    console.error("[discord-mcp] invalid key configuration:", (err as Error).message);
    return json(res, 500, { error: `Server key configuration is invalid: ${(err as Error).message}` });
  }
  if (!key) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="discord-mcp"');
    return json(res, 401, { error: "Unauthorised" });
  }

  if (req.method !== "POST") {
    // Stateless server: no server-initiated streams (GET) or sessions to end (DELETE).
    res.setHeader("Allow", "POST");
    return json(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This server is stateless; use POST." },
      id: null,
    });
  }

  try {
    cached ??= loadConfig();
    const body = parsedBody ?? (await readBody(req));
    const server = createServer(key === "open" ? cached : scopedConfig(cached, { name: key.name, scope: key.scope }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("[discord-mcp] request failed:", err);
    if (!res.headersSent) {
      json(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: (err as Error).message },
        id: null,
      });
    }
  }
}
