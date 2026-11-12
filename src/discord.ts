// Discord REST client (no gateway, so it runs in serverless functions).

import type { Config } from "./config.js";
import { RateLimiter } from "./ratelimit.js";
import { VERSION } from "./version.js";

export const ChannelType = {
  GUILD_TEXT: 0,
  GUILD_VOICE: 2,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const;

export const TYPE_NAMES: Record<number, string> = {
  0: "text",
  2: "voice",
  4: "category",
  5: "announcement",
  10: "thread",
  11: "thread",
  12: "private_thread",
  13: "stage",
  15: "forum",
  16: "media",
};

export const isThread = (type: number) =>
  type === ChannelType.ANNOUNCEMENT_THREAD ||
  type === ChannelType.PUBLIC_THREAD ||
  type === ChannelType.PRIVATE_THREAD;

export const isForum = (type: number) =>
  type === ChannelType.GUILD_FORUM || type === ChannelType.GUILD_MEDIA;

export interface ForumTag {
  id: string;
  name: string;
  moderated?: boolean;
}

export interface Channel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  topic?: string | null;
  parent_id?: string | null;
  position?: number;
  owner_id?: string;
  message_count?: number;
  last_message_id?: string | null;
  applied_tags?: string[];
  available_tags?: ForumTag[];
  flags?: number;
  default_sort_order?: number | null;
  rate_limit_per_user?: number;
  permission_overwrites?: { id: string; type: 0 | 1; allow: string; deny: string }[];
  thread_metadata?: {
    archived: boolean;
    locked: boolean;
    create_timestamp?: string;
    archive_timestamp?: string;
  };
}

export interface Message {
  id: string;
  channel_id: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  attachments?: { filename: string; url: string; size: number }[];
  embeds?: unknown[];
  message_reference?: { message_id?: string };
  type: number;
}

export class DiscordError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class Discord {
  /** Shared across every request this process makes. */
  private static limiter = new RateLimiter();

  constructor(private cfg: Config) {}

  async request<T>(method: string, path: string, body?: unknown, reason?: string): Promise<T> {
    const route = RateLimiter.route(method, path);
    const limiter = Discord.limiter;
    let res!: Response;
    for (let attempt = 0; ; attempt++) {
      res = await limiter.schedule(route, async () => {
        const r = await fetch(`${this.cfg.apiBase}${path}`, {
          method,
          headers: {
            Authorization: `Bot ${this.cfg.botToken}`,
            "Content-Type": "application/json",
            "User-Agent": `DiscordBot (https://github.com/founderie-labs/discord-mcp, ${VERSION})`,
            // Recorded in Discord's audit log.
            ...(reason ? { "X-Audit-Log-Reason": encodeURIComponent(reason.slice(0, 400)) } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        limiter.update(route, r.headers);
        return r;
      });
      if (res.status !== 429 || attempt >= 4) break;
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number; global?: boolean };
      limiter.limited(route, res.headers, data);
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        detail = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {}
      const hint =
        res.status === 401
          ? "The bot token is invalid or was reset."
          : res.status === 403
          ? "The bot lacks a Discord permission for this channel (check its role and channel overrides)."
          : res.status === 404
          ? "Not found. Check the ID, and that the bot can see it."
          : "";
      throw new DiscordError(res.status, `Discord API ${res.status}: ${detail}${hint ? ` ${hint}` : ""}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // Channel metadata, cached for a minute.
  private cache = new Map<string, { at: number; ch: Channel }>();
  private static TTL = 60_000;

  async channel(id: string, fresh = false): Promise<Channel> {
    const hit = this.cache.get(id);
    if (!fresh && hit && Date.now() - hit.at < Discord.TTL) return hit.ch;
    const ch = await this.request<Channel>("GET", `/channels/${id}`);
    this.cache.set(id, { at: Date.now(), ch });
    return ch;
  }

  forget(id: string) {
    this.cache.delete(id);
  }

  remember(ch: Channel) {
    this.cache.set(ch.id, { at: Date.now(), ch });
  }

  guildChannels() {
    return this.request<Channel[]>("GET", `/guilds/${this.cfg.guildId}/channels`);
  }

  guild() {
    return this.request<{ id: string; name: string }>("GET", `/guilds/${this.cfg.guildId}`);
  }

  me() {
    return this.request<{ id: string; username: string }>("GET", `/users/@me`);
  }

  activeThreads() {
    return this.request<{ threads: Channel[] }>("GET", `/guilds/${this.cfg.guildId}/threads/active`);
  }

  archivedThreads(channelId: string, limit = 100, before?: string) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set("before", before);
    return this.request<{ threads: Channel[]; has_more: boolean }>(
      "GET",
      `/channels/${channelId}/threads/archived/public?${q}`,
    );
  }

  messages(channelId: string, opts: { limit: number; before?: string; after?: string }) {
    const q = new URLSearchParams({ limit: String(opts.limit) });
    if (opts.before) q.set("before", opts.before);
    if (opts.after) q.set("after", opts.after);
    return this.request<Message[]>("GET", `/channels/${channelId}/messages?${q}`);
  }

  send(channelId: string, payload: object) {
    return this.request<Message>("POST", `/channels/${channelId}/messages`, payload);
  }

  createForumPost(forumId: string, payload: object) {
    return this.request<Channel & { message?: Message }>("POST", `/channels/${forumId}/threads`, payload);
  }

  editChannel(id: string, payload: object) {
    return this.request<Channel>("PATCH", `/channels/${id}`, payload);
  }
}

export interface Role {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
}

export interface Member {
  user: { id: string; username: string; global_name?: string | null; bot?: boolean };
  nick?: string | null;
  roles: string[];
  joined_at: string;
}

/** Admin endpoints. Kept separate so the read/write tools never reach them. */
export class DiscordAdmin {
  constructor(private dc: Discord, private guildId: string) {}
  private g = () => `/guilds/${this.guildId}`;

  async createChannel(payload: { flags?: number } & Record<string, unknown>, reason?: string) {
    const ch = await this.dc.request<Channel>("POST", `${this.g()}/channels`, payload, reason);
    // Discord ignores forum flags (such as "require a tag") on create, so set them afterwards.
    if (payload.flags && (ch.flags ?? 0) !== payload.flags) {
      return this.dc.request<Channel>("PATCH", `/channels/${ch.id}`, { flags: payload.flags }, reason);
    }
    return ch;
  }
  editChannel(id: string, payload: object, reason?: string) {
    return this.dc.request<Channel>("PATCH", `/channels/${id}`, payload, reason);
  }
  deleteChannel(id: string, reason?: string) {
    return this.dc.request<Channel>("DELETE", `/channels/${id}`, undefined, reason);
  }
  setOverwrite(channelId: string, targetId: string, payload: { allow: string; deny: string; type: 0 | 1 }, reason?: string) {
    return this.dc.request<void>("PUT", `/channels/${channelId}/permissions/${targetId}`, payload, reason);
  }
  deleteOverwrite(channelId: string, targetId: string, reason?: string) {
    return this.dc.request<void>("DELETE", `/channels/${channelId}/permissions/${targetId}`, undefined, reason);
  }
  roles() {
    return this.dc.request<Role[]>("GET", `${this.g()}/roles`);
  }
  createRole(payload: object, reason?: string) {
    return this.dc.request<Role>("POST", `${this.g()}/roles`, payload, reason);
  }
  editRole(id: string, payload: object, reason?: string) {
    return this.dc.request<Role>("PATCH", `${this.g()}/roles/${id}`, payload, reason);
  }
  deleteRole(id: string, reason?: string) {
    return this.dc.request<void>("DELETE", `${this.g()}/roles/${id}`, undefined, reason);
  }
  members(limit: number) {
    return this.dc.request<Member[]>("GET", `${this.g()}/members?limit=${limit}`);
  }
  searchMembers(query: string, limit: number) {
    const q = new URLSearchParams({ query, limit: String(limit) });
    return this.dc.request<Member[]>("GET", `${this.g()}/members/search?${q}`);
  }
  member(userId: string) {
    return this.dc.request<Member>("GET", `${this.g()}/members/${userId}`);
  }
  addMemberRole(userId: string, roleId: string, reason?: string) {
    return this.dc.request<void>("PUT", `${this.g()}/members/${userId}/roles/${roleId}`, undefined, reason);
  }
  removeMemberRole(userId: string, roleId: string, reason?: string) {
    return this.dc.request<void>("DELETE", `${this.g()}/members/${userId}/roles/${roleId}`, undefined, reason);
  }
  editMember(userId: string, payload: object, reason?: string) {
    return this.dc.request<Member>("PATCH", `${this.g()}/members/${userId}`, payload, reason);
  }
  kick(userId: string, reason?: string) {
    return this.dc.request<void>("DELETE", `${this.g()}/members/${userId}`, undefined, reason);
  }
  ban(userId: string, deleteMessageSeconds: number, reason?: string) {
    return this.dc.request<void>("PUT", `${this.g()}/bans/${userId}`, { delete_message_seconds: deleteMessageSeconds }, reason);
  }
  unban(userId: string, reason?: string) {
    return this.dc.request<void>("DELETE", `${this.g()}/bans/${userId}`, undefined, reason);
  }
  auditLog(q: { limit: number; user_id?: string; action_type?: number; before?: string }) {
    const p = new URLSearchParams({ limit: String(q.limit) });
    if (q.user_id) p.set("user_id", q.user_id);
    if (q.action_type !== undefined) p.set("action_type", String(q.action_type));
    if (q.before) p.set("before", q.before);
    return this.dc.request<{
      audit_log_entries: { id: string; user_id: string | null; target_id: string | null; action_type: number; reason?: string; changes?: { key: string; old_value?: unknown; new_value?: unknown }[] }[];
      users: { id: string; username: string; global_name?: string | null }[];
    }>("GET", `${this.g()}/audit-logs?${p}`);
  }
  deleteMessage(channelId: string, messageId: string, reason?: string) {
    return this.dc.request<void>("DELETE", `/channels/${channelId}/messages/${messageId}`, undefined, reason);
  }
  pin(channelId: string, messageId: string, reason?: string) {
    return this.dc.request<void>("PUT", `/channels/${channelId}/pins/${messageId}`, undefined, reason);
  }
  unpin(channelId: string, messageId: string, reason?: string) {
    return this.dc.request<void>("DELETE", `/channels/${channelId}/pins/${messageId}`, undefined, reason);
  }
  pins(channelId: string) {
    return this.dc.request<Message[]>("GET", `/channels/${channelId}/pins`);
  }
  createInvite(channelId: string, payload: object, reason?: string) {
    return this.dc.request<{ code: string; max_age: number; max_uses: number }>("POST", `/channels/${channelId}/invites`, payload, reason);
  }
  webhooks() {
    return this.dc.request<{ id: string; name: string; channel_id: string; type: number }[]>("GET", `${this.g()}/webhooks`);
  }
  createWebhook(channelId: string, name: string, reason?: string) {
    return this.dc.request<{ id: string; token: string; name: string; channel_id: string }>("POST", `/channels/${channelId}/webhooks`, { name }, reason);
  }
}

/** Discord snowflakes encode their creation time. */
export function snowflakeTime(id?: string | null): string | undefined {
  if (!id) return undefined;
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
  } catch {
    return undefined;
  }
}
