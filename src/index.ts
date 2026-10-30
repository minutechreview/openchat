import { RULES } from "./rules";
import { findRule, pickReply } from "./match";
import { parseComments, verifySignature, type Comment } from "./webhook";
import { refreshToken, replyToComment, sendPrivateReply } from "./instagram";
import { TOKEN_KEY, errorDetail, getToken, loginOf, type Env } from "./env";
import { callback, connect, setup } from "./admin";

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
  await sendPrivateReply(loginOf(env), c.accountId, c.commentId, rule.dm, token);

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

async function processBody(body: unknown, env: Env): Promise<void> {
  for (const c of parseComments(body)) {
    try {
      await handleComment(c, env);
    } catch (err) {
      const { error, detail } = errorDetail(err);
      console.error("comment failed", c.commentId, error, detail);
    }
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // Meta asks for a privacy policy URL before an app can go Live.
    if (url.pathname === "/privacy") {
      return new Response(PRIVACY, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
    ctx.waitUntil(processBody(body, env));
    return new Response("OK");
  },

  // Runs on the cron in wrangler.toml and keeps the 60-day token fresh.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (loginOf(env) !== "instagram") return;
    const fresh = await refreshToken(await getToken(env));
    await env.STATE.put(TOKEN_KEY, fresh);
  },
} satisfies ExportedHandler<Env>;
