// Safety net for missed webhooks. Meta doesn't always deliver comment webhooks, so on a timer the bot
// also reads the newest comments on your latest posts and answers any keyword comment it hasn't
// answered yet. Only comments newer than the "since" mark (set on first run) are considered, so
// people who commented before the bot existed aren't messaged out of the blue.

import { apiBase, getJson, listAccounts } from "./instagram";
import { getToken, loginOf, type Env } from "./env";
import type { Comment } from "./webhook";

const SINCE_KEY = "since";
const COUNTS_KEY = "counts";
const MEDIA_LIMIT = 25; // latest posts to watch; only posts whose comment count changed are read
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // Meta only allows private replies within 7 days
const FIRST_RUN_LOOKBACK_MS = 3 * 60 * 60 * 1000;

interface RawComment {
  id: string;
  text?: string;
  timestamp?: string;
  from?: { id?: string; username?: string };
}

export async function sinceMark(env: Env, now: number): Promise<number> {
  const saved = await env.STATE.get(SINCE_KEY);
  if (saved) return Date.parse(saved);
  const mark = now - FIRST_RUN_LOOKBACK_MS;
  await env.STATE.put(SINCE_KEY, new Date(mark).toISOString());
  return mark;
}

export async function recentComments(env: Env, now: number): Promise<Comment[]> {
  const login = loginOf(env);
  const base = apiBase(login);
  const token = await getToken(env);
  const since = Math.max(await sinceMark(env, now), now - WINDOW_MS);
  const out: Comment[] = [];
  const counts: Record<string, number> = JSON.parse((await env.STATE.get(COUNTS_KEY)) ?? "{}");
  const next: Record<string, number> = {};
  for (const account of await listAccounts(login, token)) {
    const media = (await getJson(`${base}/${account.id}/media?fields=id,comments_count&limit=${MEDIA_LIMIT}`, token)) as {
      data?: { id: string; comments_count?: number }[];
    };
    for (const m of media.data ?? []) {
      const n = m.comments_count ?? 0;
      next[m.id] = n;
      if (n === 0 || counts[m.id] === n) continue; // nothing new on this post
      const res = (await getJson(`${base}/${m.id}/comments?fields=id,text,timestamp,from&limit=50`, token)) as { data?: RawComment[] };
      for (const c of res.data ?? []) {
        const ts = c.timestamp ? Date.parse(c.timestamp) : NaN;
        if (!(ts >= since)) continue;
        out.push({ accountId: account.id, commentId: c.id, fromId: c.from?.id ?? "", fromUsername: c.from?.username, text: c.text ?? "", mediaId: m.id });
      }
    }
  }
  pendingCounts.set(env, next);
  return out;
}

// Comment counts are saved only after the comments were handled, minus posts where a reply failed,
// so a failed DM is retried on the next run.
const pendingCounts = new WeakMap<Env, Record<string, number>>();
export async function commitCounts(env: Env, failedMedia: Set<string>): Promise<void> {
  const next = pendingCounts.get(env);
  if (!next) return;
  const prev: Record<string, number> = JSON.parse((await env.STATE.get(COUNTS_KEY)) ?? "{}");
  for (const id of failedMedia) {
    if (id in prev) next[id] = prev[id];
    else delete next[id];
  }
  await env.STATE.put(COUNTS_KEY, JSON.stringify(next));
  pendingCounts.delete(env);
}
