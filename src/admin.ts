// Admin tools: structure, channels, permissions, roles, members, moderation, messages, invites, webhooks, audit log.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { Discord, TYPE_NAMES, isForum, isThread, type Channel } from "./discord.js";
import { AccessError, type Guard } from "./guard.js";
import {
  ADDITIVE, CHANNEL_TYPES, DESTRUCTIVE, PERMISSIONS, PERM_NAMES, READ, REQUIRE_TAG, SORT,
  fromBits, id, makeAdminContext, ok, perm, reason, safe, toBits,
} from "./common.js";

export { PERMISSIONS, fromBits, toBits } from "./common.js";

export function registerAdminTools(server: McpServer, cfg: Config, dc: Discord, guard: Guard) {
  const ctx = makeAdminContext(cfg, dc, guard);
  const {
    admin, everyone, protectedIds, tag, audit, allChannels, editableChannel, roles, resolveRole,
    editableRole, noAdministrator, destructiveAllowed, forumTags,
  } = ctx;
  const resetRoles = ctx.resetRoles;


  server.registerTool(
    "discord_admin_overview",
    {
      title: "Server structure (admin)",
      description:
        "The whole server's structure: every category and channel (IDs, types, private or not, " +
        "which roles have explicit access) plus all roles with their permissions. Use before changing anything.",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => {
      const [{ list }, rs] = await Promise.all([allChannels(), roles(true)]);
      const roleName = new Map(rs.map((r) => [r.id, r.id === everyone ? "@everyone" : r.name]));
      const VIEW = PERMISSIONS.VIEW_CHANNEL;
      const shape = (c: Channel) => {
        const ow = c.permission_overwrites ?? [];
        const hidden = ow.some((o) => o.id === everyone && BigInt(o.deny) & VIEW);
        return {
          id: c.id,
          name: c.name,
          type: TYPE_NAMES[c.type] ?? String(c.type),
          private: hidden || undefined,
          visible_to: hidden
            ? ow.filter((o) => BigInt(o.allow) & VIEW).map((o) => roleName.get(o.id) ?? `user ${o.id}`)
            : undefined,
          protected: protectedIds.has(c.id) || (c.parent_id ? protectedIds.has(c.parent_id) : false) || undefined,
          tags: isForum(c.type) ? (c.available_tags ?? []).map((t) => t.name) : undefined,
        };
      };
      const byPos = (a: Channel, b: Channel) => (a.position ?? 0) - (b.position ?? 0);
      const cats = list.filter((c) => c.type === 4).sort(byPos);
      return ok({
        uncategorised: list.filter((c) => c.type !== 4 && !c.parent_id).sort(byPos).map(shape),
        categories: cats.map((cat) => ({
          ...shape(cat),
          channels: list.filter((c) => c.parent_id === cat.id).sort(byPos).map(shape),
        })),
        roles: rs
          .sort((a, b) => b.position - a.position)
          .map((r) => ({
            id: r.id,
            name: r.id === everyone ? "@everyone" : r.name,
            permissions: fromBits(r.permissions),
            managed: r.managed || undefined,
            protected: protectedIds.has(r.id) || undefined,
          })),
        safety: {
          deleting_enabled: cfg.admin.allowDestructive,
          administrator_grants_enabled: cfg.admin.allowAdministratorPermission,
        },
      });
    }),
  );

  server.registerTool(
    "discord_admin_get_channel",
    {
      title: "Channel details (admin)",
      description:
        "Everything about one channel or category: type, category, topic or guidelines, slowmode, forum tags and settings, " +
        "and every permission override spelled out (who is allowed or denied what).",
      inputSchema: { channel_id: id("Channel, forum, category or thread ID") },
      annotations: READ,
    },
    safe(async ({ channel_id }) => {
      const c = await dc.channel(channel_id, true);
      if (c.guild_id && c.guild_id !== cfg.guildId) throw new AccessError("That channel belongs to a different Discord server.");
      const rs = await roles(true);
      const name = (oid: string, type: number) =>
        type === 0 ? (oid === everyone ? "@everyone" : rs.find((r) => r.id === oid)?.name ?? oid) : `user ${oid}`;
      const parent = c.parent_id ? await dc.channel(c.parent_id).catch(() => undefined) : undefined;
      const synced =
        parent && JSON.stringify((c.permission_overwrites ?? []).map((o) => [o.id, o.allow, o.deny]).sort()) ===
          JSON.stringify((parent.permission_overwrites ?? []).map((o) => [o.id, o.allow, o.deny]).sort());
      return ok({
        id: c.id,
        name: c.name,
        type: TYPE_NAMES[c.type] ?? String(c.type),
        category: parent?.name,
        synced_with_category: parent ? synced : undefined,
        topic: c.topic || undefined,
        slowmode_seconds: c.rate_limit_per_user || undefined,
        forum: isForum(c.type)
          ? {
              tags: (c.available_tags ?? []).map((t) => t.name),
              require_tag: Boolean((c.flags ?? 0) & REQUIRE_TAG),
              default_sort: c.default_sort_order === 1 ? "creation_date" : c.default_sort_order === 0 ? "latest_activity" : "default",
            }
          : undefined,
        protected: protectedIds.has(c.id) || (c.parent_id ? protectedIds.has(c.parent_id) : false) || undefined,
        permissions: (c.permission_overwrites ?? []).map((o) => ({
          for: name(o.id, o.type),
          allow: fromBits(o.allow),
          deny: fromBits(o.deny),
        })),
        url: guard.link(c.id),
      });
    }),
  );

  server.registerTool(
    "discord_admin_list_members",
    {
      title: "List members (admin)",
      description:
        "List server members with their roles, search by name, or list who has a role. Needs the Server Members Intent " +
        "turned on for the bot in the Discord Developer Portal.",
      inputSchema: {
        query: z.string().optional().describe("Start of a username or nickname"),
        role: z.string().optional().describe("Only members with this role (name or ID)"),
        include_bots: z.boolean().default(true),
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: READ,
    },
    safe(async ({ query, role, include_bots, limit }) => {
      const [all, rs] = await Promise.all([
        query ? admin.searchMembers(query, limit) : admin.members(role ? 1000 : limit),
        roles(true),
      ]);
      const roleName = new Map(rs.map((r) => [r.id, r.name]));
      const want = role ? await resolveRole(role) : undefined;
      const ms = all
        .filter((m) => !want || want.id === everyone || m.roles.includes(want.id))
        .filter((m) => include_bots || !m.user.bot)
        .slice(0, limit);
      return ok(
        ms.map((m) => ({
          user_id: m.user.id,
          name: m.nick || m.user.global_name || m.user.username,
          username: m.user.username,
          bot: m.user.bot || undefined,
          roles: m.roles.map((r) => roleName.get(r) ?? r),
          joined: m.joined_at,
        })),
      );
    }),
  );


  server.registerTool(
    "discord_admin_create_channel",
    {
      title: "Create channel (admin)",
      description:
        "Create a category, text, forum, announcement or voice channel. For forums you can set tags, " +
        "require a tag, default sort, and the post guidelines (topic). " +
        "private_to_roles makes it visible only to those roles (and this bot).",
      inputSchema: {
        name: z.string().min(1).max(100),
        type: z.enum(["text", "forum", "category", "announcement", "voice"]).default("text"),
        category_id: id("Put it in this category").optional(),
        topic: z.string().max(4096).optional().describe("Channel topic, or a forum's post guidelines"),
        tags: z.array(z.string().min(1).max(20)).max(20).optional().describe("Forum only: tag names"),
        require_tag: z.boolean().optional().describe("Forum only: posts must have a tag"),
        default_sort: z.enum(["latest_activity", "creation_date"]).optional().describe("Forum only"),
        private_to_roles: z.array(z.string()).optional().describe("Role names or IDs that can see it; everyone else can't"),
        reason,
      },
      annotations: ADDITIVE,
    },
    safe(async (a) => {
      const type = CHANNEL_TYPES[a.type];
      if (a.category_id) {
        if (type === 4) throw new AccessError("A category can't be inside another category.");
        const cat = await editableChannel(a.category_id);
        if (cat.type !== 4) throw new AccessError(`${a.category_id} is not a category.`);
      }
      if (type !== 15 && (a.tags || a.require_tag !== undefined || a.default_sort)) {
        throw new AccessError("tags, require_tag and default_sort only apply to forum channels.");
      }
      const payload: Record<string, unknown> = { name: a.name, type };
      if (a.category_id) payload.parent_id = a.category_id;
      if (a.topic && type !== 4 && type !== 2) payload.topic = a.topic;
      if (type === 15) {
        if (a.tags) payload.available_tags = forumTags(a.tags);
        if (a.require_tag) payload.flags = REQUIRE_TAG;
        if (a.default_sort) payload.default_sort_order = SORT[a.default_sort];
      }
      if (a.private_to_roles?.length) {
        const rs = await Promise.all(a.private_to_roles.map(resolveRole));
        const me = await dc.me();
        const see = (PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_MESSAGE_HISTORY).toString();
        payload.permission_overwrites = [
          { id: everyone, type: 0, allow: "0", deny: PERMISSIONS.VIEW_CHANNEL.toString() },
          ...rs.filter((r) => r.id !== everyone).map((r) => ({ id: r.id, type: 0, allow: see, deny: "0" })),
          // so the bot can still see the channel
          { id: me.id, type: 1, allow: (PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.READ_MESSAGE_HISTORY).toString(), deny: "0" },
        ];
      }
      const ch = await admin.createChannel(payload, tag(a.reason));
      dc.remember(ch);
      await audit(`created ${a.type} #${ch.name} (${ch.id})${a.private_to_roles?.length ? ` private to ${a.private_to_roles.join(", ")}` : ""}`);
      return ok({
        id: ch.id,
        name: ch.name,
        type: a.type,
        url: guard.link(ch.id),
        note:
          "New channels are not in DISCORD_READ_CHANNELS automatically. Put them in an allowlisted category, or add the ID, if the read/write tools should use them.",
      });
    }),
  );

  server.registerTool(
    "discord_admin_edit_channel",
    {
      title: "Edit channel (admin)",
      description:
        "Rename, move, reorder or change a channel's topic / forum post guidelines, forum tags (replaces the full tag list; " +
        "existing tags with the same name are kept so posts keep them), require-tag, default sort or slowmode. " +
        "category_id: \"none\" removes it from its category.",
      inputSchema: {
        channel_id: id("Channel, forum or category ID"),
        name: z.string().min(1).max(100).optional(),
        topic: z.string().max(4096).optional(),
        category_id: z.union([z.literal("none"), id("Move into this category")]).optional(),
        position: z.number().int().min(0).optional(),
        tags: z.array(z.string().min(1).max(20)).max(20).optional(),
        require_tag: z.boolean().optional(),
        default_sort: z.enum(["latest_activity", "creation_date"]).optional(),
        slowmode_seconds: z.number().int().min(0).max(21600).optional(),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      const ch = await editableChannel(a.channel_id);
      const forum = isForum(ch.type);
      if (!forum && (a.tags || a.require_tag !== undefined || a.default_sort)) {
        throw new AccessError("tags, require_tag and default_sort only apply to forum channels.");
      }
      const p: Record<string, unknown> = {};
      if (a.name) p.name = a.name;
      if (a.topic !== undefined) p.topic = a.topic;
      if (a.position !== undefined) p.position = a.position;
      if (a.slowmode_seconds !== undefined) p.rate_limit_per_user = a.slowmode_seconds;
      if (a.category_id === "none") p.parent_id = null;
      else if (a.category_id) {
        const cat = await editableChannel(a.category_id);
        if (cat.type !== 4) throw new AccessError(`${a.category_id} is not a category.`);
        p.parent_id = a.category_id;
      }
      let removedTags: string[] = [];
      if (a.tags) {
        p.available_tags = forumTags(a.tags, ch.available_tags);
        const keep = new Set(a.tags.map((t) => t.trim().toLowerCase()));
        removedTags = (ch.available_tags ?? []).filter((t) => !keep.has(t.name.toLowerCase())).map((t) => t.name);
      }
      if (a.require_tag !== undefined) p.flags = a.require_tag ? (ch.flags ?? 0) | REQUIRE_TAG : (ch.flags ?? 0) & ~REQUIRE_TAG;
      if (a.default_sort) p.default_sort_order = SORT[a.default_sort];
      if (!Object.keys(p).length) throw new AccessError("Nothing to change.");

      const updated = await admin.editChannel(a.channel_id, p, tag(a.reason));
      dc.remember(updated);
      await audit(`edited #${ch.name} (${ch.id}): ${Object.keys(p).join(", ")}${removedTags.length ? `; removed tags ${removedTags.join(", ")}` : ""}`);
      return ok({
        id: updated.id,
        name: updated.name,
        changed: Object.keys(p),
        tags: forum ? (updated.available_tags ?? []).map((t) => t.name) : undefined,
        removed_tags: removedTags.length ? removedTags : undefined,
      });
    }),
  );

  server.registerTool(
    "discord_admin_set_permissions",
    {
      title: "Set channel permissions (admin)",
      description:
        "Allow or deny permissions for a role (name, ID or @everyone) or a member on one channel or category " +
        "(channels synced to a category follow it). clear=true removes the override. " +
        `Permission names: ${PERM_NAMES.join(", ")}.`,
      inputSchema: {
        channel_id: id("Channel or category ID"),
        target: z.string().describe("Role name/ID, \"@everyone\", or a member's user ID"),
        target_type: z.enum(["role", "member"]).default("role"),
        allow: z.array(perm).default([]),
        deny: z.array(perm).default([]),
        clear: z.boolean().default(false).describe("Remove this role/member's override instead"),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      const ch = await editableChannel(a.channel_id);
      let targetId: string;
      let label: string;
      if (a.target_type === "role") {
        const r = await resolveRole(a.target);
        if (protectedIds.has(r.id)) throw new AccessError(`Role "${r.name}" is protected.`);
        targetId = r.id;
        label = r.id === everyone ? "@everyone" : r.name;
      } else {
        if (!/^\d{5,25}$/.test(a.target)) throw new AccessError("For a member, target must be their user ID.");
        targetId = a.target;
        label = `user ${a.target}`;
      }
      if (a.clear) {
        await admin.deleteOverwrite(a.channel_id, targetId, tag(a.reason));
        await audit(`cleared ${label} override on #${ch.name}`);
        return ok({ channel: ch.name, target: label, cleared: true });
      }
      if (!a.allow.length && !a.deny.length) throw new AccessError("Give allow and/or deny, or clear=true.");
      const both = a.allow.filter((x) => a.deny.includes(x));
      if (both.length) throw new AccessError(`Both allowed and denied: ${both.join(", ")}.`);
      noAdministrator(a.allow);
      await admin.setOverwrite(
        a.channel_id,
        targetId,
        { allow: toBits(a.allow).toString(), deny: toBits(a.deny).toString(), type: a.target_type === "role" ? 0 : 1 },
        tag(a.reason),
      );
      dc.forget(a.channel_id);
      await audit(`#${ch.name}: ${label} allow [${a.allow.join(", ")}] deny [${a.deny.join(", ")}]`);
      return ok({ channel: ch.name, target: label, allow: a.allow, deny: a.deny });
    }),
  );

  server.registerTool(
    "discord_admin_delete_channel",
    {
      title: "Delete channel (admin)",
      description:
        "Permanently delete a channel, forum (with all its posts) or empty category. Cannot be undone. " +
        "confirm_name must equal the channel's exact name. " +
        "Confirm with the user first.",
      inputSchema: {
        channel_id: id("Channel ID"),
        confirm_name: z.string().describe("The channel's exact current name"),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      destructiveAllowed();
      const ch = await editableChannel(a.channel_id);
      if (a.confirm_name !== ch.name) throw new AccessError(`confirm_name must be exactly "${ch.name}".`);
      if (ch.type === 4) {
        const { list } = await allChannels();
        const kids = list.filter((c) => c.parent_id === ch.id);
        if (kids.length) throw new AccessError(`Category "${ch.name}" still has ${kids.length} channel(s). Move or delete them first.`);
      }
      await admin.deleteChannel(a.channel_id, tag(a.reason));
      dc.forget(a.channel_id);
      await audit(`deleted ${TYPE_NAMES[ch.type]} #${ch.name} (${ch.id})${a.reason ? `: ${a.reason}` : ""}`);
      return ok({ deleted: ch.name, id: ch.id });
    }),
  );


  const color = z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/, "hex colour like #FF5A1F")
    .transform((s) => parseInt(s.replace("#", ""), 16));

  server.registerTool(
    "discord_admin_create_role",
    {
      title: "Create role (admin)",
      description:
        "Create a role with named permissions (see discord_admin_set_permissions for names). " +
        "The bot can only manage roles below its highest role.",
      inputSchema: {
        name: z.string().min(1).max(100),
        permissions: z.array(perm).default([]),
        color: color.optional(),
        hoist: z.boolean().default(false).describe("Show members separately in the member list"),
        mentionable: z.boolean().default(false),
        reason,
      },
      annotations: ADDITIVE,
    },
    safe(async (a) => {
      noAdministrator(a.permissions);
      const existing = await roles(true);
      if (existing.some((r) => r.name.toLowerCase() === a.name.toLowerCase())) {
        throw new AccessError(`A role named "${a.name}" already exists.`);
      }
      const r = await admin.createRole(
        { name: a.name, permissions: toBits(a.permissions).toString(), color: a.color ?? 0, hoist: a.hoist, mentionable: a.mentionable },
        tag(a.reason),
      );
      resetRoles();
      await audit(`created role "${r.name}" (${r.id}) [${a.permissions.join(", ")}]`);
      return ok({ id: r.id, name: r.name, permissions: fromBits(r.permissions) });
    }),
  );

  server.registerTool(
    "discord_admin_edit_role",
    {
      title: "Edit role (admin)",
      description:
        "Rename a role, or change its colour, display or permissions. permissions replaces the whole set; " +
        "use add_permissions / remove_permissions to change a few.",
      inputSchema: {
        role: z.string().describe("Role name or ID"),
        name: z.string().min(1).max(100).optional(),
        permissions: z.array(perm).optional(),
        add_permissions: z.array(perm).default([]),
        remove_permissions: z.array(perm).default([]),
        color: color.optional(),
        hoist: z.boolean().optional(),
        mentionable: z.boolean().optional(),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      const role = await resolveRole(a.role);
      editableRole(role, "edited");
      const p: Record<string, unknown> = {};
      if (a.name) p.name = a.name;
      if (a.color !== undefined) p.color = a.color;
      if (a.hoist !== undefined) p.hoist = a.hoist;
      if (a.mentionable !== undefined) p.mentionable = a.mentionable;
      if (a.permissions || a.add_permissions.length || a.remove_permissions.length) {
        noAdministrator([...(a.permissions ?? []), ...a.add_permissions]);
        let bits = a.permissions ? toBits(a.permissions) : BigInt(role.permissions);
        bits = (bits | toBits(a.add_permissions)) & ~toBits(a.remove_permissions);
        p.permissions = bits.toString();
      }
      if (!Object.keys(p).length) throw new AccessError("Nothing to change.");
      const r = await admin.editRole(role.id, p, tag(a.reason));
      resetRoles();
      await audit(`edited role "${role.name}" (${role.id}): ${Object.keys(p).join(", ")}`);
      return ok({ id: r.id, name: r.name, permissions: fromBits(r.permissions), changed: Object.keys(p) });
    }),
  );

  server.registerTool(
    "discord_admin_delete_role",
    {
      title: "Delete role (admin)",
      description:
        "Permanently delete a role. Cannot be undone. " +
        "confirm_name must equal the role's exact name. Confirm with the user first.",
      inputSchema: { role: z.string().describe("Role name or ID"), confirm_name: z.string(), reason },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      destructiveAllowed();
      const role = await resolveRole(a.role);
      editableRole(role, "deleted");
      if (a.confirm_name !== role.name) throw new AccessError(`confirm_name must be exactly "${role.name}".`);
      await admin.deleteRole(role.id, tag(a.reason));
      resetRoles();
      await audit(`deleted role "${role.name}" (${role.id})${a.reason ? `: ${a.reason}` : ""}`);
      return ok({ deleted: role.name, id: role.id });
    }),
  );

  server.registerTool(
    "discord_admin_set_member_roles",
    {
      title: "Give or remove roles (admin)",
      description: "Add and/or remove roles (names or IDs) for one member, by user ID (see discord_admin_list_members).",
      inputSchema: {
        user_id: id("The member's user ID"),
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      if (!a.add.length && !a.remove.length) throw new AccessError("Give roles to add and/or remove.");
      const add = await Promise.all(a.add.map(resolveRole));
      const remove = await Promise.all(a.remove.map(resolveRole));
      for (const r of [...add, ...remove]) {
        if (r.id === everyone) throw new AccessError("@everyone can't be given or removed.");
        editableRole(r, "assigned");
      }
      if (protectedIds.has(a.user_id)) throw new AccessError("That member is protected (DISCORD_PROTECTED_IDS).");
      if (!cfg.admin.allowAdministratorPermission) {
        const adminRole = add.find((r) => BigInt(r.permissions) & PERMISSIONS.ADMINISTRATOR);
        if (adminRole) throw new AccessError(`"${adminRole.name}" has ADMINISTRATOR; giving it is blocked.`);
      }
      const member = await admin.member(a.user_id);
      const name = member.nick || member.user.global_name || member.user.username;
      for (const r of add) await admin.addMemberRole(a.user_id, r.id, tag(a.reason));
      for (const r of remove) await admin.removeMemberRole(a.user_id, r.id, tag(a.reason));
      await audit(`roles for ${name}: added [${add.map((r) => r.name).join(", ")}], removed [${remove.map((r) => r.name).join(", ")}]`);
      return ok({ member: name, added: add.map((r) => r.name), removed: remove.map((r) => r.name) });
    }),
  );


  const ACTIONS: Record<number, string> = {
    1: "server_update", 10: "channel_create", 11: "channel_update", 12: "channel_delete",
    13: "permission_create", 14: "permission_update", 15: "permission_delete",
    20: "member_kick", 22: "member_ban", 23: "member_unban", 24: "member_update", 25: "member_roles_update",
    28: "bot_add", 30: "role_create", 31: "role_update", 32: "role_delete",
    40: "invite_create", 42: "invite_delete", 50: "webhook_create", 52: "webhook_delete",
    72: "message_delete", 73: "message_bulk_delete", 74: "message_pin", 75: "message_unpin",
    110: "thread_create", 111: "thread_update", 112: "thread_delete",
  };
  const ACTION_IDS = Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [v, Number(k)]));

  server.registerTool(
    "discord_admin_audit_log",
    {
      title: "Discord audit log (admin)",
      description:
        "Recent entries from Discord's own audit log: who created, changed or deleted channels, roles, permissions, " +
        "members, messages, invites and webhooks. Filter by user or action. " +
        `Actions: ${Object.values(ACTIONS).join(", ")}.`,
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(30),
        user_id: id("Only actions by this user").optional(),
        action: z.string().optional().describe("One action name from the list"),
        before: id("Only entries before this entry ID (paging)").optional(),
      },
      annotations: READ,
    },
    safe(async (a) => {
      let action_type: number | undefined;
      if (a.action) {
        action_type = ACTION_IDS[a.action.toLowerCase()];
        if (action_type === undefined) throw new AccessError(`Unknown action "${a.action}".`);
      }
      const log = await admin.auditLog({ limit: a.limit, user_id: a.user_id, action_type, before: a.before });
      const who = new Map(log.users.map((u) => [u.id, u.global_name || u.username]));
      return ok(
        log.audit_log_entries.map((e) => ({
          id: e.id,
          time: new Date(Number((BigInt(e.id) >> 22n) + 1420070400000n)).toISOString(),
          by: e.user_id ? who.get(e.user_id) ?? e.user_id : undefined,
          action: ACTIONS[e.action_type] ?? `action_${e.action_type}`,
          target_id: e.target_id ?? undefined,
          reason: e.reason ? decodeURIComponent(e.reason) : undefined,
          changes: e.changes?.map((c) => ({ key: c.key, from: c.old_value, to: c.new_value })),
        })),
      );
    }),
  );


  server.registerTool(
    "discord_admin_moderate_member",
    {
      title: "Moderate member (admin)",
      description:
        "Timeout, remove timeout, set nickname, kick, ban or unban a member by user ID. " +
        "Confirm kicks and bans with the user first. A reason is required for both.",
      inputSchema: {
        user_id: id("The member's user ID"),
        action: z.enum(["timeout", "remove_timeout", "set_nickname", "kick", "ban", "unban"]),
        minutes: z.number().int().min(1).max(40320).optional().describe("timeout: how long (max 28 days)"),
        nickname: z.string().max(32).optional().describe("set_nickname: new nickname; empty resets it"),
        delete_message_days: z.number().int().min(0).max(7).default(0).describe("ban: also delete their recent messages"),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      if (protectedIds.has(a.user_id)) throw new AccessError("That member is protected (DISCORD_PROTECTED_IDS).");
      const me = await dc.me();
      if (a.user_id === me.id) throw new AccessError("The bot can't moderate itself.");
      if (["kick", "ban"].includes(a.action)) destructiveAllowed();
      if (["kick", "ban"].includes(a.action) && !a.reason) throw new AccessError(`A reason is required to ${a.action}.`);

      let label = `user ${a.user_id}`;
      if (a.action !== "unban") {
        const m = await admin.member(a.user_id);
        label = m.nick || m.user.global_name || m.user.username;
      }
      switch (a.action) {
        case "timeout": {
          if (!a.minutes) throw new AccessError("timeout needs minutes.");
          const until = new Date(Date.now() + a.minutes * 60_000).toISOString();
          await admin.editMember(a.user_id, { communication_disabled_until: until }, tag(a.reason));
          break;
        }
        case "remove_timeout":
          await admin.editMember(a.user_id, { communication_disabled_until: null }, tag(a.reason));
          break;
        case "set_nickname":
          await admin.editMember(a.user_id, { nick: a.nickname || null }, tag(a.reason));
          break;
        case "kick":
          await admin.kick(a.user_id, tag(a.reason));
          break;
        case "ban":
          await admin.ban(a.user_id, a.delete_message_days * 86400, tag(a.reason));
          break;
        case "unban":
          await admin.unban(a.user_id, tag(a.reason));
          break;
      }
      const extra = a.action === "timeout" ? ` ${a.minutes} min` : a.action === "set_nickname" ? ` to "${a.nickname ?? ""}"` : "";
      await audit(`${a.action} ${label}${extra}${a.reason ? `: ${a.reason}` : ""}`);
      return ok({ member: label, action: a.action, done: true });
    }),
  );


  /** Channel checks for message-level admin actions (threads inherit their parent's protection). */
  async function editableMessageChannel(channelId: string) {
    const ch = await dc.channel(channelId, true);
    if (isThread(ch.type) && ch.parent_id) await editableChannel(ch.parent_id);
    else await editableChannel(channelId);
    return ch;
  }

  server.registerTool(
    "discord_admin_manage_message",
    {
      title: "Pin, unpin or delete a message (admin)",
      description:
        "Pin, unpin, list pins, publish an announcement-channel message, or delete a message. " +
        "Deleting cannot be undone; confirm with the user first.",
      inputSchema: {
        channel_id: id("Channel, thread or forum post ID"),
        action: z.enum(["pin", "unpin", "list_pins", "delete", "publish"]).describe("publish: send an announcement-channel message to following servers"),
        message_id: id("Message ID (not needed for list_pins)").optional(),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      const ch = await editableMessageChannel(a.channel_id);
      if (a.action === "list_pins") {
        const pins = await admin.pins(a.channel_id);
        return ok({
          channel: ch.name,
          pins: pins.map((m) => ({ id: m.id, author: m.author.global_name || m.author.username, content: m.content.slice(0, 300) })),
        });
      }
      if (!a.message_id) throw new AccessError(`${a.action} needs message_id.`);
      if (a.action === "delete") {
        destructiveAllowed();
        await admin.deleteMessage(a.channel_id, a.message_id, tag(a.reason));
      } else if (a.action === "publish") {
        if (ch.type !== 5) throw new AccessError(`#${ch.name} is not an announcement channel.`);
        await dc.request("POST", `/channels/${a.channel_id}/messages/${a.message_id}/crosspost`);
      } else if (a.action === "pin") await admin.pin(a.channel_id, a.message_id, tag(a.reason));
      else await admin.unpin(a.channel_id, a.message_id, tag(a.reason));
      await audit(`${a.action} message ${a.message_id} in #${ch.name}${a.reason ? `: ${a.reason}` : ""}`);
      return ok({ channel: ch.name, message_id: a.message_id, action: a.action, done: true });
    }),
  );


  server.registerTool(
    "discord_admin_create_invite",
    {
      title: "Create invite (admin)",
      description:
        "Create an invite link to a channel. Defaults: expires in 24 hours, single use.",
      inputSchema: {
        channel_id: id("Channel the invite lands in"),
        expires_hours: z.number().min(0).max(168).default(24).describe("0 = never expires"),
        max_uses: z.number().int().min(0).max(100).default(1).describe("0 = unlimited"),
        reason,
      },
      annotations: ADDITIVE,
    },
    safe(async (a) => {
      const ch = await editableChannel(a.channel_id);
      const inv = await admin.createInvite(
        a.channel_id,
        { max_age: Math.round(a.expires_hours * 3600), max_uses: a.max_uses, unique: true },
        tag(a.reason),
      );
      await audit(`created invite to #${ch.name} (${a.max_uses || "unlimited"} uses, expires ${a.expires_hours ? `in ${a.expires_hours}h` : "never"})`);
      return ok({ url: `https://discord.gg/${inv.code}`, channel: ch.name, expires_hours: a.expires_hours, max_uses: a.max_uses });
    }),
  );

  server.registerTool(
    "discord_admin_webhooks",
    {
      title: "Webhooks (admin)",
      description:
        "List, create or delete webhooks. The returned webhook URL is a secret; anyone with it can post to the channel.",
      inputSchema: {
        action: z.enum(["list", "create", "delete"]),
        webhook_id: id("delete: the webhook").optional(),
        channel_id: id("create: channel the webhook posts into").optional(),
        name: z.string().min(1).max(80).optional().describe("create: name shown on its posts"),
        reason,
      },
      annotations: ADDITIVE,
    },
    safe(async (a) => {
      if (a.action === "list") {
        const hooks = await admin.webhooks();
        const { byId } = await allChannels();
        return ok(hooks.map((h) => ({ id: h.id, name: h.name, channel: byId.get(h.channel_id)?.name ?? h.channel_id })));
      }
      if (a.action === "delete") {
        if (!a.webhook_id) throw new AccessError("delete needs webhook_id.");
        destructiveAllowed();
        await dc.request("DELETE", `/webhooks/${a.webhook_id}`, undefined, tag(a.reason));
        await audit(`deleted webhook ${a.webhook_id}`);
        return ok({ deleted: a.webhook_id });
      }
      if (!a.channel_id || !a.name) throw new AccessError("create needs channel_id and name.");
      const ch = await editableChannel(a.channel_id);
      const h = await admin.createWebhook(a.channel_id, a.name, tag(a.reason));
      await audit(`created webhook "${h.name}" in #${ch.name}`);
      return ok({
        id: h.id,
        name: h.name,
        channel: ch.name,
        url: `https://discord.com/api/webhooks/${h.id}/${h.token}`,
        note: "Secret. Put it in the other service's settings; don't post it in Discord or docs.",
      });
    }),
  );

  return ctx;
}
