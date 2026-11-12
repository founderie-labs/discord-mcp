# discord-mcp

[![npm](https://img.shields.io/npm/v/@founderie-labs/discord-mcp)](https://www.npmjs.com/package/@founderie-labs/discord-mcp)
[![CI](https://github.com/founderie-labs/discord-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/founderie-labs/discord-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server for administering one Discord server: channels, forums, roles, members, moderation, messages and audit logs. It runs over stdio or Streamable HTTP and works with any MCP client.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ffounderie-labs%2Fdiscord-mcp&project-name=discord-mcp&repository-name=discord-mcp&env=DISCORD_BOT_TOKEN,DISCORD_GUILD_ID&envDescription=Your%20Discord%20bot%20token%20and%20server%20ID.%20Access%20keys%20are%20made%20on%20the%20deployed%20site%20afterwards.&envLink=https%3A%2F%2Fgithub.com%2Ffounderie-labs%2Fdiscord-mcp%23create-the-bot)

## Create the bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application.
2. On the Bot tab:
   - reset the token and copy it (`DISCORD_BOT_TOKEN`)
   - turn off Public Bot
   - turn on Server Members Intent and Message Content Intent
3. Under Installation, choose scope `bot` with the Administrator permission, then add the bot to your server with the generated link.
4. In Server Settings → Roles, move the bot's role near the top. Discord only lets a bot manage roles below its own.

To copy IDs, turn on Developer Mode (Settings → Advanced) and right-click a server, channel, role or user.

## Run it

### Vercel

1. Use the button above and enter `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`.
2. Open the deployed site. Its home page shows what is configured and generates access keys in the browser.
3. Add the key entry to the `MCP_KEYS` environment variable and redeploy.
4. Point your MCP client at `https://<project>.vercel.app/mcp`.

The Vercel Hobby plan is for non-commercial use only ([fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines)).

### Local (stdio)

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "@founderie-labs/discord-mcp"],
      "env": {
        "DISCORD_BOT_TOKEN": "...",
        "DISCORD_GUILD_ID": "..."
      }
    }
  }
}
```

Local use has admin scope unless you set `MCP_STDIO_SCOPE`.

### Docker

```bash
cp .env.example .env
docker run -d -p 3000:3000 --env-file .env --read-only ghcr.io/founderie-labs/discord-mcp:latest
```

A `docker-compose.yml` is included. Put a TLS proxy in front.

### Any Node host

```bash
npx -y @founderie-labs/discord-mcp keygen me admin
HOST=0.0.0.0 npx -y @founderie-labs/discord-mcp serve
```

### Check the setup

```bash
npx -y @founderie-labs/discord-mcp check
```

This verifies the token, server, intents, bot permissions, role position, audit channel and keys.

## Connecting

The HTTP endpoint is `POST /mcp`. Authenticate with `Authorization: Bearer <secret>`, or use `/mcp/<secret>` for clients that only accept a URL. `GET /` is the setup page and `GET /health` returns status; neither exposes IDs.

## Keys

`MCP_KEYS` is a comma-separated list of `name:scope:secret` or `name:scope:sha256:<hex>` entries. `discord-mcp keygen <name> <scope>` prints a secret and its hashed entry. Remove an entry and redeploy to revoke it.

| Scope | Access |
|---|---|
| `read` | Read channels, messages and posts; search; activity report |
| `member` | `read`, plus posting, reactions, threads, forum posts and tags |
| `manage` | `member`, plus channel, role, permission and member management. No deletes, purges, kicks, bans, server settings or Administrator grants |
| `admin` | Everything the server configuration allows |

The audit channel and Discord's audit log record which key made each change. `MCP_AUTH_TOKEN` and `MCP_PATH_SECRET` from older versions act as an admin key named `default`.

## Tools

Tags, roles, channels and permissions can be given by name. Unknown names return the valid options.

**Read**

| Tool | Description |
|---|---|
| `discord_server_info` | Bot, server and enabled features |
| `discord_list_channels` | Channels by category, with forum tags and write access |
| `discord_read_messages` | Messages in a channel, thread or post |
| `discord_search_messages` | Search by text, author, attachments or date in a channel or category |
| `discord_activity_report` | Messages and people per channel, quiet channels, forum posts per tag, stale posts |
| `discord_list_posts` | Forum posts filtered by tag, title, status or idle time, with tag counts |
| `discord_get_post` | A forum post and its messages |
| `discord_list_forum_tags` | Tags in a forum |
| `discord_admin_overview` | All categories, channels, visibility and roles |
| `discord_admin_get_channel` | Channel settings and permission overrides |
| `discord_admin_get_server` | Server settings and counts |
| `discord_admin_list_members` | Members, by name or role |
| `discord_admin_get_member` | Roles, join date, timeout status |
| `discord_admin_bans` | Ban list, or one user's ban |
| `discord_admin_audit_log` | Discord audit log, by user or action |

**Write**

| Tool | Description |
|---|---|
| `discord_send_message` | Send a message or reply, optionally with an embed |
| `discord_edit_message` | Edit a message the bot sent |
| `discord_react` | Add or remove a reaction |
| `discord_create_post` | Create a forum post with tags |
| `discord_set_post_tags` | Add or remove post tags |
| `discord_set_post_status` | Close or reopen a post |
| `discord_create_thread` | Start a thread |
| `discord_manage_thread` | Rename, archive, lock, slowmode, members |

**Admin**

| Tool | Description |
|---|---|
| `discord_admin_setup_category` | Create a category and its channels in one call |
| `discord_admin_setup_roles` | Create or update several roles and set their order |
| `discord_admin_create_channel` | Create a channel, optionally private |
| `discord_admin_edit_channel` | Name, category, position, topic, forum tags and settings, slowmode |
| `discord_admin_clone_channel` | Copy a channel's settings to a new channel |
| `discord_admin_reorder` | Order roles, or channels in a category |
| `discord_admin_set_permissions` | Channel permission overrides for a role or member |
| `discord_admin_lockdown` | Make a channel or category read-only for `@everyone`, or undo it |
| `discord_admin_edit_server` | Server name, icon, verification, notifications, special channels |
| `discord_admin_create_role`, `discord_admin_edit_role` | Roles and their permissions |
| `discord_admin_delete_channel`, `discord_admin_delete_role` | Delete; requires the exact name |
| `discord_admin_set_member_roles` | Change one member's roles |
| `discord_admin_bulk_roles` | Add or remove a role for many members |
| `discord_admin_moderate_member` | Timeout, nickname, kick, ban, unban |
| `discord_admin_manage_message` | Pin, unpin, list pins, publish, delete |
| `discord_admin_purge_messages` | Bulk delete recent messages with filters |
| `discord_admin_automod` | AutoMod rules |
| `discord_admin_events` | Scheduled events |
| `discord_admin_create_invite`, `discord_admin_invites` | Create, list and revoke invites |
| `discord_admin_webhooks` | List, create and delete webhooks |

## Safeguards

- Changes are logged to `DISCORD_AUDIT_CHANNEL_ID` and tagged in Discord's audit log.
- IDs in `DISCORD_PROTECTED_IDS` can't be changed by admin tools. The audit channel is always protected.
- Deleting a channel or role requires its exact name. Categories must be empty first.
- Messages never ping `@everyone`, `@here` or roles.
- Kicks and bans require a reason.
- Requests follow Discord's per-route rate limits.
- Destructive tools carry `destructiveHint` so clients can ask for confirmation.
- The HTTP server won't start without a valid key.

Message content is written by server members, so treat it as untrusted. Use `read` or `member` keys for unattended jobs.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | required | Bot token |
| `DISCORD_GUILD_ID` | required | Server ID |
| `MCP_KEYS` | required for HTTP | Access keys |
| `DISCORD_AUDIT_CHANNEL_ID` | | Channel for the change log |
| `DISCORD_PROTECTED_IDS` | | IDs admin tools can't change |
| `DISCORD_READ_CHANNELS` | all | Channel, forum or category IDs readable by the read and write tools |
| `DISCORD_WRITE_CHANNELS` | all | Channel, forum or category IDs writable by the write tools |
| `DISCORD_ENABLE_ADMIN` | `true` | Admin tools |
| `DISCORD_ALLOW_DESTRUCTIVE` | `true` | Deletes, purges, kicks and bans |
| `DISCORD_ALLOW_ADMINISTRATOR_PERMISSION` | `true` | Granting Administrator |
| `DISCORD_READ_ONLY` | `false` | Block all writes |
| `DISCORD_ALLOW_USER_MENTIONS` | `false` | Allow user pings |
| `MCP_STDIO_SCOPE` | `admin` | Scope for stdio |
| `PORT`, `HOST` | `3000`, `127.0.0.1` | HTTP server address |

## Development

```bash
npm install
npm test
```

Tests run against a mock Discord API and need no token.

To release, bump the version in `package.json`, update `CHANGELOG.md` and push a `v*` tag. The release workflow publishes to npm and GHCR and updates the MCP Registry entry. It requires an `NPM_TOKEN` secret.

## Limitations

- The server only acts when called. It doesn't listen for Discord events.
- Search reads up to 2,000 recent messages per channel, since Discord's search API isn't available to bots.
- Discord allows 5 tags per post, 20 per forum, and timeouts up to 28 days.

## License

MIT
