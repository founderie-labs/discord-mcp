// `discord-mcp check`

import { loadConfig } from "./config.js";
import { Discord, type Member, type Role } from "./discord.js";
import { parseKeys } from "./keys.js";
import { PERMISSIONS } from "./common.js";

const OK = "✓";
const NO = "✗";
const WARN = "!";

export async function runCheck(): Promise<number> {
  let failures = 0;
  const line = (mark: string, text: string, hint?: string) => {
    if (mark === NO) failures++;
    console.log(`  ${mark} ${text}${hint ? `\n      → ${hint}` : ""}`);
  };
  console.log("\ndiscord-mcp setup check\n");

  let cfg;
  try {
    cfg = loadConfig();
    line(OK, "DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are set");
  } catch (e) {
    line(NO, (e as Error).message);
    return 1;
  }
  const dc = new Discord(cfg);

  let botId = "";
  try {
    const me = await dc.me();
    botId = me.id;
    line(OK, `Bot token works (bot: ${me.username})`);
  } catch {
    line(NO, "Bot token was rejected", "Discord Developer Portal → your app → Bot → Reset Token, then update DISCORD_BOT_TOKEN");
    return 1;
  }

  try {
    const app = await dc.request<{ flags?: number }>("GET", "/applications/@me");
    const f = app.flags ?? 0;
    const members = Boolean(f & ((1 << 14) | (1 << 15)));
    const content = Boolean(f & ((1 << 18) | (1 << 19)));
    line(members ? OK : WARN, "Server Members Intent", members ? undefined : "Turn it on (Bot tab) to list and search members");
    line(content ? OK : NO, "Message Content Intent", content ? undefined : "Turn it on (Bot tab), or messages are read with empty text");
  } catch {
    line(WARN, "Couldn't read the app's intent settings; check them in the Developer Portal (Bot tab)");
  }

  let guildName = "";
  try {
    guildName = (await dc.guild()).name;
    line(OK, `Bot is in the server "${guildName}"`);
  } catch {
    line(NO, `Bot can't see server ${cfg.guildId}`, "Check DISCORD_GUILD_ID, and invite the bot (OAuth2 → URL Generator → scope bot)");
    return 1;
  }

  try {
    const [member, roles] = await Promise.all([
      dc.request<Member>("GET", `/guilds/${cfg.guildId}/members/${botId}`),
      dc.request<Role[]>("GET", `/guilds/${cfg.guildId}/roles`),
    ]);
    const mine = roles.filter((r) => member.roles.includes(r.id) || r.id === cfg.guildId);
    const perms = mine.reduce((acc, r) => acc | BigInt(r.permissions), 0n);
    const admin = Boolean(perms & PERMISSIONS.ADMINISTRATOR);
    const needed = ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "MANAGE_THREADS"];
    const missing = admin ? [] : needed.filter((n) => !(perms & PERMISSIONS[n]));
    line(missing.length ? NO : OK, admin ? "Bot has Administrator" : missing.length ? `Bot is missing: ${missing.join(", ")}` : "Bot has the basic permissions", missing.length ? "Give the bot's role these permissions, or Administrator for the admin tools" : undefined);
    if (!admin && cfg.admin.enabled) line(WARN, "Admin tools are on but the bot isn't Administrator; some admin actions will fail", "Grant Administrator, or set DISCORD_ENABLE_ADMIN=false");
    const top = Math.max(...mine.map((r) => r.position));
    const above = roles.filter((r) => r.position > top && !r.managed);
    line(above.length ? WARN : OK, above.length ? `Roles above the bot (it can't manage these or their members): ${above.map((r) => r.name).join(", ")}` : "Bot's role is at the top", above.length ? "Server Settings → Roles: drag the bot's role up (just under yours)" : undefined);
  } catch (e) {
    line(WARN, `Couldn't check the bot's roles (${(e as Error).message})`);
  }

  if (cfg.auditChannelId) {
    try {
      const c = await dc.channel(cfg.auditChannelId);
      line(OK, `Audit channel: #${c.name}`);
    } catch {
      line(NO, "DISCORD_AUDIT_CHANNEL_ID isn't a channel the bot can see");
    }
  } else line(WARN, "No audit channel", "Set DISCORD_AUDIT_CHANNEL_ID to a private #bot-log channel so every change is recorded");

  try {
    const keys = parseKeys();
    if (keys.length) line(OK, `Keys: ${keys.map((k) => `${k.name} (${k.scope})`).join(", ")}`);
    else line(WARN, "No MCP_KEYS (only needed for `discord-mcp serve`)", "discord-mcp keygen <name> admin");
  } catch (e) {
    line(NO, (e as Error).message);
  }
  if (!cfg.admin.protectedIds.size) line(WARN, "No DISCORD_PROTECTED_IDS", "Add your own user ID and top role so the admin tools can never change them");

  console.log(failures ? `\n${failures} problem(s) to fix.\n` : "\nAll set.\n");
  return failures ? 1 : 0;
}
