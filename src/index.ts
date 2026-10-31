import { RULES } from "./rules";
import { findRule, pickReply } from "./match";
import { parseComments, verifySignature, type Comment } from "./webhook";
import { refreshToken, replyToComment, sendPrivateReply } from "./instagram";
import { TOKEN_KEY, errorDetail, getToken, loginOf, type Env } from "./env";
import { callback, connect, setup } from "./admin";
import { commitCounts, recentComments } from "./catchup";

export type { Env } from "./env";

const DONE_TTL = 8 * 24 * 60 * 60; // a bit longer than Meta's 7-day reply window

const PRIVACY = `<!doctype html><meta name="viewport" content="width=device-width"><title>Privacy</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.5">
<h1>Privacy policy</h1>
<p>This bot reads comments on our own Instagram posts. When a comment contains a keyword, it sends the commenter one direct message and may reply to the comment.</p>
<p>It stores only the comment ID, for up to 8 days, so it never messages anyone twice. It does not store names, messages or any other personal data, and shares nothing with third parties.</p>
<p>To ask about your data, message us on Instagram.</p></body>`;

export async function handleComment(c: Comment, env: Env): Promise<"skipped" | "sent" | "duplicate"> {
  if (c.fromId === c.accountId) return "skipped"; // our own replies
  const rule = findRule(c.text, c.mediaId, RULES);
  if (!rule) return "skipped";

  // Meta retries webhooks, so remember which comments we already answered.
  const doneKey = `done:${c.commentId}`;
  if (await env.STATE.get(doneKey)) return "duplicate";
  await env.STATE.put(doneKey, "1", { expirationTtl: DONE_TTL });

  const token = await getToken(env);
  try {
    await sendPrivateReply(loginOf(env), c.accountId, c.commentId, rule.dm, token);
  } catch (err) {
    await env.STATE.delete(doneKey); // let a later webhook or catch-up run try again
    throw err;
  }

  const reply = pickReply(rule.publicReplies);
  if (reply) {
    try {
      await replyToComment(loginOf(env), c.commentId, reply, token);
    } catch (err) {
      // The DM already went out; a failed public reply isn't worth failing over.
      console.error("public reply failed", c.commentId, err instanceof Error ? err.message : err);
    }
  }
  return "sent";
}

// Returns the posts where a reply failed, so catch-up can retry them.
async function processAll(comments: Comment[], env: Env): Promise<Set<string>> {
  const failed = new Set<string>();
  for (const c of comments) {
    try {
      const result = await handleComment(c, env);
      console.log("comment", c.commentId, result, JSON.stringify(c.text.slice(0, 60)));
    } catch (err) {
      if (c.mediaId) failed.add(c.mediaId);
      const { error, detail } = errorDetail(err);
      console.error("comment failed", c.commentId, error, detail);
    }
  }
  return failed;
}

async function catchUp(env: Env): Promise<number> {
  const found = await recentComments(env, Date.now());
  await commitCounts(env, await processAll(found, env));
  return found.length;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // Meta asks for a privacy policy URL before an app can go Live.
    if (url.pathname === "/privacy") {
      return new Response(PRIVACY, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/setup" && url.searchParams.get("catchup") === "1" && url.searchParams.get("key") === env.VERIFY_TOKEN) {
      return Response.json({ ok: true, checked: await catchUp(env) });
    }
    if (url.pathname === "/setup") return setup(url, env);
    if (url.pathname === "/connect") return connect(url, env);
    if (url.pathname === "/callback") return callback(url, env);
    if (url.pathname !== "/webhook") {
      return new Response("openchat is running", { status: url.pathname === "/" ? 200 : 404 });
    }

    // Meta checks the endpoint once when you save the webhook settings.
    if (req.method === "GET") {
      const ok =
        url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === env.VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
    }

    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    if (!env.IG_APP_SECRET) return new Response("IG_APP_SECRET is not set", { status: 503 });
    const raw = await req.text();
    if (!(await verifySignature(raw, req.headers.get("X-Hub-Signature-256"), env.IG_APP_SECRET))) {
      console.warn("webhook rejected: bad signature");
      return new Response("Bad signature", { status: 401 });
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    console.log("webhook received", parseComments(body).length, "comment(s)");
    // Answer Meta right away and do the API calls in the background.
    ctx.waitUntil(processAll(parseComments(body), env));
    return new Response("OK");
  },

  // Crons in wrangler.toml: every few minutes, catch comments Meta didn't deliver;
  // on Mondays, refresh the 60-day token (only the "instagram" setup needs that).
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === "0 3 * * 1") {
      if (loginOf(env) !== "instagram") return;
      const fresh = await refreshToken(await getToken(env));
      await env.STATE.put(TOKEN_KEY, fresh);
      return;
    }
    try {
      await catchUp(env);
    } catch (err) {
      const { error, detail } = errorDetail(err);
      console.error("catch-up failed", error, detail);
    }
  },
} satisfies ExportedHandler<Env>;
