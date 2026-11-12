// Admin tools that make several changes per call.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Channel } from "./discord.js";
import { AccessError } from "./guard.js";
import {
  ADDITIVE, CHANNEL_TYPES, DESTRUCTIVE, PERMISSIONS, REQUIRE_TAG, SORT,
  fromBits, id, ok, perm, reason, safe, toBits, type AdminContext,
} from "./common.js";

const channelSpec = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["text", "forum", "announcement", "voice"]).default("text"),
  topic: z.string().max(4096).optional().describe("Topic, or a forum's post guidelines"),
  tags: z.array(z.string().min(1).max(20)).max(20).optional(),
  require_tag: z.boolean().optional(),
  default_sort: z.enum(["latest_activity", "creation_date"]).optional(),
  read_only: z.boolean().optional().describe("Everyone can read; only roles with overrides can post"),
  private_to_roles: z.array(z.string()).optional().describe("Override the category: only these roles see this channel"),
});

const roleSpec = z.object({
  name: z.string().min(1).max(100),
  permissions: z.array(perm).default([]),
  color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  hoist: z.boolean().default(false),
  mentionable: z.boolean().default(false),
});

/** Permissions a lockdown removes from @everyone. */
const LOCK =
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.SEND_MESSAGES_IN_THREADS |
  PERMISSIONS.CREATE_PUBLIC_THREADS |
  PERMISSIONS.CREATE_PRIVATE_THREADS |
  PERMISSIONS.ADD_REACTIONS;

export function registerSetupTools(server: McpServer, ctx: AdminContext) {
  const { cfg, dc, admin, everyone, tag, audit, allChannels, editableChannel, roles, resolveRole, editableRole, editableMember, noAdministrator, forumTags } = ctx;

  async function overwritesFor(roleRefs: string[]) {
    const rs = await Promise.all(roleRefs.map(resolveRole));
    const me = await dc.me();
    const see = (PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_MESSAGE_HISTORY).toString();
    return [
      { id: everyone, type: 0, allow: "0", deny: PERMISSIONS.VIEW_CHANNEL.toString() },
      ...rs.filter((r) => r.id !== everyone).map((r) => ({ id: r.id, type: 0, allow: see, deny: "0" })),
      { id: me.id, type: 1, allow: (PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.READ_MESSAGE_HISTORY).toString(), deny: "0" },
    ];
  }


  server.registerTool(
    "discord_admin_setup_category",
    {
      title: "Set up a category with channels (admin)",
      description:
        "Create a category and all its channels in one call: text, forum (with tags, required tag, sort, guidelines), " +
        "announcement or voice. private_to_roles on the category hides it from everyone else; channels inherit that " +
        "unless they set their own. read_only makes a channel post-by-admins-only. " +
        "Use category_id instead of name to add channels to an existing category. Reports each channel's result.",
      inputSchema: {
        name: z.string().min(1).max(100).optional().describe("New category name"),
        category_id: id("Or: add to this existing category").optional(),
        private_to_roles: z.array(z.string()).optional(),
        channels: z.array(channelSpec).min(1).max(50),
        reason,
      },
      annotations: ADDITIVE,
    },
    safe(async (a) => {
      if (!a.name === !a.category_id) throw new AccessError("Give either name (new category) or category_id (existing).");
      let cat: Channel;
      if (a.category_id) {
        cat = await editableChannel(a.category_id);
        if (cat.type !== 4) throw new AccessError(`${a.category_id} is not a category.`);
      } else {
        const payload: Record<string, unknown> = { name: a.name, type: 4 };
        if (a.private_to_roles?.length) payload.permission_overwrites = await overwritesFor(a.private_to_roles);
        cat = await admin.createChannel(payload, tag(a.reason));
      }
      const results: { name: string; id?: string; type: string; error?: string }[] = [];
      for (const c of a.channels) {
        try {
          const type = CHANNEL_TYPES[c.type];
          const p: Record<string, unknown> = { name: c.name, type, parent_id: cat.id };
          if (c.topic && type !== 2) p.topic = c.topic;
          if (type === 15) {
            if (c.tags) p.available_tags = forumTags(c.tags);
            if (c.require_tag) p.flags = REQUIRE_TAG;
            if (c.default_sort) p.default_sort_order = SORT[c.default_sort];
          } else if (c.tags || c.require_tag || c.default_sort) {
            throw new AccessError("tags, require_tag and default_sort are for forums only");
          }
          // Start from the category's overwrites so the channel stays in sync with it.
          let ow = c.private_to_roles?.length ? await overwritesFor(c.private_to_roles) : [...(cat.permission_overwrites ?? [])];
          if (c.read_only) {
            const ev = ow.find((o) => o.id === everyone);
            const deny = (BigInt(ev?.deny ?? "0") | LOCK).toString();
            ow = [...ow.filter((o) => o.id !== everyone), { id: everyone, type: 0, allow: ev?.allow ?? "0", deny }];
          }
          if (ow.length) p.permission_overwrites = ow;
          const made = await admin.createChannel(p, tag(a.reason));
          dc.remember(made);
          results.push({ name: made.name ?? c.name, id: made.id, type: c.type });
        } catch (e) {
          results.push({ name: c.name, type: c.type, error: (e as Error).message });
        }
      }
      const failed = results.filter((r) => r.error).length;
      await audit(`set up category "${cat.name}": ${results.filter((r) => r.id).map((r) => `#${r.name}`).join(", ")}${failed ? ` (${failed} failed)` : ""}`);
      return ok({ category: { id: cat.id, name: cat.name, created: !a.category_id }, channels: results, failed });
    }),
  );


  server.registerTool(
    "discord_admin_setup_roles",
    {
      title: "Set up roles in order (admin)",
      description:
        "Create or update several roles at once, listed top to bottom, then order them that way. " +
        "Existing roles (matched by name) are updated, others created. Colours are hex.",
      inputSchema: { roles: z.array(roleSpec).min(1).max(25), reason },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      a.roles.forEach((r) => noAdministrator(r.permissions));
      const existing = await roles(true);
      const out: { name: string; id: string; created: boolean }[] = [];
      for (const spec of a.roles) {
        const payload = {
          name: spec.name,
          permissions: toBits(spec.permissions).toString(),
          color: spec.color ? parseInt(spec.color.replace("#", ""), 16) : 0,
          hoist: spec.hoist,
          mentionable: spec.mentionable,
        };
        const found = existing.find((r) => r.name.toLowerCase() === spec.name.toLowerCase());
        if (found) {
          editableRole(found, "edited");
          await admin.editRole(found.id, payload, tag(a.reason));
          out.push({ name: spec.name, id: found.id, created: false });
        } else {
          const r = await admin.createRole(payload, tag(a.reason));
          out.push({ name: r.name, id: r.id, created: true });
        }
      }
      await ctx.orderRoles(out.map((o) => o.id), a.reason);
      await audit(`set up roles: ${out.map((o) => `${o.name}${o.created ? " (new)" : ""}`).join(" > ")}`);
      return ok({ roles: out });
    }),
  );


  server.registerTool(
    "discord_admin_lockdown",
    {
      title: "Lock or unlock a channel (admin)",
      description:
        "Lock a channel or category so @everyone can read but not post, react or start threads. " +
        "Roles with their own overrides are unaffected. Unlocking removes only what locking added.",
      inputSchema: { channel_id: id("Channel or category ID"), lock: z.boolean(), reason },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      const ch = await editableChannel(a.channel_id);
      const targets = [ch];
      if (ch.type === 4) {
        const { list } = await allChannels();
        targets.push(...list.filter((c) => c.parent_id === ch.id));
      }
      for (const t of targets) {
        const fresh = await dc.channel(t.id, true);
        const ev = fresh.permission_overwrites?.find((o) => o.id === everyone);
        const allow = BigInt(ev?.allow ?? "0") & ~LOCK;
        const deny = a.lock ? BigInt(ev?.deny ?? "0") | LOCK : BigInt(ev?.deny ?? "0") & ~LOCK;
        if (allow === 0n && deny === 0n) await admin.deleteOverwrite(t.id, everyone, tag(a.reason)).catch(() => undefined);
        else await admin.setOverwrite(t.id, everyone, { allow: allow.toString(), deny: deny.toString(), type: 0 }, tag(a.reason));
        dc.forget(t.id);
      }
      await audit(`${a.lock ? "locked" : "unlocked"} ${targets.map((t) => `#${t.name}`).join(", ")}`);
      return ok({ locked: a.lock, channels: targets.map((t) => t.name), removed_for_everyone: a.lock ? fromBits(LOCK) : undefined });
    }),
  );


  server.registerTool(
    "discord_admin_bulk_roles",
    {
      title: "Give or remove a role for many members (admin)",
      description:
        "Add or remove one role for a list of members (user IDs), or for everyone who currently has another role " +
        "Reports each member's result.",
      inputSchema: {
        role: z.string().describe("Role to add or remove"),
        action: z.enum(["add", "remove"]),
        user_ids: z.array(z.string().regex(/^\d{5,25}$/)).max(500).optional(),
        members_with_role: z.string().optional().describe("Or: everyone who has this role"),
        reason,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async (a) => {
      const role = await resolveRole(a.role);
      if (role.id === everyone) throw new AccessError("@everyone can't be given or removed.");
      editableRole(role, "assigned");
      if (a.action === "add" && !cfg.admin.allowAdministratorPermission && BigInt(role.permissions) & PERMISSIONS.ADMINISTRATOR) {
        throw new AccessError(`"${role.name}" has ADMINISTRATOR; giving it is turned off.`);
      }
      let ids = a.user_ids ?? [];
      if (a.members_with_role) {
        const from = await resolveRole(a.members_with_role);
        const all = await admin.members(1000);
        ids = [...ids, ...all.filter((m) => from.id === everyone || m.roles.includes(from.id)).map((m) => m.user.id)];
      }
      ids = [...new Set(ids)];
      if (!ids.length) throw new AccessError("No members given (user_ids or members_with_role).");
      const results: { user_id: string; ok: boolean; error?: string }[] = [];
      for (const uid of ids) {
        try {
          editableMember(uid);
          if (a.action === "add") await admin.addMemberRole(uid, role.id, tag(a.reason));
          else await admin.removeMemberRole(uid, role.id, tag(a.reason));
          results.push({ user_id: uid, ok: true });
        } catch (e) {
          results.push({ user_id: uid, ok: false, error: (e as Error).message });
        }
      }
      const done = results.filter((r) => r.ok).length;
      await audit(`${a.action === "add" ? "gave" : "removed"} "${role.name}" ${a.action === "add" ? "to" : "from"} ${done}/${ids.length} member(s)`);
      return ok({ role: role.name, action: a.action, done, failed: results.filter((r) => !r.ok) });
    }),
  );


  server.registerTool(
    "discord_admin_clone_channel",
    {
      title: "Copy a channel (admin)",
      description: "Create a new channel with the same type, category, topic, permissions, slowmode and forum tags/settings as an existing one.",
      inputSchema: { channel_id: id("Channel to copy"), name: z.string().min(1).max(100), reason },
      annotations: ADDITIVE,
    },
    safe(async (a) => {
      const src = await editableChannel(a.channel_id);
      if (src.type === 4) throw new AccessError("Use discord_admin_setup_category to build categories.");
      const p: Record<string, unknown> = {
        name: a.name,
        type: src.type,
        parent_id: src.parent_id,
        topic: src.topic,
        rate_limit_per_user: src.rate_limit_per_user,
        permission_overwrites: src.permission_overwrites,
      };
      if (src.type === 15 || src.type === 16) {
        p.available_tags = (src.available_tags ?? []).map((t) => ({ name: t.name, moderated: t.moderated }));
        p.flags = src.flags;
        p.default_sort_order = src.default_sort_order;
      }
      const made = await admin.createChannel(p, tag(a.reason));
      await audit(`copied #${src.name} to #${made.name}`);
      return ok({ id: made.id, name: made.name, copied_from: src.name });
    }),
  );

}
