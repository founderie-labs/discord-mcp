// Named, scoped access keys from MCP_KEYS: name:scope:secret or name:scope:sha256:<hex>.
// Scopes: read < member < manage < admin. A key can only narrow the server's configuration.

import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";

export const SCOPES = ["read", "member", "manage", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

export interface Key {
  name: string;
  scope: Scope;
  /** SHA-256 of each accepted secret. Plain secrets aren't kept after parsing. */
  hashes: Buffer[];
}

export interface Actor {
  name: string;
  scope: Scope;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function parseKeys(env = process.env): Key[] {
  const keys: Key[] = [];
  // Error messages never include secrets or unvalidated text, since they end up in logs.
  const add = (name: string, scope: string, secretOrHash: string, where: string, legacy = false) => {
    if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(name)) throw new Error(`${where}: key name must be 1–40 letters, digits, _ . -`);
    if (!SCOPES.includes(scope as Scope)) throw new Error(`${where}: key "${name}" has an unknown scope (use ${SCOPES.join(", ")})`);
    let hash: Buffer;
    if (secretOrHash.startsWith("sha256:")) {
      const hex = secretOrHash.slice(7);
      if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${where}: key "${name}" has a malformed sha256 hash`);
      hash = Buffer.from(hex, "hex");
    } else {
      if (!legacy && secretOrHash.length < 32) {
        throw new Error(`${where}: key "${name}" secret is too short (32+ characters; generate one with discord-mcp keygen)`);
      }
      hash = sha(secretOrHash);
    }
    const existing = keys.find((k) => k.name === name);
    if (existing && !legacy) throw new Error(`${where}: key name "${name}" is used twice`);
    if (existing) existing.hashes.push(hash);
    else keys.push({ name, scope: scope as Scope, hashes: [hash] });
  };

  const value = (env.MCP_KEYS ?? "").trim().replace(/^MCP_KEYS=/, "");
  value.split(/[,\n]/).forEach((raw, i) => {
    const entry = raw.trim().replace(/^["']|["']$/g, "");
    if (!entry || entry.startsWith("#")) return;
    const where = `MCP_KEYS entry ${i + 1}`;
    const [name, scope, ...rest] = entry.split(":");
    if (!rest.length) {
      throw new Error(
        /^[A-Za-z0-9_-]{32,}$/.test(entry)
          ? `${where} looks like a bare secret. Use the "MCP_KEYS entry" line (name:scope:sha256:...), not the secret.`
          : `${where} must look like name:scope:secret or name:scope:sha256:<hex>`,
      );
    }
    add(name, scope, rest.join(":"), where);
  });
  // Older single-key settings: both become secrets of one admin key called "default".
  if (env.MCP_AUTH_TOKEN) add("default", "admin", env.MCP_AUTH_TOKEN, "MCP_AUTH_TOKEN", true);
  if (env.MCP_PATH_SECRET) add("default", "admin", env.MCP_PATH_SECRET, "MCP_PATH_SECRET", true);
  return keys;
}

/** Find the key for a presented secret. Checks every key so timing doesn't reveal which matched. */
export function matchKey(keys: Key[], presented: string | undefined): Key | undefined {
  if (!presented) return undefined;
  const h = sha(presented);
  let found: Key | undefined;
  for (const k of keys) for (const kh of k.hashes) if (timingSafeEqual(kh, h) && !found) found = k;
  return found;
}

const rank = (s: Scope) => SCOPES.indexOf(s);

/** Tools hidden from "manage" even though they live in the admin set. */
const ADMIN_ONLY = new Set([
  "discord_admin_edit_server",
  "discord_admin_delete_channel",
  "discord_admin_delete_role",
  "discord_admin_purge_messages",
]);

/** Apply a key's scope on top of the server's own switches (a key can only narrow, never widen). */
export function scopedConfig(cfg: Config, actor: Actor): Config {
  const c: Config = { ...cfg, actor, admin: { ...cfg.admin } };
  if (rank(actor.scope) < rank("admin")) {
    c.admin.allowDestructive = false;
    c.admin.allowAdministratorPermission = false;
  }
  if (rank(actor.scope) < rank("manage")) c.admin.enabled = false;
  if (actor.scope === "read") c.readOnly = true;
  return c;
}

/** Which tools a scope may see. */
export function toolAllowed(scope: Scope, name: string, annotations?: { readOnlyHint?: boolean }): boolean {
  if (scope === "read") return annotations?.readOnlyHint === true;
  if (scope === "manage") return !ADMIN_ONLY.has(name);
  return true;
}
