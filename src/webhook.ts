// Parsing and verifying Meta webhook requests.

export interface Comment {
  accountId: string; // your Instagram professional account ID
  commentId: string;
  fromId: string;
  fromUsername?: string;
  text: string;
  mediaId?: string;
}

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : undefined;
}

function toComment(accountId: string, field: unknown, rawValue: unknown): Comment | undefined {
  if (field !== "comments") return undefined;
  const value = asObj(rawValue);
  if (!value) return undefined;
  const from = asObj(value.from);
  const media = asObj(value.media);
  // Meta's docs show both `id` and `comment_id` for the comment ID depending on the login type.
  const commentId = str(value.comment_id) ?? str(value.id);
  const fromId = str(from?.id);
  const text = typeof value.text === "string" ? value.text : "";
  if (!commentId || !fromId) return undefined;
  return {
    accountId,
    commentId,
    fromId,
    fromUsername: str(from?.username),
    text,
    mediaId: str(media?.id),
  };
}

// Pulls every comment out of a webhook body. Handles both the `changes: [...]`
// shape and the flat `field`/`value` shape shown in Meta's docs.
export function parseComments(body: unknown): Comment[] {
  const payloads = Array.isArray(body) ? body : [body];
  const out: Comment[] = [];
  for (const p of payloads) {
    const obj = asObj(p);
    if (!obj || obj.object !== "instagram" || !Array.isArray(obj.entry)) continue;
    for (const e of obj.entry) {
      const entry = asObj(e);
      const accountId = str(entry?.id);
      if (!entry || !accountId) continue;
      const changes = Array.isArray(entry.changes) ? entry.changes : [entry];
      for (const c of changes) {
        const change = asObj(c);
        const comment = change && toComment(accountId, change.field, change.value);
        if (comment) out.push(comment);
      }
    }
  }
  return out;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Checks the X-Hub-Signature-256 header against an HMAC of the raw body.
export async function verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return safeEqual(hex(sig), header.slice("sha256=".length).toLowerCase());
}
