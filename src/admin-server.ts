// Admin tools: server settings, ordering, bans, invites, events, AutoMod, member details.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AccessError } from "./guard.js";
import { DESTRUCTIVE, READ, id, idTime, ok, reason, safe, type AdminContext } from "./common.js";

const VERIFICATION = ["none", "low", "medium", "high", "very_high"] as const;
const NOTIFICATIONS = ["all_messages", "only_mentions"] as const;
const CONTENT_FILTER = ["off", "members_without_roles", "all_members"] as const;

interface Guild {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  owner_id: string;
  verification_level: number;
  default_message_notifications: number;
  explicit_content_filter: number;
  system_channel_id: string | null;
  rules_channel_id: string | null;
  public_updates_channel_id: string | null;
  afk_channel_id: string | null;
  afk_timeout: number;
  premium_tier: number;
  premium_subscription_count?: number;
  preferred_locale: string;
  features: string[];
  approximate_member_count?: number;
  approximate_presence_count?: number;
}

/** Fetch an https image and turn it into the data URI Discord expects. */
async function imageData(url: string): Promise<string> {
  if (!/^https:\/\//.test(url)) throw new AccessError("Image must be an https:// URL.");
  const res = await fetch(url);
  if (!res.ok) throw new AccessError(`Couldn't download the image (${res.status}).`);
  const type = res.headers.get("content-type")?.split(";")[0] ?? "";
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new AccessError(`Not a PNG, JPEG, GIF or WebP image (${type || "unknown type"}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new AccessError("Image is larger than 8 MB.");
  return `data:${type};base64,${buf.toString("base64")}`;
}

export function registerServerAdminTools(server: McpServer, ctx: AdminContext) {
  const { cfg, dc, tag, audit, allChannels, editableChannel, roles, resolveRole, editableRole, destructiveAllowed } = ctx;
  const g = `/guilds/${cfg.guildId}`;
  const chName = async (cid: string | null) => (cid ? (await dc.channel(cid).catch(() => undefined))?.name ?? cid : null);


  server.registerTool(
    "discord_admin_get_server",
    {
      title: "Server settings (admin)",
      description: "Server name, description, member counts, owner, verification, notifications, content filter, system/rules/AFK channels, boosts and features.",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => {
      const s = await dc.request<Guild>("GET", `${g}?with_counts=true`);
      return ok({
        id: s.id,
        name: s.name,
        description: s.description,
        owner_id: s.owner_id,
        members: s.approximate_member_count,
        online: s.approximate_presence_count,
        verification: VERIFICATION[s.verification_level],
        default_notifications: NOTIFICATIONS[s.default_message_notifications],
        content_filter: CONTENT_FILTER[s.explicit_content_filter],
        system_channel: await chName(s.system_channel_id),
        rules_channel: await chName(s.rules_channel_id),
        updates_channel: await chName(s.public_updates_channel_id),
        afk_channel: await chName(s.afk_channel_id),
        afk_timeout_minutes: s.afk_timeout / 60,
        boost_tier: s.premium_tier,
        boosts: s.premium_subscription_count,
        locale: s.preferred_locale,
        community: s.features.includes("COMMUNITY"),
        features: s.features,
        icon: s.icon ? `https://cdn.discordapp.com/icons/${s.id}/${s.icon}.png` : null,
      });
    }),
  );

  server.registerTool(
    "discord_admin_edit_server",
    {
      title: "Edit server settings (admin)",
      description:
        "Change the server's name, description, icon or banner (https image URL, or \"none\"), verification level, " +
        "default notifications, content filter, system / rules / AFK channel and AFK timeout. Channels: ID, or \"none\".",
      inputSchema: {
        name: z.string().min(2).max(100).optional(),
        description: z.string().max(120).optional(),
        icon_url: z.string().optional(),
        banner_url: z.string().optional().describe("Needs boost level 2"),
        verification: z.enum(VERIFICATION).optional(),
        default_notifications: z.enum(NOTIFICATIONS).optional(),
        content_filter: z.enum(CONTENT_FILTER).optional(),
        system_channel_id: z.string().optional(),
        rules_channel_id: z.string().optional().describe("Community servers only"),
        afk_channel_id: z.string().optional(),
        afk_timeout_minutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).optional(),
        locale: z.string().optional().describe('e.g. "en-US", "en-GB", "hi"'),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      const p: Record<string, unknown> = {};
      const chan = async (v: string | undefined, key: string) => {
        if (v === undefined) return;
        if (v === "none") p[key] = null;
        else {
          if (!/^\d{5,25}$/.test(v)) throw new AccessError(`${key} must be a channel ID or "none".`);
          await editableChannel(v);
          p[key] = v;
        }
      };
      if (a.name) p.name = a.name;
      if (a.description !== undefined) p.description = a.description || null;
      if (a.icon_url) p.icon = a.icon_url === "none" ? null : await imageData(a.icon_url);
      if (a.banner_url) p.banner = a.banner_url === "none" ? null : await imageData(a.banner_url);
      if (a.verification) p.verification_level = VERIFICATION.indexOf(a.verification);
      if (a.default_notifications) p.default_message_notifications = NOTIFICATIONS.indexOf(a.default_notifications);
      if (a.content_filter) p.explicit_content_filter = CONTENT_FILTER.indexOf(a.content_filter);
      await chan(a.system_channel_id, "system_channel_id");
      await chan(a.rules_channel_id, "rules_channel_id");
      await chan(a.afk_channel_id, "afk_channel_id");
      if (a.afk_timeout_minutes) p.afk_timeout = a.afk_timeout_minutes * 60;
      if (a.locale) p.preferred_locale = a.locale;
      if (!Object.keys(p).length) throw new AccessError("Nothing to change.");
      const s = await dc.request<Guild>("PATCH", g, p, tag(a.reason));
      await audit(`server settings: ${Object.keys(p).join(", ")}`);
      return ok({ name: s.name, changed: Object.keys(p) });
    }),
  );


  server.registerTool(
    "discord_admin_reorder",
    {
      title: "Reorder roles or channels (admin)",
      description:
        "Set the order of roles (top to bottom, below the bot's own role) or of channels inside one category " +
        "(top to bottom, by name or ID). Items not listed keep their relative order after the listed ones.",
      inputSchema: {
        what: z.enum(["roles", "channels"]),
        order: z.array(z.string()).min(1).describe("Names or IDs, top first"),
        category_id: id("channels: the category whose channels to order (omit for channels outside categories)").optional(),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      if (a.what === "roles") {
        const picked = await Promise.all(a.order.map(resolveRole));
        picked.forEach((r) => editableRole(r, "moved"));
        await ctx.orderRoles(picked.map((r) => r.id), a.reason);
        await audit(`reordered roles: ${picked.map((r) => r.name).join(" > ")}`);
        return ok({ order: picked.map((r) => r.name) });
      }
      const { list } = await allChannels();
      if (a.category_id) await editableChannel(a.category_id);
      const siblings = list
        .filter((c) => (c.parent_id ?? null) === (a.category_id ?? null) && c.type !== 4)
        .sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
      const find = (ref: string) => {
        const r = ref.replace(/^#/, "").toLowerCase();
        const c = siblings.find((x) => x.id === ref || x.name?.toLowerCase() === r);
        if (!c) throw new AccessError(`"${ref}" isn't in that category. There: ${siblings.map((x) => x.name).join(", ")}.`);
        return c;
      };
      const picked = a.order.map(find);
      const all = [...picked, ...siblings.filter((c) => !picked.includes(c))];
      const base = Math.min(...siblings.map((c) => c.position ?? 0));
      await dc.request("PATCH", `${g}/channels`, all.map((c, i) => ({ id: c.id, position: base + i })), tag(a.reason));
      all.forEach((c) => dc.forget(c.id));
      await audit(`reordered channels: ${picked.map((c) => c.name).join(" > ")}`);
      return ok({ order: all.map((c) => c.name) });
    }),
  );


  server.registerTool(
    "discord_admin_bans",
    {
      title: "Bans (admin)",
      description: "List banned users with reasons, or check whether one user is banned. (Ban and unban with discord_admin_moderate_member.)",
      inputSchema: { user_id: id("Check this user only").optional(), limit: z.number().int().min(1).max(1000).default(100) },
      annotations: READ,
    },
    safe(async (a) => {
      type Ban = { user: { id: string; username: string }; reason: string | null };
      if (a.user_id) {
        try {
          const b = await dc.request<Ban>("GET", `${g}/bans/${a.user_id}`);
          return ok({ banned: true, user: b.user.username, reason: b.reason });
        } catch (e) {
          if ((e as { status?: number }).status === 404) return ok({ banned: false });
          throw e;
        }
      }
      const bans = await dc.request<Ban[]>("GET", `${g}/bans?limit=${a.limit}`);
      return ok(bans.map((b) => ({ user_id: b.user.id, user: b.user.username, reason: b.reason })));
    }),
  );

  server.registerTool(
    "discord_admin_invites",
    {
      title: "Invites (admin)",
      description: "List active invite links (who made them, uses, expiry), or revoke one by code. (Create with discord_admin_create_invite.)",
      inputSchema: { action: z.enum(["list", "revoke"]), code: z.string().optional().describe("revoke: invite code or URL"), reason },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      type Invite = { code: string; channel?: { name: string }; inviter?: { username: string }; uses?: number; max_uses?: number; max_age?: number; created_at?: string };
      if (a.action === "list") {
        const inv = await dc.request<Invite[]>("GET", `${g}/invites`);
        return ok(
          inv.map((i) => ({
            code: i.code,
            url: `https://discord.gg/${i.code}`,
            channel: i.channel?.name,
            by: i.inviter?.username,
            uses: `${i.uses ?? 0}/${i.max_uses || "∞"}`,
            expires: i.max_age && i.created_at ? new Date(Date.parse(i.created_at) + i.max_age * 1000).toISOString() : "never",
          })),
        );
      }
      const code = a.code?.split("/").pop();
      if (!code) throw new AccessError("revoke needs code.");
      await dc.request("DELETE", `/invites/${code}`, undefined, tag(a.reason));
      await audit(`revoked invite ${code}`);
      return ok({ revoked: code });
    }),
  );


  server.registerTool(
    "discord_admin_events",
    {
      title: "Scheduled events (admin)",
      description:
        "List, create, edit, cancel or delete scheduled events. " +
        "An event is in a voice channel (channel_id) or somewhere else (location; needs an end time). Times are ISO 8601.",
      inputSchema: {
        action: z.enum(["list", "create", "edit", "cancel", "delete"]),
        event_id: id("edit/cancel/delete: the event").optional(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(1000).optional(),
        start: z.string().optional().describe("ISO 8601, e.g. 2026-11-20T15:00:00+05:30"),
        end: z.string().optional(),
        channel_id: id("Voice or stage channel for the event").optional(),
        location: z.string().max(100).optional().describe("For events outside Discord (Meet link, office address)"),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      type Ev = { id: string; name: string; description?: string; scheduled_start_time: string; scheduled_end_time?: string; status: number; channel_id?: string; entity_metadata?: { location?: string }; user_count?: number };
      const STATUS = ["", "scheduled", "active", "completed", "canceled"];
      const shape = (e: Ev) => ({
        id: e.id, name: e.name, description: e.description, start: e.scheduled_start_time, end: e.scheduled_end_time,
        status: STATUS[e.status], where: e.entity_metadata?.location ?? e.channel_id, interested: e.user_count,
      });
      if (a.action === "list") {
        return ok((await dc.request<Ev[]>("GET", `${g}/scheduled-events?with_user_count=true`)).map(shape));
      }
      const iso = (v?: string) => {
        if (!v) return undefined;
        const t = Date.parse(v);
        if (Number.isNaN(t)) throw new AccessError(`"${v}" is not a date and time.`);
        return new Date(t).toISOString();
      };
      if (a.action === "create" || a.action === "edit") {
        const p: Record<string, unknown> = {};
        if (a.name) p.name = a.name;
        if (a.description !== undefined) p.description = a.description;
        if (a.start) p.scheduled_start_time = iso(a.start);
        if (a.end) p.scheduled_end_time = iso(a.end);
        if (a.channel_id) {
          const ch = await editableChannel(a.channel_id);
          if (ch.type !== 2 && ch.type !== 13) throw new AccessError(`#${ch.name} is not a voice or stage channel.`);
          Object.assign(p, { channel_id: a.channel_id, entity_type: ch.type === 13 ? 1 : 2, entity_metadata: null });
        } else if (a.location) {
          Object.assign(p, { channel_id: null, entity_type: 3, entity_metadata: { location: a.location } });
        }
        if (a.action === "create") {
          if (!a.name || !a.start) throw new AccessError("create needs name and start.");
          if (!a.channel_id && !a.location) throw new AccessError("create needs channel_id or location.");
          if (a.location && !a.end) throw new AccessError("Events outside Discord need an end time.");
          p.privacy_level = 2;
          const e = await dc.request<Ev>("POST", `${g}/scheduled-events`, p, tag(a.reason));
          await audit(`created event "${e.name}" on ${e.scheduled_start_time}`);
          return ok(shape(e));
        }
        if (!a.event_id) throw new AccessError("edit needs event_id.");
        const e = await dc.request<Ev>("PATCH", `${g}/scheduled-events/${a.event_id}`, p, tag(a.reason));
        await audit(`edited event "${e.name}": ${Object.keys(p).join(", ")}`);
        return ok(shape(e));
      }
      if (!a.event_id) throw new AccessError(`${a.action} needs event_id.`);
      if (a.action === "cancel") {
        const e = await dc.request<Ev>("PATCH", `${g}/scheduled-events/${a.event_id}`, { status: 4 }, tag(a.reason));
        await audit(`canceled event "${e.name}"`);
        return ok(shape(e));
      }
      destructiveAllowed();
      await dc.request("DELETE", `${g}/scheduled-events/${a.event_id}`, undefined, tag(a.reason));
      await audit(`deleted event ${a.event_id}`);
      return ok({ deleted: a.event_id });
    }),
  );


  server.registerTool(
    "discord_admin_automod",
    {
      title: "AutoMod rules (admin)",
      description:
        "List, create, enable, disable or delete AutoMod rules. Triggers: keywords (* wildcards), " +
        "presets (profanity, sexual_content, slurs), spam, mention_spam. Actions: block, alert a channel, timeout.",
      inputSchema: {
        action: z.enum(["list", "create", "enable", "disable", "delete"]),
        rule_id: id("enable/disable/delete: the rule").optional(),
        name: z.string().max(100).optional(),
        trigger: z.enum(["keywords", "preset", "spam", "mention_spam"]).optional(),
        keywords: z.array(z.string().max(60)).max(1000).optional(),
        allow: z.array(z.string().max(60)).max(100).optional().describe("Words that never trigger the rule"),
        presets: z.array(z.enum(["profanity", "sexual_content", "slurs"])).optional(),
        mention_limit: z.number().int().min(1).max(50).optional().describe("mention_spam: unique mentions per message"),
        block: z.boolean().default(true).describe("Block the message"),
        alert_channel_id: id("Post an alert here").optional(),
        timeout_minutes: z.number().int().min(1).max(40320).optional().describe("Also time the author out (keywords / mention_spam only)"),
        exempt_roles: z.array(z.string()).max(20).optional(),
        exempt_channel_ids: z.array(z.string()).max(50).optional(),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      type Rule = { id: string; name: string; trigger_type: number; enabled: boolean; trigger_metadata: Record<string, unknown>; actions: { type: number; metadata?: Record<string, unknown> }[]; exempt_roles: string[]; exempt_channels: string[] };
      const TRIG = ["", "keywords", "", "spam", "preset", "mention_spam"];
      const PRE = ["", "profanity", "sexual_content", "slurs"];
      const ACT = ["", "block", "alert", "timeout"];
      const base = `${g}/auto-moderation/rules`;
      const shape = (r: Rule) => ({
        id: r.id, name: r.name, enabled: r.enabled, trigger: TRIG[r.trigger_type],
        keywords: r.trigger_metadata.keyword_filter, presets: (r.trigger_metadata.presets as number[] | undefined)?.map((p) => PRE[p]),
        mention_limit: r.trigger_metadata.mention_total_limit, actions: r.actions.map((x) => ACT[x.type]),
        exempt_roles: r.exempt_roles.length || undefined, exempt_channels: r.exempt_channels.length || undefined,
      });
      if (a.action === "list") return ok((await dc.request<Rule[]>("GET", base)).map(shape));
      if (a.action === "create") {
        if (!a.name || !a.trigger) throw new AccessError("create needs name and trigger.");
        const meta: Record<string, unknown> = {};
        const trigger_type = { keywords: 1, spam: 3, preset: 4, mention_spam: 5 }[a.trigger];
        if (a.trigger === "keywords") {
          if (!a.keywords?.length) throw new AccessError("keywords trigger needs keywords.");
          meta.keyword_filter = a.keywords;
          if (a.allow) meta.allow_list = a.allow;
        }
        if (a.trigger === "preset") {
          if (!a.presets?.length) throw new AccessError("preset trigger needs presets.");
          meta.presets = a.presets.map((p) => PRE.indexOf(p));
          if (a.allow) meta.allow_list = a.allow;
        }
        if (a.trigger === "mention_spam") meta.mention_total_limit = a.mention_limit ?? 10;
        const actions: { type: number; metadata?: object }[] = [];
        if (a.block) actions.push({ type: 1 });
        if (a.alert_channel_id) {
          await editableChannel(a.alert_channel_id);
          actions.push({ type: 2, metadata: { channel_id: a.alert_channel_id } });
        }
        if (a.timeout_minutes) {
          if (!["keywords", "mention_spam"].includes(a.trigger)) throw new AccessError("Timeouts only work with keywords or mention_spam rules.");
          actions.push({ type: 3, metadata: { duration_seconds: a.timeout_minutes * 60 } });
        }
        if (!actions.length) throw new AccessError("Give at least one action: block, alert_channel_id or timeout_minutes.");
        const exempt_roles = a.exempt_roles ? (await Promise.all(a.exempt_roles.map(resolveRole))).map((r) => r.id) : [];
        const r = await dc.request<Rule>(
          "POST",
          base,
          { name: a.name, event_type: 1, trigger_type, trigger_metadata: meta, actions, enabled: true, exempt_roles, exempt_channels: a.exempt_channel_ids ?? [] },
          tag(a.reason),
        );
        await audit(`AutoMod rule "${r.name}" (${a.trigger}) created`);
        return ok(shape(r));
      }
      if (!a.rule_id) throw new AccessError(`${a.action} needs rule_id.`);
      if (a.action === "delete") {
        destructiveAllowed();
        await dc.request("DELETE", `${base}/${a.rule_id}`, undefined, tag(a.reason));
        await audit(`AutoMod rule ${a.rule_id} deleted`);
        return ok({ deleted: a.rule_id });
      }
      const r = await dc.request<Rule>("PATCH", `${base}/${a.rule_id}`, { enabled: a.action === "enable" }, tag(a.reason));
      await audit(`AutoMod rule "${r.name}" ${a.action}d`);
      return ok(shape(r));
    }),
  );


  server.registerTool(
    "discord_admin_get_member",
    {
      title: "Member details (admin)",
      description: "One member's roles, nickname, join date, account age, timeout status and avatar.",
      inputSchema: { user_id: id("The member's user ID") },
      annotations: READ,
    },
    safe(async (a) => {
      const m = await ctx.admin.member(a.user_id) as Awaited<ReturnType<typeof ctx.admin.member>> & {
        communication_disabled_until?: string | null; pending?: boolean; avatar?: string | null;
        user: { avatar?: string | null };
      };
      const rs = await roles(true);
      const until = m.communication_disabled_until && Date.parse(m.communication_disabled_until) > Date.now() ? m.communication_disabled_until : undefined;
      return ok({
        user_id: m.user.id,
        name: m.nick || m.user.global_name || m.user.username,
        username: m.user.username,
        bot: m.user.bot || undefined,
        roles: m.roles.map((r) => rs.find((x) => x.id === r)?.name ?? r),
        joined: m.joined_at,
        account_created: idTime(m.user.id),
        timed_out_until: until,
        pending_rules_screening: m.pending || undefined,
        protected: ctx.protectedIds.has(m.user.id) || undefined,
        avatar: m.user.avatar ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png` : undefined,
      });
    }),
  );
}
