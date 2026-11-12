# Security

Report vulnerabilities through GitHub's private vulnerability reporting on this repository, not in public issues.

When running the server:

- Keep `DISCORD_BOT_TOKEN` in your host's secret store. Reset it in the Developer Portal if it leaks.
- Store keys as `sha256:` entries.
- Prefer the `Authorization` header to `/mcp/<secret>` URLs, which can end up in logs.
- Set `DISCORD_PROTECTED_IDS` to your own user ID and top role.
- Use `read` or `member` keys for unattended jobs.
