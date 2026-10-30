// Your keywords live here. Edit, then run `npm run deploy`.
//
// keywords:      words that trigger the DM (case doesn't matter, matched as whole words)
// dm:            the private message the commenter gets
// publicReplies: one is picked at random and posted under their comment (leave empty to skip)
// media:         optional list of post/reel IDs; leave out to match on every post

export interface Rule {
  keywords: string[];
  dm: string;
  publicReplies?: string[];
  media?: string[];
}

export const RULES: Rule[] = [
  {
    keywords: ["GUIDE"],
    dm: "Hey! Here's the free guide you asked for 👉 https://example.com/guide",
    publicReplies: ["Sent it to your DMs 📩", "Check your DMs 👀", "Just sent it! 🚀"],
  },
];
