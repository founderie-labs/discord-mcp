// Shared helpers for admin tools: permissions, schemas, results, and AdminContext.

import { z } from "zod";
import type { Config } from "./config.js";
import { Discord, DiscordAdmin, type Channel, type Role } from "./discord.js";
import { AccessError, type Guard } from "./guard.js";


export const PERMISSIONS: Record<string, bigint> = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  MANAGE_EVENTS: 1n << 33n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  MODERATE_MEMBERS: 1n << 40n,
};
export const PERM_NAMES = Object.keys(PERMISSIONS) as [string, ...string[]];
export const perm = z
  .string()
  .transform((s) => s.trim().toUpperCase().replace(/[\s-]+/g, "_"))
  .pipe(z.enum(PERM_NAMES));

export function toBits(names: string[]): bigint {
  return names.reduce((acc, n) => acc | PERMISSIONS[n], 0n);
}

export function fromBits(bits: string | bigint): string[] {
  const b = BigInt(bits);
  if (b & PERMISSIONS.ADMINISTRATOR) return ["ADMINISTRATOR (all permissions)"];
  return PERM_NAMES.filter((n) => b & PERMISSIONS[n]);
}

export const CHANNEL_TYPES = { text: 0, voice: 2, category: 4, announcement: 5, forum: 15 } as const;
export const REQUIRE_TAG = 1 << 4;
export const SORT = { latest_activity: 0, creation_date: 1 } as const;

export const id = (what: string) => z.string().regex(/^\d{5,25}$/, "a Discord ID (digits only)").describe(what);
export const reason = z.string().max(300).optional().describe("Reason, recorded in Discord's audit log");

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
export const safe =
  <A>(fn: (args: A) => Promise<ToolResult>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      if (!(err instanceof AccessError)) console.error("[discord-mcp] admin:", err);
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  };

export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
export const ADDITIVE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
export const READ = { readOnlyHint: true, openWorldHint: true } as const;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turns a Discord snowflake into an ISO time. */
export const idTime = (sf: string) => new Date(Number((BigInt(sf) >> 22n) + 1420070400000n)).toISOString();
/** The smallest snowflake created at a given time (for "after this date" queries). */
export const timeId = (ms: number) => ((BigInt(ms) - 1420070400000n) << 22n).toString();

export type AdminContext = ReturnType<typeof makeAdminContext>;

export function makeAdminContext(cfg: Config, dc: Discord, guard: Guard) {
  const admin = new DiscordAdmin(dc, cfg.guildId);
  const everyone = cfg.guildId; // the @everyone role shares the server's ID
  const protectedIds = new Set(cfg.admin.protectedIds);
  if (cfg.auditChannelId) protectedIds.add(cfg.auditChannelId);

  const who = cfg.actor ? ` (${cfg.actor.name})` : "";
  const tag = (r?: string) => (r ? `MCP admin${who}: ${r}` : `MCP admin${who}`);
  const audit = (line: string) => guard.audit(`admin: ${line}`);


  async function allChannels() {
    const list = await admin_channels();
    return { list, byId: new Map(list.map((c) => [c.id, c])) };
  }
  async function admin_channels() {
    const list = await dc.guildChannels();
    list.forEach((c) => dc.remember(c));
    return list;
  }

  /** Throws if the channel (or its category) is protected or belongs elsewhere. */
  async function editableChannel(channelId: string): Promise<Channel> {
    const ch = await dc.channel(channelId, true);
    if (ch.guild_id && ch.guild_id !== cfg.guildId) throw new AccessError("That channel belongs to a different Discord server.");
    const chain = [ch.id, ch.parent_id].filter(Boolean) as string[];
    if (ch.parent_id) {
      const parent = await dc.channel(ch.parent_id).catch(() => undefined);
      if (parent?.parent_id) chain.push(parent.parent_id);
    }
    const hit = chain.find((x) => protectedIds.has(x));
    if (hit) throw new AccessError(`#${ch.name} is protected (DISCORD_PROTECTED_IDS or the audit channel). Change it in Discord yourself.`);
    return ch;
  }

  let rolesCache: Role[] | undefined;
  async function roles(fresh = false) {
    if (!rolesCache || fresh) rolesCache = await admin.roles();
    return rolesCache;
  }

  /** Accepts a role ID, a role name (case-insensitive) or "@everyone". */
  async function resolveRole(ref: string): Promise<Role> {
    const r = ref.trim().replace(/^@/, "");
    const list = await roles(true);
    const found =
      list.find((x) => x.id === r) ??
      (r.toLowerCase() === "everyone" ? list.find((x) => x.id === everyone) : undefined) ??
      list.find((x) => x.name.toLowerCase() === r.toLowerCase());
    if (!found) {
      throw new AccessError(`No role "${ref}". Roles: ${list.map((x) => x.name).join(", ")}.`);
    }
    return found;
  }

  function editableRole(role: Role, action: string) {
    if (protectedIds.has(role.id)) throw new AccessError(`Role "${role.name}" is protected (DISCORD_PROTECTED_IDS).`);
    if (role.managed) throw new AccessError(`Role "${role.name}" is managed by an integration or bot and can't be ${action}.`);
    if (role.id === everyone && action !== "used") {
      throw new AccessError("The @everyone role can't be changed here. Use channel permissions instead.");
    }
  }

  function noAdministrator(names: string[]) {
    if (names.includes("ADMINISTRATOR") && !cfg.admin.allowAdministratorPermission) {
      throw new AccessError(
        "Granting ADMINISTRATOR is turned off on this server (DISCORD_ALLOW_ADMINISTRATOR_PERMISSION=false). Grant specific permissions instead.",
      );
    }
  }

  function destructiveAllowed() {
    if (!cfg.admin.allowDestructive) {
      throw new AccessError("Deleting, kicking and banning are turned off on this server (DISCORD_ALLOW_DESTRUCTIVE=false).");
    }
  }

  /** Build forum tag list from names, keeping existing tag IDs so posts keep their tags. */
  function forumTags(names: string[], existing: Channel["available_tags"] = []) {
    if (names.length > 20) throw new AccessError("Discord allows at most 20 tags per forum.");
    return names.map((n) => {
      const keep = existing.find((t) => t.name.toLowerCase() === n.trim().toLowerCase());
      return keep ? { id: keep.id, name: n.trim() } : { name: n.trim() };
    });
  }

  /**
   * Put `topIds` at the top of the range the bot can manage (below its own highest role),
   * in the given order, keeping every other role's relative order below them.
   */
  async function orderRoles(topIds: string[], reason?: string) {
    const all = await roles(true);
    const me = await dc.me();
    const member = await admin.member(me.id);
    const botTop = Math.max(...all.filter((r) => member.roles.includes(r.id)).map((r) => r.position));
    const below = all.filter((r) => r.id !== everyone && r.position < botTop).sort((x, y) => y.position - x.position);
    const listed = topIds.map((id) => {
      const r = below.find((x) => x.id === id);
      if (!r) throw new AccessError(`Role "${all.find((x) => x.id === id)?.name ?? id}" is at or above the bot's role, so it can't be moved.`);
      return r;
    });
    const final = [...listed, ...below.filter((r) => !listed.includes(r))];
    await dc.request("PATCH", `/guilds/${cfg.guildId}/roles`, final.map((r, i) => ({ id: r.id, position: botTop - 1 - i })), tag(reason));
    rolesCache = undefined;
  }

  /** Member IDs can be protected too. */
  function editableMember(userId: string) {
    if (protectedIds.has(userId)) throw new AccessError("That member is protected (DISCORD_PROTECTED_IDS).");
  }

  return {
    cfg, dc, guard, admin, everyone, protectedIds, tag, audit,
    allChannels, editableChannel, roles, resolveRole, editableRole, editableMember,
    noAdministrator, destructiveAllowed, forumTags,
    resetRoles: () => { rolesCache = undefined; },
    orderRoles,
  };
}
