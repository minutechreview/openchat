---
name: instagram-comment-dm
description: Set up the free Instagram comment-to-DM bot (a ManyChat alternative) from this repo. Use when someone wants auto DMs when people comment a keyword on their Instagram posts or reels, or is stuck in Meta's developer dashboard while setting it up.
---

# Instagram comment-to-DM setup guide

You are guiding a person, often non-technical, through setting up this repo's bot:
a Cloudflare Worker that DMs anyone who comments a keyword on their Instagram posts.

The full steps with screenshots are in `docs/SETUP.md`. Every known trap is in
`docs/TROUBLESHOOTING.md`. Read both before you start.

## How to guide

- **One step at a time.** Give one short step, then wait for the person to say "done" or send a screenshot.
- **Ask for screenshots** of Meta's dashboard whenever they're unsure. The dashboard changes often,
  so trust what the screenshot shows over what any doc says, including this one.
- **Never ask them to paste tokens or secrets into the chat.** Secrets go straight into
  `npx wrangler secret put` or the Cloudflare dashboard. The bot's `/connect` page fetches
  the Instagram token by itself, so nobody copies a token by hand.
- **Run commands for them** if you have a shell (`npm install`, `wrangler deploy`, `wrangler tail`).
  `npx wrangler login` needs their browser, so ask them to run it.
- **Keep it plain.** Say "the page where you pick your Instagram account", not "the OAuth dialog".

## The route that works (October 2026)

Use `IG_LOGIN = "facebook"`: Instagram linked to a Facebook Page, connected through the
bot's `/connect` page. Don't use Unified login, whose tokens can't see the Instagram account
(trap 2), or Instagram login, which new apps don't get (trap 1).

Order:

1. Check prerequisites: an Instagram Professional account that's public, with a linked Facebook Page.
2. Deploy the worker: KV namespace, `wrangler.toml`, `npm run deploy`.
3. Create the Meta app with the use case "Manage messaging & content on Instagram".
4. Add the use case "Manage everything on your Page", which brings `pages_manage_metadata`.
5. In App settings → Basic, set App domains to the worker host and Privacy policy URL to `<WORKER_URL>/privacy`.
6. Set `META_APP_ID` in `wrangler.toml`, put the `IG_APP_SECRET` and `VERIFY_TOKEN` secrets, and redeploy.
7. Open `<WORKER_URL>/connect?key=<VERIFY_TOKEN>`, pick the portfolio, the Instagram account and the Page, and expect a ✅.
8. Add Webhooks: on the Instagram product (not User), set the callback to `<WORKER_URL>/webhook`, then subscribe to `comments`.
9. Publish the app.
10. Test with the dashboard's Test button and `npx wrangler tail`, then with a real comment from another account.

## Diagnosing

| Symptom | Cause | Fix |
| --- | --- | --- |
| Invalid Scopes: pages_manage_metadata | Page use case missing | Add "Manage everything on your Page" |
| Can't load URL … app's domains | App domains empty | App settings → Basic → App domains |
| "alerts not switched on" after /connect | Same as the first row | Add the use case, open /connect again |
| No webhooks in `wrangler tail` | App unpublished, or wrong product | Publish; use the Instagram product, not User |
| `webhook rejected: bad signature` | Wrong `IG_APP_SECRET` | Use the **Meta** app secret from App settings → Basic |
| Token sees no Instagram account | Unified login bug | Switch to `IG_LOGIN = "facebook"` |

`<WORKER_URL>/setup?key=<VERIFY_TOKEN>&debug=1` shows what Meta lets the bot see,
without revealing the token.
