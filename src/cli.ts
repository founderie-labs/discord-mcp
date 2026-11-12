#!/usr/bin/env node
// discord-mcp command line: stdio (default), serve, keygen, check.

import { NAME, VERSION } from "./version.js";

const pkg = { name: NAME, version: VERSION };

const HELP = `${pkg.name} ${pkg.version}
MCP server for administering one Discord server.

Usage
  discord-mcp                          run over stdio
  discord-mcp serve                    run the HTTP server
  discord-mcp keygen <name> <scope>    generate an access key (read, member, manage, admin)
                     [--plain]         store the secret instead of its SHA-256
  discord-mcp check                    check the bot, server and configuration
  discord-mcp --version | --help

Environment
  DISCORD_BOT_TOKEN    bot token
  DISCORD_GUILD_ID     server ID
  MCP_KEYS             access keys (serve only)

https://github.com/founderie-labs/discord-mcp
`;

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case undefined:
  case "stdio":
    await import("./stdio.js");
    break;
  case "serve":
  case "http":
    await import("./serve.js");
    break;
  case "keygen": {
    const { makeKey, keyInstructions } = await import("./keygen.js");
    const [name, scope] = args.filter((a) => !a.startsWith("--"));
    if (!name || !scope) {
      console.error("Usage: discord-mcp keygen <name> <read|member|manage|admin> [--plain]");
      process.exit(1);
    }
    try {
      console.log(keyInstructions(makeKey(name, scope, !args.includes("--plain"))));
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    break;
  }
  case "check": {
    const { runCheck } = await import("./check.js");
    process.exit(await runCheck());
  }
  case "-v":
  case "--version":
  case "version":
    console.log(pkg.version);
    break;
  case "-h":
  case "--help":
  case "help":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    process.exit(1);
}
