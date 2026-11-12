// `discord-mcp keygen`

import { createHash, randomBytes } from "node:crypto";
import { SCOPES, type Scope } from "./keys.js";

export interface NewKey {
  name: string;
  scope: Scope;
  secret: string;
  entry: string;
}

export function makeKey(name: string, scope: string, hashed = true): NewKey {
  if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(name)) throw new Error("Key name must be 1–40 letters, digits, _ . -");
  if (!SCOPES.includes(scope as Scope)) throw new Error(`Scope must be one of: ${SCOPES.join(", ")}`);
  const secret = randomBytes(32).toString("base64url");
  const stored = hashed ? `sha256:${createHash("sha256").update(secret).digest("hex")}` : secret;
  return { name, scope: scope as Scope, secret, entry: `${name}:${scope}:${stored}` };
}

export function keyInstructions(k: NewKey): string {
  return `
Secret (not stored; share it privately):
  ${k.secret}

MCP_KEYS entry:
  ${k.entry}

Use as "Authorization: Bearer <secret>" or https://<host>/mcp/<secret>.
`;
}
