import type { Login } from "./instagram";

export interface Env {
  STATE: KVNamespace;
  IG_LOGIN?: string; // "facebook", "unified" or "instagram" (wrangler.toml [vars])
  META_APP_ID?: string; // Meta app ID, for the Connect Instagram link (wrangler.toml [vars])
  META_CONFIG_ID?: string; // Unified login configuration ID
  META_FB_CONFIG_ID?: string; // optional Facebook Login for Business config for "facebook"; scopes are used otherwise
  IG_ACCOUNT_ID?: string; // your Instagram account ID, used if the token doesn't list it
  IG_APP_SECRET: string; // app secret that signs webhooks (Meta app secret for unified, Instagram app secret otherwise)
  IG_ACCESS_TOKEN?: string; // optional starting token; /connect saves one to KV instead
  VERIFY_TOKEN: string; // any string you pick; typed into Meta's webhook settings too
}

export const TOKEN_KEY = "token";

export function loginOf(env: Env): Login {
  if (env.IG_LOGIN === "instagram" || env.IG_LOGIN === "facebook") return env.IG_LOGIN;
  return "unified";
}

export async function getToken(env: Env): Promise<string> {
  const token = (await env.STATE.get(TOKEN_KEY)) ?? env.IG_ACCESS_TOKEN;
  if (!token) throw new Error("No access token yet. Open /connect?key=<VERIFY_TOKEN> first.");
  return token;
}

export function errorDetail(err: unknown): { error: string; detail: string } {
  const detail = err && typeof err === "object" && "body" in err ? String((err as { body: unknown }).body) : "";
  return { error: err instanceof Error ? err.message : String(err), detail };
}
