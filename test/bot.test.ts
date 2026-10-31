import { afterEach, describe, expect, it, vi } from "vitest";
import { findRule, pickReply } from "../src/match";
import { parseComments, verifySignature } from "../src/webhook";
import worker, { handleComment, type Env } from "../src/index";
import { RULES, type Rule } from "../src/rules";

const rules: Rule[] = [
  { keywords: ["BUILD"], dm: "build link" },
  { keywords: ["free guide"], dm: "guide link", media: ["m1"] },
];

describe("findRule", () => {
  it("matches a keyword anywhere, any case, ignoring punctuation", () => {
    expect(findRule("build!!", undefined, rules)?.dm).toBe("build link");
    expect(findRule("pls send BUILD 🙏", undefined, rules)?.dm).toBe("build link");
  });
  it("needs a whole word", () => {
    expect(findRule("rebuilding", undefined, rules)).toBeUndefined();
  });
  it("accepts simple plurals", () => {
    expect(findRule("Builds", undefined, rules)?.dm).toBe("build link");
    expect(findRule("buildes", undefined, rules)?.dm).toBe("build link");
    expect(findRule("builder", undefined, rules)).toBeUndefined();
  });
  it("supports multi-word keywords and media filters", () => {
    expect(findRule("Free Guide please", "m1", rules)?.dm).toBe("guide link");
    expect(findRule("free guide please", "m2", rules)).toBeUndefined();
  });
});

describe("pickReply", () => {
  it("returns undefined for no replies and picks by index", () => {
    expect(pickReply(undefined)).toBeUndefined();
    expect(pickReply(["a", "b"], () => 0.99)).toBe("b");
  });
});

describe("parseComments", () => {
  const value = { from: { id: "u1", username: "sam" }, text: "BUILD", media: { id: "m1" } };
  it("reads the changes[] shape with comment_id", () => {
    const body = { object: "instagram", entry: [{ id: "acc", changes: [{ field: "comments", value: { ...value, comment_id: "c1" } }] }] };
    expect(parseComments(body)).toEqual([
      { accountId: "acc", commentId: "c1", fromId: "u1", fromUsername: "sam", text: "BUILD", mediaId: "m1" },
    ]);
  });
  it("reads the flat field/value shape with id, inside an array", () => {
    const body = [{ object: "instagram", entry: [{ id: "acc", field: "comments", value: { ...value, id: "c2" } }] }];
    expect(parseComments(body)[0].commentId).toBe("c2");
  });
  it("ignores other fields and junk", () => {
    expect(parseComments({ object: "instagram", entry: [{ id: "acc", changes: [{ field: "mentions", value: {} }] }] })).toEqual([]);
    expect(parseComments("nope")).toEqual([]);
  });
});

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifySignature", () => {
  it("accepts a correct signature and rejects others", async () => {
    const header = await sign("{}", "s3cret");
    expect(await verifySignature("{}", header, "s3cret")).toBe(true);
    expect(await verifySignature("{ }", header, "s3cret")).toBe(false);
    expect(await verifySignature("{}", null, "s3cret")).toBe(false);
  });
});

function fakeEnv(): Env {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
  return { STATE: kv, IG_APP_SECRET: "s3cret", IG_ACCESS_TOKEN: "tok", VERIFY_TOKEN: "vt" };
}

describe("handleComment", () => {
  afterEach(() => vi.restoreAllMocks());
  const base = { accountId: "acc", commentId: "c1", fromId: "u1", text: `${RULES[0].keywords[0]} please` };

  it("sends the DM once, then treats retries as duplicates", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    const env = fakeEnv();
    expect(await handleComment(base, env)).toBe("sent");
    expect(await handleComment(base, env)).toBe("duplicate");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("/acc/messages");
    expect(urls[1]).toContain("/c1/replies");
    expect(urls).toHaveLength(2);
  });

  it("skips its own comments and comments without a keyword", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const env = fakeEnv();
    expect(await handleComment({ ...base, fromId: "acc" }, env)).toBe("skipped");
    expect(await handleComment({ ...base, text: "nice video" }, env)).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("worker.fetch", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it("answers Meta's verification check only with the right token", async () => {
    const env = fakeEnv();
    const ok = await worker.fetch(new Request("https://x/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42"), env, ctx);
    expect(await ok.text()).toBe("42");
    const bad = await worker.fetch(new Request("https://x/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42"), env, ctx);
    expect(bad.status).toBe(403);
  });

  it("rejects unsigned posts and accepts signed ones", async () => {
    const env = fakeEnv();
    const body = JSON.stringify({ object: "instagram", entry: [] });
    const unsigned = await worker.fetch(new Request("https://x/webhook", { method: "POST", body }), env, ctx);
    expect(unsigned.status).toBe(401);
    const signed = await worker.fetch(
      new Request("https://x/webhook", { method: "POST", body, headers: { "X-Hub-Signature-256": await sign(body, "s3cret") } }),
      env,
      ctx,
    );
    expect(signed.status).toBe(200);
  });
});

describe("/setup", () => {
  afterEach(() => vi.restoreAllMocks());
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it("needs the verify token as key", async () => {
    const res = await worker.fetch(new Request("https://x/setup?key=wrong"), fakeEnv(), ctx);
    expect(res.status).toBe(403);
  });

  it("subscribes every account the token covers (unified login)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("assigned_instagram_accounts")
        ? Response.json({ data: [{ id: "acc", username: "rayan" }] })
        : Response.json({ success: true }),
    );
    const res = await worker.fetch(new Request("https://x/setup?key=vt"), fakeEnv(), ctx);
    const json = (await res.json()) as { ok: boolean; accounts: { account: string }[] };
    expect(json.ok).toBe(true);
    expect(json.accounts[0].account).toBe("rayan");
    expect(String(fetchMock.mock.calls[1][0])).toContain("graph.facebook.com/v26.0/acc/subscribed_apps?subscribed_fields=comments");
  });
});

describe("/connect and /callback", () => {
  afterEach(() => vi.restoreAllMocks());
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const env = () => ({ ...fakeEnv(), META_APP_ID: "app1", META_CONFIG_ID: "cfg1" });

  it("redirects to Meta's login with our state", async () => {
    const res = await worker.fetch(new Request("https://bot.dev/connect?key=vt"), env(), ctx);
    const loc = new URL(res.headers.get("Location") ?? "");
    expect(res.status).toBe(302);
    expect(loc.searchParams.get("config_id")).toBe("cfg1");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://bot.dev/callback");
    expect(loc.searchParams.get("state")).toBe("vt");
  });

  it("rejects a callback with the wrong state", async () => {
    const res = await worker.fetch(new Request("https://bot.dev/callback?code=c&state=nope"), env(), ctx);
    expect(res.status).toBe(403);
  });

  it("saves the token and subscribes the shared account", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("oauth/access_token")) return Response.json({ access_token: "newtok" });
      if (u.includes("assigned_instagram_accounts")) return Response.json({ data: [{ id: "acc", username: "rayan" }] });
      return Response.json({ success: true });
    });
    const e = env();
    const res = await worker.fetch(new Request("https://bot.dev/callback?code=c&state=vt"), e, ctx);
    expect(await res.text()).toContain("@rayan");
    expect(await e.STATE.get("token")).toBe("newtok");
  });
});

describe("facebook login setup", () => {
  afterEach(() => vi.restoreAllMocks());
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const env = () => ({ ...fakeEnv(), IG_LOGIN: "facebook", META_APP_ID: "app1", IG_ACCOUNT_ID: "ig1" });

  it("asks for Page and Instagram scopes", async () => {
    const res = await worker.fetch(new Request("https://bot.dev/connect?key=vt"), env(), ctx);
    const loc = new URL(res.headers.get("Location") ?? "");
    expect(loc.searchParams.get("scope")).toContain("instagram_manage_messages");
    expect(loc.searchParams.get("config_id")).toBeNull();
  });

  it("saves the token of the Page linked to the Instagram account", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      calls.push(u);
      if (u.includes("oauth/access_token") && u.includes("fb_exchange_token")) return Response.json({ access_token: "longuser" });
      if (u.includes("oauth/access_token")) return Response.json({ access_token: "shortuser" });
      if (u.includes("/me/accounts"))
        return Response.json({
          data: [
            { id: "p0", access_token: "other" },
            { id: "p1", access_token: "pagetok", instagram_business_account: { id: "ig1", username: "rayan" } },
          ],
        });
      if (u.includes("instagram_business_account")) return Response.json({ instagram_business_account: { id: "ig1", username: "rayan" } });
      return Response.json({ success: true });
    });
    const e = env();
    const res = await worker.fetch(new Request("https://bot.dev/callback?code=c&state=vt"), e, ctx);
    expect(await res.text()).toContain("@rayan");
    expect(await e.STATE.get("token")).toBe("pagetok");
    expect(calls.some((u) => u.includes("/me/subscribed_apps?subscribed_fields=feed"))).toBe(true);
  });
});

describe("catch-up for missed webhooks", () => {
  afterEach(() => vi.restoreAllMocks());
  it("answers only new keyword comments, once", async () => {
    const { recentComments, commitCounts } = await import("../src/catchup");
    const now = Date.parse("2026-10-31T02:00:00Z");
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      calls.push(u);
      if (u.includes("instagram_business_account")) return Response.json({ instagram_business_account: { id: "acc", username: "rayan" } });
      if (u.includes("/acc/media")) return Response.json({ data: [{ id: "m1", comments_count: 2 }, { id: "m2", comments_count: 0 }] });
      if (u.includes("/m1/comments"))
        return Response.json({ data: [
          { id: "new", text: `${RULES[0].keywords[0]}S`, timestamp: "2026-10-31T01:31:52+0000", from: { id: "u1" } },
          { id: "old", text: "Skills", timestamp: "2026-10-27T16:31:42+0000", from: { id: "u2" } },
        ] });
      return Response.json({ success: true });
    });
    const env = { ...fakeEnv(), IG_LOGIN: "facebook" };
    const found = await recentComments(env, now);
    expect(found.map((c) => c.commentId)).toEqual(["new"]);
    expect(await handleComment(found[0], env)).toBe("sent");
    expect(calls.some((u) => u.endsWith("/v26.0/me/messages"))).toBe(true);
    expect(await handleComment(found[0], env)).toBe("duplicate");
    await commitCounts(env, new Set());
    // Same comment count next time: the post isn't read again.
    calls.length = 0;
    expect(await recentComments(env, now)).toEqual([]);
    expect(calls.some((u) => u.includes("/m1/comments"))).toBe(false);
  });
});
