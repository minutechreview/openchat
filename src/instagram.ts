// Calls to the Instagram API.
//
// Two setups exist in Meta's dashboard:
//   "instagram" = API setup with Instagram login  -> graph.instagram.com
//   "unified"   = API setup with Unified login    -> graph.facebook.com (needs a business portfolio)
//   "facebook"  = API setup with Facebook login   -> graph.facebook.com (Instagram linked to a Facebook Page;
//                 the saved token is the Page token)

export type Login = "instagram" | "unified" | "facebook";

const VERSION = "v26.0";

export function apiBase(login: Login): string {
  return login === "instagram" ? `https://graph.instagram.com/${VERSION}` : `https://graph.facebook.com/${VERSION}`;
}

export class InstagramError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

async function call(url: string, init: RequestInit, token: string): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = await res.text();
  if (!res.ok) throw new InstagramError(`Instagram API ${res.status}`, res.status, body);
  return body ? JSON.parse(body) : {};
}

// A plain GET that returns parsed JSON (throws InstagramError on failure).
export function getJson(url: string, token: string): Promise<unknown> {
  return call(url, { method: "GET" }, token);
}

// One private DM to the person who left the comment (Meta allows one per comment, within 7 days).
export function sendPrivateReply(login: Login, accountId: string, commentId: string, text: string, token: string) {
  // With a Page token ("facebook"), DMs go through the Page's own messages edge; the
  // Instagram-account edge answers "App is not connected to the business" (subcode 2534039).
  const sender = login === "facebook" ? "me" : accountId;
  return call(
    `${apiBase(login)}/${sender}/messages`,
    { method: "POST", body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }) },
    token,
  );
}

// A public reply under the comment, e.g. "Sent to your DMs".
export function replyToComment(login: Login, commentId: string, message: string, token: string) {
  return call(`${apiBase(login)}/${commentId}/replies`, { method: "POST", body: JSON.stringify({ message }) }, token);
}

// The Instagram accounts this token can act for.
export async function listAccounts(login: Login, token: string): Promise<{ id: string; username?: string }[]> {
  if (login === "facebook") {
    // With a Page token, /me is the Page; its linked Instagram account is the one we act for.
    const page = (await call(`${apiBase(login)}/me?fields=instagram_business_account{id,username}`, { method: "GET" }, token)) as {
      instagram_business_account?: { id: string; username?: string };
    };
    return page.instagram_business_account ? [page.instagram_business_account] : [];
  }
  const path = login === "unified" ? "me/assigned_instagram_accounts?fields=id,username" : "me?fields=user_id,username";
  const json = (await call(`${apiBase(login)}/${path}`, { method: "GET" }, token)) as {
    data?: { id: string; username?: string }[];
    user_id?: string;
    username?: string;
  };
  if (json.data) return json.data;
  return json.user_id ? [{ id: json.user_id, username: json.username }] : [];
}

// Turns on comment webhooks for one Instagram account.
export function subscribeComments(login: Login, accountId: string, token: string) {
  if (login === "facebook") {
    // Instagram comment webhooks flow through the linked Page's app subscription.
    return call(`${apiBase(login)}/me/subscribed_apps?subscribed_fields=feed`, { method: "POST" }, token);
  }
  return call(`${apiBase(login)}/${accountId}/subscribed_apps?subscribed_fields=comments`, { method: "POST" }, token);
}

// Instagram-login tokens last 60 days; refreshing gives another 60.
// (Unified-login tokens are managed by Meta and are not refreshed here.)
export async function refreshToken(token: string): Promise<string> {
  const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) throw new InstagramError(`Token refresh ${res.status}`, res.status, body);
  const json = JSON.parse(body) as { access_token?: string };
  if (!json.access_token) throw new InstagramError("Token refresh returned no token", res.status, "");
  return json.access_token;
}
