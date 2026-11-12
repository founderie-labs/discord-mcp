// End-to-end test: real MCP client ↔ this server (stdio and HTTP) ↔ mock Discord API.
//   npm test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockDiscord } from "./mock-discord.mjs";

let mock = await startMockDiscord();
const env = {
  ...process.env,
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_GUILD_ID: "100000",
  DISCORD_READ_CHANNELS: "200000,210000", // PIPELINE and START categories
  DISCORD_WRITE_CHANNELS: "201000", // only #leads
  DISCORD_AUDIT_CHANNEL_ID: "500000",
  DISCORD_API_BASE: mock.url,
};

let passed = 0;
const step = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { error: r.isError, text, data: r.isError ? undefined : JSON.parse(text) };
};

async function suite(client, label) {
  console.log(`\n${label}`);
  await step("lists 46 tools (admin on by default) with hints", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 46);
    assert.equal(tools.find((t) => t.name === "discord_admin_delete_channel").annotations.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === "discord_read_messages").annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === "discord_create_post").annotations.readOnlyHint, false);
  });
  await step("server info", async () => {
    const r = await call(client, "discord_server_info");
    assert.equal(r.data.server, "Founderie Labs");
    assert.equal(r.data.writes_audited, true);
  });
  await step("lists only allowed channels; ADMIN and other servers hidden", async () => {
    const r = await call(client, "discord_list_channels");
    const names = r.data.map((c) => c.name).sort();
    assert.deepEqual(names, ["announcements", "general", "leads", "standup"]);
    assert.equal(r.data.find((c) => c.name === "leads").can_post, true);
    assert.equal(r.data.find((c) => c.name === "general").can_post, false);
    assert.ok(r.data.find((c) => c.name === "leads").tags.includes("Won"));
  });
  await step("reads a text channel", async () => {
    const r = await call(client, "discord_read_messages", { channel_id: "300000" });
    assert.equal(r.data.messages[0].content, "hello team");
  });
  await step("blocks reading #finance (not allowlisted)", async () => {
    const r = await call(client, "discord_read_messages", { channel_id: "401000" });
    assert.ok(r.error && /DISCORD_READ_CHANNELS/.test(r.text));
  });
  await step("blocks a channel from another Discord server", async () => {
    const r = await call(client, "discord_read_messages", { channel_id: "999000" });
    assert.ok(r.error && /different Discord server/.test(r.text));
  });
  await step("lists open posts, filters by tag and title", async () => {
    let r = await call(client, "discord_list_posts", { forum_id: "201000" });
    assert.equal(r.data.total, 1);
    assert.deepEqual(r.data.posts[0].tags, ["New", "Launch offer"]);
    r = await call(client, "discord_list_posts", { forum_id: "201000", status: "all", tags: ["won"] });
    assert.equal(r.data.posts[0].title, "Old Clinic · Services · Referral");
    r = await call(client, "discord_list_posts", { forum_id: "201000", status: "all", title_contains: "bakery" });
    assert.equal(r.data.total, 1);
  });
  await step("unknown tag gives a helpful error", async () => {
    const r = await call(client, "discord_list_posts", { forum_id: "201000", tags: ["Hot"] });
    assert.ok(r.error && /Available: New, Call Booked/.test(r.text));
  });
  await step("gets a post with its body first", async () => {
    const r = await call(client, "discord_get_post", { post_id: "201001" });
    assert.ok(r.data.messages[0].content.startsWith("Business: Ammu Bakery"));
    assert.equal(r.data.forum, "leads");
  });
  await step("lists forum tags", async () => {
    const r = await call(client, "discord_list_forum_tags", { forum_id: "201000" });
    assert.equal(r.data.tags.length, 5);
  });
  await step("blocks posting in #general (read-only channel)", async () => {
    const r = await call(client, "discord_send_message", { channel_id: "300000", content: "hi" });
    assert.ok(r.error && /DISCORD_WRITE_CHANNELS/.test(r.text));
  });
  await step("creates a post with tags; mentions disabled; audited", async () => {
    const before = mock.log.length;
    const r = await call(client, "discord_create_post", {
      forum_id: "201000",
      title: "Test Shop · Launch site · WhatsApp",
      content: "@everyone Business: Test Shop",
      tags: ["new", "Launch offer"],
    });
    assert.deepEqual(r.data.tags, ["New", "Launch offer"]);
    const create = mock.log.slice(before).find((e) => e.op === "create_post");
    assert.deepEqual(create.body.message.allowed_mentions, { parse: [] });
    assert.ok(mock.log.slice(before).some((e) => e.op === "send" && e.channel === "500000"), "audit line posted");
  });
  await step("replies inside a post; long text is split", async () => {
    const r = await call(client, "discord_send_message", { channel_id: "201001", content: "line\n".repeat(700) });
    assert.equal(r.data.sent, 2);
  });
  await step("moves tags: New → Call Booked", async () => {
    const r = await call(client, "discord_set_post_tags", { post_id: "201001", add: ["Call Booked"], remove: ["New"] });
    assert.deepEqual(r.data.tags_after, ["Launch offer", "Call Booked"]);
  });
  await step("closes and reopens a post", async () => {
    let r = await call(client, "discord_set_post_status", { post_id: "201001", closed: true, note: "Won → see #projects" });
    assert.equal(mock.channels.get("201001").thread_metadata.archived, true);
    r = await call(client, "discord_set_post_status", { post_id: "201001", closed: false });
    assert.equal(mock.channels.get("201001").thread_metadata.archived, false);
  });
  await step("rejects non-ID input", async () => {
    const r = await client.callTool({ name: "discord_read_messages", arguments: { channel_id: "general" } });
    assert.ok(r.isError);
  });
}

// ---- stdio
const stdio = new Client({ name: "test", version: "1" });
await stdio.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js"], env, stderr: "ignore" }));
await suite(stdio, "stdio transport");
await stdio.close();

// ---- read-only mode
const ro = new Client({ name: "test", version: "1" });
await ro.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js"], env: { ...env, DISCORD_READ_ONLY: "true" }, stderr: "ignore" }));
console.log("\nread-only mode");
await step("blocks every write and hides admin tools", async () => {
  const r = await call(ro, "discord_create_post", { forum_id: "201000", title: "x", content: "x", tags: ["New"] });
  assert.ok(r.error && /read-only/.test(r.text));
  assert.equal((await ro.listTools()).tools.length, 16);
});
await ro.close();

// ---- whole-server default + admin tools (fresh mock)
mock.close();
mock = await startMockDiscord();
const adminEnv = {
  ...process.env,
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_GUILD_ID: "100000",
  DISCORD_API_BASE: mock.url,
  DISCORD_AUDIT_CHANNEL_ID: "500000",
  DISCORD_PROTECTED_IDS: "400000,611000,700007", // ADMIN category, Founder role, Kalki
};
const ad = new Client({ name: "test", version: "1" });
await ad.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js"], env: adminEnv, stderr: "ignore" }));

console.log("\ndefaults (no allowlists)");
await step("whole server readable and writable", async () => {
  const r = await call(ad, "discord_list_channels");
  assert.ok(r.data.some((c) => c.name === "finance" && c.can_post));
  const s = await call(ad, "discord_send_message", { channel_id: "300000", content: "hi" });
  assert.ok(!s.error);
});

console.log("\nadmin tools");
let forumId;
await step("overview shows categories, roles and protection", async () => {
  const r = await call(ad, "discord_admin_overview");
  assert.ok(r.data.categories.some((c) => c.name === "PIPELINE" && c.channels.some((x) => x.name === "leads")));
  assert.equal(r.data.categories.find((c) => c.name === "ADMIN").protected, true);
  assert.deepEqual(r.data.roles.find((x) => x.name === "Founder").permissions, ["ADMINISTRATOR (all permissions)"]);
});
await step("creates a private forum with tags, required tag and sort", async () => {
  const r = await call(ad, "discord_admin_create_channel", {
    name: "projects", type: "forum", category_id: "200000", topic: "One post per project",
    tags: ["Launch site", "Custom", "Build", "Live"], require_tag: true, default_sort: "latest_activity",
    private_to_roles: ["team"], reason: "set up delivery",
  });
  forumId = r.data.id;
  const c = mock.channels.get(forumId);
  assert.equal(c.type, 15);
  assert.equal(c.flags, 16);
  assert.equal(c.available_tags.length, 4);
  const ow = c.permission_overwrites;
  assert.ok(ow.find((o) => o.id === "100000" && o.deny === String(1n << 10n)), "@everyone hidden");
  assert.ok(ow.find((o) => o.id === "610000"), "Team can see");
  assert.ok(ow.find((o) => o.id === "1" && o.type === 1), "bot keeps access");
  assert.ok(mock.reasons.includes("MCP admin: set up delivery"), "reason in Discord audit log");
});
await step("edits forum tags and keeps existing tag IDs", async () => {
  const before = mock.channels.get(forumId).available_tags.find((t) => t.name === "Build").id;
  const r = await call(ad, "discord_admin_edit_channel", { channel_id: forumId, tags: ["Launch site", "Build", "Review", "Live"] });
  assert.deepEqual(r.data.removed_tags, ["Custom"]);
  assert.equal(mock.channels.get(forumId).available_tags.find((t) => t.name === "Build").id, before);
});
await step("can't touch protected channels or the audit channel", async () => {
  let r = await call(ad, "discord_admin_edit_channel", { channel_id: "401000", name: "money" });
  assert.ok(r.error && /protected/.test(r.text));
  r = await call(ad, "discord_admin_set_permissions", { channel_id: "500000", target: "@everyone", allow: ["VIEW_CHANNEL"] });
  assert.ok(r.error && /protected/.test(r.text));
});
await step("sets channel permissions by role name and permission name", async () => {
  const r = await call(ad, "discord_admin_set_permissions", { channel_id: "300000", target: "Team", allow: ["send messages", "ATTACH_FILES"], deny: ["mention_everyone"] });
  assert.deepEqual(r.data.allow, ["SEND_MESSAGES", "ATTACH_FILES"]);
  const o = mock.channels.get("300000").permission_overwrites.find((x) => x.id === "610000");
  assert.equal(o.allow, String((1n << 11n) | (1n << 15n)));
});
await step("creates and edits a role (ADMINISTRATOR allowed by default)", async () => {
  let r = await call(ad, "discord_admin_create_role", { name: "Engineer", permissions: ["MANAGE_THREADS"], color: "#FF5A1F" });
  assert.equal(mock.roles.get(r.data.id).color, 0xff5a1f);
  r = await call(ad, "discord_admin_edit_role", { role: "engineer", add_permissions: ["MANAGE_MESSAGES"] });
  assert.deepEqual(r.data.permissions, ["MANAGE_MESSAGES", "MANAGE_THREADS"]);
  r = await call(ad, "discord_admin_create_role", { name: "Lead", permissions: ["ADMINISTRATOR"] });
  assert.ok(!r.error);
});
await step("refuses protected, managed and @everyone roles", async () => {
  assert.ok((await call(ad, "discord_admin_edit_role", { role: "Founder", name: "x" })).error);
  assert.ok((await call(ad, "discord_admin_edit_role", { role: "Ops Bot", name: "x" })).error);
  assert.ok((await call(ad, "discord_admin_delete_role", { role: "@everyone", confirm_name: "@everyone" })).error);
});
await step("lists/searches members and gives roles", async () => {
  let r = await call(ad, "discord_admin_list_members", { query: "aru" });
  assert.equal(r.data[0].name, "Arun");
  r = await call(ad, "discord_admin_set_member_roles", { user_id: "800008", add: ["Team", "Engineer"] });
  assert.deepEqual(r.data.added, ["Team", "Engineer"]);
  assert.equal(mock.members.get("800008").roles.length, 2);
  r = await call(ad, "discord_admin_set_member_roles", { user_id: "700007", remove: ["Team"] });
  assert.ok(r.error && /protected/.test(r.text));
});
await step("moderation: timeout, nickname; kick needs a reason; can't touch protected member", async () => {
  let r = await call(ad, "discord_admin_moderate_member", { user_id: "800008", action: "timeout", minutes: 10 });
  assert.ok(mock.members.get("800008").communication_disabled_until);
  r = await call(ad, "discord_admin_moderate_member", { user_id: "800008", action: "set_nickname", nickname: "Arun (Eng)" });
  assert.equal(mock.members.get("800008").nick, "Arun (Eng)");
  r = await call(ad, "discord_admin_moderate_member", { user_id: "800008", action: "kick" });
  assert.ok(r.error && /reason/.test(r.text));
  r = await call(ad, "discord_admin_moderate_member", { user_id: "700007", action: "ban", reason: "x" });
  assert.ok(r.error && /protected/.test(r.text));
});
await step("pins, lists pins and deletes a message", async () => {
  await call(ad, "discord_admin_manage_message", { channel_id: "300000", action: "pin", message_id: "800000000000000003" });
  let r = await call(ad, "discord_admin_manage_message", { channel_id: "300000", action: "list_pins" });
  assert.equal(r.data.pins[0].content, "hello team");
  r = await call(ad, "discord_admin_manage_message", { channel_id: "300000", action: "delete", message_id: "800000000000000003" });
  assert.ok(mock.log.some((e) => e.op === "delete_message"));
});
await step("creates an invite and a webhook", async () => {
  let r = await call(ad, "discord_admin_create_invite", { channel_id: "300000" });
  assert.equal(r.data.url, "https://discord.gg/abcXYZ");
  r = await call(ad, "discord_admin_webhooks", { action: "create", channel_id: "300000", name: "Vercel" });
  assert.ok(r.data.url.endsWith("/wh-secret-token"));
  r = await call(ad, "discord_admin_webhooks", { action: "list" });
  assert.equal(r.data[0].name, "Vercel");
});
await step("reads Discord's audit log", async () => {
  const r = await call(ad, "discord_admin_audit_log", { limit: 5 });
  assert.equal(r.data[0].by, "Kalki");
  assert.equal(r.data[0].action, "channel_update");
  assert.equal(r.data[0].reason, "tidy up");
});
console.log("\nserver settings, ordering, bans, invites, events, AutoMod");
await step("reads and edits server settings", async () => {
  let r = await call(ad, "discord_admin_get_server");
  assert.equal(r.data.verification, "low");
  assert.equal(r.data.system_channel, "general");
  r = await call(ad, "discord_admin_edit_server", { description: "A foundry for ideas", verification: "medium", content_filter: "all_members", system_channel_id: "none" });
  assert.equal(mock.guild.verification_level, 2);
  assert.equal(mock.guild.system_channel_id, null);
  r = await call(ad, "discord_admin_edit_server", { icon_url: "http://insecure/x.png" });
  assert.ok(r.error && /https/.test(r.text));
});
await step("reorders roles and channels by name", async () => {
  await call(ad, "discord_admin_create_role", { name: "Designer" });
  let r = await call(ad, "discord_admin_reorder", { what: "roles", order: ["Engineer", "Designer", "Team"] });
  assert.deepEqual(r.data.order, ["Engineer", "Designer", "Team"]);
  const pos = (n) => [...mock.roles.values()].find((x) => x.name === n).position;
  assert.ok(pos("Engineer") > pos("Designer") && pos("Designer") > pos("Team"));
  r = await call(ad, "discord_admin_reorder", { what: "channels", category_id: "210000", order: ["#announcements", "general"] });
  assert.deepEqual(r.data.order.slice(0, 2), ["announcements", "general"]);
  r = await call(ad, "discord_admin_reorder", { what: "roles", order: ["Founder"] });
  assert.ok(r.error && /protected/.test(r.text));
});
await step("lists bans and checks one user", async () => {
  let r = await call(ad, "discord_admin_bans", {});
  assert.equal(r.data[0].reason, "spam links");
  r = await call(ad, "discord_admin_bans", { user_id: "800008" });
  assert.equal(r.data.banned, false);
});
await step("lists and revokes invites", async () => {
  let r = await call(ad, "discord_admin_invites", { action: "list" });
  assert.equal(r.data[0].uses, "0/1");
  r = await call(ad, "discord_admin_invites", { action: "revoke", code: "https://discord.gg/abcXYZ" });
  assert.equal(r.data.revoked, "abcXYZ");
});
await step("creates, edits, cancels and deletes events", async () => {
  let r = await call(ad, "discord_admin_events", { action: "create", name: "Weekly demo", start: "2026-11-20T15:00:00+05:30", channel_id: "302000" });
  const evId = r.data.id;
  assert.equal(mock.events.get(evId).entity_type, 2);
  r = await call(ad, "discord_admin_events", { action: "create", name: "Client visit", start: "2026-11-21T10:00:00+05:30", location: "Kochi office" });
  assert.ok(r.error && /end time/.test(r.text));
  r = await call(ad, "discord_admin_events", { action: "edit", event_id: evId, description: "Show what shipped" });
  r = await call(ad, "discord_admin_events", { action: "cancel", event_id: evId });
  assert.equal(r.data.status, "canceled");
  r = await call(ad, "discord_admin_events", { action: "list" });
  assert.equal(r.data[0].name, "Weekly demo");
  await call(ad, "discord_admin_events", { action: "delete", event_id: evId });
  assert.equal(mock.events.size, 0);
});
await step("creates, toggles and deletes AutoMod rules", async () => {
  let r = await call(ad, "discord_admin_automod", { action: "create", name: "No slurs", trigger: "preset", presets: ["slurs", "profanity"], alert_channel_id: "300000", exempt_roles: ["Team"] });
  const ruleId = r.data.id;
  const body = mock.log.find((e) => e.op === "automod").body;
  assert.deepEqual(body.trigger_metadata.presets, [3, 1]);
  assert.deepEqual(body.actions.map((x) => x.type), [1, 2]);
  r = await call(ad, "discord_admin_automod", { action: "create", name: "x", trigger: "spam", timeout_minutes: 5 });
  assert.ok(r.error && /Timeouts only/.test(r.text));
  r = await call(ad, "discord_admin_automod", { action: "disable", rule_id: ruleId });
  assert.equal(r.data.enabled, false);
  await call(ad, "discord_admin_automod", { action: "delete", rule_id: ruleId });
  assert.equal(mock.automod.size, 0);
});
await step("member and channel details", async () => {
  let r = await call(ad, "discord_admin_get_member", { user_id: "800008" });
  assert.equal(r.data.name, "Arun (Eng)");
  assert.ok(r.data.timed_out_until);
  await call(ad, "discord_admin_set_permissions", { channel_id: "201000", target: "Team", allow: ["VIEW_CHANNEL"] });
  r = await call(ad, "discord_admin_get_channel", { channel_id: "201000" });
  assert.equal(r.data.forum.tags.length, 5);
  assert.deepEqual(r.data.permissions.find((x) => x.for === "Team").allow, ["VIEW_CHANNEL"]);
  r = await call(ad, "discord_admin_list_members", { role: "Engineer" });
  assert.deepEqual(r.data.map((x) => x.name), ["Arun (Eng)"]);
});

console.log("\nsetup in one call");
await step("sets up a category with a forum, a read-only channel and a voice room", async () => {
  const r = await call(ad, "discord_admin_setup_category", {
    name: "DELIVERY", private_to_roles: ["Team"],
    channels: [
      { name: "projects", type: "forum", tags: ["Launch site", "Custom", "Build", "Live"], require_tag: true, topic: "One post per client project" },
      { name: "releases", read_only: true },
      { name: "pairing", type: "voice" },
      { name: "bad", type: "text", tags: ["x"] },
    ],
  });
  assert.equal(r.data.failed, 1);
  const forum = mock.channels.get(r.data.channels[0].id);
  assert.equal(forum.parent_id, r.data.category.id);
  assert.equal(forum.flags, 16);
  assert.ok(forum.permission_overwrites.some((o) => o.id === "100000" && BigInt(o.deny) & (1n << 10n)), "inherits private");
  const rel = mock.channels.get(r.data.channels[1].id).permission_overwrites.find((o) => o.id === "100000");
  assert.ok(BigInt(rel.deny) & (1n << 11n) && BigInt(rel.deny) & (1n << 10n), "read-only and still private");
});
await step("sets up roles in order (create + update)", async () => {
  const r = await call(ad, "discord_admin_setup_roles", {
    roles: [
      { name: "Tech Lead", permissions: ["MANAGE_MESSAGES", "MANAGE_THREADS"], color: "#FF5A1F", hoist: true },
      { name: "Engineer", permissions: ["MANAGE_THREADS"] },
      { name: "Contractor" },
    ],
  });
  assert.deepEqual(r.data.roles.map((x) => x.created), [true, false, true]);
  const pos = (n) => [...mock.roles.values()].find((x) => x.name === n).position;
  assert.ok(pos("Tech Lead") > pos("Engineer") && pos("Engineer") > pos("Contractor"));
});
await step("locks and unlocks a channel without touching other permissions", async () => {
  await call(ad, "discord_admin_set_permissions", { channel_id: "300000", target: "@everyone", allow: ["ATTACH_FILES"] });
  await call(ad, "discord_admin_lockdown", { channel_id: "300000", lock: true });
  let ev = mock.channels.get("300000").permission_overwrites.find((o) => o.id === "100000");
  assert.ok(BigInt(ev.deny) & (1n << 11n));
  assert.ok(BigInt(ev.allow) & (1n << 15n), "attach files kept");
  await call(ad, "discord_admin_lockdown", { channel_id: "300000", lock: false });
  ev = mock.channels.get("300000").permission_overwrites.find((o) => o.id === "100000");
  assert.equal(BigInt(ev.deny) & (1n << 11n), 0n);
});
await step("bulk role for everyone with a role; protected member skipped", async () => {
  mock.members.get("700007").roles.push("610000");
  const r = await call(ad, "discord_admin_bulk_roles", { role: "Contractor", action: "add", members_with_role: "Team" });
  assert.equal(r.data.done, 1);
  assert.equal(r.data.failed.length, 1);
  assert.ok(/protected/.test(r.data.failed[0].error));
});
await step("copies a forum with its tags and settings", async () => {
  const r = await call(ad, "discord_admin_clone_channel", { channel_id: "201000", name: "leads-2027" });
  const c = mock.channels.get(r.data.id);
  assert.equal(c.type, 15);
  assert.equal(c.available_tags.length, 5);
});

console.log("\ncontent, threads, search, monitoring");
await step("sends a message with an embed, then edits it", async () => {
  let r = await call(ad, "discord_send_message", { channel_id: "300000", embed: { title: "Weekly report", description: "All green", color: "#FF5A1F", fields: [{ name: "Leads", value: "4" }] } });
  const mid = r.data.message_ids[0];
  const sent = mock.messages.get("300000").find((x) => x.id === mid);
  assert.ok(sent);
  r = await call(ad, "discord_edit_message", { channel_id: "300000", message_id: mid, content: "Updated" });
  assert.equal(r.data.edited, mid);
  r = await call(ad, "discord_edit_message", { channel_id: "300000", message_id: "800000000000000003", content: "x" });
  assert.ok(r.error);
});
await step("reacts and removes the reaction", async () => {
  await call(ad, "discord_react", { channel_id: "300000", message_id: "800000000000000003", emoji: "✅" });
  await call(ad, "discord_react", { channel_id: "300000", message_id: "800000000000000003", emoji: "✅", remove: true });
  assert.deepEqual(mock.log.filter((e) => e.op.startsWith("reaction")).map((e) => e.op), ["reaction_PUT", "reaction_DELETE"]);
});
await step("starts a thread with a first message and manages it", async () => {
  let r = await call(ad, "discord_create_thread", { channel_id: "300000", name: "Deploy issue", message_id: "800000000000000003", content: "Looking into it" });
  const tid = r.data.thread_id;
  assert.equal(mock.messages.get(tid)[0].content, "Looking into it");
  r = await call(ad, "discord_manage_thread", { thread_id: tid, name: "Deploy issue (fixed)", archived: true, locked: true, add_member_id: "800008" });
  assert.deepEqual(r.data.changed, ["name", "archived", "locked", "add_member"]);
  r = await call(ad, "discord_create_thread", { channel_id: "201000", name: "x" });
  assert.ok(r.error && /forum/.test(r.text));
});
await step("searches by text, author, attachments; and across a category", async () => {
  let r = await call(ad, "discord_search_messages", { channel_id: "300000", text: "deploy" });
  assert.equal(r.data.matches, 1);
  r = await call(ad, "discord_search_messages", { channel_id: "300000", has_attachments: true });
  assert.equal(r.data.results[0].content, "Deploy failed on staging");
  r = await call(ad, "discord_search_messages", { category_id: "210000", author_id: "800008", since_days: 1 });
  assert.equal(r.data.matches, 2);
});
await step("activity report: busy, quiet and forum stats", async () => {
  const r = await call(ad, "discord_activity_report", { days: 7, idle_days: 3 });
  const gen = r.data.channels.find((c) => c.channel === "general");
  assert.ok(gen.messages >= 3 && gen.people >= 1);
  const leads = r.data.forums.find((f) => f.forum === "leads");
  assert.equal(leads.open_posts, 1);
  assert.ok(leads.stale.length === 1 && leads.stale[0].idle_days > 3);
});
await step("list_posts: idle filter and tag counts", async () => {
  const r = await call(ad, "discord_list_posts", { forum_id: "201000", status: "all", min_idle_days: 3 });
  assert.equal(r.data.total, 2);
  assert.equal(r.data.tag_counts["Won"], 1);
});
await step("pins a forum post; pinned posts stay out of the activity report", async () => {
  const r = await call(ad, "discord_create_post", { forum_id: "201000", title: "Template · copy this", content: "Business:", tags: ["New"] });
  const pid = r.data.post_id;
  let m = await call(ad, "discord_manage_thread", { thread_id: pid, pinned: true });
  assert.deepEqual(m.data.changed, ["flags"]);
  assert.equal(mock.channels.get(pid).flags & 2, 2);
  const posts = await call(ad, "discord_list_posts", { forum_id: "201000" });
  assert.equal(posts.data.posts.find((x) => x.id === pid).pinned, true);
  const rep = await call(ad, "discord_activity_report", { days: 7 });
  assert.ok(!rep.data.forums.find((f) => f.forum === "leads").stale.some((x) => x.title.startsWith("Template")));
  m = await call(ad, "discord_manage_thread", { thread_id: "300000", pinned: true });
  assert.ok(m.error);
  await call(ad, "discord_manage_thread", { thread_id: pid, pinned: false, archived: true });
  assert.equal(mock.channels.get(pid).flags & 2, 0);
});
await step("publishes an announcement", async () => {
  const id = mock.messages.get("303000")[0].id;
  await call(ad, "discord_admin_manage_message", { channel_id: "303000", action: "publish", message_id: id });
  assert.ok(mock.log.some((e) => e.op === "crosspost"));
  const r = await call(ad, "discord_admin_manage_message", { channel_id: "300000", action: "publish", message_id: id });
  assert.ok(r.error && /announcement/.test(r.text));
});
await step("purges recent spam by one author; skips protected channels", async () => {
  const before = mock.messages.get("300000").length;
  const r = await call(ad, "discord_admin_purge_messages", { channel_id: "300000", count: 50, contains: "spam" });
  assert.equal(r.data.deleted, 1);
  assert.equal(mock.messages.get("300000").length, before - 1);
  const p = await call(ad, "discord_admin_purge_messages", { channel_id: "401000", count: 10 });
  assert.ok(p.error && /protected/.test(p.text));
});
await step("deletes a webhook", async () => {
  await call(ad, "discord_admin_webhooks", { action: "delete", webhook_id: "900000000000000001" });
  assert.ok(mock.log.some((e) => e.op === "webhook_delete"));
});
await step("delete needs the exact name, then works", async () => {
  let r = await call(ad, "discord_admin_delete_channel", { channel_id: forumId, confirm_name: "Projects" });
  assert.ok(r.error && /exactly "projects"/.test(r.text));
  r = await call(ad, "discord_admin_delete_channel", { channel_id: forumId, confirm_name: "projects" });
  assert.ok(!mock.channels.has(forumId));
  r = await call(ad, "discord_admin_delete_role", { role: "Lead", confirm_name: "Lead" });
  assert.ok(![...mock.roles.values()].some((x) => x.name === "Lead"));
});
await step("refuses to delete a category that still has channels", async () => {
  const r = await call(ad, "discord_admin_delete_channel", { channel_id: "210000", confirm_name: "START" });
  assert.ok(r.error && /still has/.test(r.text));
});
await step("every admin change is in the audit channel", async () => {
  const lines = mock.log.filter((e) => e.op === "send" && e.channel === "500000").map((e) => e.body.content);
  assert.ok(lines.some((l) => l.includes("created forum #projects")));
  assert.ok(lines.some((l) => l.includes("deleted forum #projects")));
});
await ad.close();

console.log("\nswitches off");
const off = new Client({ name: "test", version: "1" });
await off.connect(new StdioClientTransport({
  command: "node", args: ["dist/cli.js"], stderr: "ignore",
  env: { ...adminEnv, DISCORD_ALLOW_DESTRUCTIVE: "false", DISCORD_ALLOW_ADMINISTRATOR_PERMISSION: "false" },
}));
await step("DISCORD_ALLOW_DESTRUCTIVE=false blocks delete, kick and ban", async () => {
  assert.ok(/turned off/.test((await call(off, "discord_admin_delete_channel", { channel_id: "300000", confirm_name: "general" })).text));
  assert.ok(/turned off/.test((await call(off, "discord_admin_moderate_member", { user_id: "800008", action: "ban", reason: "x" })).text));
  assert.ok(/turned off/.test((await call(off, "discord_admin_manage_message", { channel_id: "300000", action: "delete", message_id: "800000000000000003" })).text));
});
await step("DISCORD_ALLOW_ADMINISTRATOR_PERMISSION=false blocks granting it", async () => {
  assert.ok((await call(off, "discord_admin_create_role", { name: "Boss", permissions: ["ADMINISTRATOR"] })).error);
});
await off.close();
const noAdmin = new Client({ name: "test", version: "1" });
await noAdmin.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js"], stderr: "ignore", env: { ...adminEnv, DISCORD_ENABLE_ADMIN: "false" } }));
await step("DISCORD_ENABLE_ADMIN=false hides admin tools", async () => {
  assert.equal((await noAdmin.listTools()).tools.length, 16);
});
await noAdmin.close();

console.log("\nrate limiter");
const { RateLimiter } = await import("../dist/ratelimit.js");
await step("route keys keep channel/guild IDs and group the rest", async () => {
  assert.equal(RateLimiter.route("GET", "/channels/123456/messages/999999?limit=5"), "GET /channels/123456/messages/:id");
  assert.equal(RateLimiter.route("PUT", "/guilds/100000/members/700007/roles/610000"), "PUT /guilds/100000/members/:id/roles/:id");
  assert.equal(RateLimiter.route("DELETE", "/channels/123456/messages/999999"), "DELETE /channels/123456/messages/:id:delete");
});
await step("waits for an empty bucket to reset, and runs a route's calls in order", async () => {
  const rl = new RateLimiter();
  const route = "POST /channels/1/messages";
  rl.update(route, new Headers({ "x-ratelimit-bucket": "b1", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "0.3" }));
  const order = [];
  const t0 = Date.now();
  await Promise.all([1, 2, 3].map((n) => rl.schedule(route, async () => order.push(n))));
  assert.ok(Date.now() - t0 >= 280, "waited for reset");
  assert.deepEqual(order, [1, 2, 3]);
});
await step("a global 429 pauses every route", async () => {
  const rl = new RateLimiter();
  rl.limited("GET /a", new Headers({ "x-ratelimit-global": "true" }), { retry_after: 0.25, global: true });
  const t0 = Date.now();
  await rl.schedule("GET /b", async () => 1);
  assert.ok(Date.now() - t0 >= 230);
});

// ---- HTTP (fresh mock state)
mock.close();
mock = await startMockDiscord();
env.DISCORD_API_BASE = mock.url;
const port = 39000 + Math.floor(Math.random() * 500);
const proc = spawn("node", ["dist/serve.js"], {
  env: { ...env, PORT: String(port), MCP_AUTH_TOKEN: "s3cret-token", MCP_PATH_SECRET: "path-secret-123" },
  stdio: ["ignore", "ignore", "pipe"],
});
await new Promise((r) => proc.stderr.once("data", r));
const base = `http://127.0.0.1:${port}`;

console.log("\nhttp auth");
await step("health check needs no auth", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
await step("setup page: status only, no IDs; browser key generator", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes("New access key") && html.includes("crypto.subtle.digest"));
  assert.ok(!html.includes("100000") && !html.includes("test-token"), "no server ID or token in the page");
  assert.ok(/default-src 'none'/.test(r.headers.get("content-security-policy")));
  const vercelStyle = await fetch(`${base}/api/mcp?page=setup`);
  assert.equal(vercelStyle.status, 200);
});
await step("rejects missing or wrong token", async () => {
  const init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" };
  assert.equal((await fetch(`${base}/mcp`, init)).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { ...init, headers: { ...init.headers, authorization: "Bearer nope" } })).status, 401);
  assert.equal((await fetch(`${base}/mcp/wrong-secret`, init)).status, 401);
});
await step("refuses to start with no auth configured", async () => {
  const p = spawn("node", ["dist/serve.js"], { env: { ...env, PORT: String(port + 1) }, stdio: "ignore" });
  const code = await new Promise((r) => p.on("exit", r));
  assert.equal(code, 1);
});

const http = new Client({ name: "test", version: "1" });
await http.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer s3cret-token" } } }),
);
await suite(http, "http transport (bearer token)");
await http.close();

const viaPath = new Client({ name: "test", version: "1" });
await viaPath.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/path-secret-123`)));
console.log("\nhttp transport (path secret)");
await step("works without headers", async () => {
  const r = await call(viaPath, "discord_server_info");
  assert.equal(r.data.bot, "founderie-bot");
});
await viaPath.close();

console.log("\ncli");
await step("check: setup checklist passes against a healthy server", async () => {
  const out = await new Promise((r) => {
    let o = "";
    const p = spawn("node", ["dist/cli.js", "check"], { env: { ...env, DISCORD_API_BASE: mock.url, DISCORD_AUDIT_CHANNEL_ID: "500000", DISCORD_PROTECTED_IDS: "700007", MCP_KEYS: `me:admin:${"y".repeat(40)}` } });
    p.stdout.on("data", (d) => (o += d));
    p.on("exit", (code) => r({ o, code }));
  });
  assert.equal(out.code, 0, out.o);
  assert.ok(/Bot has Administrator/.test(out.o) && /Message Content Intent/.test(out.o) && /All set/.test(out.o));
});
await step("--version and unknown commands", async () => {
  const v = await new Promise((r) => { let o = ""; const p = spawn("node", ["dist/cli.js", "--version"]); p.stdout.on("data", (d) => (o += d)); p.on("exit", () => r(o.trim())); });
  assert.match(v, /^\d+\.\d+\.\d+$/);
  const code = await new Promise((r) => spawn("node", ["dist/cli.js", "nope"], { stdio: "ignore" }).on("exit", r));
  assert.equal(code, 1);
});
proc.kill();
// ---- named, scoped keys (fresh mock)
console.log("\nnamed keys");
mock.close();
mock = await startMockDiscord();
const { createHash } = await import("node:crypto");
const secret = (n) => `${n}-`.padEnd(40, "x");
const kport = port + 7;
const keysEnv = {
  ...env, DISCORD_API_BASE: mock.url, DISCORD_READ_CHANNELS: "", DISCORD_WRITE_CHANNELS: "", PORT: String(kport),
  MCP_KEYS: [
    `viewer:read:${secret("viewer")}`,
    `arun:member:${secret("arun")}`,
    `lead:manage:sha256:${createHash("sha256").update(secret("lead")).digest("hex")}`,
    `kalki:admin:${secret("kalki")}`,
  ].join(","),
};
const kproc = spawn("node", ["dist/serve.js"], { env: keysEnv, stdio: ["ignore", "ignore", "pipe"] });
await new Promise((r) => kproc.stderr.once("data", r));
const kbase = `http://127.0.0.1:${kport}`;
const as = async (name) => {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${kbase}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret(name)}` } } }));
  return c;
};
const names = async (c) => (await c.listTools()).tools.map((t) => t.name);

const kalki = await as("kalki");
const allTools = (await kalki.listTools()).tools;
await step("admin key sees all 46 tools and is named in server info", async () => {
  assert.equal(allTools.length, 46);
  assert.equal((await call(kalki, "discord_server_info")).data.key, "kalki (admin)");
});
await step("read key: only read tools; writes don't exist for it", async () => {
  const c = await as("viewer");
  const ts = await names(c);
  assert.equal(ts.length, allTools.filter((t) => t.annotations?.readOnlyHint && !t.name.startsWith("discord_admin_")).length);
  assert.ok(ts.includes("discord_activity_report") && !ts.includes("discord_send_message"));
  const r = await call(c, "discord_send_message", { channel_id: "300000", content: "x" });
  assert.ok(r.error);
  await c.close();
});
await step("member key: posts and tags, no admin tools; audit names the key", async () => {
  const c = await as("arun");
  const ts = await names(c);
  assert.ok(!ts.some((t) => t.startsWith("discord_admin_")));
  const r = await call(c, "discord_create_post", { forum_id: "201000", title: "Shop · Launch site · DM", content: "Business: Shop", tags: ["New"] });
  assert.ok(!r.error);
  const audit = mock.log.filter((e) => e.op === "send" && e.channel === "500000").map((e) => e.body.content);
  assert.ok(audit.some((l) => l.startsWith("[arun] created post")));
  await c.close();
});
await step("manage key (stored as a hash): setup yes, deletes/bans/server settings no", async () => {
  const c = await as("lead");
  const ts = await names(c);
  assert.ok(ts.includes("discord_admin_setup_category") && ts.includes("discord_admin_create_role"));
  assert.ok(!ts.includes("discord_admin_delete_channel") && !ts.includes("discord_admin_edit_server") && !ts.includes("discord_admin_purge_messages"));
  let r = await call(c, "discord_admin_create_role", { name: "Intern", reason: "new hire" });
  assert.ok(!r.error);
  assert.ok(mock.reasons.includes("MCP admin (lead): new hire"));
  r = await call(c, "discord_admin_moderate_member", { user_id: "800008", action: "ban", reason: "x" });
  assert.ok(r.error && /turned off/.test(r.text));
  r = await call(c, "discord_admin_create_role", { name: "Boss", permissions: ["ADMINISTRATOR"] });
  assert.ok(r.error);
  r = await call(c, "discord_admin_manage_message", { channel_id: "300000", action: "delete", message_id: "800000000000000003" });
  assert.ok(r.error);
  await c.close();
});
await step("unknown key is refused; path URL works per key", async () => {
  const res = await fetch(`${kbase}/mcp`, { method: "POST", headers: { authorization: `Bearer ${secret("nobody")}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${kbase}/mcp/${secret("viewer")}`)));
  assert.equal((await call(c, "discord_server_info")).data.key, "viewer (read)");
  await c.close();
});
await step("bad key config stops the server at boot", async () => {
  const bad = spawn("node", ["dist/serve.js"], { env: { ...keysEnv, PORT: String(kport + 1), MCP_KEYS: "x:admin:short" }, stdio: "ignore" });
  assert.notEqual(await new Promise((r) => bad.on("exit", r)), 0);
  const bad2 = spawn("node", ["dist/serve.js"], { env: { ...keysEnv, PORT: String(kport + 2), MCP_KEYS: `x:owner:${secret("x")}` }, stdio: "ignore" });
  assert.notEqual(await new Promise((r) => bad2.on("exit", r)), 0);
});
await step("misconfigured MCP_KEYS: clear errors that never echo the secret", async () => {
  const { parseKeys } = await import("../dist/keys.js");
  const bare = "3z6YApcFAsOGJstNC3qnDfZK1XZDDhaXmOT9KMzRV08";
  assert.throws(() => parseKeys({ MCP_KEYS: bare }), (e) => /bare secret/.test(e.message) && !e.message.includes(bare));
  assert.throws(() => parseKeys({ MCP_KEYS: `bad name:admin:${bare}` }), (e) => !e.message.includes(bare));
  assert.throws(() => parseKeys({ MCP_KEYS: `me:owner:${bare}` }), (e) => !e.message.includes(bare) && /unknown scope/.test(e.message));
  assert.equal(parseKeys({ MCP_KEYS: `MCP_KEYS="me:admin:${bare}"` }).length, 1, "tolerates a pasted MCP_KEYS= prefix and quotes");
  const { handleMcpRequest } = await import("../dist/http.js");
  const { createServer } = await import("node:http");
  const saved = process.env.MCP_KEYS;
  process.env.MCP_KEYS = bare;
  const srv = createServer((q, r) => void handleMcpRequest(q, r));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const u = `http://127.0.0.1:${srv.address().port}`;
  const page = await (await fetch(`${u}/`)).text();
  assert.ok(page.includes("Access keys are invalid") && !page.includes(bare));
  const res = await fetch(`${u}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bare}` }, body: "{}" });
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.ok(/bare secret/.test(body) && !body.includes(bare));
  srv.close();
  if (saved === undefined) delete process.env.MCP_KEYS; else process.env.MCP_KEYS = saved;
});
await step("keygen prints a working entry", async () => {
  const out = await new Promise((r) => {
    let o = "";
    const p = spawn("node", ["dist/cli.js", "keygen", "priya", "member"]);
    p.stdout.on("data", (d) => (o += d));
    p.on("exit", () => r(o));
  });
  assert.ok(/priya:member:sha256:[0-9a-f]{64}/.test(out));
});
await kalki.close();
kproc.kill();
mock.close();
console.log(`\n${passed} checks passed`);
