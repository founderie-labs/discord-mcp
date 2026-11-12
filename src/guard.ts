// Channel allowlists, read-only mode, mention policy and the audit channel.

import type { Config } from "./config.js";
import { Discord, type Channel } from "./discord.js";

export class AccessError extends Error {}

export type Mode = "read" | "write";

export class Guard {
  constructor(private cfg: Config, private dc: Discord) {}

  /** Returns the channel if access is allowed, otherwise throws AccessError. */
  async check(channelId: string, mode: Mode): Promise<Channel> {
    if (!/^\d{5,25}$/.test(channelId)) throw new AccessError(`"${channelId}" is not a Discord ID.`);
    if (mode === "write" && this.cfg.readOnly) {
      throw new AccessError("This server is running in read-only mode (DISCORD_READ_ONLY=true).");
    }

    const ch = await this.dc.channel(channelId);
    if (ch.guild_id && ch.guild_id !== this.cfg.guildId) {
      throw new AccessError("That channel belongs to a different Discord server.");
    }

    const chain = await this.ancestry(ch);
    // An empty list means "no restriction".
    const inList = (list: Set<string>) => list.size === 0 || chain.some((id) => list.has(id));

    if (!inList(this.cfg.readIds)) {
      throw new AccessError(
        `Channel ${this.label(ch)} is not in DISCORD_READ_CHANNELS, so this server can't access it.`,
      );
    }
    if (mode === "write" && !inList(this.cfg.writeIds)) {
      throw new AccessError(
        `Channel ${this.label(ch)} is readable but not in DISCORD_WRITE_CHANNELS, so this server can't post there.`,
      );
    }
    return ch;
  }

  /** Synchronous check against a pre-fetched channel map (used when listing). */
  allowedFromMap(ch: Channel, byId: Map<string, Channel>, mode: Mode): boolean {
    const list = mode === "write" ? this.cfg.writeIds : this.cfg.readIds;
    if (list.size === 0) return mode === "write" ? this.allowedFromMap(ch, byId, "read") : true;
    let cur: Channel | undefined = ch;
    for (let depth = 0; cur && depth < 4; depth++) {
      if (list.has(cur.id)) return mode === "write" ? this.allowedFromMap(ch, byId, "read") : true;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return false;
  }

  canWrite(ch: Channel, byId: Map<string, Channel>) {
    return !this.cfg.readOnly && this.allowedFromMap(ch, byId, "write");
  }

  /** The channel, its parent (forum or category) and grandparent (category). */
  private async ancestry(ch: Channel): Promise<string[]> {
    const chain = [ch.id];
    let cur = ch;
    for (let depth = 0; cur.parent_id && depth < 3; depth++) {
      chain.push(cur.parent_id);
      try {
        cur = await this.dc.channel(cur.parent_id);
      } catch {
        break;
      }
    }
    return chain;
  }

  private label(ch: Channel) {
    return ch.name ? `#${ch.name} (${ch.id})` : ch.id;
  }

  /** allowed_mentions block attached to everything the server posts. */
  allowedMentions() {
    return { parse: this.cfg.allowUserMentions ? ["users"] : [] };
  }

  /** Best-effort audit line; a failure here never fails the tool call. */
  async audit(line: string) {
    if (!this.cfg.auditChannelId) return;
    try {
      const who = this.cfg.actor ? `[${this.cfg.actor.name}] ` : "";
      await this.dc.send(this.cfg.auditChannelId, {
        content: (who + line).slice(0, 1900),
        allowed_mentions: { parse: [] },
      });
    } catch (err) {
      console.error("[discord-mcp] audit log failed:", (err as Error).message);
    }
  }

  link(channelId: string, messageId?: string) {
    return `https://discord.com/channels/${this.cfg.guildId}/${channelId}${messageId ? `/${messageId}` : ""}`;
  }
}

/** Split long text into Discord-sized chunks (2,000 chars), preferring line breaks. */
export function chunk(text: string, size = 2000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length) out.push(rest);
  return out;
}
