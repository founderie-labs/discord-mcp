// Page served at "/": configuration status and an in-browser key generator. Shows no IDs.

export interface SetupStatus {
  version: string;
  token: boolean;
  guild: boolean;
  keys: number;
  keyError?: string;
  admin: boolean;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function setupPage(st: SetupStatus): string {
  const row = (ok: boolean, label: string, hint: string) =>
    `<li class="${ok ? "ok" : "no"}"><span>${ok ? "✓" : "–"}</span><div><b>${esc(label)}</b>${ok ? "" : `<small>${hint}</small>`}</div></li>`;
  const ready = st.token && st.guild && st.keys > 0 && !st.keyError;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>discord-mcp</title>
<style>
  :root { --paper:#F4F3EF; --card:#FFFFFF; --ink:#141414; --muted:#5F5E59; --line:#DFDDD6; --accent:#FF5A1F; --ok:#1F7A4D; }
  @media (prefers-color-scheme: dark) { :root { --paper:#141414; --card:#1D1D1C; --ink:#E9E7E1; --muted:#A3A19A; --line:#333331; --ok:#5BC08A; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 48px 16px 64px; }
  h1 { font-weight:500; letter-spacing:-.035em; font-size: clamp(28px, 6vw, 40px); line-height:1.1; margin:12px 0 8px; }
  h2 { font-weight:500; letter-spacing:-.02em; font-size:20px; margin:0 0 12px; }
  p { color: var(--muted); margin: 0 0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:24px; margin-top:20px; }
  ul { list-style:none; padding:0; margin:0; }
  li { display:flex; gap:12px; padding:10px 0; border-top:1px solid var(--line); }
  li:first-child { border-top:0; }
  li span { width:20px; flex:none; font-weight:600; }
  li.ok span { color: var(--ok); } li.no span { color: var(--accent); }
  li small { display:block; color:var(--muted); font-size:14px; }
  label { display:block; font-size:14px; color:var(--muted); margin:12px 0 6px; }
  input, select { width:100%; font:inherit; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink); }
  .row { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
  @media (max-width: 480px) { .row { grid-template-columns: 1fr; } }
  button { margin-top:16px; font:inherit; padding:10px 18px; border-radius:999px; border:0; background:var(--ink); color:var(--paper); cursor:pointer; }
  pre { white-space:pre-wrap; word-break:break-all; background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:12px; font:13px/1.5 ui-monospace, Menlo, monospace; margin:6px 0 0; }
  .out { display:none; } .out.show { display:block; }
  .note { font-size:14px; }
  code { font: 13px ui-monospace, Menlo, monospace; }
</style>
</head>
<body>
<main>
  <h1>discord-mcp</h1>
  <p>v${esc(st.version)}. ${ready ? "Configured. The MCP endpoint is <code>/mcp</code>." : "Not fully configured. Set the missing environment variables and redeploy."}</p>

  <section class="card">
    <h2>Status</h2>
    <ul>
      ${row(st.token, "Bot token", "Set DISCORD_BOT_TOKEN.")}
      ${row(st.guild, "Server ID", "Set DISCORD_GUILD_ID.")}
      ${st.keyError
        ? row(false, "Access keys are invalid", esc(st.keyError))
        : row(st.keys > 0, st.keys > 0 ? `${st.keys} access key${st.keys === 1 ? "" : "s"}` : "Access keys", "Set MCP_KEYS.")}
    </ul>
  </section>

  <section class="card">
    <h2>New access key</h2>
    <p class="note">Generated locally. The server stores only the hash.</p>
    <div class="row">
      <div><label for="n">Name</label><input id="n" value="me" maxlength="40" autocomplete="off"></div>
      <div><label for="s">Scope</label>
        <select id="s">
          <option value="admin">admin</option>
          <option value="manage">manage</option>
          <option value="member">member</option>
          <option value="read">read</option>
        </select></div>
    </div>
    <button id="go" type="button">Generate</button>
    <div class="out" id="out">
      <label>MCP_KEYS entry</label><pre id="entry"></pre>
      <label>Secret (shown once)</label><pre id="secret"></pre>
      <label>URL form</label><pre id="url"></pre>
    </div>
  </section>
  <p class="note" style="margin-top:20px"><a href="https://github.com/founderie-labs/discord-mcp#readme" style="color:inherit">Documentation</a></p>
</main>
<script>
  const b64url = (a) => btoa(String.fromCharCode(...a)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  document.getElementById("go").onclick = async () => {
    const name = document.getElementById("n").value.trim();
    if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(name)) { alert("Name: 1–40 letters, digits, _ . -"); return; }
    const scope = document.getElementById("s").value;
    const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
    const hex = Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("");
    document.getElementById("entry").textContent = name + ":" + scope + ":sha256:" + hex;
    document.getElementById("secret").textContent = secret;
    document.getElementById("url").textContent = location.origin + "/mcp/" + secret;
    document.getElementById("out").classList.add("show");
  };
</script>
</body>
</html>`;
}
