// One-time setup pages, all locked behind ?key=<VERIFY_TOKEN>:
//   /connect   sends you to Meta to pick your Instagram account; Meta returns to /callback
//   /callback  swaps Meta's code for a token, saves it, turns on comment webhooks
//   /setup     turns on comment webhooks again (add &debug=1 to see what the token can see)

import { listAccounts, subscribeComments, type Login } from "./instagram";
import { TOKEN_KEY, errorDetail, getToken, loginOf, type Env } from "./env";

const FB = "https://graph.facebook.com/v26.0";

// Permissions asked for in the "facebook" setup (Instagram linked to a Facebook Page).
const FB_SCOPES = [
  "instagram_basic",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "business_management",
].join(",");

function allowed(key: string | null, env: Env): boolean {
  return Boolean(env.VERIFY_TOKEN) && key === env.VERIFY_TOKEN;
}

function callbackUrl(url: URL): string {
  return `${url.origin}/callback`;
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.5">${body}</body>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export async function subscribeAll(env: Env): Promise<{ account: string; subscribed: unknown }[]> {
  const login = loginOf(env);
  const token = await getToken(env);
  const listed = await listAccounts(login, token);
  const accounts = listed.length === 0 && env.IG_ACCOUNT_ID ? [{ id: env.IG_ACCOUNT_ID }] : listed;
  const results = [];
  for (const a of accounts) {
    try {
      results.push({ account: a.username ?? a.id, subscribed: await subscribeComments(login, a.id, token) });
    } catch (err) {
      results.push({ account: a.username ?? a.id, subscribed: errorDetail(err) });
    }
  }
  return results;
}

async function whoami(login: Login, token: string): Promise<Record<string, unknown>> {
  const probes: Record<string, string> =
    login === "facebook"
      ? {
          page: `${FB}/me?fields=id,name,instagram_business_account{id,username}`,
          page_subscriptions: `${FB}/me/subscribed_apps`,
        }
      : {
          me: `${FB}/me?fields=id,name,client_business_id`,
          permissions: `${FB}/me/permissions`,
          instagram_accounts: `${FB}/me/assigned_instagram_accounts?fields=id,username`,
        };
  const out: Record<string, unknown> = {};
  for (const [name, u] of Object.entries(probes)) {
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    out[name] = { status: res.status, body: (await res.text()).slice(0, 400) };
  }
  return out;
}

export async function setup(url: URL, env: Env): Promise<Response> {
  if (!allowed(url.searchParams.get("key"), env)) return new Response("Forbidden", { status: 403 });
  try {
    if (url.searchParams.get("debug") === "1") return Response.json(await whoami(loginOf(env), await getToken(env)));
    return Response.json({ ok: true, login: loginOf(env), accounts: await subscribeAll(env) });
  } catch (err) {
    return Response.json({ ok: false, ...errorDetail(err) }, { status: 500 });
  }
}

export function connect(url: URL, env: Env): Response {
  if (!allowed(url.searchParams.get("key"), env)) return new Response("Forbidden", { status: 403 });
  const facebook = loginOf(env) === "facebook";
  const configId = facebook ? env.META_FB_CONFIG_ID : env.META_CONFIG_ID;
  if (!env.META_APP_ID || (!facebook && !configId)) {
    return new Response("Set META_APP_ID and META_CONFIG_ID in wrangler.toml first", { status: 503 });
  }
  const dialog = new URL("https://www.facebook.com/dialog/oauth");
  dialog.searchParams.set("client_id", env.META_APP_ID);
  if (configId) dialog.searchParams.set("config_id", configId);
  else dialog.searchParams.set("scope", FB_SCOPES);
  dialog.searchParams.set("redirect_uri", callbackUrl(url));
  dialog.searchParams.set("response_type", "code");
  dialog.searchParams.set("state", env.VERIFY_TOKEN);
  return Response.redirect(dialog.toString(), 302);
}

async function exchangeToken(env: Env, params: Record<string, string>): Promise<string> {
  const exchange = new URL(`${FB}/oauth/access_token`);
  exchange.searchParams.set("client_id", env.META_APP_ID ?? "");
  exchange.searchParams.set("client_secret", env.IG_APP_SECRET);
  for (const [k, v] of Object.entries(params)) exchange.searchParams.set(k, v);
  const res = await fetch(exchange);
  const json = (await res.json()) as { access_token?: string; error?: { message?: string } };
  if (!res.ok || !json.access_token) throw new Error(json.error?.message ?? `Token exchange failed (${res.status})`);
  return json.access_token;
}

interface PageInfo {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string };
}

// "facebook" setup: turn the short user token into a long-lived one, then take the token of the
// Page linked to your Instagram. A Page token made from a long-lived user token doesn't expire.
async function pageTokenFor(env: Env, userToken: string): Promise<string> {
  const longLived = await exchangeToken(env, { grant_type: "fb_exchange_token", fb_exchange_token: userToken });
  const res = await fetch(`${FB}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}`, {
    headers: { Authorization: `Bearer ${longLived}` },
  });
  const json = (await res.json()) as { data?: PageInfo[]; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Could not list Pages (${res.status})`);
  const linked = (json.data ?? []).filter((p) => p.instagram_business_account && p.access_token);
  const page = linked.find((p) => p.instagram_business_account?.id === env.IG_ACCOUNT_ID) ?? linked[0];
  if (!page?.access_token) {
    throw new Error("No Facebook Page with a linked Instagram account was shared. Run /connect again and tick your Page.");
  }
  return page.access_token;
}

export async function callback(url: URL, env: Env): Promise<Response> {
  if (!allowed(url.searchParams.get("state"), env)) return page("Error", "<h1>Link expired</h1><p>Start again from /connect.</p>", 403);
  const code = url.searchParams.get("code");
  if (!code) {
    const reason = escapeHtml(url.searchParams.get("error_description") ?? "No code returned");
    return page("Cancelled", `<h1>Not connected</h1><p>${reason}</p>`, 400);
  }
  try {
    const token = await exchangeToken(env, {
      redirect_uri: callbackUrl(url),
      code,
    });
    await env.STATE.put(TOKEN_KEY, loginOf(env) === "facebook" ? await pageTokenFor(env, token) : token);

    const accounts = await subscribeAll(env);
    if (accounts.length === 0) {
      return page("Almost", `<h1>Token saved, but no Instagram account was shared</h1><p>Run /connect again and tick your Instagram account.</p>`);
    }
    const rows = accounts
      .map((a) => {
        const failed = a.subscribed && typeof a.subscribed === "object" && "error" in a.subscribed;
        const note = failed ? ` ⚠️ alerts not switched on: <code>${escapeHtml(JSON.stringify(a.subscribed))}</code>` : " ✅";
        return `<li>@${escapeHtml(a.account)}${note}</li>`;
      })
      .join("");
    return page("Connected", `<h1>Connected</h1><ul>${rows}</ul>`);
  } catch (err) {
    const { error, detail } = errorDetail(err);
    return page("Error", `<h1>Something went wrong</h1><p>${escapeHtml(error)}</p><pre>${escapeHtml(detail)}</pre>`, 500);
  }
}
