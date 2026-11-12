// Configuration from environment variables.

import type { Actor } from "./keys.js";

export interface Config {
  /** Who is acting (set per request from their key; "local" for stdio). */
  actor?: Actor;
  botToken: string;
  guildId: string;
  /** Channel, forum or category IDs the server may read. Empty = the whole server. */
  readIds: Set<string>;
  /** Channel, forum or category IDs the server may write to. Empty = everywhere it can read. */
  writeIds: Set<string>;
  readOnly: boolean;
  auditChannelId?: string;
  allowUserMentions: boolean;
  apiBase: string;
  /** Admin tools: structure, permissions, roles, members, moderation. On by default. */
  admin: {
    enabled: boolean;
    /** Deleting channels, roles and messages; kicks and bans. On by default. */
    allowDestructive: boolean;
    /** Granting the Administrator permission through roles or overrides. On by default. */
    allowAdministratorPermission: boolean;
    /** Channel, category or role IDs the admin tools may never change. */
    protectedIds: Set<string>;
  };
}

const ids = (v?: string) =>
  new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const bool = (v?: string) => /^(1|true|yes|on)$/i.test((v ?? "").trim());
/** On unless explicitly turned off. */
const onUnless = (v?: string) => !/^(0|false|no|off)$/i.test((v ?? "").trim());

export function loadConfig(env = process.env): Config {
  const missing = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID"].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  const readIds = ids(env.DISCORD_READ_CHANNELS);
  const writeIds = ids(env.DISCORD_WRITE_CHANNELS);
  return {
    botToken: env.DISCORD_BOT_TOKEN!,
    guildId: env.DISCORD_GUILD_ID!,
    readIds,
    writeIds,
    readOnly: bool(env.DISCORD_READ_ONLY),
    auditChannelId: env.DISCORD_AUDIT_CHANNEL_ID || undefined,
    allowUserMentions: bool(env.DISCORD_ALLOW_USER_MENTIONS),
    admin: {
      enabled: onUnless(env.DISCORD_ENABLE_ADMIN) && !bool(env.DISCORD_READ_ONLY),
      allowDestructive: onUnless(env.DISCORD_ALLOW_DESTRUCTIVE),
      allowAdministratorPermission: onUnless(env.DISCORD_ALLOW_ADMINISTRATOR_PERMISSION),
      protectedIds: ids(env.DISCORD_PROTECTED_IDS),
    },
    apiBase: (env.DISCORD_API_BASE || "https://discord.com/api/v10").replace(/\/$/, ""),
  };
}
