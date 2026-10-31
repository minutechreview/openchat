# OpenChat

**A free, open-source alternative to ManyChat's comment-to-DM feature.**

Someone comments a keyword on your Instagram post or reel, and they get your link in their
DMs within seconds, plus a "Check your DMs 📩" reply under their comment.

ManyChat charges by contacts (from $14/month for 250 people on its Essential plan), so the
more a reel blows up, the more you pay. This runs on Cloudflare's free tier, and you own it.

## What it does

- 💬 **Keyword → DM.** Comment "GUIDE" and get the guide. Keywords are matched as whole words (plurals count too), in any case, anywhere in the comment.
- 📩 **Public reply** under the comment, picked at random from your list.
- 🎯 **Per-post rules** (optional): limit a keyword to specific posts.
- 🛟 **Safety net.** Meta sometimes drops webhooks, so every 5 minutes the bot also checks your latest posts for keyword comments it missed.
- 🔁 **No double DMs.** Meta retries webhooks; the bot remembers which comments it already answered.
- 🔐 **Signed webhooks.** Every request from Meta is checked against your app secret.
- 🔑 **No token copying.** The bot's `/connect` page gets its own Instagram token. It doesn't expire.
- 🪶 **Tiny.** About 500 lines of TypeScript, no runtime dependencies.

## How it works

```
Someone comments "GUIDE"
        │
        ▼
Meta sends a webhook ──► Cloudflare Worker (this repo)
                              │  checks the signature
                              │  matches your keywords (src/rules.ts)
                              ├──► Instagram API: private reply (the DM)
                              └──► Instagram API: public reply under the comment
```

It uses Instagram's official
[Private Replies](https://developers.facebook.com/documentation/instagram-platform/private-replies)
API: one DM per comment, within 7 days of the comment.

## Set it up

About 30 minutes, all free. **[→ Setup guide with screenshots](docs/SETUP.md)**

Meta's developer dashboard is a maze. Half the official docs describe options that no
longer exist. We documented every trap we hit: **[→ Traps & fixes](docs/TROUBLESHOOTING.md)**.

### Let your AI agent guide you

Point Claude, Codex or any coding agent at
[`skills/instagram-comment-dm/SKILL.md`](skills/instagram-comment-dm/SKILL.md):

> Read skills/instagram-comment-dm/SKILL.md in this repo and walk me through setting it up, one step at a time.

## Your keywords

```ts
// src/rules.ts
export const RULES: Rule[] = [
  {
    keywords: ["GUIDE"],
    dm: "Here's the free guide 👉 https://example.com/guide",
    publicReplies: ["Sent it to your DMs 📩", "Check your DMs 👀"],
  },
];
```

Then `npm run deploy`.

## Limits (from Meta, not us)

- One DM per comment, sent within 7 days of the comment.
- Your Instagram must be a public Professional (Creator/Business) account linked to a Facebook Page.
- Your Meta app must be published to receive real comments.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
npx wrangler tail # live logs from the deployed bot
```

## License

MIT. Made by [Rayan Abdul Cader](https://www.instagram.com/minutechbuilds/) with Claude.
Contributions welcome. Meta's dashboard changes all the time, so screenshot updates and
new traps are especially useful.
